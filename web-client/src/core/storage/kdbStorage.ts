// ============================================
// KDB Storage - Bridge between WASM and IndexedDB
// ============================================

// ------------------------------------------------------------------
// Batched write layer
//
// WASM's parse_and_store_kdb() calls store_signal_inst / store_module /
// store_source_file_info once PER RECORD (2,005,030 signal instances for
// n900). If each call opened its own IndexedDB transaction, loading became
// 2M serial round-trips and took a very long time. Instead we buffer records
// here and flush them in a single transaction per BATCH, which cuts the
// transaction count by BATCH_SIZE and removes the per-record await overhead.
// A periodic flush timer guarantees stragglers are written even if the final
// batch never reaches BATCH_SIZE.
// ------------------------------------------------------------------
const STORE_BATCH_SIZE = 5000;

// Format current time as HH:MM:SS.mmm for timestamping store-step logs.
function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// Heartbeat relay during the multi-minute WASM store.
//
// The worker's setInterval heartbeat can be starved while the worker is busy
// (and during the long synchronous stretches of parse_and_store_kdb the main
// thread's KDBDownloadManager would otherwise log a spurious "Worker heartbeat
// timeout"). We post a heartbeat from *inside* the hot store loop — which runs
// periodically throughout the store — so the main thread's stall timer keeps
// getting reset. Only meaningful inside a Web Worker; on the main thread
// `self.Window` exists, so this is a no-op there.
let _lastWorkerHeartbeat = 0;
function postWorkerHeartbeat(): void {
  if (typeof (self as any).Window !== 'undefined') return;
  const now = Date.now();
  if (now - _lastWorkerHeartbeat < 2000) return; // at most one every 2s
  _lastWorkerHeartbeat = now;
  (self as any).postMessage({
    type: 'heartbeat',
    timestamp: now,
    loaded: 0,
    total: 0,
    phase: 'storing',
  });
}

interface ModuleRecord { id: number; name: any; parentModuleId: number; definition: any; signalDefs: any[]; isInstance: boolean; childModuleIds: any[]; defModuleId: number; signalInstsStartId: number; kdbId: string; }
// Lightweight metadata only — the heavy per-256-line byte offsets are written
// to the separate `source-file-line-index` store so the Files tab never loads them.
interface FileInfoRecord { id: number; path: string; name: string; fullName: string; totalLines: number; kdbId: string; }
interface FileLineIndexRecord { id: number; lineIndexOffset: number[]; kdbId: string; }

// Flat OPFS binary layout for signals + drivers (see lib.rs store path).
//   signals.bin : SIGNAL_RECORD_SIZE bytes/record, indexed by signal global id
//                 msb:u32, lsb:u32, parentModuleId:u32, driverStart:u32, driverCount:u16
//   drivers.bin : DRIVER_RECORD_SIZE bytes/record, indexed by driverStart
//                 driverSignalGlobalId:u64, line:u32
const SIGNAL_RECORD_SIZE = 18;
const DRIVER_RECORD_SIZE = 12;
const SIGNALS_BIN = 'signals.bin';
const DRIVERS_BIN = 'drivers.bin';

let _dbPromise: Promise<any> | null = null;
let _flushTimer: ReturnType<typeof setInterval> | null = null;

function getDb(): Promise<any> {
  if (!_dbPromise) _dbPromise = indexedDBManager.initialize().then(() => (indexedDBManager as any).db);
  return _dbPromise;
}

const _moduleBatch: ModuleRecord[] = [];
const _fileInfoBatch: FileInfoRecord[] = [];
const _fileLineIndexBatch: FileLineIndexRecord[] = [];

// Per-store "flush in flight" guard. The periodic timer in ensureFlushTimer()
// and the in-line flushes from the store loop can race: both may try to flush
// the same batch, producing a second empty IndexedDB transaction (the old
// "Flushed 0 records" lines). Guarding on the store name serializes flushes
// and prevents the wasted transaction.
const _flushing: Record<string, boolean> = {};
const _flushCount: Record<string, number> = {};

