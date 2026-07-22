/**
 * OPFS Access Interface
 * 
 * Provides read/write/exists callbacks for WASM to access OPFS.
 * These functions are passed to WASM's init_with_opfs().
 */

// OPFS root directory handle (cached)
let opfsRoot: FileSystemDirectoryHandle | null = null;

/// Waveform tile cache lives under this directory inside the OPFS root.
/// All WASM tile-cache paths (e.g. "<waveform>/lod0/tile_0000/group_0.bin") are
/// resolved relative to this folder so waveform data does not clutter the OPFS root.
const WAVE_CACHE_DIR = 'wave_cache';

/// Resolve a waveform tile-cache path to its location under WAVE_CACHE_DIR.
function toWaveCachePath(path: string): string {
  return `${WAVE_CACHE_DIR}/${path}`;
}

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
    const parts = toWaveCachePath(path).split('/');
    
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

// Per-path write lock: serializes concurrent writes to the same file path
// to prevent interleaved/corrupt data from parallel createWritable calls.
const writeLocks = new Map<string, Promise<void>>();

// GC state: only run GC once per burst of QuotaExceeded errors.
let _gcInProgress = false;
let _quotaErrorCount = 0;

/**
 * Run OPFS GC: clear the oldest waveform cache entries until storage usage is
 * below 85% of quota. This is a best-effort operation and may not free enough
 * space if the quota is very small.
 */
async function runOpfsGc(): Promise<void> {
  if (_gcInProgress) return;
  _gcInProgress = true;
  try {
    const est = await getStorageEstimate();
    const quota = est.quota;
    let usage = est.usage;
    if (quota === 0) return;
    const target = quota * 0.85;
    if (usage <= target) return;
    console.warn(`[OPFS] Running GC: usage ${(usage / 1e6).toFixed(1)}MB / quota ${(quota / 1e6).toFixed(1)}MB`);
    // For now, clear the entire wave_cache to free up space.
    // A more sophisticated GC would evict LRU waveform directories.
    const root = await getOpfsRoot();
    try {
      const cacheDir = await root.getDirectoryHandle('wave_cache', { create: false });
      // List all waveform subdirectories and remove the oldest ones
      const entries: { name: string; mtime: number }[] = [];
      // @ts-ignore
      for await (const entry of cacheDir.values()) {
        if (entry.kind === 'directory') {
          try {
            const fh = await cacheDir.getDirectoryHandle(entry.name, { create: false });
            // Try to get the directory's modification time from header.json
            try {
              const hf = await fh.getFileHandle('header.json');
              const f = await hf.getFile();
              entries.push({ name: entry.name, mtime: f.lastModified });
            } catch {
              entries.push({ name: entry.name, mtime: 0 });
            }
          } catch { /* ignore */ }
        }
      }
      // Sort oldest-first and remove entries until below target
      entries.sort((a, b) => a.mtime - b.mtime);
      for (const entry of entries) {
        if (usage >= target) break;
        try {
          const fSize = await estimateDirSize(cacheDir, entry.name);
          await cacheDir.removeEntry(entry.name, { recursive: true });
          usage -= fSize;
          console.log(`[OPFS] GC removed: ${entry.name}`);
        } catch { /* ignore */ }
      }
    } catch { /* wave_cache doesn't exist — nothing to GC */ }
  } finally {
    _gcInProgress = false;
  }
}

async function estimateDirSize(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<number> {
  try {
    const dir = await parent.getDirectoryHandle(name, { create: false });
    let total = 0;
    // @ts-ignore
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') {
        const fh = await dir.getFileHandle(entry.name);
        const f = await fh.getFile();
        total += f.size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function doWrite(path: string, data: Uint8Array): Promise<void> {
  const root = await getOpfsRoot();
  const parts = toWaveCachePath(path).split('/');

  // Navigate/create directories
  let currentDir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true });
  }

  const fileName = parts[parts.length - 1];
  const fileHandle = await currentDir.getFileHandle(fileName, { create: true });

  // Write to a temp file first, then atomically rename (OPFS move is atomic).
  // This prevents concurrent readers from seeing a partially-written file.
  const tmpPath = `${fileName}.tmp`;
  let tmpHandle: FileSystemFileHandle;
  try {
    tmpHandle = await currentDir.getFileHandle(tmpPath, { create: true });
  } catch {
    // If tmp file creation fails, write directly (better than nothing)
    const writable = await fileHandle.createWritable();
    await writable.write(data as unknown as BufferSource);
    await writable.close();
    console.log(`[OPFS] Written (direct fallback): ${path} (${data.length} bytes)`);
    return;
  }

  const writable = await tmpHandle.createWritable();
  await writable.write(data as unknown as BufferSource);
  await writable.close();

  // Atomic rename: move the temp file to the target path
  try {
    // Cast to 'any' because FileSystemFileHandle.move() is not in all TS libs yet
    await (tmpHandle as any).move(fileName);
  } catch {
    // If move fails (e.g. unsupported), try to write directly
    const writable2 = await fileHandle.createWritable();
    await writable2.write(data as unknown as BufferSource);
    await writable2.close();
    // Clean up the temp file
    try { await currentDir.removeEntry(tmpPath); } catch { /* ignore */ }
  }

  console.log(`[OPFS] Written: ${path} (${data.length} bytes)`);
}

/**
 * Write file to OPFS
 *
 * @param path Relative path from wave_cache/
 * @param data Data to write
 */
export async function opfsWrite(path: string, data: Uint8Array): Promise<void> {
  // Serialize concurrent writes to the same path to prevent interleaved data.
  const prev = writeLocks.get(path) ?? Promise.resolve();
  const next = prev.then(() =>
    (async () => {
      try {
        await doWrite(path, data);
      } catch (e: any) {
        // Handle QuotaExceededError: run GC and retry once.
        if (
          e.name === 'QuotaExceededError' ||
          e.name === 'NS_ERROR_FILE_FILE_CORRUPTED' ||
          (e.message && e.message.includes('Quota'))
        ) {
          _quotaErrorCount++;
          console.warn(`[OPFS] Quota exceeded for ${path}, running GC (attempt ${_quotaErrorCount})`);
          await runOpfsGc();
          // Retry once after GC
          await doWrite(path, data);
        } else {
          throw e;
        }
      }
    })().catch((e) => {
      // Log but don't poison the write lock chain: the next write should still
      // attempt. If writes consistently fail the caller will surface the error.
      console.error(`[OPFS] Write failed for ${path}:`, e);
    })
  );
  writeLocks.set(path, next);
  await next;
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
    const parts = toWaveCachePath(path).split('/');
    
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
    const parts = toWaveCachePath(path).split('/');
    
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
    const parts = toWaveCachePath(path).split('/').filter(p => p);
    
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
    // New location: waveform tiles live under wave_cache/
    try {
      const cacheDir = await root.getDirectoryHandle('wave_cache', { create: false });
      try {
        await cacheDir.removeEntry(waveformName, { recursive: true });
        console.log(`[OPFS] Cleared cache for: ${waveformName}`);
      } catch (e) {
        // Directory doesn't exist
      }
    } catch (e) {
      // wave_cache doesn't exist
    }
    // Migration: also clear the old root-level location used before the
    // wave_cache prefix was introduced (no-op if it doesn't exist).
    try {
      await root.removeEntry(waveformName, { recursive: true });
    } catch (e) {
      // Directory doesn't exist
    }
  } catch (e) {
    console.warn(`[OPFS] Failed to clear cache:`, e);
  }
}
