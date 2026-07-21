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
export function postWorkerHeartbeat(): void {
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

// Lightweight metadata (what the Files tab needs) goes to the `source-file-info`
// IndexedDB store. The heavy per-256-line byte offsets used for line seeking are
// NOT stored in IDB (a ~36 MB blob there, plus a ~36 MB JS spike on first file
// open when the whole bundle is read back). They are buffered during parse and
// written once to OPFS as `source_line_index.bin` (see store_source_file_info /
// writeLineIndexToOPFS), then read lazily per file.
interface FileInfoRecord { id: number; path: string; name: string; fullName: string; totalLines: number; kdbId: string; }
interface LineIndexChunk { id: number; offsets: number[]; }

// Flat OPFS binary layout for signals + drivers (see lib.rs store path).
//   signals.bin : SIGNAL_RECORD_SIZE bytes/record, indexed by signal global id
//                 msb:u32, lsb:u32, parentModuleId:u32, driverStart:u32, driverCount:u16
//   drivers.bin : DRIVER_RECORD_SIZE bytes/record, indexed by driverStart
//                 driverSignalGlobalId:u64, line:u32
const SIGNAL_RECORD_SIZE = 18;
const DRIVER_RECORD_SIZE = 12;
const SIGNALS_BIN = 'signals.bin';
const DRIVERS_BIN = 'drivers.bin';
const MODULES_BIN = 'modules.bin';
const MODULE_SIGNAL_DEFS_BIN = 'module_signal_defs.bin';

let _dbPromise: Promise<any> | null = null;
let _flushTimer: ReturnType<typeof setInterval> | null = null;

function getDb(): Promise<any> {
  if (!_dbPromise) _dbPromise = indexedDBManager.initialize().then(() => (indexedDBManager as any).db);
  return _dbPromise;
}

const _fileInfoBatch: FileInfoRecord[] = [];

// Per-256-line byte offsets, buffered during parse and flushed ONCE to OPFS
// (source_line_index.bin) at the end of load. Keyed by file id for lazy reads.
const _lineIndexChunks: LineIndexChunk[] = [];
// Caches for the OPFS-backed line index (read lazily, one file at a time).
const _lineIndexBufferCache: Map<string, ArrayBuffer> = new Map();
const _lineIndexTocCache: Map<string, Map<number, { off: number; num: number }>> = new Map();
// Memory fallback when OPFS is unavailable (populated by writeLineIndexToOPFS).
const _lineIndexMemoryCache: Map<string, Map<number, number[]>> = new Map();

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
  const t0 = performance.now();
  try {
    const db = await getDb();
    if (!db) return;
    if (storeName === 'source-file-info') {
      // Bundle ALL metadata records into ONE put. This IDB backend costs ~0.4s
      // PER put() (measured ~240s for 483 records), so we must not write them
      // one-by-one. A single record (= one commit) is sub-second. The read
      // helper in indexedDB.ts unpacks the bundle by id. clear_kdb_data
      // truncates the store first, so keying the bundle by kdbId is unambiguous.
      const sample = batch[0] as any;
      const kdbId = (sample && sample.kdbId) || '';
      await db.put(storeName, { id: kdbId, kdbId, records: batch });
      if (typeof (indexedDBManager as any).setActiveKdb === 'function') {
        (indexedDBManager as any).setActiveKdb(kdbId);
      }
    } else {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const rec of batch) store.put(rec);
      await tx.done;
    }
    const count = (_flushCount[storeName] = (_flushCount[storeName] || 0) + 1);
    // Throttle logging: signal-insts flushes are very frequent (2M records),
    // so only log every 50th flush plus the final partial one. This keeps the
    // console readable and avoids the (non-trivial) cost of thousands of logs.
    if (count % 50 === 0 || batch.length < STORE_BATCH_SIZE) {
      console.log(
        `[${ts()}] [KdbStorage] Flushed ${batch.length} records to ${storeName} (batch #${count}) in ${(
          performance.now() - t0
        ).toFixed(0)}ms`,
      );
    }
    // Keep the main thread's heartbeat stall-timer alive during the long store.
    postWorkerHeartbeat();
    batch.length = 0;
  } finally {
    _flushing[storeName] = false;
  }
}

