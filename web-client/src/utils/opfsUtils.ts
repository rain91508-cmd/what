/**
 * OPFS (Origin Private File System) Utilities
 * 
 * Provides common functions for OPFS operations with fallback support.
 */

/**
 * Check if OPFS is available in the current context
 * This checks for navigator.storage.getDirectory API availability
 */
export function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

/**
 * Safely get OPFS root directory
 * Returns null if OPFS is not available or fails
 */
export async function getOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (!isOpfsAvailable()) {
    return null;
  }

  try {
    return await navigator.storage.getDirectory();
  } catch (e) {
    console.warn('[OPFS] Failed to get root directory:', e);
    return null;
  }
}

/**
 * Get or create a subdirectory in OPFS
 * Returns null if OPFS is not available or fails
 */
export async function getOpfsDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
  create: boolean = true
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name, { create });
  } catch (e) {
    console.warn(`[OPFS] Failed to get directory "${name}":`, e);
    return null;
  }
}

/**
 * In-memory storage fallback for when OPFS is not available
 * Used for storing file content when OPFS is unavailable
 */
export class MemoryFileStorage {
  private storage: Map<string, Uint8Array> = new Map();

  set(key: string, content: Uint8Array): void {
    this.storage.set(key, new Uint8Array(content));
  }

  get(key: string): Uint8Array | undefined {
    return this.storage.get(key);
  }

  has(key: string): boolean {
    return this.storage.has(key);
  }

  delete(key: string): boolean {
    return this.storage.delete(key);
  }

  clear(): void {
    this.storage.clear();
  }

  /**
   * Get a slice of the content (for range requests)
   */
  getRange(key: string, start: number, end: number): Uint8Array | undefined {
    const content = this.storage.get(key);
    if (!content) return undefined;
    return content.slice(start, end);
  }
}

// Global memory storage instance for shared use
export const globalMemoryStorage = new MemoryFileStorage();
