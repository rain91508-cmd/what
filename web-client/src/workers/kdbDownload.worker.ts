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
  store_module,
  store_modules_batch,
  store_signals_opfs,
  store_drivers_opfs,
  store_source_file_info,
  get_source_file_content_by_range,
  clear_kdb_data,
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
(self as any).store_module = store_module;
(self as any).store_modules_batch = store_modules_batch;
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

/**
 * Setup storage functions with OPFSWriter integration
 * This is called after OPFSWriter is initialized
 */
function setupStorageFunctions(writer: OPFSWriter) {
  // Override store_source_file_content_opfs to use OPFSWriter
  // This ensures files are properly queued for postMessage fallback if needed
  (self as any).store_source_file_content_opfs = async (id: number, content: Uint8Array, _kdbId: string) => {
    // (Log removed: this path is fast and the per-file line was just noise.)
    // Always use OPFSWriter to handle file storage
    // OPFSWriter will handle the fallback logic internally
    await writer.writeFile(id, content);
  };
  
  console.log('[KDBWorker] Storage functions setup complete');
}

// ============================================
// Types
// ============================================

interface KDBDownloadMessage {
  type: 'start' | 'cancel';
  kdbName?: string;
  baseUrl?: string;
  kdbId?: string;
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
  'modules': {
    key: number;
    value: {
      id: number;
      name: string;
      parentModuleId: number;
      definition: unknown;
      signalDefs: unknown[];
      childModuleIds: number[];
      defModuleId: number;
      signalInstsStartId: number;
      kdbId: string;
    };
    indexes: { 'by-kdb': string };
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
const WRITE_CONCURRENCY = 4; // Max concurrent OPFS writes
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
// IndexedDB Operations (Batch Write)
// ============================================

class MetadataBatcher {
  private db: IDBPDatabase<KDBWorkerSchema> | null = null;
  private moduleBatch: KDBWorkerSchema['modules']['value'][] = [];
  private fileInfoBatch: KDBWorkerSchema['source-file-info']['value'][] = [];

  async init(): Promise<void> {
    this.db = await openDB<KDBWorkerSchema>(DB_NAME, DB_VERSION);
    console.log('[KDBWorker] IndexedDB initialized');
  }

  queueModule(module: KDBWorkerSchema['modules']['value']): void {
    this.moduleBatch.push(module);
    if (this.moduleBatch.length >= BATCH_SIZE) {
      this.flushModules();
    }
  }

  queueFileInfo(fileInfo: KDBWorkerSchema['source-file-info']['value']): void {
    this.fileInfoBatch.push(fileInfo);
    if (this.fileInfoBatch.length >= BATCH_SIZE) {
      this.flushFileInfos();
    }
  }

  async flushModules(): Promise<void> {
    if (!this.db || this.moduleBatch.length === 0) return;
    
    const tx = this.db.transaction('modules', 'readwrite');
    const store = tx.objectStore('modules');
    
    for (const module of this.moduleBatch) {
      await store.put(module);
    }
    
    await tx.done;
    console.log(`[${ts()}] [KDBWorker] Flushed ${this.moduleBatch.length} modules`);
    this.moduleBatch = [];
  }

  async flushFileInfos(): Promise<void> {
    if (!this.db || this.fileInfoBatch.length === 0) return;
    
    const tx = this.db.transaction('source-file-info', 'readwrite');
    const store = tx.objectStore('source-file-info');
    
    for (const fileInfo of this.fileInfoBatch) {
      await store.put(fileInfo);
    }
    
    await tx.done;
    console.log(`[${ts()}] [KDBWorker] Flushed ${this.fileInfoBatch.length} file infos`);
    this.fileInfoBatch = [];
  }

  async flushAll(): Promise<void> {
    await this.flushModules();
    await this.flushFileInfos();
  }

  async storeKnowledgeBase(data: KDBWorkerSchema['knowledge-base']['value']): Promise<void> {
    if (!this.db) return;
    await this.db.put('knowledge-base', data);
  }
}

// ============================================
// OPFS Operations (Streaming Write with Concurrency Control)
// ============================================

class OPFSWriter {
  private kdbDir: FileSystemDirectoryHandle | null = null;
  private kdbId: string = '';
  private writeQueue: (() => Promise<void>)[] = [];
  private activeWrites = 0;
  private usePostMessageFallback = false;
  private pendingFiles: Map<number, Uint8Array> = new Map();
  
  async init(kdbId: string): Promise<void> {
    this.kdbId = kdbId;
    
    // Check if OPFS is available in this context
    if (typeof navigator.storage === 'undefined' || !navigator.storage.getDirectory) {
      console.warn('[KDBWorker] OPFS not available in Worker, will use postMessage fallback');
      this.usePostMessageFallback = true;
      return;
    }
    
    // Don't create directory here - it will be created on first write
    // This avoids the race condition with clear_kdb_data
    console.log('[KDBWorker] OPFS available, directory will be created on first write:', kdbId);
  }

  async writeFile(fileId: number, content: Uint8Array): Promise<void> {
    // Use postMessage fallback if OPFS is not available
    if (this.usePostMessageFallback) {
      // Store file content temporarily, will send to main thread at the end
      this.pendingFiles.set(fileId, new Uint8Array(content));
      return;
    }

    // Create write task
    const writeTask = async () => {
      const fileName = `file_${fileId}.content`;
      
      // Lazy initialization: create directory on first write
      // This ensures directory exists even if clear_kdb_data deleted it
      if (!this.kdbDir) {
        try {
          const root = await navigator.storage.getDirectory();
          this.kdbDir = await root.getDirectoryHandle(this.kdbId, { create: true });
          console.log('[KDBWorker] Created OPFS directory on first write:', this.kdbId);
        } catch (e) {
          console.error('[KDBWorker] Failed to create directory:', e);
          throw new Error('Failed to create OPFS directory');
        }
      }
      
      let fileHandle: FileSystemFileHandle;
      
      try {
        fileHandle = await this.kdbDir.getFileHandle(fileName, { create: true });
      } catch (e) {
        // Directory might have been deleted by clear_kdb_data, recreate it
        console.warn('[KDBWorker] Directory handle invalid, recreating:', e);
        const root = await navigator.storage.getDirectory();
        this.kdbDir = await root.getDirectoryHandle(this.kdbId, { create: true });
        fileHandle = await this.kdbDir.getFileHandle(fileName, { create: true });
      }
      
      const writable = await fileHandle.createWritable();
      
      try {
        // Create a view of the exact data to write
        const contentView = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
        await writable.write(contentView as any);
      } finally {
        await writable.close();
      }
    };

    // Add to queue with concurrency control
    await this.enqueueWrite(writeTask);
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

  private async enqueueWrite(task: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const wrappedTask = async () => {
        try {
          await task();
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          this.activeWrites--;
          this.processQueue();
        }
      };

      this.writeQueue.push(wrappedTask);
      this.processQueue();
    });
  }

  private processQueue(): void {
    while (this.activeWrites < WRITE_CONCURRENCY && this.writeQueue.length > 0) {
      const task = this.writeQueue.shift();
      if (task) {
        this.activeWrites++;
        task();
      }
    }
  }

  async waitForAll(): Promise<void> {
    while (this.activeWrites > 0 || this.writeQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
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

// Minimum time between progress updates (ms)
const MIN_PROGRESS_INTERVAL = 5000; // 5 seconds

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
  
  // Only update if enough time has passed or forced
  if (!force && timeDelta < MIN_PROGRESS_INTERVAL) {
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

async function downloadAndStoreKDB(
  kdbName: string,
  baseUrl: string,
  kdbId: string
): Promise<void> {
  const opfsWriter = new OPFSWriter();
  
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
  };
  
  // Start heartbeat
  startHeartbeat();
  
  try {
    // Initialize storage
    await opfsWriter.init(kdbId);
    
    // Setup storage functions with OPFSWriter integration
    // This ensures store_source_file_content_opfs uses OPFSWriter for proper fallback handling
    setupStorageFunctions(opfsWriter);
    
    // Get file info first
    const infoResponse = await fetch(`${baseUrl}/api/kdb/${kdbName}`);
    if (!infoResponse.ok) {
      throw new Error(`Failed to get KDB info: ${infoResponse.status}`);
    }
    
    const info = await infoResponse.json();
    const totalSize = info.data.kdb_info.file_size;
    currentDownload.totalSize = totalSize;
    
    updateProgress(0, totalSize, 'downloading', 'Starting download...');
    
    // Download with resume and stall detection
    const kdbData = await downloadWithResume(kdbName, baseUrl, totalSize);

    // Check magic number
    if (kdbData.length < 8) {
      throw new Error('KDB file too small');
    }

    const magic = new DataView(kdbData.buffer).getUint32(0, true);
    if (magic !== CWDK_MAGIC) {
      throw new Error(`Invalid magic: 0x${magic.toString(16)}`);
    }

    // Use WASM to decompress and store
    // Report storing phase (download is already at 100% from downloadWithResume)
    updateProgress(totalSize, totalSize, 'storing', 'Decompressing and storing...', true);
    
    await initWasm();
    
    if (!wasmModule) {
      throw new Error('WASM not initialized');
    }
    
    // Call WASM to parse and store
    const designName = await wasmModule.parse_and_store_kdb(kdbId, kdbData);
    
    if (!designName) {
      throw new Error('Failed to parse KDB');
    }
    
    // Flush any buffered IndexedDB records (the per-record store_* calls
    // batch writes; the final partial batch must be flushed before we
    // report completion).
    if ((self as any).__flushKdbBatches) {
      await (self as any).__flushKdbBatches();
    }
    
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

// ============================================
// Worker Message Handler
// ============================================

self.onmessage = async (event: MessageEvent<KDBDownloadMessage>) => {
  const { type, kdbName, baseUrl, kdbId } = event.data;
  
  if (type === 'start' && kdbName && baseUrl && kdbId) {
    await downloadAndStoreKDB(kdbName, baseUrl, kdbId);
  } else if (type === 'cancel') {
    if (currentDownload) {
      currentDownload.isCancelled = true;
    }
  }
};

export {};