async function flushBatch<T>(storeName: string, batch: T[]): Promise<void> {
  if (batch.length === 0) return;
  if (_flushing[storeName]) return;
  _flushing[storeName] = true;
  try {
    const db = await getDb();
    if (!db) return;
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const rec of batch) store.put(rec);
    await tx.done;
    const count = (_flushCount[storeName] = (_flushCount[storeName] || 0) + 1);
    // Throttle logging: signal-insts flushes are very frequent (2M records),
    // so only log every 50th flush plus the final partial one. This keeps the
    // console readable and avoids the (non-trivial) cost of thousands of logs.
    if (count % 50 === 0 || batch.length < STORE_BATCH_SIZE) {
      console.log(`[${ts()}] [KdbStorage] Flushed ${batch.length} records to ${storeName} (batch #${count})`);
    }
    // Keep the main thread's heartbeat stall-timer alive during the long store.
    postWorkerHeartbeat();
    batch.length = 0;
  } finally {
    _flushing[storeName] = false;
  }
}

async function flushAllBatches(): Promise<void> {
  await Promise.all([
    flushBatch('modules', _moduleBatch as any),
    flushBatch('source-file-info', _fileInfoBatch as any),
    flushBatch('source-file-line-index', _fileLineIndexBatch as any),
  ]);
}

// Ensure a periodic flush runs so the last partial batch is never lost.
function ensureFlushTimer(): void {
  if (_flushTimer != null) return;
  _flushTimer = setInterval(() => {
    // Fire-and-forget; swallow errors. We only want best-effort progress.
    flushAllBatches().catch(() => {});
  }, 1000);
}
ensureFlushTimer();

// Expose a final flush hook so callers (e.g. after parse_and_store_kdb) can
// guarantee everything is persisted before reporting completion.
// Use `self` (not `window`) so it is available in both the window context and
// Web Worker context — the worker imports this module and `window` is undefined there.
(self as any).__flushKdbBatches = flushAllBatches;


// Exposes IndexedDB operations to WASM as global functions
// Updated for new KDB structure (SignalDef + SignalInst split)

import { indexedDBManager } from './indexedDB';
import { isOpfsAvailable, globalMemoryStorage } from '../../utils/opfsUtils';

/**
 * Store knowledge base metadata
 * WASM stores: { id, header, hierarchies }
 */
async function store_knowledge_base(id: string, data: any): Promise<void> {
  console.log(`[${ts()}] [KdbStorage] Storing knowledge base:`, id);
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  // Handle both Map (from serde_wasm_bindgen) and plain object
  const getValue = (key: string) => {
    if (data instanceof Map) {
      return data.get(key);
    }
    return data[key];
  };
  
  // Store knowledge base with new structure
  const record = {
    id,
    header: getValue('header') || {},
    hierarchies: getValue('hierarchies') || [],
  };
  console.log(`[${ts()}] [KdbStorage] Storing record:`, record);
  await db.put('knowledge-base', record);
  console.log(`[${ts()}] [KdbStorage] Stored successfully`);
}

/**
 * Convert Map to plain object recursively
 */
