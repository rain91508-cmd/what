// ============================================
// KDB Download Worker
// ============================================
// Implements streaming download + zstd decompression + batch storage
// Following the architecture from hint7.md
//
// Pipeline:
// Main Thread -> Worker -> fetch stream -> zstd decode -> batch metadata write + stream content write
//
// Key optimizations:
// - Streaming: Data flows as chunks, never whole file in memory
// - Worker: All processing off main thread
// - Batch: Metadata writes batched (100 items per transaction)
// - Concurrency: Limited concurrent OPFS writes (4 concurrent)
// - Resume: Supports download resume with Range requests
// - Stall detection: Auto-retry on stalled downloads

import { openDB, DBSchema, IDBPDatabase } from 'idb';

// Import storage functions that WASM needs
// These are exposed to window (which is aliased to self in this Worker)
import {
  store_knowledge_base,
  store_modules_opfs,
  store_signal_defs_opfs,
  store_signals_opfs,
  store_drivers_opfs,
  store_source_file_info,
  get_source_file_content_by_range,
  clear_kdb_data,
  postWorkerHeartbeat,
} from '../core/storage/kdbStorage';

// Create window alias for self (Worker global scope)
// This is needed because wasm-bindgen generates code that uses window.*
(self as any).window = self;

// Format current time as HH:MM:SS.mmm for timestamping store-step logs.
function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// Storage functions will be set up after OPFSWriter initialization
// This allows us to use OPFSWriter for file storage when OPFS is not available

// Expose storage functions to Worker global scope (self)
// WASM will access these via window.* (which we alias to self)
(self as any).store_knowledge_base = store_knowledge_base;
(self as any).store_modules_opfs = store_modules_opfs;
(self as any).store_signal_defs_opfs = store_signal_defs_opfs;
(self as any).store_signals_opfs = store_signals_opfs;
(self as any).store_drivers_opfs = store_drivers_opfs;
(self as any).store_source_file_info = store_source_file_info;
// store_source_file_content_opfs will be set after OPFSWriter init
(self as any).get_source_file_content_by_range = get_source_file_content_by_range;
(self as any).clear_kdb_data = clear_kdb_data;

// WASM (parse_and_store_kdb) calls this at each discrete "unpacking to local
// storage" step so the UI can show granular progress (e.g. "Step 4/6: Storing
// 1234 source files"). We forward it as a normal 'storing' progress message.
// This bypasses updateProgress()'s 5s throttle on purpose: step boundaries are
// infrequent and each one should be shown immediately. loaded/total carry the
// step index / step count so the UI can render "Step X/N".
(self as any).report_kdb_progress = (step: number, total: number, message: string) => {
  postMessage({
    type: 'progress',
    phase: 'storing',
    loaded: step,
    total,
    message: `Step ${step}/${total}: ${message}`,
  } as KDBProgressMessage);
};

// WASM calls this from inside its long synchronous serialization loops (modules
// / signal defs / signals / drivers) to keep the main thread's worker-stall
// watchdog alive. postWorkerHeartbeat posts a 'heartbeat' to the main thread,
// which re-arms the timeout — and crucially, that postMessage is delivered even
// while the worker is CPU-bound in a tight WASM loop (no yield required). The
// 2s throttle inside it bounds how often we actually send.
(self as any).report_heartbeat = () => {
  postWorkerHeartbeat();
};

/**
 * Setup storage functions with OPFSWriter integration
 * This is called after OPFSWriter is initialized
 */
function setupStorageFunctions(writer: OPFSWriter) {
  // Override store_source_file_content_opfs to use OPFSWriter
  // This ensures files are properly queued for postMessage fallback if needed
  (self as any).store_source_file_content_opfs = async (id: number, content: Uint8Array, _kdbId: string) => {
    // Fire-and-forget with a copy: WASM owns the bytes we are handed (a view
    // into its linear memory) and frees them as soon as this call returns, so
    // we MUST copy before letting the write run in the background.
    // OPFSWriter appends every source file into a single source_content.bin
    // stream and closes it once (a single fsync) instead of writing each file
    // to its own `file_${id}.content` (createWritable -> write -> close per
    // file, close fsyncs). The old per-file approach stalled "Step 4: Storing
    // source files" for minutes on large designs. The worker calls
    // opfsWriter.waitForAll() after parse_and_store_kdb to guarantee every
    // file is physically written before completion is reported.
    writer.writeFile(id, new Uint8Array(content)).catch((e) => {
      console.error(`[KDBWorker] Source file content write failed for id ${id}:`, e);
    });
    return;
  };
  
  console.log('[KDBWorker] Storage functions setup complete');
}

