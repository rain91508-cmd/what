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
   * Download and store KDB using Web Worker
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

    return new Promise((resolve, reject) => {
      this.currentDownload = {
        kdbName,
        kdbId,
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

        // Start download
        this.worker.postMessage({
          type: 'start',
          kdbName,
          baseUrl,
          kdbId,
        });
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
        break;

      case 'heartbeat':
        if (message.timestamp) {
          // Clear existing timeout
          if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
          }
          
          // Set new timeout to detect worker stall
          this.heartbeatTimeout = setTimeout(() => {
            console.warn('[KDBDownloadManager] Worker heartbeat timeout');
          }, 15000); // 15 seconds without heartbeat = warning
          
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
   */
  private async storePendingFiles(
    pendingFiles: Array<{ fileId: number; content: Uint8Array }>,
    kdbId: string
  ): Promise<void> {
    // Import storage function dynamically
    const { store_source_file_content_opfs } = await import('../core/storage/kdbStorage');
    
    for (const { fileId, content } of pendingFiles) {
      try {
        await store_source_file_content_opfs(fileId, content, kdbId);
      } catch (error) {
        console.error(`[KDBDownloadManager] Failed to store file ${fileId}:`, error);
        throw error;
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