function convertToPlainObject(value: any): any {
  if (value instanceof Map) {
    const obj: any = {};
    for (const [key, val] of value.entries()) {
      obj[key] = convertToPlainObject(val);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(convertToPlainObject);
  }
  return value;
}

/**
 * WASM builds these records using js_sys, which already produces plain JS
 * objects (not Maps). The old code ran every value through convertToPlainObject,
 * which walks the whole tree and is pure overhead for already-plain data. Only
 * convert when we actually see a Map (e.g. serde_wasm_bindgen output).
 */
function maybePlain(value: any): any {
  return value instanceof Map ? convertToPlainObject(value) : value;
}

/**
 * Store module
 * WASM stores: { name, parentModuleId, definition, signalDefs, isInstance, childModuleIds, defModuleId, signalInstsStartId }
 */
async function store_module(id: number, data: any, kdbId: string): Promise<void> {
  // Handle both Map (from serde_wasm_bindgen) and plain object
  const getValue = (key: string) => {
    if (data instanceof Map) {
      return data.get(key);
    }
    return data[key];
  };
  
  // Convert signalDefs from Map to plain objects
  const signalDefs = getValue('signalDefs') || [];
  const plainSignalDefs = signalDefs.map(convertToPlainObject);
  
  _moduleBatch.push({
    id,
    name: getValue('name'),
    parentModuleId: getValue('parentModuleId') || 0,
    definition: convertToPlainObject(getValue('definition')),
    signalDefs: plainSignalDefs,
    isInstance: getValue('isInstance') || false,
    childModuleIds: getValue('childModuleIds') || [],
    defModuleId: getValue('defModuleId') || 0,
    signalInstsStartId: getValue('signalInstsStartId') || 0,
    kdbId,
  });
  
  if (_moduleBatch.length >= STORE_BATCH_SIZE) {
    await flushBatch('modules', _moduleBatch as any);
  }
}

// ------------------------------------------------------------------
// Flat binary signal/driver storage (OPFS)
//
// Signals and drivers are stored as two contiguous binary files in the KDB's
// OPFS directory instead of millions of IndexedDB records. WASM hands us the
// fully-serialized little-endian buffers (see lib.rs); we just write each to a
// single file. Reads are O(1) byte-range lookups (see get_signals_buffer /
// get_drivers_by_range). Falls back to in-memory storage when OPFS is absent.
// ------------------------------------------------------------------

async function writeOpfsBinary(kdbId: string, fileName: string, bytes: Uint8Array): Promise<void> {
  // Copy to a tight view so we never write trailing WASM-heap bytes.
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (!isOpfsAvailable()) {
    console.warn(`[KdbStorage] OPFS unavailable, keeping ${fileName} in memory (key=${kdbId}_${fileName})`);
    // Store a detached copy so the underlying WASM memory can be freed.
    globalMemoryStorage.set(`${kdbId}_${fileName}`, view.slice());
    return;
  }

  try {
    const root = await navigator.storage.getDirectory();
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: true });
    const fileHandle = await kdbDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(view as any);
    await writable.close();
    console.log(`[${ts()}] [KdbStorage] Wrote ${view.byteLength} bytes to OPFS: ${kdbId}/${fileName}`);
  } catch (e) {
    console.error(`[KdbStorage] Failed to write ${fileName} to OPFS:`, e);
    globalMemoryStorage.set(`${kdbId}_${fileName}`, view.slice());
  }
}