// ============================================
// Types
// ============================================

interface KDBDownloadMessage {
  type: 'start' | 'cancel' | 'startUrl' | 'startBytes';
  kdbName?: string;
  baseUrl?: string;
  kdbId?: string;
  url?: string;
  bytes?: Uint8Array;
}

interface KDBProgressMessage {
  type: 'progress';
  phase: 'downloading' | 'decompressing' | 'storing' | 'retrying';
  loaded: number;
  total: number;
  message: string;
  speed?: number; // bytes per second
  eta?: number; // estimated time remaining in seconds
}

interface KDBHeartbeatMessage {
  type: 'heartbeat';
  timestamp: number;
  loaded: number;
  total: number;
  phase: string;
}

interface KDBCompleteMessage {
  type: 'complete';
  designName: string;
  moduleCount: number;
  signalCount: number;
  fileCount: number;
  pendingFiles?: Array<{ fileId: number; content: Uint8Array }>; // For OPFS fallback
  kdbId?: string; // For OPFS fallback
}

interface KDBErrorMessage {
  type: 'error';
  error: string;
  canRetry?: boolean;
}

// IndexedDB Schema for metadata batch writes
interface KDBWorkerSchema extends DBSchema {
  'knowledge-base': {
    key: string;
    value: {
      id: string;
      designName: string;
      version: string;
      timestamp: number;
      moduleCount: number;
      signalCount: number;
      fileCount: number;
      hierarchy: unknown;
    };
  };
  'source-file-info': {
    key: number;
    value: {
      id: number;
      path: string;
      name: string;
      fullName: string;
      totalLines: number;
      kdbId: string;
    };
    indexes: { 'by-kdb': string };
  };
  // Heavy per-256-line byte offsets, stored separately so the Files tab never loads them.
  'source-file-line-index': {
    key: number;
    value: {
      id: number;
      lineIndexOffset: number[];
      kdbId: string;
    };
    indexes: { 'by-kdb': string };
  };
}

// ============================================
// Constants
// ============================================

const DB_NAME = 'hwda-database';
const DB_VERSION = 6;
const BATCH_SIZE = 100; // Batch size for metadata writes
const CWDK_MAGIC = 0x4B445743; // "CWDK" in little-endian

// Download resume and stall detection constants
const STALL_TIMEOUT = 30000; // 30 seconds without progress = stalled
const HEARTBEAT_INTERVAL = 5000; // Send heartbeat every 5 seconds
const MAX_RETRIES = 3; // Max retry attempts
const RETRY_DELAY = 2000; // Delay between retries (ms)
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks for resume

// ============================================
// Download State Management
// ============================================

interface DownloadState {
  kdbName: string;
  baseUrl: string;
  kdbId: string;
  totalSize: number;
  downloaded: number;
  lastProgressTime: number;
  lastProgressBytes: number;
  retryCount: number;
  isCancelled: boolean;
  phase: 'downloading' | 'decompressing' | 'storing' | 'retrying';
  speedHistory: number[]; // For calculating average speed
  lastProgressPercent: number; // Percent of the last SENT progress message
}

let currentDownload: DownloadState | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// ============================================
// Zstd Decompression (using WebAssembly)
// ============================================

// Import the WASM module dynamically
let wasmModule: typeof import('../../wasm-pkg/hwda_wasm') | null = null;

async function initWasm(): Promise<void> {
  if (wasmModule) return;
  
  try {
    wasmModule = await import('../../wasm-pkg/hwda_wasm');
    await wasmModule.default();
    console.log('[KDBWorker] WASM initialized');
  } catch (error) {
    console.error('[KDBWorker] Failed to initialize WASM:', error);
    throw error;
  }
}

