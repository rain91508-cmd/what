// ============================================
// KDB Download Manager
// ============================================
// Manages KDB downloads using Web Workers for off-main-thread processing
// Provides progress callbacks, heartbeat monitoring, and error handling

import { apiService } from './api';

export interface KDBDownloadProgress {
  phase: 'downloading' | 'decompressing' | 'storing' | 'retrying';
  loaded: number;
  total: number;
  message: string;
  speed?: number; // bytes per second
  eta?: number; // estimated time remaining in seconds
}

export interface KDBDownloadResult {
  success: boolean;
  designName?: string;
  moduleCount?: number;
  signalCount?: number;
  fileCount?: number;
  error?: string;
  canRetry?: boolean;
}

export interface KDBDownloadHeartbeat {
  timestamp: number;
  loaded: number;
  total: number;
  phase: string;
}

type KDBDownloadWorker = Worker;

class KDBDownloadManager {
  private worker: KDBDownloadWorker | null = null;
  private currentDownload: {
    kdbName: string;
    kdbId: string;
    resolve: (result: KDBDownloadResult) => void;
    reject: (error: Error) => void;
    onProgress?: (progress: KDBDownloadProgress) => void;
    onHeartbeat?: (heartbeat: KDBDownloadHeartbeat) => void;
  } | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Download and store KDB from server using Web Worker
   * @param kdbName Name of the KDB file
   * @param kdbId Unique KDB identifier
   * @param onProgress Progress callback
   * @returns Download result
   */
  async downloadKDB(
    kdbName: string,
    kdbId: string,
    onProgress?: (progress: KDBDownloadProgress) => void
  ): Promise<KDBDownloadResult> {
    // Check if already downloading
    if (this.currentDownload) {
      return {
        success: false,
        error: 'Another KDB download is in progress',
      };
    }

    // Get server config
    const baseUrl = apiService.getBaseUrl();
    if (!baseUrl) {
      return {
        success: false,
        error: 'Server not configured',
      };
    }

    return this.startWorkerWithMessage(
      { type: 'start', kdbName, baseUrl, kdbId },
      kdbName,
      onProgress,
    );
  }

  /**
   * Fetch a raw .kdb from an arbitrary URL and store it via the Web Worker.
   * @param url Direct URL to a .kdb file
   * @param kdbId Unique KDB identifier (derived from the URL by the caller)
   * @param onProgress Progress callback
   * @returns Download result
   */
  async downloadKDBFromUrl(
    url: string,
    kdbId: string,
    onProgress?: (progress: KDBDownloadProgress) => void
  ): Promise<KDBDownloadResult> {
    if (this.currentDownload) {
      return {
        success: false,
        error: 'Another KDB download is in progress',
      };
    }

    return this.startWorkerWithMessage(
      { type: 'startUrl', url, kdbId },
      url,
      onProgress,
    );
  }

  /**
   * Store a raw .kdb provided as in-memory bytes (e.g. a local file picked from
   * disk) via the Web Worker. The bytes buffer is transferred (not copied).
   * @param bytes Raw .kdb bytes
   * @param kdbId Unique KDB identifier (derived from the file name by the caller)
   * @param onProgress Progress callback
   * @returns Download result
   */
  async downloadKDBFromBytes(
    bytes: Uint8Array,
    kdbId: string,
    onProgress?: (progress: KDBDownloadProgress) => void
  ): Promise<KDBDownloadResult> {
    if (this.currentDownload) {
      return {
        success: false,
        error: 'Another KDB download is in progress',
      };
    }

    return this.startWorkerWithMessage(
      { type: 'startBytes', bytes, kdbId },
      kdbId,
      onProgress,
    );
  }