async function readOpfsWhole(kdbId: string, fileName: string): Promise<ArrayBuffer | null> {
  const memKey = `${kdbId}_${fileName}`;
  if (globalMemoryStorage.has(memKey)) {
    const buf = globalMemoryStorage.get(memKey)!;
    // Our in-memory copies are always plain ArrayBuffers (never SharedArrayBuffer).
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  if (!isOpfsAvailable()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
    const fileHandle = await kdbDir.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    return await file.arrayBuffer();
  } catch (e) {
    console.warn(`[KdbStorage] ${fileName} not found for KDB ${kdbId}`);
    return null;
  }
}

async function readOpfsRange(kdbId: string, fileName: string, startByte: number, endByte: number): Promise<Uint8Array | null> {
  const memKey = `${kdbId}_${fileName}`;
  const memRange = globalMemoryStorage.getRange(memKey, startByte, endByte);
  if (memRange) return memRange;
  if (!isOpfsAvailable()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
    const fileHandle = await kdbDir.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    const slice = file.slice(startByte, endByte);
    return new Uint8Array(await slice.arrayBuffer());
  } catch (e) {
    console.warn(`[KdbStorage] Failed to read range from ${fileName}:`, e);
    return null;
  }
}

/**
 * Store the flat signals.bin buffer to OPFS. Called once by WASM.
 * WASM calls: store_signals_opfs(bytes, kdbId)
 */
async function store_signals_opfs(bytes: Uint8Array, kdbId: string): Promise<void> {
  await writeOpfsBinary(kdbId, SIGNALS_BIN, bytes);
  postWorkerHeartbeat();
}

/**
 * Store the flat drivers.bin buffer to OPFS. Called once by WASM.
 * WASM calls: store_drivers_opfs(bytes, kdbId)
 */
async function store_drivers_opfs(bytes: Uint8Array, kdbId: string): Promise<void> {
  await writeOpfsBinary(kdbId, DRIVERS_BIN, bytes);
  postWorkerHeartbeat();
}

/**
 * Read the entire signals.bin as an ArrayBuffer (18 bytes/record). The caller
 * keeps this resident (~18 bytes * #signals, tens of MB) and indexes into it
 * with a DataView for O(1) synchronous field access — no per-signal JS objects.
 */
async function get_signals_buffer(kdbId: string): Promise<ArrayBuffer | null> {
  return readOpfsWhole(kdbId, SIGNALS_BIN);
}

/**
 * Read a signal's drivers on demand by its (driverStart, driverCount) slice.
 * Only that signal's bytes ever enter memory — this is the lazy "trace driver"
 * path. Returns an array of { driverSignalGlobalId, line }.
 */
async function get_drivers_by_range(
  kdbId: string,
  driverStart: number,
  driverCount: number,
): Promise<Array<{ driverSignalGlobalId: number; line: number }>> {
  if (!driverCount) return [];
  const startByte = driverStart * DRIVER_RECORD_SIZE;
  const endByte = startByte + driverCount * DRIVER_RECORD_SIZE;
  const bytes = await readOpfsRange(kdbId, DRIVERS_BIN, startByte, endByte);
  if (!bytes || bytes.byteLength < driverCount * DRIVER_RECORD_SIZE) return [];

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Array<{ driverSignalGlobalId: number; line: number }> = new Array(driverCount);
  for (let i = 0; i < driverCount; i++) {
    const off = i * DRIVER_RECORD_SIZE;
    const low = dv.getUint32(off, true);
    const high = dv.getUint32(off + 4, true);
    out[i] = {
      driverSignalGlobalId: high * 4294967296 + low,
      line: dv.getUint32(off + 8, true),
    };
  }
  return out;
}



/**
 * Store a batch of modules in a single IndexedDB transaction.
 * Called by WASM (parse_and_store_kdb) with an Array of module objects.
 */
async function store_modules_batch(modules: any[], kdbId: string): Promise<void> {
  for (const m of modules) {
    const signalDefs = m.signalDefs || [];
    const plainSignalDefs = signalDefs.map(maybePlain);

    _moduleBatch.push({
      id: Number(m.id || 0),
      name: m.name,
      parentModuleId: m.parentModuleId || 0,
      definition: maybePlain(m.definition),
      signalDefs: plainSignalDefs,
      isInstance: m.isInstance || false,
      childModuleIds: m.childModuleIds || [],
      defModuleId: m.defModuleId || 0,
      signalInstsStartId: m.signalInstsStartId || 0,
      kdbId,
    });
  }

  if (_moduleBatch.length >= STORE_BATCH_SIZE) {
    await flushBatch('modules', _moduleBatch as any);
  }
}

/**
 * Store source file info (metadata only)
 * WASM calls: store_source_file_info(id, path, name, fullName, totalLines, lineIndexOffset, kdbId)
 *
 * The lightweight metadata (what the Files tab needs) goes to `source-file-info`.
 * The heavy per-256-line `lineIndexOffset` array goes to the separate
 * `source-file-line-index` store, read back only when a file is actually opened
 * for line seeking. This keeps the Files tab's memory footprint tiny regardless
 * of design size (previously loading every file's offsets at once OOM'd the
 * renderer at ~1.6 GB on large designs).
 */
async function store_source_file_info(
  id: number, 
  path: string, 
  name: string, 
  fullName: string, 
  totalLines: number, 
  lineIndexOffset: number[],
  kdbId: string
): Promise<void> {
  // Keep the main-thread heartbeat alive through the (per-file) source storing phase.
  postWorkerHeartbeat();
  
  // Metadata (light) — what the Files tab and name lookups need.
  _fileInfoBatch.push({
    id,
    path,
    name,
    fullName,
    totalLines,
    kdbId,
  });

  // Heavy per-256-line byte offsets — stored separately so the Files tab never
  // loads them. Only read back when a file is actually opened (line seeking).
  _fileLineIndexBatch.push({
    id,
    lineIndexOffset: lineIndexOffset || [],
    kdbId,
  });

  if (_fileInfoBatch.length >= STORE_BATCH_SIZE) {
    await flushBatch('source-file-info', _fileInfoBatch as any);
  }
  if (_fileLineIndexBatch.length >= STORE_BATCH_SIZE) {
    await flushBatch('source-file-line-index', _fileLineIndexBatch as any);
  }
}

/**
 * Store source file content (large data) to OPFS (Origin Private File System)
 * WASM calls: store_source_file_content_opfs(id, content, kdbId)
 * Uses OPFS for better performance with large files
 * Falls back to memory storage if OPFS is not available
 */
async function store_source_file_content_opfs(id: number, content: Uint8Array, kdbId: string): Promise<void> {
  // Check if OPFS is available
  if (!isOpfsAvailable()) {
    console.warn('[KdbStorage] OPFS not available, storing in memory, key=', `${kdbId}_${id}`);
    // Store in memory as fallback
    globalMemoryStorage.set(`${kdbId}_${id}`, content);
    return;
  }
  
  try {
    // Get OPFS root directory
    const root = await navigator.storage.getDirectory();
    
    // Create/get KDB-specific directory
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: true });
    
    // Create/get file handle
    const fileName = `file_${id}.content`;
    const fileHandle = await kdbDir.getFileHandle(fileName, { create: true });
    
    // Write content using FileSystemWritableFileStream
    // Create a new Uint8Array view to ensure we only write the actual data
    const writable = await fileHandle.createWritable();
    const contentView = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    await writable.write(contentView as any);
    await writable.close();
  } catch (e) {
    console.error('[KdbStorage] Failed to store content to OPFS:', e);
    // Fallback to memory storage
    console.warn('[KdbStorage] Falling back to memory storage, key=', `${kdbId}_${id}`);
    globalMemoryStorage.set(`${kdbId}_${id}`, content);
  }
}

