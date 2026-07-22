/**
 * Signal ID Manager
 * 
 * Manages the mapping between global_id (from KDB) and draw_sig_id (monotonic ID for rendering).
 * This is stored per waveform in OPFS as signals.json.
 */

import { isOpfsAvailable } from '../../utils/opfsUtils';

// Signal metadata structure (simplified - only ID mapping)
interface SignalMetadata {
  version: number;
  next_draw_sig_id: number;
  signal_map: Record<string, number>;  // global_id (string) -> draw_sig_id
}

// Global constants (must match WASM)
const GROUP_SIZE = 256;

/**
 * Signal ID Manager
 * Manages draw_sig_id allocation and persistence
 */
export class SignalIdManager {
  private waveform: string;
  private metadata: SignalMetadata;
  private opfsRoot: FileSystemDirectoryHandle | null = null;
  // Serialized save chain: each saveMetadata() call awaits the previous one,
  // preventing overlapping createWritable calls that would corrupt signals.json.
  private savePromise: Promise<void> = Promise.resolve();
  // Debounce timer: coalesces rapid allocations into one write.
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savePending = false;

  constructor(waveform: string) {
    this.waveform = waveform;
    this.metadata = {
      version: 1,
      next_draw_sig_id: 0,
      signal_map: {},
    };
  }

  /**
   * Initialize the manager
   * Loads existing metadata from OPFS if available
   */
  async init(): Promise<void> {
    // Check if OPFS is available
    if (!isOpfsAvailable()) {
      console.warn(`[SignalIdManager] OPFS not available, using memory only`);
      this.opfsRoot = null;
      return;
    }

    try {
      this.opfsRoot = await navigator.storage.getDirectory();
      await this.loadMetadata();
      console.log(`[SignalIdManager] Initialized for ${this.waveform}, next_id=${this.metadata.next_draw_sig_id}`);
    } catch (e) {
      console.warn(`[SignalIdManager] Failed to init OPFS, using memory only:`, e);
      this.opfsRoot = null;
    }
  }

  /**
   * Get or create draw_sig_id for a global_id
   */
  getOrCreateDrawSigId(global_id: number): number {
    const key = global_id.toString();
    const existing = this.metadata.signal_map[key];
    
    if (existing !== undefined) {
      return existing;
    }

    // Allocate new ID (monotonic递增)
    const draw_sig_id = this.metadata.next_draw_sig_id++;
    this.metadata.signal_map[key] = draw_sig_id;
    
    // Debounced serialized save: coalesce rapid allocations into one write.
    this.scheduleSave();

    console.log(`[SignalIdManager] Allocated new ID: global_id=${global_id} -> draw_sig_id=${draw_sig_id}`);
    return draw_sig_id;
  }

  /**
   * Schedule a debounced save (200ms). If called again within 200ms, the
   * timer resets so rapid allocations produce a single OPFS write.
   */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // Chain the save so overlapping writes never interleave.
      this.savePromise = this.savePromise
        .then(() => this.doSave())
        .catch(e => console.warn(`[SignalIdManager] Failed to save metadata:`, e));
    }, 200);
  }

  /**
   * Batch get draw_sig_ids
   * Returns map of global_id -> draw_sig_id (only for existing mappings)
   */
  getDrawSigIds(global_ids: number[]): Map<number, number> {
    const result = new Map<number, number>();
    
    for (const global_id of global_ids) {
      const key = global_id.toString();
      const draw_sig_id = this.metadata.signal_map[key];
      if (draw_sig_id !== undefined) {
        result.set(global_id, draw_sig_id);
      }
    }
    
    return result;
  }

  /**
   * Get group ID for a draw_sig_id
   */
  getGroupId(draw_sig_id: number): number {
    return Math.floor(draw_sig_id / GROUP_SIZE);
  }

  /**
   * Check if a global_id has been allocated
   */
  hasGlobalId(global_id: number): boolean {
    return this.metadata.signal_map[global_id.toString()] !== undefined;
  }

  /**
   * Get the next available draw_sig_id (for pre-allocation)
   */
  getNextDrawSigId(): number {
    return this.metadata.next_draw_sig_id;
  }

  /**
   * Get all allocated signal mappings
   */
  getAllMappings(): Map<number, number> {
    const result = new Map<number, number>();
    for (const [key, value] of Object.entries(this.metadata.signal_map)) {
      result.set(parseInt(key), value);
    }
    return result;
  }

  /**
   * Load metadata from OPFS
   */
  private async loadMetadata(): Promise<void> {
    if (!this.opfsRoot) return;

    try {
      const waveDir = await this.getWaveformDir();
      const fileHandle = await waveDir.getFileHandle('signals.json');
      const file = await fileHandle.getFile();
      const text = await file.text();
      
      const data = JSON.parse(text) as SignalMetadata;
      
      // Validate version
      if (data.version !== 1) {
        console.warn(`[SignalIdManager] Unknown version: ${data.version}, resetting`);
        return;
      }

      this.metadata = data;
      console.log(`[SignalIdManager] Loaded metadata: ${Object.keys(this.metadata.signal_map).length} signals`);
    } catch (e) {
      // File doesn't exist or is corrupt - start fresh
      console.log(`[SignalIdManager] No existing metadata, starting fresh`);
      this.metadata = {
        version: 1,
        next_draw_sig_id: 0,
        signal_map: {},
      };
    }
  }

  /**
   * Save metadata to OPFS (serialized via savePromise chain)
   */
  private async doSave(): Promise<void> {
    if (!this.opfsRoot) return;

    try {
      const waveDir = await this.getWaveformDir();
      const fileHandle = await waveDir.getFileHandle('signals.json', { create: true });
      
      const writable = await fileHandle.createWritable();
      const data = JSON.stringify(this.metadata, null, 2);
      await writable.write(data);
      await writable.close();
      
      console.log(`[SignalIdManager] Saved metadata: ${Object.keys(this.metadata.signal_map).length} signals`);
    } catch (e) {
      console.warn(`[SignalIdManager] Failed to save metadata:`, e);
    }
  }

  /**
   * Get or create waveform directory
   */
  private async getWaveformDir(): Promise<FileSystemDirectoryHandle> {
    if (!this.opfsRoot) {
      throw new Error('OPFS not initialized');
    }

    const cacheDir = await this.opfsRoot.getDirectoryHandle('wave_cache', { create: true });
    return await cacheDir.getDirectoryHandle(this.waveform, { create: true });
  }

  /**
   * Clear all data (for testing)
   */
  async clear(): Promise<void> {
    this.metadata = {
      version: 1,
      next_draw_sig_id: 0,
      signal_map: {},
    };
    await this.doSave();
  }
}

// Singleton instance cache with promise-based dedup
const managerCache = new Map<string, SignalIdManager>();
const managerPromises = new Map<string, Promise<SignalIdManager>>();

/**
 * Get or create SignalIdManager for a waveform.
 * Uses a promise-based lock to prevent duplicate managers when called concurrently.
 */
export async function getSignalIdManager(waveform: string): Promise<SignalIdManager> {
  const existing = managerCache.get(waveform);
  if (existing) return existing;

  let p = managerPromises.get(waveform);
  if (!p) {
    p = (async () => {
      const m = new SignalIdManager(waveform);
      await m.init();
      managerCache.set(waveform, m);
      return m;
    })();
    managerPromises.set(waveform, p);
  }

  const manager = await p;
  return manager;
}

/**
 * Clear manager cache (e.g., when switching waveforms)
 */
export function clearSignalIdManagerCache(): void {
  managerCache.clear();
}
