// ============================================
// Large File Controller
// ============================================
// Manages large file viewing with windowed loading
// Coordinates between Monaco editor and OPFS Reader Worker
//
// Architecture:
// - LargeFileController (main thread)
//   ├─ OPFS Reader Worker (for chunk reading)
//   ├─ WindowManager (tracks visible window)
//   └─ MonacoAdapter (updates editor)

// ============================================
// Constants
// ============================================

const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024; // 2MB threshold for large file mode
const WINDOW_SIZE = 2000; // Number of lines in window
const BUFFER_LINES = 1000; // Extra lines to load before/after visible area

// ============================================
// Types
// ============================================

export interface FileMetadata {
  id: number;
  path: string;
  name: string;
  fullName: string;
  size: number;
  totalLines: number;
  kdbId: string;
}

export interface WindowState {
  startLine: number;
  endLine: number;
  visibleStart: number;
  visibleEnd: number;
}

export interface LargeFileCallbacks {
  onContentChange: (content: string, startLine: number) => void;
  onLoadingChange: (loading: boolean) => void;
  onError: (error: string) => void;
}

// ============================================
// Large File Controller
// ============================================

export class LargeFileController {
  private worker: Worker | null = null;
  private metadata: FileMetadata | null = null;
  private windowState: WindowState = {
    startLine: 1,
    endLine: WINDOW_SIZE,
    visibleStart: 1,
    visibleEnd: 100,
  };
  private callbacks: LargeFileCallbacks;
  private isLoading = false;
  private pendingLoad: { start: number; end: number } | null = null;

  constructor(callbacks: LargeFileCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Check if file should use large file mode
   */
  static isLargeFile(metadata: FileMetadata): boolean {
    return metadata.size > LARGE_FILE_THRESHOLD;
  }

  /**
   * Initialize controller with file metadata
   */
  async init(metadata: FileMetadata): Promise<boolean> {
    this.metadata = metadata;

    try {
      // Create worker
      this.worker = new Worker(
        new URL('../workers/opfsReader.worker.ts', import.meta.url),
        { type: 'module' }
      );

      // Set up message handler
      this.worker.onmessage = (event) => {
        this.handleWorkerMessage(event.data);
      };

      this.worker.onerror = (error) => {
        console.error('[LargeFileController] Worker error:', error);
        this.callbacks.onError('Worker error: ' + error.message);
      };

      // Initialize worker with file
      const result = await this.sendMessage({
        type: 'init',
        kdbId: metadata.kdbId,
        fileId: metadata.id,
      });

      if (result.type === 'initialized') {
        console.log('[LargeFileController] Initialized with', result.lineCount, 'lines');
        return true;
      } else if (result.type === 'error') {
        throw new Error(result.error || 'Failed to initialize');
      }

      return false;
    } catch (error) {
      console.error('[LargeFileController] Failed to init:', error);
      this.callbacks.onError(error instanceof Error ? error.message : 'Unknown error');
      return false;
    }
  }

  /**
   * Send message to worker and wait for response
   */
  private sendMessage(message: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const handler = (event: MessageEvent) => {
        this.worker!.removeEventListener('message', handler);
        resolve(event.data);
      };

      this.worker.addEventListener('message', handler);
      this.worker.postMessage(message);
    });
  }

  /**
   * Handle messages from worker
   */
  private handleWorkerMessage(data: any): void {
    switch (data.type) {
      case 'lines':
        this.handleLinesLoaded(data.text);
        break;
      case 'error':
        this.isLoading = false;
        this.callbacks.onLoadingChange(false);
        this.callbacks.onError(data.error || 'Unknown error');
        break;
    }
  }

  /**
   * Handle loaded lines
   */
  private handleLinesLoaded(text: string): void {
    this.isLoading = false;
    this.callbacks.onLoadingChange(false);
    this.callbacks.onContentChange(text, this.windowState.startLine);

    // Check if there's a pending load
    if (this.pendingLoad) {
      const { start, end } = this.pendingLoad;
      this.pendingLoad = null;
      this.loadWindow(start, end);
    }
  }

  /**
   * Update visible range and ensure window covers it
   */
  async ensureWindow(visibleStart: number, visibleEnd: number): Promise<void> {
    this.windowState.visibleStart = visibleStart;
    this.windowState.visibleEnd = visibleEnd;

    // Check if visible range is within current window (with buffer)
    // Window should cover: [visibleStart - BUFFER_LINES, visibleEnd + BUFFER_LINES]
    const requiredStart = Math.max(1, visibleStart - BUFFER_LINES);
    const requiredEnd = Math.min(
      this.metadata?.totalLines || visibleEnd + BUFFER_LINES,
      visibleEnd + BUFFER_LINES
    );

    // Check if current window covers the required range
    const windowCovers = 
      this.windowState.startLine <= requiredStart && 
      this.windowState.endLine >= requiredEnd;

    if (!windowCovers) {
      // Calculate new window centered around visible area
      const windowSize = WINDOW_SIZE;
      const newStart = Math.max(1, visibleStart - Math.floor(windowSize / 2));
      const newEnd = Math.min(
        this.metadata?.totalLines || visibleEnd + Math.floor(windowSize / 2),
        newStart + windowSize - 1
      );

      await this.loadWindow(newStart, newEnd);
    }
  }

  /**
   * Load window content from worker
   */
  private async loadWindow(startLine: number, endLine: number): Promise<void> {
    // Debounce: if already loading, queue the request
    if (this.isLoading) {
      this.pendingLoad = { start: startLine, end: endLine };
      return;
    }

    this.isLoading = true;
    this.callbacks.onLoadingChange(true);

    this.windowState.startLine = startLine;
    this.windowState.endLine = endLine;

    try {
      this.worker?.postMessage({
        type: 'readLines',
        startLine,
        endLine,
      });
    } catch (error) {
      this.isLoading = false;
      this.callbacks.onLoadingChange(false);
      this.callbacks.onError(error instanceof Error ? error.message : 'Failed to load');
    }
  }

  /**
   * Get current window state
   */
  getWindowState(): WindowState {
    return { ...this.windowState };
  }

  /**
   * Get file metadata
   */
  getMetadata(): FileMetadata | null {
    return this.metadata;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'close' });
      this.worker.terminate();
      this.worker = null;
    }
  }
}

// ============================================
// Small File Handler (for comparison)
// ============================================

export async function loadSmallFile(
  fileId: number,
  kdbId: string
): Promise<string | null> {
  // For small files, load entire content directly
  const { get_source_file_content } = await import('../core/storage/kdbStorage');
  return get_source_file_content(fileId, kdbId);
}