/**
 * Get full source file content from OPFS or memory fallback
 * Returns: string (UTF-8 decoded)
 */
async function get_source_file_content(fileId: number, kdbId: string): Promise<string | null> {
  // Check memory fallback first
  const memoryKey = `${kdbId}_${fileId}`;
  if (globalMemoryStorage.has(memoryKey)) {
    const content = globalMemoryStorage.get(memoryKey)!;
    return new TextDecoder().decode(content);
  }
  
  // Check if OPFS is available
  if (!isOpfsAvailable()) {
    console.warn('[KdbStorage] OPFS not available and no memory fallback for key=', memoryKey);
    return null;
  }
  
  try {
    // Get OPFS root directory
    const root = await navigator.storage.getDirectory();
    
    // Get KDB-specific directory
    let kdbDir: FileSystemDirectoryHandle;
    try {
      kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
    } catch (e) {
      console.error(`[KdbStorage] KDB directory not found: ${kdbId}`, e);
      return null;
    }
    
    // Get file handle
    const fileName = `file_${fileId}.content`;
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await kdbDir.getFileHandle(fileName, { create: false });
    } catch (e) {
      console.error(`[KdbStorage] File not found: ${kdbId}/${fileName}`, e);
      return null;
    }
    
    // Get file and read all content
    const file = await fileHandle.getFile();
    const arrayBuffer = await file.arrayBuffer();
    
    // Decode UTF-8 bytes to string
    const content = new TextDecoder().decode(arrayBuffer);
    return content;
  } catch (e) {
    console.error('[KdbStorage] Failed to get content from OPFS:', e);
    return null;
  }
}