// ============================================
// OPFS Operations (Streaming Write with Concurrency Control)
// ============================================

// KDB unpacked data lives under a `kdb/` subfolder in OPFS so it is clearly
// separated from the `wave_cache` directory used for waveform data.
async function getKdbDir(
  root: FileSystemDirectoryHandle,
  kdbId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  const kdbParent = await root.getDirectoryHandle('kdb', { create });
  return await kdbParent.getDirectoryHandle(kdbId, { create });
}

class OPFSWriter {
  private kdbId: string = '';
  private usePostMessageFallback = false;
  private pendingFiles: Map<number, Uint8Array> = new Map();

  // ------------------------------------------------------------------
  // Buffer ALL source-file content in memory during parse, then write it in
  // ONE shot at the end via a synchronous access handle.
  //
  // The previous two attempts both stalled ~4 minutes on C910:
  //   1) one OPFS file per source file (createWritable -> write -> close per
  //      file): 483 close() fsyncs.
  //   2) one append stream with 483 serialized contentWritable.write() calls:
  //      in this OPFS backend each write() also costs ~0.5s (it fsyncs or
  //      otherwise blocks per call), so 483 writes == the same ~4 min.
  //
  // A FileSystemSyncAccessHandle does NOT fsync on every write — write() is a
  // synchronous memcpy into the OS page cache and flush() persists once. So we
  // record each file's [id, start, len] here (in memory) and, in waitForAll(),
  // open a sync handle and write the whole blob with one flush(). Source content
  // is only ~20MB for C910, so holding it in memory during parse is cheap.
  // ------------------------------------------------------------------
  private contentChunks: Uint8Array[] = []; // one entry per source file, append order
  private contentIndex: number[] = []; // flattened: [id, start, len, ...]
  private contentTotal = 0;

  async init(kdbId: string): Promise<void> {
    this.kdbId = kdbId;

    // Check if OPFS is available in this context
    if (typeof navigator.storage === 'undefined' || !navigator.storage.getDirectory) {
      console.warn('[KDBWorker] OPFS not available in Worker, will use postMessage fallback');
      this.usePostMessageFallback = true;
      return;
    }

    console.log('[KDBWorker] OPFS available, directory will be created on first write:', kdbId);
  }

  async writeFile(fileId: number, content: Uint8Array): Promise<void> {
    // Use postMessage fallback if OPFS is not available
    if (this.usePostMessageFallback) {
      // Store file content temporarily, will send to main thread at the end
      this.pendingFiles.set(fileId, new Uint8Array(content));
      return;
    }

    // Copy out of WASM linear memory immediately (WASM frees the bytes on
    // return). Just buffer in memory; the actual OPFS write happens once in
    // waitForAll() via a sync access handle.
    const copy = new Uint8Array(content);
    this.contentIndex.push(fileId, this.contentTotal, copy.byteLength);
    this.contentTotal += copy.byteLength;
    this.contentChunks.push(copy);
  }

  /**
   * Get all pending files for postMessage fallback
   * Called at the end of download to send files to main thread
   */
  getPendingFiles(): Map<number, Uint8Array> {
    return this.pendingFiles;
  }

  /**
   * Check if using postMessage fallback
   */
  isUsingFallback(): boolean {
    return this.usePostMessageFallback;
  }

  async waitForAll(): Promise<void> {
    if (this.usePostMessageFallback) return;

    const t0 = performance.now();
    const root = await navigator.storage.getDirectory();
    const kdbDir: any = await getKdbDir(root, this.kdbId, true);
    const fh: any = await kdbDir.getFileHandle('source_content.bin', { create: true });
    const handle: any = await fh.createSyncAccessHandle();
    const tOpen = performance.now();

    handle.truncate(this.contentTotal);
    let pos = 0;
    for (let i = 0; i < this.contentChunks.length; i++) {
      const chunk = this.contentChunks[i];
      handle.write(chunk, { at: pos });
      pos += chunk.byteLength;
    }
    const tWrite = performance.now();
    handle.flush();
    const tFlush = performance.now();
    handle.close();
    const tClose = performance.now();

    // Free the in-memory copy now that it is on disk.
    this.contentChunks = [];

    console.log(
      `[${ts()}] [KDBWorker] source_content.bin write: open=${(tOpen - t0).toFixed(0)}ms ` +
        `write=${(tWrite - tOpen).toFixed(0)}ms flush=${(tFlush - tWrite).toFixed(0)}ms ` +
        `close=${(tClose - tFlush).toFixed(0)}ms  ${this.contentTotal} bytes, ` +
        `${this.contentIndex.length / 3} files`,
    );

    await this.writeIndex(kdbDir);
  }

