/**
 * OPFS Access Interface
 * 
 * Provides read/write/exists callbacks for WASM to access OPFS.
 * These functions are passed to WASM's init_with_opfs().
 */

// OPFS root directory handle (cached)
let opfsRoot: FileSystemDirectoryHandle | null = null;

/**
 * Initialize OPFS root
 */
async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!opfsRoot) {
    opfsRoot = await navigator.storage.getDirectory();
  }
  return opfsRoot;
}

/**
 * Read file from OPFS
 * 
 * @param path Relative path from wave_cache/ (e.g., "waveform1/lod0/tile_0000/group_0.bin")
 * @returns Uint8Array or null if not found
 */
export async function opfsRead(path: string): Promise<Uint8Array | null> {
  try {
    const root = await getOpfsRoot();
    const parts = path.split('/');
    
    // Navigate to file
    let currentDir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i], { create: false });
    }
    
    const fileName = parts[parts.length - 1];
    const fileHandle = await currentDir.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    
    const arrayBuffer = await file.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } catch (e) {
    // File not found or other error
    return null;
  }
}

/**
 * Write file to OPFS
 * 
 * @param path Relative path from wave_cache/
 * @param data Data to write
 */
export async function opfsWrite(path: string, data: Uint8Array): Promise<void> {
  const root = await getOpfsRoot();
  const parts = path.split('/');
  
  // Navigate/create directories
  let currentDir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true });
  }
  
  const fileName = parts[parts.length - 1];
  const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
  
  const writable = await fileHandle.createWritable();
  await writable.write(data as unknown as BufferSource);
  await writable.close();
  
  console.log(`[OPFS] Written: ${path} (${data.length} bytes)`);
}

/**
 * Check if file exists in OPFS
 * 
 * @param path Relative path from wave_cache/
 * @returns true if exists
 */
export async function opfsExists(path: string): Promise<boolean> {
  try {
    const root = await getOpfsRoot();
    const parts = path.split('/');
    
    // Navigate to file
    let currentDir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i], { create: false });
    }
    
    const fileName = parts[parts.length - 1];
    await currentDir.getFileHandle(fileName);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Delete file from OPFS
 * 
 * @param path Relative path from wave_cache/
 */
export async function opfsDelete(path: string): Promise<void> {
  try {
    const root = await getOpfsRoot();
    const parts = path.split('/');
    
    // Navigate to parent directory
    let currentDir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i], { create: false });
    }
    
    const fileName = parts[parts.length - 1];
    await currentDir.removeEntry(fileName);
    
    console.log(`[OPFS] Deleted: ${path}`);
  } catch (e) {
    console.warn(`[OPFS] Failed to delete ${path}:`, e);
  }
}

/**
 * List all files in a directory
 * 
 * @param path Relative path from wave_cache/
 * @returns Array of file names
 */
export async function opfsList(path: string): Promise<string[]> {
  try {
    const root = await getOpfsRoot();
    const parts = path.split('/').filter(p => p);
    
    // Navigate to directory
    let currentDir = root;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create: false });
    }
    
    const entries: string[] = [];
    // @ts-ignore - TypeScript doesn't know about values() yet
    for await (const entry of currentDir.values()) {
      entries.push(entry.name);
    }
    
    return entries;
  } catch (e) {
    return [];
  }
}

/**
 * Get storage quota information
 */
export async function getStorageEstimate(): Promise<{ usage: number; quota: number }> {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
    };
  }
  return { usage: 0, quota: 0 };
}

/**
 * Check if OPFS is supported
 */
export function isOpfsSupported(): boolean {
  return 'storage' in navigator && 'getDirectory' in navigator.storage;
}

/**
 * Clear all waveform cache data
 */
export async function clearWaveformCache(waveformName: string): Promise<void> {
  try {
    const root = await getOpfsRoot();
    const cacheDir = await root.getDirectoryHandle('wave_cache', { create: false });
    
    try {
      await cacheDir.removeEntry(waveformName, { recursive: true });
      console.log(`[OPFS] Cleared cache for: ${waveformName}`);
    } catch (e) {
      // Directory doesn't exist
    }
  } catch (e) {
    console.warn(`[OPFS] Failed to clear cache:`, e);
  }
}