/**
 * Get source file content by byte range from OPFS or memory fallback
 * Uses index offset for efficient seeking
 * WASM calls: get_source_file_content_by_range(fileId, startByte, endByte, kdbId)
 * Returns: Uint8Array of the requested range
 */
async function get_source_file_content_by_range(
  fileId: number, 
  startByte: number, 
  endByte: number, 
  kdbId: string
): Promise<Uint8Array> {
  // Check memory fallback first
  const memoryKey = `${kdbId}_${fileId}`;
  const memoryContent = globalMemoryStorage.getRange(memoryKey, startByte, endByte);
  if (memoryContent) {
    return memoryContent;
  }
  
  // Check if OPFS is available
  if (!isOpfsAvailable()) {
    throw new Error('OPFS not available and no memory fallback');
  }
  
  try {
    // Get OPFS root directory
    const root = await navigator.storage.getDirectory();
    
    // Get KDB-specific directory
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
    
    // Get file handle
    const fileName = `file_${fileId}.content`;
    const fileHandle = await kdbDir.getFileHandle(fileName, { create: false });
    
    // Get file
    const file = await fileHandle.getFile();
    
    // Read specific byte range using slice
    const slice = file.slice(startByte, endByte);
    const arrayBuffer = await slice.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } catch (e) {
    console.error('[KdbStorage] Failed to get content by range from OPFS:', e);
    throw e;
  }
}

/**
 * Get source file content by line range using index offset
 * First gets the line_index_offset from IndexedDB, then reads from OPFS
 */
async function get_source_file_lines_by_range(
  fileId: number,
  startLine: number,
  endLine: number,
  kdbId: string
): Promise<string[]> {
  // 1. Get file info from IndexedDB (contains line_index_offset)
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  const fileInfo = await db.get('source-file-info', fileId);
  if (!fileInfo || fileInfo.kdbId !== kdbId) {
    throw new Error(`File info not found: ${fileId}`);
  }
  
  // Line offset index lives in its own store (`source-file-line-index`), read
  // lazily only when a file is opened for line seeking.
  const lineIndexOffset: number[] = await indexedDBManager.getSourceFileLineIndex(fileId);
  const totalLines: number = fileInfo.totalLines || 0;
  
  // Validate line range
  if (startLine < 1 || endLine < 1 || startLine > totalLines) {
    throw new Error(`Invalid line range: ${startLine}-${endLine}, total: ${totalLines}`);
  }
  
  endLine = Math.min(endLine, totalLines);
  
  // 2. Calculate byte range using index offset
  // Find the index slot for startLine (every 256 lines)
  const startIndexSlot = Math.floor((startLine - 1) / 256);
  const startByteOffset = lineIndexOffset[startIndexSlot] || 0;
  
  // For endLine, we need to read until we find the end
  // For simplicity, read from startByteOffset to end of file, then parse lines
  // A more optimized version would estimate the end byte
  
  // 3. Read content from OPFS
  const root = await navigator.storage.getDirectory();
  const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
  const fileHandle = await kdbDir.getFileHandle(`file_${fileId}.content`, { create: false });
  const file = await fileHandle.getFile();
  
  // Read from calculated start offset to end of file
  const slice = file.slice(startByteOffset);
  const arrayBuffer = await slice.arrayBuffer();
  const content = new Uint8Array(arrayBuffer);
  
  // 4. Parse lines
  const lines: string[] = [];
  let currentLine = startIndexSlot * 256 + 1;
  let pos = 0;
  
  // Skip lines until we reach startLine
  while (currentLine < startLine && pos < content.length) {
    if (content[pos] === 0x0A) { // '\n'
      currentLine++;
    }
    pos++;
  }
  
  // Read lines from startLine to endLine
  while (currentLine <= endLine && pos < content.length) {
    let lineStart = pos;
    // Find end of line
    while (pos < content.length && content[pos] !== 0x0A && content[pos] !== 0x0D) {
      pos++;
    }
    // Extract line as UTF-8 string
    const lineBytes = content.slice(lineStart, pos);
    const line = new TextDecoder().decode(lineBytes);
    lines.push(line);
    currentLine++;
    // Skip newline characters
    if (pos < content.length && content[pos] === 0x0D) pos++; // '\r'
    if (pos < content.length && content[pos] === 0x0A) pos++; // '\n'
  }
  
  return lines;
}