  private async writeIndex(kdbDir: any): Promise<void> {
    const count = this.contentIndex.length / 3;
    const buf = new ArrayBuffer(4 + count * 12);
    const dv = new DataView(buf);
    dv.setUint32(0, count, true);
    let off = 4;
    for (let i = 0; i < count; i++) {
      dv.setUint32(off, this.contentIndex[i * 3], true);
      dv.setUint32(off + 4, this.contentIndex[i * 3 + 1], true);
      dv.setUint32(off + 8, this.contentIndex[i * 3 + 2], true);
      off += 12;
    }
    const fh: any = await kdbDir.getFileHandle('source_index.bin', { create: true });
    const writable = await fh.createWritable();
    await writable.write(new Uint8Array(buf));
    await writable.close();
    console.log(`[${ts()}] [KDBWorker] Wrote source index: ${count} files`);
  }
}

// ============================================
// Progress Tracking & Heartbeat
// ============================================

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  
  heartbeatTimer = setInterval(() => {
    if (currentDownload) {
      postMessage({
        type: 'heartbeat',
        timestamp: Date.now(),
        loaded: currentDownload.downloaded,
        total: currentDownload.totalSize,
        phase: currentDownload.phase,
      } as KDBHeartbeatMessage);
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Minimum time between progress updates (ms). Kept for stable speed/ETA
// sampling — but progress is ALSO sent whenever it advances by at least
// MIN_PROGRESS_PERCENT, so a fast download still shows a smooth count-up
// instead of jumping (e.g. 10% -> 90%).
const MIN_PROGRESS_INTERVAL = 5000; // 5 seconds
const MIN_PROGRESS_PERCENT = 5; // send if advanced >= 5% since last message

function updateProgress(
  loaded: number,
  total: number,
  phase: DownloadState['phase'],
  message: string,
  force: boolean = false
): void {
  if (!currentDownload) return;
  
  const now = Date.now();
  const timeDelta = now - currentDownload.lastProgressTime;
  const percent = total > 0 ? (loaded / total) * 100 : 0;
  const percentDelta = Math.abs(percent - currentDownload.lastProgressPercent);
  
  // Only update if enough time OR visible progress has passed, or forced.
  if (!force && timeDelta < MIN_PROGRESS_INTERVAL && percentDelta < MIN_PROGRESS_PERCENT) {
    // Still update the downloaded count, but don't send message
    currentDownload.downloaded = loaded;
    return;
  }
  
  const bytesDelta = loaded - currentDownload.lastProgressBytes;
  
  // Calculate speed (bytes per second)
  let speed = 0;
  if (timeDelta > 0) {
    speed = (bytesDelta / timeDelta) * 1000;
    currentDownload.speedHistory.push(speed);
    // Keep last 5 speed samples for averaging
    if (currentDownload.speedHistory.length > 5) {
      currentDownload.speedHistory.shift();
    }
  }
  
  // Calculate average speed
  const avgSpeed = currentDownload.speedHistory.length > 0
    ? currentDownload.speedHistory.reduce((a, b) => a + b, 0) / currentDownload.speedHistory.length
    : 0;
  
  // Calculate ETA
  const remaining = total - loaded;
  const eta = avgSpeed > 0 ? remaining / avgSpeed : 0;
  
  // Update state
  currentDownload.downloaded = loaded;
  currentDownload.lastProgressTime = now;
  currentDownload.lastProgressBytes = loaded;
  currentDownload.lastProgressPercent = percent;
  currentDownload.phase = phase;
  
  postMessage({
    type: 'progress',
    phase,
    loaded,
    total,
    message,
    speed: Math.round(avgSpeed),
    eta: Math.round(eta),
  } as KDBProgressMessage);
}

// ============================================
// Download with Resume & Stall Detection
// ============================================

async function downloadWithResume(
  kdbName: string,
  baseUrl: string,
  totalSize: number
): Promise<Uint8Array> {
  if (!currentDownload) throw new Error('Download not initialized');
  
  const chunks: Uint8Array[] = [];
  let downloaded = currentDownload.downloaded;
  let lastChunkTime = Date.now();
  
  // Check if server supports Range requests (for resume)
  const supportsRange = await checkRangeSupport(baseUrl, kdbName);
  
  while (downloaded < totalSize) {
    // Check if cancelled
    if (currentDownload.isCancelled) {
      throw new Error('Download cancelled');
    }
    
    // Check for stall
    const timeSinceLastChunk = Date.now() - lastChunkTime;
    if (timeSinceLastChunk > STALL_TIMEOUT) {
      console.warn(`[KDBWorker] Download stalled at ${downloaded} bytes`);
      
      if (currentDownload.retryCount < MAX_RETRIES) {
        currentDownload.retryCount++;
        updateProgress(
          downloaded,
          totalSize,
          'retrying',
          `Download stalled, retrying (${currentDownload.retryCount}/${MAX_RETRIES})...`
        );
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        lastChunkTime = Date.now(); // Reset timer
        continue; // Retry from current position
      } else {
        throw new Error(`Download stalled after ${MAX_RETRIES} retries`);
      }
    }
    
    try {
      // Calculate chunk range
      const start = downloaded;
      const end = Math.min(downloaded + CHUNK_SIZE - 1, totalSize - 1);
      
      // Fetch chunk (with Range header if supported)
      const headers: HeadersInit = {};
      if (supportsRange && downloaded > 0) {
        headers['Range'] = `bytes=${start}-${end}`;
      }
      
      const response = await fetch(`${baseUrl}/api/kdb/${kdbName}/file`, { headers });
      
      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      if (!response.body) {
        throw new Error('No response body');
      }
      
      // Read stream with stall detection
      const reader = response.body.getReader();
      
      try {
        while (true) {
          // Check for stall during read
          const readPromise = reader.read();
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Read timeout')), STALL_TIMEOUT);
          });
          
          const { done, value } = await Promise.race([readPromise, timeoutPromise]);
          
          if (done) break;
          if (!value) continue;
          
          chunks.push(value);
          downloaded += value.length;
          lastChunkTime = Date.now();
          
          // Reset retry count on successful progress
          currentDownload.retryCount = 0;
          
          // Update progress
          updateProgress(
            downloaded,
            totalSize,
            'downloading',
            `Downloaded ${(downloaded / 1024 / 1024).toFixed(2)} MB / ${(totalSize / 1024 / 1024).toFixed(2)} MB`
          );
        }
      } finally {
        reader.releaseLock();
      }
      
      // If server doesn't support Range, we got the whole file
      if (!supportsRange) {
        break;
      }
      
    } catch (error) {
      console.error('[KDBWorker] Download error:', error);
      
      if (currentDownload.retryCount < MAX_RETRIES) {
        currentDownload.retryCount++;
        updateProgress(
          downloaded,
          totalSize,
          'retrying',
          `Download error: ${error instanceof Error ? error.message : 'Unknown error'}, retrying (${currentDownload.retryCount}/${MAX_RETRIES})...`
        );
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        lastChunkTime = Date.now();
      } else {
        throw error;
      }
    }
  }
  
  // Combine all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let position = 0;
  
  for (const chunk of chunks) {
    combined.set(chunk, position);
    position += chunk.length;
  }
  
  return combined;
}

async function checkRangeSupport(baseUrl: string, kdbName: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/kdb/${kdbName}/file`, {
      method: 'HEAD',
    });
    
    // Check if Accept-Ranges header is present
    const acceptRanges = response.headers.get('Accept-Ranges');
    return acceptRanges === 'bytes';
  } catch {
    return false;
  }
}

// ============================================
// Main Worker Logic
// ============================================

// Decompress + store a raw .kdb byte buffer into OPFS/IndexedDB. Shared by all
// three ingestion paths (server download, URL fetch, local file bytes). Assumes
// `currentDownload` is already set (for progress reporting) and sets up its own
// OPFSWriter. Throws on any failure so the caller can surface an error message.
async function storeKdbBytesInStorage(
  kdbData: Uint8Array,
  kdbId: string
): Promise<void> {
  const opfsWriter = new OPFSWriter();

  // Initialize storage
  await opfsWriter.init(kdbId);

  // Setup storage functions with OPFSWriter integration
  // This ensures store_source_file_content_opfs uses OPFSWriter for proper fallback handling
  setupStorageFunctions(opfsWriter);

  // Check magic number
  if (kdbData.length < 8) {
    throw new Error('KDB file too small');
  }

  const magic = new DataView(kdbData.buffer).getUint32(0, true);
  if (magic !== CWDK_MAGIC) {
    throw new Error(`Invalid magic: 0x${magic.toString(16)}`);
  }

  // Report storing phase (download is already at 100% from downloadWithResume)
  updateProgress(kdbData.length, kdbData.length, 'storing', 'Decompressing and storing...', true);

  await initWasm();

  if (!wasmModule) {
    throw new Error('WASM not initialized');
  }

  // Call WASM to parse and store
  if ((self as any).__resetKdbBatches) (self as any).__resetKdbBatches();
  const designName = await wasmModule.parse_and_store_kdb(kdbId, kdbData);

  if (!designName) {
    throw new Error('Failed to parse KDB');
  }

  // Source-file content writes are buffered in memory during parse and written
  // in one shot here (single sync access handle). Wait for it to finish so we
  // never report completion before the files are physically on disk.
  const tw0 = performance.now();
  await opfsWriter.waitForAll();
  console.log(`[${ts()}] [KDBWorker] waitForAll (source_content.bin) took ${(performance.now() - tw0).toFixed(0)}ms`);

  // Flush the per-256-line byte offsets to OPFS as source_line_index.bin (one
  // flat binary; replaces the old source-file-line-index IDB store).
  const tl0 = performance.now();
  if ((self as any).__flushKdbLineIndex) {
    await (self as any).__flushKdbLineIndex(kdbId);
  }
  console.log(`[${ts()}] [KDBWorker] __flushKdbLineIndex (OPFS) took ${(performance.now() - tl0).toFixed(0)}ms`);

  // Flush any buffered IndexedDB records (the per-record store_* calls
  // batch writes; the final partial batch must be flushed before we
  // report completion).
  const tf0 = performance.now();
  if ((self as any).__flushKdbBatches) {
    await (self as any).__flushKdbBatches();
  }
  console.log(`[${ts()}] [KDBWorker] __flushKdbBatches (IDB) took ${(performance.now() - tf0).toFixed(0)}ms`);

  stopHeartbeat();

  // Check if we need to send files to main thread (OPFS fallback)
  const pendingFiles = opfsWriter.isUsingFallback()
    ? Array.from(opfsWriter.getPendingFiles().entries()).map(([fileId, content]) => ({ fileId, content }))
    : undefined;

  if (pendingFiles && pendingFiles.length > 0) {
    console.log(`[${ts()}] [KDBWorker] Sending ${pendingFiles.length} files to main thread for storage`);

    // Use Transferable Objects to avoid copying large data
    // Extract Uint8Arrays for transfer
    const transferableArrays: Transferable[] = [];
    for (const file of pendingFiles) {
      if (file.content.buffer) {
        transferableArrays.push(file.content.buffer as ArrayBuffer);
      }
    }

    (self as any).postMessage({
      type: 'complete',
      designName,
      moduleCount: 0, // TODO: Get actual counts from WASM
      signalCount: 0,
      fileCount: 0,
      pendingFiles,
      kdbId,
    } as KDBCompleteMessage, transferableArrays);
  } else {
    postMessage({
      type: 'complete',
      designName,
      moduleCount: 0, // TODO: Get actual counts from WASM
      signalCount: 0,
      fileCount: 0,
    } as KDBCompleteMessage);
  }
}

async function downloadAndStoreKDB(
  kdbName: string,
  baseUrl: string,
  kdbId: string
): Promise<void> {
  // Initialize download state
  currentDownload = {
    kdbName,
    baseUrl,
    kdbId,
    totalSize: 0,
    downloaded: 0,
    lastProgressTime: Date.now(),
    lastProgressBytes: 0,
    retryCount: 0,
    isCancelled: false,
    phase: 'downloading',
    speedHistory: [],
    lastProgressPercent: 0,
  };

  // Start heartbeat
  startHeartbeat();

  try {
    // Get file info first
    const infoResponse = await fetch(`${baseUrl}/api/kdb/${kdbName}`);
    if (!infoResponse.ok) {
      throw new Error(`Failed to get KDB info: ${infoResponse.status}`);
    }

    const info = await infoResponse.json();
    const totalSize = info.data.kdb_info.file_size;
    currentDownload.totalSize = totalSize;

    updateProgress(0, totalSize, 'downloading', 'Starting download...', true);

    // Download with resume and stall detection
    const kdbData = await downloadWithResume(kdbName, baseUrl, totalSize);

    await storeKdbBytesInStorage(kdbData, kdbId);
  } catch (error) {
    stopHeartbeat();

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const canRetry = currentDownload ? currentDownload.retryCount < MAX_RETRIES : false;

    postMessage({
      type: 'error',
      error: errorMessage,
      canRetry,
    } as KDBErrorMessage);
  } finally {
    currentDownload = null;
  }
}

// Fetch a raw .kdb from an arbitrary URL (option A from the user: a direct URL
// to a .kdb file) and store it via the shared pipeline. Subject to browser
// CORS — the target host must allow cross-origin fetches.
async function downloadFromUrlAndStore(
  url: string,
  kdbId: string
): Promise<void> {
  currentDownload = {
    kdbName: url,
    baseUrl: '',
    kdbId,
    totalSize: 0,
    downloaded: 0,
    lastProgressTime: Date.now(),
    lastProgressBytes: 0,
    retryCount: 0,
    isCancelled: false,
    phase: 'downloading',
    speedHistory: [],
    lastProgressPercent: 0,
  };

  startHeartbeat();

  try {
    updateProgress(0, 0, 'downloading', `Fetching ${url}...`, true);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch KDB: HTTP ${response.status}`);
    }

    const kdbData = new Uint8Array(await response.arrayBuffer());
    currentDownload.totalSize = kdbData.length;

    await storeKdbBytesInStorage(kdbData, kdbId);
  } catch (error) {
    stopHeartbeat();

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    postMessage({
      type: 'error',
      error: errorMessage,
    } as KDBErrorMessage);
  } finally {
    currentDownload = null;
  }
}