  /**
   * (Re)create the Worker, wire up its handlers, and post the given message.
   * Shared by all three ingestion paths (server / URL / bytes).
   */
  private startWorkerWithMessage(
    message: {
      type: 'start' | 'startUrl' | 'startBytes';
      kdbName?: string;
      baseUrl?: string;
      kdbId: string;
      url?: string;
      bytes?: Uint8Array;
    },
    kdbName: string,
    onProgress?: (progress: KDBDownloadProgress) => void
  ): Promise<KDBDownloadResult> {
    return new Promise((resolve, reject) => {
      this.currentDownload = {
        kdbName,
        kdbId: message.kdbId,
        resolve,
        reject,
        onProgress,
      };

      // Create worker
      try {
        this.worker = new Worker(
          new URL('../workers/kdbDownload.worker.ts', import.meta.url),
          { type: 'module' }
        );

        // Set up message handler
        this.worker.onmessage = (event) => {
          this.handleWorkerMessage(event.data);
        };

        // Set up error handler
        this.worker.onerror = (error) => {
          console.error('[KDBDownloadManager] Worker error:', error);
          this.cleanup();
          resolve({
            success: false,
            error: `Worker error: ${error.message}`,
          });
        };

        // Transfer the bytes buffer (if any) so we don't clone a large file.
        const transfer: Transferable[] = [];
        if (message.bytes && message.bytes.buffer) {
          transfer.push(message.bytes.buffer as ArrayBuffer);
        }

        // Start download
        this.worker.postMessage(message, transfer);
      } catch (error) {
        console.error('[KDBDownloadManager] Failed to create worker:', error);
        this.cleanup();
        resolve({
          success: false,
          error: `Failed to create worker: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    });
  }

  /**
   * (Re)arm the worker-stall watchdog.
   *
   * The heartbeat only proves the worker *process* is alive — it keeps firing
   * even when the worker is blocked waiting on the network, so it is NOT a
   * network-stall detector (the worker has its own STALL_TIMEOUT/retry logic).
   * Its job is to catch a genuinely hung worker (e.g. a long synchronous WASM
   * block during the multi-million-record store).
   *
   * During the 'storing' phase the worker is legitimately CPU-bound for
   * minutes at a time, so a short window would produce spurious
   * "Worker heartbeat timeout" warnings. Use a generous window there; keep a
   * tighter one for the network phases.
   */
  private armHeartbeatTimeout(phase?: string): void {
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    const timeoutMs = phase === 'storing' ? 180000 : 30000;
    this.heartbeatTimeout = setTimeout(() => {
      console.warn('[KDBDownloadManager] Worker heartbeat timeout');
    }, timeoutMs);
  }

  /**
   * Handle messages from worker
   */
  private handleWorkerMessage(data: unknown): void {
    if (!this.currentDownload) return;

    const message = data as {
      type: 'progress' | 'heartbeat' | 'complete' | 'error';
      phase?: 'downloading' | 'decompressing' | 'storing' | 'retrying';
      loaded?: number;
      total?: number;
      message?: string;
      speed?: number;
      eta?: number;
      timestamp?: number;
      designName?: string;
      moduleCount?: number;
      signalCount?: number;
      fileCount?: number;
      error?: string;
      canRetry?: boolean;
      pendingFiles?: Array<{ fileId: number; content: Uint8Array }>;
      kdbId?: string;
    };

    switch (message.type) {
      case 'progress':
        if (message.phase && message.loaded !== undefined && message.total !== undefined) {
          const progress: KDBDownloadProgress = {
            phase: message.phase,
            loaded: message.loaded,
            total: message.total,
            message: message.message || '',
            speed: message.speed,
            eta: message.eta,
          };
          this.currentDownload.onProgress?.(progress);
        }
        // Progress is also proof the worker is alive — keep the stall timer armed.
        this.armHeartbeatTimeout(message.phase);
        break;

      case 'heartbeat':
        if (message.timestamp) {
          // Re-arm the stall timer on every heartbeat (proof the worker is alive).
          this.armHeartbeatTimeout(message.phase);

          const heartbeat: KDBDownloadHeartbeat = {
            timestamp: message.timestamp,
            loaded: message.loaded || 0,
            total: message.total || 0,
            phase: message.phase || 'unknown',
          };
          this.currentDownload.onHeartbeat?.(heartbeat);
        }
        break;

      case 'complete':
        if (this.currentDownload) {
          const resolve = this.currentDownload.resolve;
          
          // Handle pending files from Worker (OPFS fallback)
          if (message.pendingFiles && message.pendingFiles.length > 0 && message.kdbId) {
            console.log(`[KDBDownloadManager] Storing ${message.pendingFiles.length} files from Worker fallback`);
            this.storePendingFiles(message.pendingFiles, message.kdbId).then(() => {
              this.cleanup();
              resolve({
                success: true,
                designName: message.designName,
                moduleCount: message.moduleCount,
                signalCount: message.signalCount,
                fileCount: message.fileCount,
              });
            }).catch((error) => {
              console.error('[KDBDownloadManager] Failed to store pending files:', error);
              this.cleanup();
              resolve({
                success: false,
                error: `Failed to store files: ${error instanceof Error ? error.message : 'Unknown error'}`,
              });
            });
          } else {
            this.cleanup();
            resolve({
              success: true,
              designName: message.designName,
              moduleCount: message.moduleCount,
              signalCount: message.signalCount,
              fileCount: message.fileCount,
            });
          }
        }
        break;

      case 'error':
        if (this.currentDownload) {
          const resolve = this.currentDownload.resolve;
          this.cleanup();
          resolve({
            success: false,
            error: message.error || 'Unknown error',
            canRetry: message.canRetry,
          });
        }
        break;
    }
  }

  /**
   * Cancel current download gracefully
   */
  cancelDownload(): void {
    if (this.worker) {
      // Send cancel message to worker first
      this.worker.postMessage({ type: 'cancel' });
      
      // Give worker time to cancel, then force terminate
      setTimeout(() => {
        if (this.worker) {
          this.worker.terminate();
          this.cleanup();
          if (this.currentDownload) {
            this.currentDownload.resolve({
              success: false,
              error: 'Download cancelled',
            });
          }
        }
      }, 1000);
    }
  }

  /**
   * Store pending files from Worker (OPFS fallback)
   * Called when Worker cannot access OPFS directly
   * Uses batch processing and yielding to avoid blocking UI
   */
  private async storePendingFiles(
    pendingFiles: Array<{ fileId: number; content: Uint8Array }>,
    kdbId: string
  ): Promise<void> {
    // Import storage function dynamically
    const { store_source_file_content_opfs } = await import('../core/storage/kdbStorage');
    
    console.log(`[KDBDownloadManager] Storing ${pendingFiles.length} files with batch processing`);
    
    // Process files in batches to avoid blocking UI
    const BATCH_SIZE = 5; // Process 5 files at a time
    const YIELD_INTERVAL = 10; // Yield every 10 files
    
    for (let i = 0; i < pendingFiles.length; i += BATCH_SIZE) {
      const batch = pendingFiles.slice(i, i + BATCH_SIZE);
      
      // Process batch concurrently
      await Promise.all(
        batch.map(async ({ fileId, content }) => {
          try {
            await store_source_file_content_opfs(fileId, content, kdbId);
          } catch (error) {
            console.error(`[KDBDownloadManager] Failed to store file ${fileId}:`, error);
            throw error;
          }
        })
      );
      
      // Yield to main thread every YIELD_INTERVAL files
      if ((i + BATCH_SIZE) % YIELD_INTERVAL === 0 && i + BATCH_SIZE < pendingFiles.length) {
        console.log(`[KDBDownloadManager] Processed ${i + batch.length}/${pendingFiles.length} files, yielding...`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    console.log(`[KDBDownloadManager] Successfully stored ${pendingFiles.length} files`);
  }

  /**
   * Check if download is in progress
   */
  isDownloading(): boolean {
    return this.currentDownload !== null;
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    
    // Clear heartbeat timeout
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    
    this.currentDownload = null;
  }
}

// Export singleton instance
export const kdbDownloadManager = new KDBDownloadManager();