/**
 * Clear all data for a KDB
 */
async function clear_kdb_data(kdbId: string): Promise<void> {
  console.log('[KdbStorage] Clearing data for KDB:', kdbId);
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');

  // Fast clear: truncate each object store with a single native operation.
  //
  // The previous approaches were far too slow for 2M records:
  //   - v1 collected every key into a giant array then `delete()`-ed per key
  //   - v2 used a cursor + `cursor.delete()` (one request per record)
  // Both took ~6.5 minutes for the signal-insts store. IDB's store.clear()
  // removes all records at the native layer in one shot, so it is effectively
  // instant. This app loads one KDB at a time and wipes the previous one
  // before loading, so truncating the whole store is equivalent here.
  // Note: signals/drivers now live in OPFS (signals.bin/drivers.bin), removed
  // together with the source-file contents by the OPFS directory removal below.
  const stores = ['knowledge-base', 'modules', 'source-file-info', 'source-file-line-index'];
  for (const storeName of stores) {
    try {
      await db.clear(storeName);
      console.log(`[${ts()}] [KdbStorage] Cleared store: ${storeName}`);
    } catch (e) {
      console.warn(`[KdbStorage] Error clearing ${storeName}:`, e);
    }
  }

  // Clear file contents from OPFS (single native dir removal). The per-file
  // store path recreates the directory via getDirectoryHandle(kdbId, {create:true}).
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(kdbId, { recursive: true });
    console.log(`[${ts()}] [KdbStorage] Cleared OPFS directory: ${kdbId}`);
  } catch (e) {
    console.log(`[${ts()}] [KdbStorage] OPFS directory not found for KDB: ${kdbId}`);
  }

  console.log(`[${ts()}] [KdbStorage] Cleared data for KDB:`, kdbId);
}

// Expose functions to global scope for WASM
if (typeof window !== 'undefined') {
  (window as any).store_knowledge_base = store_knowledge_base;
  (window as any).store_module = store_module;
  (window as any).store_signals_opfs = store_signals_opfs;
  (window as any).store_drivers_opfs = store_drivers_opfs;
  (window as any).store_module = store_module;
  (window as any).store_modules_batch = store_modules_batch;
  (window as any).store_source_file_info = store_source_file_info;
  (window as any).store_source_file_content_opfs = store_source_file_content_opfs;
  (window as any).get_source_file_content = get_source_file_content;
  (window as any).get_source_file_content_by_range = get_source_file_content_by_range;
  (window as any).get_source_file_lines_by_range = get_source_file_lines_by_range;
  (window as any).clear_kdb_data = clear_kdb_data;
  // No-op fallback for the WASM progress callback on the main thread. The Web
  // Worker overrides this with a version that relays step progress to the UI;
  // on the main thread we just log so WASM's `window.report_kdb_progress` call
  // never throws when the KDB is parsed outside the worker.
  if (typeof (window as any).report_kdb_progress !== 'function') {
    (window as any).report_kdb_progress = (step: number, total: number, message: string) => {
      console.log(`[${ts()}] [KdbStorage] Unpack step ${step}/${total}: ${message}`);
    };
  }
  console.log('[KdbStorage] Functions exposed to global scope');
}

// Export for use in other modules
export {
  store_knowledge_base,
  store_module,
  store_modules_batch,
  store_signals_opfs,
  store_drivers_opfs,
  get_signals_buffer,
  get_drivers_by_range,
  store_source_file_info,
  store_source_file_content_opfs,
  get_source_file_content,
  get_source_file_content_by_range,
  get_source_file_lines_by_range,
  clear_kdb_data,
};