// Store a raw .kdb provided as in-memory bytes (e.g. a local file picked from
// disk) via the shared pipeline. The buffer is transferred (not copied) from
// the main thread.
async function storeFromBytesAndStore(
  bytes: Uint8Array,
  kdbId: string
): Promise<void> {
  currentDownload = {
    kdbName: kdbId,
    baseUrl: '',
    kdbId,
    totalSize: bytes.length,
    downloaded: 0,
    lastProgressTime: Date.now(),
    lastProgressBytes: 0,
    retryCount: 0,
    isCancelled: false,
    phase: 'storing',
    speedHistory: [],
    lastProgressPercent: 0,
  };

  startHeartbeat();

  try {
    await storeKdbBytesInStorage(bytes, kdbId);
  } catch (error) {
    stopHeartbeat();

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    postMessage({
      type: 'error',
      error: errorMessage,
    } as KDBErrorMessage);
  } finally {
    currentDownload = null;
  }
}

// ============================================
// Worker Message Handler
// ============================================

self.onmessage = async (event: MessageEvent<KDBDownloadMessage>) => {
  const { type, kdbName, baseUrl, kdbId, url, bytes } = event.data;
  
  if (type === 'start' && kdbName && baseUrl && kdbId) {
    await downloadAndStoreKDB(kdbName, baseUrl, kdbId);
  } else if (type === 'startUrl' && url && kdbId) {
    await downloadFromUrlAndStore(url, kdbId);
  } else if (type === 'startBytes' && bytes && kdbId) {
    await storeFromBytesAndStore(bytes, kdbId);
  } else if (type === 'cancel') {
    if (currentDownload) {
      currentDownload.isCancelled = true;
    }
  }
};

export {};