async function flushAllBatches(): Promise<void> {
  const nInfo = _fileInfoBatch.length;
  const t0 = performance.now();
  await Promise.all([
    flushBatch('source-file-info', _fileInfoBatch as any),
  ]);
  const dt = performance.now() - t0;
  if (dt > 50 || nInfo > 0) {
    console.log(
      `[${ts()}] [KdbStorage] flushAllBatches took ${dt.toFixed(0)}ms (info=${nInfo})`,
    );
  }
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
// Hook for the worker to flush the buffered line-index offsets to OPFS once,
// after parsing completes (replaces the source-file-line-index IDB store).
(self as any).__flushKdbLineIndex = writeLineIndexToOPFS;
// Reset in-memory write buffers at the start of a fresh load so a reused worker
// doesn't carry stale chunks/records from a previous (possibly aborted) load
// into the next KDB (the line-index binary is keyed by the worker's kdbId, so a
// stale chunk would otherwise be written under the wrong KDB).
function resetKdbBatches(): void {
  _fileInfoBatch.length = 0;
  _lineIndexChunks.length = 0;
}
(self as any).__resetKdbBatches = resetKdbBatches;


// Exposes IndexedDB operations to WASM as global functions
// Updated for new KDB structure (SignalDef + SignalInst split)

import { indexedDBManager } from './indexedDB';
import { isOpfsAvailable, globalMemoryStorage } from '../../utils/opfsUtils';
import type { Module, SignalDef } from '../../types/kdb';

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

// ------------------------------------------------------------------
// Concatenated source-content storage (see kdbDownload.worker.ts OPFSWriter).
//
// Instead of one OPFS file per source file (`file_${id}.content`), all source
// content is appended into a single `source_content.bin` with one fsync. A tiny
// `source_index.bin` records each file's [id, byteStart, byteLen]. We cache the
// index per KDB so reads don't re-parse it on every file access.
// ------------------------------------------------------------------
const _sourceIndexCache: Map<string, Map<number, { start: number; len: number }>> = new Map();

async function getSourceContentIndex(
  kdbId: string,
): Promise<Map<number, { start: number; len: number }> | null> {
  const cached = _sourceIndexCache.get(kdbId);
  if (cached) return cached;
  if (!isOpfsAvailable()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
    const fh = await kdbDir.getFileHandle('source_index.bin', { create: false });
    const file = await fh.getFile();
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const count = dv.getUint32(0, true);
    const map = new Map<number, { start: number; len: number }>();
    let off = 4;
    for (let i = 0; i < count; i++) {
      const id = dv.getUint32(off, true);
      const start = dv.getUint32(off + 4, true);
      const len = dv.getUint32(off + 8, true);
      map.set(id, { start, len });
      off += 12;
    }
    _sourceIndexCache.set(kdbId, map);
    return map;
  } catch {
    return null;
  }
}

/**
 * Read a byte range of a source file from OPFS. Prefers the concatenated
 * `source_content.bin` (new layout); falls back to the legacy per-file
 * `file_${id}.content` (main-thread store path / older data) when no index
 * entry exists. `endByte` may be Number.MAX_SAFE_INTEGER to read to EOF.
 */
async function readSourceFileBytes(
  kdbId: string,
  fileId: number,
  startByte: number,
  endByte: number,
): Promise<Uint8Array | null> {
  const index = await getSourceContentIndex(kdbId);
  const entry = index?.get(fileId);
  if (entry) {
    const absStart = entry.start + startByte;
    const absEnd = entry.start + Math.min(endByte, entry.start + entry.len);
    if (absEnd <= absStart) return new Uint8Array(0);
    const root = await navigator.storage.getDirectory();
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
    const fh = await kdbDir.getFileHandle('source_content.bin', { create: false });
    const file = await fh.getFile();
    const slice = file.slice(absStart, absEnd);
    return new Uint8Array(await slice.arrayBuffer());
  }
  // Legacy per-file fallback.
  const root = await navigator.storage.getDirectory();
  const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
  const fh = await kdbDir.getFileHandle(`file_${fileId}.content`, { create: false });
  const file = await fh.getFile();
  const slice = file.slice(startByte, endByte);
  return new Uint8Array(await slice.arrayBuffer());
}

/**
 * Write the buffered per-256-line byte offsets to OPFS as a single flat binary
 * (`source_line_index.bin`), replacing the old `source-file-line-index` IndexedDB
 * store. This removes a ~36 MB IDB blob (and the ~36 MB JS spike on first file
 * open) — exactly the same reasoning that moved source content + signals to OPFS.
 *
 * Layout (all little-endian u32):
 *   [ count ]
 *   [ TOC:  count × (id, dataOffset, numOffsets) ]   dataOffset = absolute byte
 *                                                      offset of this file's
 *                                                      offsets within the file
 *   [ DATA: concatenated u32 offsets, per file in order ]
 */
async function writeLineIndexToOPFS(kdbId: string): Promise<void> {
  if (_lineIndexChunks.length === 0) return;
  const chunks = _lineIndexChunks;
  const n = chunks.length;
  let totalOffsets = 0;
  for (const c of chunks) totalOffsets += c.offsets.length;
  const headerSize = 4 + n * 12;
  const fileSize = headerSize + totalOffsets * 4;
  const buf = new ArrayBuffer(fileSize);
  const dv = new DataView(buf);
  dv.setUint32(0, n, true);
  let tocOff = 4;
  let dataOff = headerSize;
  for (const c of chunks) {
    dv.setUint32(tocOff, c.id, true);
    dv.setUint32(tocOff + 4, dataOff, true);
    dv.setUint32(tocOff + 8, c.offsets.length, true);
    tocOff += 12;
    const offs = c.offsets;
    for (let k = 0; k < offs.length; k++) {
      dv.setUint32(dataOff + k * 4, offs[k] | 0, true);
    }
    dataOff += offs.length * 4;
  }

  const t0 = performance.now();
  if (!isOpfsAvailable()) {
    // No OPFS: keep the chunks in memory so reads still work (lost on reload).
    const map = new Map<number, number[]>();
    for (const c of chunks) map.set(c.id, c.offsets);
    _lineIndexMemoryCache.set(kdbId, map);
    _lineIndexChunks.length = 0;
    console.log(
      `[${ts()}] [KdbStorage] source_line_index kept in memory (no OPFS): ${n} files, ${totalOffsets} offsets`,
    );
    return;
  }

  const root = await navigator.storage.getDirectory();
  const kdbDir = await root.getDirectoryHandle(kdbId, { create: true });
  const fh: any = await kdbDir.getFileHandle('source_line_index.bin', { create: true });
  const isWorker = typeof (self as any).Window === 'undefined';
  if (isWorker && typeof fh.createSyncAccessHandle === 'function') {
    // Worker context: sync access handle is available and avoids the per-call
    // fsync cost of createWritable (same as source_content.bin).
    const handle: any = await fh.createSyncAccessHandle();
    handle.truncate(fileSize);
    handle.write(new Uint8Array(buf), { at: 0 });
    handle.flush();
    handle.close();
  } else {
    const writable = await fh.createWritable();
    await writable.write(new Uint8Array(buf));
    await writable.close();
  }
  const dt = performance.now() - t0;
  console.log(
    `[${ts()}] [KdbStorage] source_line_index.bin write: ${dt.toFixed(0)}ms, ${n} files, ` +
      `${totalOffsets} offsets, ${(fileSize / 1e6).toFixed(1)} MB`,
  );
  // Free the in-memory copy now that it is on disk.
  _lineIndexChunks.length = 0;
}

/**
 * Read the per-256-line byte offsets for a single source file from OPFS
 * (source_line_index.bin), lazily and cached per KDB. Only the TOC (a few KB for
 * hundreds of files) is materialised into JS; each file's offsets are returned as
 * a zero-copy Int32Array view over the cached file buffer, so opening one file
 * never loads the whole ~36 MB at once.
 */
async function getSourceLineIndex(kdbId: string, fileId: number): Promise<Int32Array | number[]> {
  // Memory fallback (no OPFS).
  const mem = _lineIndexMemoryCache.get(kdbId);
  if (mem) return mem.get(fileId) || [];

  let toc = _lineIndexTocCache.get(kdbId);
  let buffer = _lineIndexBufferCache.get(kdbId);
  if (!toc || !buffer) {
    if (!isOpfsAvailable()) return [];
    const root = await navigator.storage.getDirectory();
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
    const fh = await kdbDir.getFileHandle('source_line_index.bin', { create: false });
    const file = await fh.getFile();
    buffer = await file.arrayBuffer();
    const dv = new DataView(buffer);
    const n = dv.getUint32(0, true);
    toc = new Map<number, { off: number; num: number }>();
    let t = 4;
    for (let i = 0; i < n; i++) {
      const id = dv.getUint32(t, true);
      const dataOffset = dv.getUint32(t + 4, true);
      const num = dv.getUint32(t + 8, true);
      toc.set(id, { off: dataOffset, num });
      t += 12;
    }
    _lineIndexBufferCache.set(kdbId, buffer);
    _lineIndexTocCache.set(kdbId, toc);
  }
  const entry = toc.get(fileId);
  if (!entry) return [];
  return new Int32Array(buffer!, entry.off, entry.num);
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
 * Store the flat modules.bin buffer to OPFS. Called once by WASM. Mirrors
 * store_signals_opfs: WASM hands over the fully-serialized little-endian buffer
 * (see lib.rs) and we just write it to a single file. The module hierarchy that
 * used to live as ~125k IndexedDB records is now one OPFS file read at load time.
 * WASM calls: store_modules_opfs(bytes, kdbId)
 */
async function store_modules_opfs(bytes: Uint8Array, kdbId: string): Promise<void> {
  await writeOpfsBinary(kdbId, MODULES_BIN, bytes);
  postWorkerHeartbeat();
}

/**
 * Store the flat module_signal_defs.bin buffer to OPFS. Called once by WASM.
 * Heavy per-module signal definitions, range-readable by module id (see lib.rs).
 * WASM calls: store_signal_defs_opfs(bytes, kdbId)
 */
async function store_signal_defs_opfs(bytes: Uint8Array, kdbId: string): Promise<void> {
  await writeOpfsBinary(kdbId, MODULE_SIGNAL_DEFS_BIN, bytes);
  postWorkerHeartbeat();
}

/**
 * Parse modules.bin (skeleton table + child-id pool + name pool) into the
 * in-memory Module[] used by the navigation tree. One OPFS file read + a linear
 * parse replaces the previous ~125k IndexedDB record reads. signalDefs are left
 * empty here; they are fetched lazily per module via get_module_signal_defs.
 */
async function get_module_skeletons(kdbId: string): Promise<Module[]> {
  const buf = await readOpfsWhole(kdbId, MODULES_BIN);
  if (!buf) return [];
  const dv = new DataView(buf);
  const count = dv.getUint32(0, true);
  const namePoolOffset = dv.getUint32(4, true);
  const childPoolOffset = dv.getUint32(8, true);
  const decoder = new TextDecoder();
  const out: Module[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = 16 + i * 42;
    const nameOff = dv.getUint32(base, true);
    const nameLen = dv.getUint32(base + 4, true);
    const parentModuleId = dv.getUint32(base + 8, true);
    const hasDef = dv.getUint8(base + 12) !== 0;
    const defFileId = dv.getUint32(base + 13, true);
    const defStartLine = dv.getUint32(base + 17, true);
    const defEndLine = dv.getUint32(base + 21, true);
    const isInstance = dv.getUint8(base + 25) !== 0;
    const defModuleId = dv.getUint32(base + 26, true);
    const signalInstsStartId = dv.getUint32(base + 30, true);
    const childCount = dv.getUint32(base + 34, true);
    const childOff = dv.getUint32(base + 38, true);
    const name = decoder.decode(new Uint8Array(buf, namePoolOffset + nameOff, nameLen));
    const childModuleIds: number[] = new Array(childCount);
    for (let j = 0; j < childCount; j++) {
      childModuleIds[j] = dv.getUint32(childPoolOffset + (childOff + j) * 4, true);
    }
    const definition = hasDef
      ? { fileId: defFileId, startLine: defStartLine, endLine: defEndLine }
      : { fileId: 0, startLine: 0, endLine: 0 };
    out[i] = {
      name,
      parentModuleId,
      definition,
      signalDefs: [],
      isInstance,
      childModuleIds,
      defModuleId,
      signalInstsStartId,
    };
  }
  return out;
}

/**
 * Read one module's signal definitions lazily from module_signal_defs.bin.
 * Reads just the two relevant table entries + that module's region (a small
 * byte range), so the renderer never holds all ~2M SignalDef objects at once.
 */
async function get_module_signal_defs(moduleId: number, kdbId: string): Promise<SignalDef[]> {
  if (moduleId <= 0) return [];
  const header = await readOpfsRange(kdbId, MODULE_SIGNAL_DEFS_BIN, 0, 8);
  if (!header || header.byteLength < 8) return [];
  const hdv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const count = hdv.getUint32(0, true);
  // IMPORTANT: the header's second u32 is the start of the *regions* area (it is
  // named `table_offset` in lib.rs, but that is the regions base, NOT the table
  // base). The lookup table itself sits immediately after the 8-byte header, at
  // byte offset 8, and holds (count + 1) entries of (def_count:u32,
  // region_offset:u32). The region_offset values stored in the table are ABSOLUTE
  // file offsets, so they are used directly below.
  const regionsBase = hdv.getUint32(4, true);
  if (moduleId > count) return [];
  const idx = moduleId - 1;
  // Read two consecutive table entries (entry[idx] and entry[idx+1]) -> 16 bytes.
  const tbl = await readOpfsRange(
    kdbId,
    MODULE_SIGNAL_DEFS_BIN,
    8 + idx * 8,
    8 + (idx + 2) * 8,
  );
  if (!tbl || tbl.byteLength < 16) return [];
  const tdv = new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength);
  const regionStart = tdv.getUint32(4, true);
  const regionEnd = tdv.getUint32(12, true);
  const region = await readOpfsRange(kdbId, MODULE_SIGNAL_DEFS_BIN, regionStart, regionEnd);
  if (!region || region.byteLength < 8) return [];
  const rdv = new DataView(region.buffer, region.byteOffset, region.byteLength);
  const defCount = rdv.getUint32(0, true);
  const namePoolLen = rdv.getUint32(4, true);
  const decoder = new TextDecoder();
  const out: SignalDef[] = new Array(defCount);
  let recBase = 8 + namePoolLen;
  for (let i = 0; i < defCount; i++) {
    const nameOff = rdv.getUint32(recBase, true);
    const nameLen = rdv.getUint32(recBase + 4, true);
    const type = rdv.getInt32(recBase + 8, true);
    const hasDecl = rdv.getUint8(recBase + 12) !== 0;
    const declFileId = rdv.getUint32(recBase + 13, true);
    const declLine = rdv.getUint32(recBase + 17, true);
    const direction = rdv.getInt32(recBase + 21, true);
    const name = decoder.decode(new Uint8Array(region.buffer, region.byteOffset + 8 + nameOff, nameLen));
    const declaration = hasDecl ? { fileId: declFileId, line: declLine } : undefined;
    out[i] = { name, type, declaration, direction };
    recBase += 25;
  }
  return out;
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

  // Heavy per-256-line byte offsets — buffered for a single OPFS write at the
  // end of load (writeLineIndexToOPFS), NOT per-record IDB puts. Read back lazily
  // only when a file is actually opened for line seeking (getSourceLineIndex).
  _lineIndexChunks.push({ id, offsets: lineIndexOffset || [] });

  if (_fileInfoBatch.length >= STORE_BATCH_SIZE) {
    await flushBatch('source-file-info', _fileInfoBatch as any);
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
    const bytes = await readSourceFileBytes(kdbId, fileId, 0, Number.MAX_SAFE_INTEGER);
    if (!bytes) {
      console.error(`[KdbStorage] Source content not found for file ${fileId}`);
      return null;
    }
    return new TextDecoder().decode(bytes);
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
    const bytes = await readSourceFileBytes(kdbId, fileId, startByte, endByte);
    if (!bytes) throw new Error(`Source content not found for file ${fileId}`);
    return bytes;
  } catch (e) {
    console.error('[KdbStorage] Failed to get content by range from OPFS:', e);
    throw e;
  }
}

/**
 * Get source file content by line range using index offset
 * First gets the line_index_offset from OPFS (source_line_index.bin), then reads content from OPFS
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
  
  const fileInfo = await indexedDBManager.getSourceFileInfo(fileId, kdbId);
  if (!fileInfo || fileInfo.kdbId !== kdbId) {
    throw new Error(`File info not found: ${fileId}`);
  }
  
  // Per-256-line byte offsets live in OPFS (source_line_index.bin), read lazily
  // only when a file is actually opened for line seeking.
  const lineIndexOffset = await getSourceLineIndex(kdbId, fileId);
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
  
  // 3. Read content from OPFS (concatenated source_content.bin, or legacy per-file)
  const bytes = await readSourceFileBytes(kdbId, fileId, startByteOffset, Number.MAX_SAFE_INTEGER);
  if (!bytes) throw new Error(`Source content not found for file ${fileId}`);
  const content = bytes;
  
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
  // Drop any cached source-content offset index for this KDB so the next load
  // re-reads source_index.bin (or falls back to legacy per-file content).
  _sourceIndexCache.delete(kdbId);
  // Drop cached OPFS line-index state for this KDB (the OPFS dir itself is
  // removed below, which deletes source_line_index.bin).
  _lineIndexTocCache.delete(kdbId);
  _lineIndexBufferCache.delete(kdbId);
  _lineIndexMemoryCache.delete(kdbId);
  _lineIndexChunks.length = 0;
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
  // Note: signals/drivers and modules now live in OPFS (signals.bin/drivers.bin,
  // modules.bin/module_signal_defs.bin), removed together with the source-file
  // contents by the OPFS directory removal below.
  const stores = ['knowledge-base', 'source-file-info', 'source-file-line-index'];
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
  (window as any).store_signals_opfs = store_signals_opfs;
  (window as any).store_drivers_opfs = store_drivers_opfs;
  (window as any).store_modules_opfs = store_modules_opfs;
  (window as any).store_signal_defs_opfs = store_signal_defs_opfs;
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
  store_signals_opfs,
  store_drivers_opfs,
  store_modules_opfs,
  store_signal_defs_opfs,
  get_signals_buffer,
  get_drivers_by_range,
  get_module_skeletons,
  get_module_signal_defs,
  store_source_file_info,
  store_source_file_content_opfs,
  get_source_file_content,
  get_source_file_content_by_range,
  get_source_file_lines_by_range,
  clear_kdb_data,
};
