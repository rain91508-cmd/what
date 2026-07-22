// ============================================
// Knowledge Base Manager - KDB Download & Storage
// ============================================
//
// New Architecture (per interpreter-implementation.md):
// - Module.id removed, use array index + 1
// - Module.fullName removed, calculate dynamically
// - Signal split into SignalDef and SignalInst
// - SignalInst stored in global allSignalInsts
//

import { apiService } from '../../services/api';
import { indexedDBManager } from '../../core/storage/indexedDB';
import { get_source_file_content, get_signals_buffer, get_drivers_by_range, get_module_skeletons, get_module_signal_defs } from '../../core/storage/kdbStorage';
import { kdbDownloadManager, type KDBDownloadProgress } from '../../services/kdbDownloadManager';
import { wasmManager } from '../../wasm';
import type { 
  Module, 
  Signal, 
  SignalDef, 
  SignalInst,
  SourceFileInfo, 
  DesignHierarchy
} from '../../types/kdb';

// Tree node for UI display
export interface TreeNode {
  id: number;
  name: string;
  fullName: string;
  isInstance: boolean;
  hasChildren: boolean;
  childModuleIds: number[];
  children?: TreeNode[];
  parentId?: number;
}

// signals.bin record layout (see kdbStorage.ts / lib.rs):
//   msb:u32, lsb:u32, parentModuleId:u32, driverStart:u32, driverCount:u16
const SIGNAL_RECORD_SIZE = 18;

class KdbManager {
  private currentKdbId: string | null = null;
  private downloading = false;
  // Cache for modules (navigation skeletons, loaded at startup)
  private modules: Module[] = [];
  // Design hierarchies (top_module_id + module_ids) loaded at startup. When the
  // KDB was built with a `-top <module>` command-line option, the interpreter
  // records exactly one hierarchy rooted at that module; otherwise it records
  // one hierarchy per parent-less definition. The navigation tree uses these
  // top_module_ids as its roots so only the intended top module is displayed.
  private hierarchies: DesignHierarchy[] = [];
  // Lazy cache of signalDefs keyed by module id (definition modules only).
  // Populated on demand by getSignalDefs() so the renderer never holds all
  // ~2M SignalDef objects in memory at once — previously this OOM'd / SIGILL'd
  // the renderer on large KDBs (e.g. n900: 125k modules / 2M signals). Only the
  // module currently being viewed pulls its defs into memory.
  private signalDefsCache: Map<number, SignalDef[]> = new Map();
  // Signal instances are stored as one flat binary buffer (signals.bin) kept
  // resident here (~18 bytes/signal, tens of MB) and indexed with a DataView for
  // O(1) synchronous field access — no per-signal JS objects. Drivers are NOT
  // resident; they are range-read from OPFS drivers.bin only when traced.
  private signalsView: DataView | null = null;
  private signalCount = 0;

  /**
   * Check if KDB is available on server
   */
  async checkServerKdb(): Promise<{ available: boolean; name?: string; size?: number }> {
    try {
      const response = await apiService.getKdbList();
      if (response.status === 'success' && response.data && response.data.kdbs && response.data.kdbs.length > 0) {
        const kdbs = response.data.kdbs as any[];
        const validKdbs = kdbs.filter((kdb: any) => kdb.is_valid);
        if (validKdbs.length > 0) {
          const kdb = validKdbs[0];
          return {
            available: true,
            name: kdb.name,
            size: kdb.file_size,
          };
        }
      }
      return { available: false };
    } catch (error) {
      console.error('[KdbManager] Failed to check server KDB:', error);
      return { available: false };
    }
  }

  /**
   * Download and load KDB from server using Web Worker
   * Implements streaming download + zstd decompression + batch storage
   */
  async downloadAndLoadKdb(
    kdbName: string,
    onProgress?: (downloaded: number, total: number, phase?: string, message?: string) => void
  ): Promise<boolean> {
    if (this.downloading) {
      console.warn('[KdbManager] Download already in progress');
      return false;
    }

    this.downloading = true;

    try {
      console.log('[KdbManager] Starting KDB download with Worker...');

      // Use new Worker-based download manager
      const result = await kdbDownloadManager.downloadKDB(
        kdbName,
        kdbName, // Use kdbName as kdbId
        (progress: KDBDownloadProgress) => {
          console.log(`[KdbManager] ${progress.phase}: ${progress.loaded}/${progress.total}`);
          onProgress?.(progress.loaded, progress.total, progress.phase, progress.message);
        }
      );

      if (!result.success) {
        throw new Error(result.error || 'Download failed');
      }

      console.log('[KdbManager] Download complete:', result.designName);

      this.currentKdbId = kdbName;
      // Load modules and signal instances into memory
      await this.loadKdbData();
      console.log('[KdbManager] KDB loaded successfully:', kdbName);
      return true;
    } catch (error) {
      console.error('[KdbManager] Failed to download/load KDB:', error);
      return false;
    } finally {
      this.downloading = false;
    }
  }

  /**
   * Open a KDB that is already stored in the local IDB/OPFS cache (no server
   * download). Verifies a record exists in the `knowledge-base` store, then
   * loads modules + signal instances into memory exactly like the post-download
   * path. Returns false if no cached data is found for the given id.
   */
  async openCachedKdb(kdbId: string): Promise<boolean> {
    if (this.downloading) {
      console.warn('[KdbManager] Download in progress; ignoring openCachedKdb');
      return false;
    }
    if (!kdbId) return false;

    // Verify the KDB was actually cached locally (OPFS holds the real data)
    // before claiming it "loaded". This succeeds for legacy caches too, which
    // may not have an IndexedDB header or header.json.
    const exists = await indexedDBManager.knowledgeBaseExists(kdbId);
    if (!exists) {
      console.warn('[KdbManager] No cached KDB found for id:', kdbId);
      return false;
    }

    try {
      this.currentKdbId = kdbId;
      await this.loadKdbData();
      console.log('[KdbManager] Opened cached KDB:', kdbId);
      return true;
    } catch (error) {
      console.error('[KdbManager] Failed to open cached KDB:', error);
      this.currentKdbId = null;
      return false;
    }
  }

  /**
   * Derive a stable kdbId from a URL pointing at a raw .kdb file. Uses the URL
   * path's last segment (stripped of query/fragment), mirroring the server
   * convention where the kdbId equals the file name (e.g. "c910.kdb").
   */
  private deriveKdbIdFromUrl(url: string): string {
    try {
      const u = new URL(url);
      let base = u.pathname.split('/').pop() || '';
      base = base.split(/[?#]/)[0];
      if (base) return base;
    } catch {
      // Not a valid URL — fall through to a best-effort split.
    }
    const seg = url.split(/[/\\]/).pop() || '';
    return (seg.split(/[?#]/)[0] || 'kdb-from-url');
  }

  /**
   * Derive a stable kdbId from a local file's name (last path segment).
   */
  private deriveKdbIdFromFileName(name: string): string {
    const base = name.split(/[\\/]/).pop() || name;
    return base || 'kdb-from-file';
  }

  /**
   * Load a KDB directly from a URL (option A: a direct URL to a raw .kdb file).
   * The bytes are fetched and stored into OPFS/IndexedDB exactly like the server
   * path, so the KDB also becomes available in the "Open Cached KDB" list.
   * The target host must permit cross-origin fetches (CORS).
   */
  async loadKdbFromUrl(
    url: string,
    onProgress?: (downloaded: number, total: number, phase?: string, message?: string) => void
  ): Promise<boolean> {
    if (this.downloading) {
      console.warn('[KdbManager] Download already in progress');
      return false;
    }

    this.downloading = true;

    try {
      const kdbId = this.deriveKdbIdFromUrl(url);
      console.log('[KdbManager] Loading KDB from URL:', url, 'kdbId:', kdbId);

      const result = await kdbDownloadManager.downloadKDBFromUrl(
        url,
        kdbId,
        (progress: KDBDownloadProgress) => {
          onProgress?.(progress.loaded, progress.total, progress.phase, progress.message);
        }
      );

      if (!result.success) {
        throw new Error(result.error || 'Download failed');
      }

      this.currentKdbId = kdbId;
      await this.loadKdbData();
      console.log('[KdbManager] KDB loaded from URL:', url);
      return true;
    } catch (error) {
      console.error('[KdbManager] Failed to load KDB from URL:', error);
      return false;
    } finally {
      this.downloading = false;
    }
  }

  /**
   * Load a KDB from a local file picked from disk. The bytes are stored into
   * OPFS/IndexedDB like any other source, so the KDB also appears in the
   * "Open Cached KDB" list for later reopening.
   */
  async loadKdbFromLocalFile(
    file: File,
    onProgress?: (downloaded: number, total: number, phase?: string, message?: string) => void
  ): Promise<boolean> {
    if (this.downloading) {
      console.warn('[KdbManager] Download already in progress');
      return false;
    }

    this.downloading = true;

    try {
      const kdbId = this.deriveKdbIdFromFileName(file.name);
      console.log('[KdbManager] Loading KDB from local file:', file.name, 'kdbId:', kdbId);

      const bytes = new Uint8Array(await file.arrayBuffer());

      const result = await kdbDownloadManager.downloadKDBFromBytes(
        bytes,
        kdbId,
        (progress: KDBDownloadProgress) => {
          onProgress?.(progress.loaded, progress.total, progress.phase, progress.message);
        }
      );

      if (!result.success) {
        throw new Error(result.error || 'Load failed');
      }

      this.currentKdbId = kdbId;
      await this.loadKdbData();
      console.log('[KdbManager] KDB loaded from local file:', file.name);
      return true;
    } catch (error) {
      console.error('[KdbManager] Failed to load KDB from local file:', error);
      return false;
    } finally {
      this.downloading = false;
    }
  }

  /**
   * Load KDB data from IndexedDB into memory
   */
  private async loadKdbData(): Promise<void> {    if (!this.currentKdbId) return;
    
    // Load only module *skeletons* (no signalDefs) — the heavy signal
    // definitions stay in IndexedDB and are fetched lazily, per module, when a
    // module's signals are actually viewed. This keeps memory bounded at load
    // (the navigation tree only needs name/parent/children/etc.), avoiding the
    // OOM that previously crashed the renderer on large designs
    // (e.g. n900: 125k modules / 2M signals).
    this.modules = await get_module_skeletons(this.currentKdbId);

    // Load design hierarchies so the tree can root at the intended top
    // module(s) (e.g. the one passed via `-top` at build time) instead of
    // every parent-less definition.
    this.hierarchies = (await indexedDBManager.getKnowledgeBaseHierarchies(this.currentKdbId)) || [];

    // Load the flat signals.bin buffer once and keep it resident as a DataView.
    // This replaces the millions of per-signal JS objects that previously lived
    // in memory (the ~10 GB footprint that crashed the renderer). Drivers stay
    // on disk (drivers.bin) and are range-read on demand via getDriverBySignalId.
    const buf = await get_signals_buffer(this.currentKdbId);
    if (buf) {
      this.signalsView = new DataView(buf);
      this.signalCount = Math.floor(buf.byteLength / SIGNAL_RECORD_SIZE);
    } else {
      this.signalsView = null;
      this.signalCount = 0;
      console.warn('[KdbManager] signals.bin not found; no signal instances loaded');
    }

    console.log(`[KdbManager] Loaded ${this.modules.length} modules and ${this.signalCount} signal instances`);
  }

  /**
   * Read a raw signal record from the resident signals.bin buffer (synchronous).
   * Returns null if out of range or the buffer isn't loaded.
   */
  private readSignalRecord(globalId: number): { msb: number; lsb: number; parentModuleId: number; driverStart: number; driverCount: number } | null {
    if (!this.signalsView || globalId < 0 || globalId >= this.signalCount) return null;
    const off = globalId * SIGNAL_RECORD_SIZE;
    return {
      msb: this.signalsView.getUint32(off, true),
      lsb: this.signalsView.getUint32(off + 4, true),
      parentModuleId: this.signalsView.getUint32(off + 8, true),
      driverStart: this.signalsView.getUint32(off + 12, true),
      driverCount: this.signalsView.getUint16(off + 16, true),
    };
  }

  // ==================== Dynamic Calculation Helpers ====================

  /**
   * Calculate module's full hierarchical name from parent chain
   * Computed on demand, not stored
   */
  calculateModuleFullName(moduleIndex: number): string {
    const names: string[] = [];
    let currentId = moduleIndex;
    
    while (currentId > 0) {
      const module = this.getModuleById(currentId);
      if (!module) break;
      
      names.push(module.name);
      if (module.parentModuleId === 0) break;
      currentId = module.parentModuleId;
    }
    
    return names.reverse().join('.');
  }

  /**
   * Calculate signal's full hierarchical name
   * Computed on demand when needed
   */
  calculateSignalFullName(parentModuleId: number, signalName: string): string {
    const moduleFullName = this.calculateModuleFullName(parentModuleId);
    return moduleFullName ? `${moduleFullName}.${signalName}` : signalName;
  }

  /**
   * Get display range for a module
   * If the module is an instance, returns the def_module's range and fileId
   * If the module is not an instance, returns its own range and fileId
   * @param moduleId Module ID (1-based)
   * @returns Display range info or null if not found
   */
  getDisplayRange(moduleId: number): { fileId: number; startLine: number; endLine: number } | null {
    const module = this.getModuleById(moduleId);
    if (!module || !module.definition) return null;

    // If this is an instance, use def_module's range
    if (module.isInstance && module.defModuleId > 0) {
      const defModule = this.getModuleById(module.defModuleId);
      if (defModule && defModule.definition) {
        return {
          fileId: defModule.definition.fileId,
          startLine: defModule.definition.startLine,
          endLine: defModule.definition.endLine,
        };
      }
    }

    // Not an instance or def_module not found, use own range
    return {
      fileId: module.definition.fileId,
      startLine: module.definition.startLine,
      endLine: module.definition.endLine,
    };
  }

  /**
   * Get module by ID (1-based)
   * Uses in-memory cache for fast access
   */
  getModuleById(id: number): Module | null {
    if (id <= 0 || id > this.modules.length) return null;
    return this.modules[id - 1];
  }

  /**
   * Get signal instance by global ID (0-based index into signals.bin).
   * driverLocations is intentionally empty here (drivers are fetched on demand
   * via getDriverBySignalId); buildSignal() only needs msb/lsb/parentModuleId.
   */
  getSignalInstByGlobalId(globalId: number): SignalInst | null {
    const rec = this.readSignalRecord(globalId);
    if (!rec) return null;
    return {
      msb: rec.msb,
      lsb: rec.lsb,
      parentModuleId: rec.parentModuleId,
      driverLocations: [],
    } as SignalInst;
  }

  /**
   * Get signal definition for a module (lazy, cached).
   * For instances, returns the definition module's signal defs.
   * The heavy defs are NOT resident for all modules; they are fetched from
   * OPFS (module_signal_defs.bin) on first use for a given module and cached here.
   */
  async getSignalDefs(moduleId: number): Promise<SignalDef[]> {
    if (!this.currentKdbId) return [];
    const module = this.getModuleById(moduleId);
    if (!module) return [];

    // Instances inherit their defs from the definition module.
    const targetId = (module.isInstance && module.defModuleId > 0)
      ? module.defModuleId
      : moduleId;

    const cached = this.signalDefsCache.get(targetId);
    if (cached) return cached;

    const defs = await get_module_signal_defs(targetId, this.currentKdbId);
    this.signalDefsCache.set(targetId, defs);
    return defs;
  }

  /**
   * Build complete Signal object from SignalDef + SignalInst
   * Computed on demand for UI display
   */
  async buildSignal(globalId: number): Promise<Signal | null> {
    const inst = this.getSignalInstByGlobalId(globalId);
    if (!inst) return null;
    
    const module = this.getModuleById(inst.parentModuleId);
    if (!module) return null;
    
    // Get signal defs (lazy)
    const signalDefs = await this.getSignalDefs(inst.parentModuleId);
    
    // Calculate local index within module
    const localIndex = globalId - module.signalInstsStartId;
    if (localIndex < 0 || localIndex >= signalDefs.length) return null;
    
    const def = signalDefs[localIndex];

    // Build fullName with bit width if msb != lsb (multi-bit signal)
    const baseFullName = this.calculateSignalFullName(inst.parentModuleId, def.name);
    const fullNameWithBitWidth = (inst.msb !== inst.lsb)
      ? `${baseFullName}[${inst.msb}:${inst.lsb}]`
      : baseFullName;

    return {
      globalId,
      localIndex,
      name: def.name,
      fullName: fullNameWithBitWidth,
      signalType: def.type,
      direction: def.direction,
      msb: inst.msb,
      lsb: inst.lsb,
      declaration: def.declaration,
      driverLocations: inst.driverLocations || [],  // Updated to use new DriverLocation structure
      parentModuleId: inst.parentModuleId,
    };
  }

  /**
   * Get driver information by signal global ID
   * Returns array of DriverLocation containing driver signal global ID and source line.
   *
   * The signal's (driverStart, driverCount) slice is read synchronously from the
   * resident signals.bin buffer, then only that signal's driver bytes are
   * range-read from OPFS drivers.bin. Nothing else enters memory — this is the
   * lazy "trace driver" path.
   * @param signalGlobalId - Global ID of the signal
   * @returns Promise of DriverLocation[] (empty if not found / no drivers)
   */
  async getDriverBySignalId(signalGlobalId: number): Promise<import('../../types/kdb').DriverLocation[]> {
    if (!this.currentKdbId) return [];
    const rec = this.readSignalRecord(signalGlobalId);
    if (!rec) return [];
    // Even if this (instance) signal stores no own drivers, its INTERNAL drivers
    // live on the module type's SOURCE module and must be merged at lookup time
    // below. So do NOT early-return on driverCount === 0.
    const own = rec.driverCount === 0
      ? []
      : await get_drivers_by_range(this.currentKdbId, rec.driverStart, rec.driverCount);

    // Instances store only their own (port-connection) drivers; their INTERNAL
    // (continuous / procedural) drivers live on the module *type's* SOURCE module
    // -- the defmodule, or the first instance of a nested-only type (which has
    // no defmodule). Merge those at lookup time: keep the source's line but
    // remap the driver signal id to the instance-local signal of the same name.
    // Internal vs port-connection is distinguished WITHOUT a proto flag: a
    // source driver is internal iff its driver signal's parent module is the
    // source module itself (port-connection drivers point at sub-instances, a
    // different module). The proto layout is unchanged.
    const module = this.getModuleById(rec.parentModuleId);
    if (!module || !module.isInstance || module.defModuleId <= 0) {
      return own;
    }
    const srcModule = this.getModuleById(module.defModuleId);
    if (!srcModule || srcModule.signalInstsStartId === module.signalInstsStartId) {
      return own;
    }
    const localIndex = signalGlobalId - module.signalInstsStartId;
    const srcGlobalId = srcModule.signalInstsStartId + localIndex;
    const srcRec = this.readSignalRecord(srcGlobalId);
    if (!srcRec || srcRec.driverCount === 0) {
      return own;
    }
    const srcDrivers = await get_drivers_by_range(this.currentKdbId, srcRec.driverStart, srcRec.driverCount);

    const merged: import('../../types/kdb').DriverLocation[] = [...own];
    for (const dl of srcDrivers) {
      if (dl.driverSignalGlobalId === 0) {
        // Constant/unknown driver: include as-is (no remap) if not duplicate.
        if (!merged.some(m => m.driverSignalGlobalId === 0 && m.line === dl.line)) {
          merged.push(dl);
        }
        continue;
      }
      // Only INTERNAL drivers: the driver signal lives in the source module
      // itself (port-connection drivers point at sub-instances).
      const drvRec = this.readSignalRecord(dl.driverSignalGlobalId);
      if (!drvRec) continue;
      if (drvRec.parentModuleId !== module.defModuleId) continue;

      // Remap driver signal id to the instance-local signal by name.
      const drvParent = this.getModuleById(drvRec.parentModuleId);
      const drvDefs = await this.getSignalDefs(drvRec.parentModuleId);
      const drvLocalIdx = dl.driverSignalGlobalId - (drvParent ? drvParent.signalInstsStartId : 0);
      const drvName = drvDefs[drvLocalIdx]?.name;
      let instDriverId = 0;
      if (drvName) {
        instDriverId = (await this.findSignalByName(rec.parentModuleId, drvName)) ?? 0;
      }
      const out = { driverSignalGlobalId: instDriverId, line: dl.line } as import('../../types/kdb').DriverLocation;
      if (!merged.some(m => m.driverSignalGlobalId === out.driverSignalGlobalId && m.line === out.line)) {
        merged.push(out);
      }
    }
    return merged;
  }

  // ==================== On-Demand Loading API ====================

  /**
   * Get top-level modules for tree root
   */
  async getTopLevelModules(): Promise<TreeNode[]> {
    console.log('[KdbManager] getTopLevelModules called');
    if (!this.currentKdbId || this.modules.length === 0) return [];

    // The design has exactly ONE top module. The KDB records "hierarchies":
    //  - built WITH `-top <module>`: a single hierarchy rooted at that module.
    //  - built WITHOUT `-top`: one hierarchy per parent-less *definition*
    //    (the real design top PLUS every library/cell definition). Picking any
    //    of those as a root would explode the tree into thousands of roots.
    //
    // The real design top is the hierarchy that spans the most modules (the
    // actual instantiated design), as opposed to library/cell definitions which
    // span only themselves. Pick exactly that one as the sole root.
    if (this.hierarchies.length > 0) {
      let bestId = -1;
      let bestSize = -1;
      for (const h of this.hierarchies) {
        const size = h.moduleIds ? h.moduleIds.length : 0;
        if (size > bestSize) {
          bestSize = size;
          bestId = h.topModuleId;
        }
      }
      if (bestId >= 1 && bestId <= this.modules.length) {
        const m = this.getModuleById(bestId);
        if (m) {
          console.log('[KdbManager] top module (largest hierarchy):', bestId, 'moduleIds:', bestSize);
          return [this.moduleToTreeNode(m, bestId)];
        }
      }
    }

    // Fallback (no hierarchies recorded): the single instance with no parent.
    const topInstances = this.modules
      .map((m, index) => ({ module: m, id: index + 1 }))
      .filter(({ module }) => module.parentModuleId === 0 && module.isInstance);
    if (topInstances.length > 0) {
      // Prefer the instance with the most children (the design top).
      let best = topInstances[0];
      let bestChildren = -1;
      for (const { module, id } of topInstances) {
        const n = module.childModuleIds ? module.childModuleIds.length : 0;
        if (n > bestChildren) {
          bestChildren = n;
          best = { module, id };
        }
      }
      console.log('[KdbManager] top module (instance root fallback):', best.id);
      return [this.moduleToTreeNode(best.module, best.id)];
    }

    // Last resort (no instances at all): first parent-less module.
    const parentless = this.modules
      .map((m, index) => ({ module: m, id: index + 1 }))
      .filter(({ module }) => module.parentModuleId === 0);
    if (parentless.length > 0) {
      const first = parentless[0];
      console.log('[KdbManager] top module (parentless fallback):', first.id);
      return [this.moduleToTreeNode(first.module, first.id)];
    }

    return [];
  }

  /**
   * Get child modules for lazy loading
   */
  async getChildModules(parentId: number): Promise<TreeNode[]> {
    console.log('[KdbManager] getChildModules called for parentId:', parentId);
    if (!this.currentKdbId || this.modules.length === 0) return [];
    
    const parent = this.getModuleById(parentId);
    if (!parent || !parent.childModuleIds || parent.childModuleIds.length === 0) {
      return [];
    }
    
    return parent.childModuleIds.map(childId => {
      const child = this.getModuleById(childId);
      return child ? this.moduleToTreeNode(child, childId) : null;
    }).filter((node): node is TreeNode => node !== null);
  }

  /**
   * Get module details by ID
   */
  async getModule(id: number): Promise<Module | null> {
    return this.getModuleById(id);
  }

  /**
   * Get module by full name (searches all modules)
   */
  async getModuleByFullName(fullName: string): Promise<Module | null> {
    for (let i = 1; i <= this.modules.length; i++) {
      const moduleFullName = this.calculateModuleFullName(i);
      if (moduleFullName === fullName) {
        return this.getModuleById(i);
      }
    }
    return null;
  }

  /**
   * Get signals for a module
   * Builds Signal objects on demand from SignalDef + SignalInst
   */
  async getModuleSignals(moduleId: number): Promise<Signal[]> {
    console.log('[KdbManager] getModuleSignals called for moduleId:', moduleId);
    const module = this.getModuleById(moduleId);
    if (!module) return [];
    
    const signalDefs = await this.getSignalDefs(moduleId);
    const signals: Signal[] = [];
    
    for (let i = 0; i < signalDefs.length; i++) {
      const globalId = module.signalInstsStartId + i;
      const signal = await this.buildSignal(globalId);
      if (signal) {
        signals.push(signal);
      }
    }
    
    console.log(`[KdbManager] Built ${signals.length} signals for module ${moduleId}`);
    return signals;
  }

  /**
   * Get signal count for a module
   */
  async getModuleSignalCount(moduleId: number): Promise<number> {
    const signalDefs = await this.getSignalDefs(moduleId);
    return signalDefs.length;
  }

  /**
   * Get signals for a module with pagination (lazy loading)
   * @param moduleId Module ID (1-based)
   * @param offset Start index (0-based)
   * @param limit Maximum number of signals to return
   * @returns Array of signals for the requested page
   */
  async getModuleSignalsPaged(moduleId: number, offset: number, limit: number): Promise<Signal[]> {
    console.log(`[KdbManager] getModuleSignalsPaged called for moduleId: ${moduleId}, offset: ${offset}, limit: ${limit}`);
    const module = this.getModuleById(moduleId);
    if (!module) return [];
    
    const signalDefs = await this.getSignalDefs(moduleId);
    const signals: Signal[] = [];
    
    const endIndex = Math.min(offset + limit, signalDefs.length);
    
    for (let i = offset; i < endIndex; i++) {
      const globalId = module.signalInstsStartId + i;
      const signal = await this.buildSignal(globalId);
      if (signal) {
        signals.push(signal);
      }
    }
    
    console.log(`[KdbManager] Built ${signals.length} signals for module ${moduleId} (offset: ${offset}, limit: ${limit})`);
    return signals;
  }

  /**
   * Find next filtered signals starting from a given index
   * @param moduleId Module ID (1-based)
   * @param startIndex Starting index (0-based, inclusive)
   * @param limit Maximum number of signals to return
   * @param filterFn Filter function that returns true if signal matches
   * @param direction 'forward' or 'backward'
   * @returns Object with signals array and actual start/end indices
   */
  async findFilteredSignalsPaged(
    moduleId: number,
    startIndex: number,
    limit: number,
    filterFn: (signal: Signal) => boolean,
    direction: 'forward' | 'backward' = 'forward'
  ): Promise<{ signals: Signal[]; actualStartIndex: number; actualEndIndex: number; hasMore: boolean }> {
    console.log(`[KdbManager] findFilteredSignalsPaged: moduleId=${moduleId}, startIndex=${startIndex}, limit=${limit}, direction=${direction}`);
    
    const module = this.getModuleById(moduleId);
    if (!module) {
      return { signals: [], actualStartIndex: -1, actualEndIndex: -1, hasMore: false };
    }
    
    const signalDefs = await this.getSignalDefs(moduleId);
    const signals: Signal[] = [];
    
    if (direction === 'forward') {
      // Search forward from startIndex
      let currentIndex = startIndex;
      let firstMatchIndex = -1;
      let lastMatchIndex = -1;
      
      while (currentIndex < signalDefs.length && signals.length < limit) {
        const globalId = module.signalInstsStartId + currentIndex;
        const signal = await this.buildSignal(globalId);
        
        if (signal && filterFn(signal)) {
          if (firstMatchIndex === -1) {
            firstMatchIndex = currentIndex;
          }
          lastMatchIndex = currentIndex;
          signals.push(signal);
        }
        
        currentIndex++;
      }
      
      return {
        signals,
        actualStartIndex: firstMatchIndex,
        actualEndIndex: lastMatchIndex,
        hasMore: currentIndex < signalDefs.length
      };
    } else {
      // Search backward from startIndex
      let currentIndex = startIndex;
      let firstMatchIndex = -1;
      let lastMatchIndex = -1;
      
      while (currentIndex >= 0 && signals.length < limit) {
        const globalId = module.signalInstsStartId + currentIndex;
        const signal = await this.buildSignal(globalId);
        
        if (signal && filterFn(signal)) {
          if (firstMatchIndex === -1) {
            firstMatchIndex = currentIndex;
          }
          lastMatchIndex = currentIndex;
          signals.unshift(signal); // Add to beginning since we're going backward
        }
        
        currentIndex--;
      }
      
      return {
        signals,
        actualStartIndex: lastMatchIndex, // In backward search, last is actually the first in result
        actualEndIndex: firstMatchIndex,
        hasMore: currentIndex >= 0
      };
    }
  }

  /**
   * Get source file info by ID (metadata only)
   */
  async getSourceFileInfo(id: number): Promise<SourceFileInfo | null> {
    return indexedDBManager.getSourceFileInfo(id, this.currentKdbId);
  }

  /**
   * Get source file content by ID (large data from OPFS)
   */
  async getSourceFileContent(id: number): Promise<string | null> {
    if (!this.currentKdbId) return null;
    return get_source_file_content(id, this.currentKdbId);
  }

  /**
   * Get source file total lines by ID
   * Uses stored totalLines from file info
   */
  async getSourceFileTotalLines(id: number): Promise<number> {
    const fileInfo = await indexedDBManager.getSourceFileInfo(id, this.currentKdbId);
    return fileInfo?.totalLines || 0;
  }

  /**
   * Get all source file info in current KDB
   */
  async getAllSourceFileInfo(): Promise<SourceFileInfo[]> {
    if (!this.currentKdbId) return [];
    // Load only lightweight file-name/path metadata (no per-file
    // lineIndexOffset arrays). The Files tab and name-based lookups never need
    // the byte-offset index, and loading it for every file at once OOMs the
    // renderer on large designs. The offsets are still available per-file via
    // getSourceFileInfo(id) when a file is actually opened.
    return indexedDBManager.getSourceFileInfoSkeletons(this.currentKdbId);
  }

  /**
   * Get all modules
   */
  getAllModules(): Module[] {
    return this.modules;
  }

  /**
   * Get file ID for a module
   */
  async getModuleFileId(moduleId: number): Promise<number | null> {
    const module = this.getModuleById(moduleId);
    if (!module) return null;
    
    // Module's definition contains the fileId
    if (module.definition && module.definition.fileId) {
      return module.definition.fileId;
    }
    
    // Fallback: try to match by module name
    const sourceFileInfos = await this.getAllSourceFileInfo();
    const fileInfo = sourceFileInfos.find((f: SourceFileInfo) => {
      const fileName = f.path.split('/').pop()?.replace(/\.v$/, '') || '';
      return fileName === module.name || f.path.includes(module.name);
    });
    
    return fileInfo?.id || null;
  }

  /**
   * Get file info by ID
   */
  async getFileInfo(fileId: number): Promise<{ id: number; name: string; fullName: string; path: string } | null> {
    const fileInfo = await this.getSourceFileInfo(fileId);
    if (!fileInfo) return null;
    
    return {
      id: fileInfo.id,
      name: fileInfo.name,
      fullName: fileInfo.fullName,
      path: fileInfo.path,
    };
  }

  /**
   * Get KDB header info
   */
  async getHeader(): Promise<{ version: string; projectName: string; createdAt: string } | null> {
    if (!this.currentKdbId) return null;
    return indexedDBManager.getKnowledgeBaseHeader(this.currentKdbId);
  }

  /**
   * Get design hierarchies
   */
  async getHierarchies(): Promise<DesignHierarchy[] | null> {
    if (!this.currentKdbId) return null;
    return indexedDBManager.getKnowledgeBaseHierarchies(this.currentKdbId);
  }

  /**
   * Get current KDB ID
   */
  getCurrentKdbId(): string | null {
    return this.currentKdbId;
  }

  /**
   * Check if KDB is loaded
   */
  isLoaded(): boolean {
    return this.currentKdbId !== null && this.modules.length > 0;
  }

  /**
   * Find instance by name within a module's children (for source code click)
   * First tries WASM, then falls back to JS implementation
   * @param moduleId Module ID (1-based) to search in
   * @param instanceName Instance name to find
   * @returns Module ID of the found instance, or null if not found
   */
  async findInstanceByName(moduleId: number, instanceName: string): Promise<number | null> {
    console.log(`[KdbManager] findInstanceByName: moduleId=${moduleId}, instanceName=${instanceName}`);

    // Use JS implementation directly
    return this.findInstanceByNameJS(moduleId, instanceName);
  }

  /**
   * JS fallback for finding instance by name
   */
  private async findInstanceByNameJS(moduleId: number, instanceName: string): Promise<number | null> {
    const module = this.getModuleById(moduleId);
    if (!module) return null;

    // Search through child modules in batches
    const BATCH_SIZE = 50;
    const childIds = module.childModuleIds;

    for (let i = 0; i < childIds.length; i += BATCH_SIZE) {
      const batch = childIds.slice(i, i + BATCH_SIZE);

      for (const childId of batch) {
        const child = this.getModuleById(childId);
        if (child && child.isInstance && child.name === instanceName) {
          console.log(`[KdbManager] Found instance via JS: ${instanceName} at moduleId=${childId}`);
          return childId;
        }
      }

      // Yield to allow UI updates between batches
      if (i + BATCH_SIZE < childIds.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return null;
  }

  /**
   * Get child instances for a module
   * @param moduleId Module ID (1-based)
   * @returns Array of child instance modules
   */
  async getModuleInstances(moduleId: number): Promise<Module[]> {
    console.log(`[KdbManager] getModuleInstances called for moduleId: ${moduleId}`);
    const module = this.getModuleById(moduleId);
    if (!module) return [];

    const instances: Module[] = [];
    for (const childId of module.childModuleIds) {
      const child = this.getModuleById(childId);
      if (child && child.isInstance) {
        instances.push(child);
      }
    }

    console.log(`[KdbManager] Found ${instances.length} instances for module ${moduleId}`);
    return instances;
  }

  /**
   * Find signal by name within a module (for source code click)
   * @param moduleId Module ID (1-based) to search in
   * @param signalName Signal name to find
   * @returns Global signal ID if found, or null if not found
   */
  async findSignalByName(moduleId: number, signalName: string): Promise<number | null> {
    console.log(`[KdbManager] findSignalByName: moduleId=${moduleId}, signalName=${signalName}`);

    // Use JS implementation directly
    return this.findSignalByNameJS(moduleId, signalName);
  }

  /**
   * JS fallback for finding signal by name.
   * Searches the given module first, then recursively searches child modules,
   * parent chain, and finally falls back to a global search across ALL modules.
   * This handles the common case where a source file references signals from
   * any module in the design hierarchy.
   */
  private async findSignalByNameJS(
    moduleId: number,
    signalName: string,
    visited: Set<number> = new Set(),
    globalSearchAttempted: boolean = false,
  ): Promise<number | null> {
    if (visited.has(moduleId)) return null;
    visited.add(moduleId);

    const module = this.getModuleById(moduleId);
    if (!module) return null;

    // Search this module's signal defs
    const signalDefs = await this.getSignalDefs(moduleId);
    const BATCH_SIZE = 100;

    for (let i = 0; i < signalDefs.length; i += BATCH_SIZE) {
      const endIndex = Math.min(i + BATCH_SIZE, signalDefs.length);

      for (let j = i; j < endIndex; j++) {
        const signalDef = signalDefs[j];
        if (signalDef.name === signalName) {
          const globalId = module.signalInstsStartId + j;
          console.log(`[KdbManager] Found signal via JS: ${signalName} at globalId=${globalId} (module ${moduleId})`);
          return globalId;
        }
      }

      // Yield to allow UI updates between batches
      if (endIndex < signalDefs.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Not found in this module — search child modules recursively.
    for (const childId of (module.childModuleIds || [])) {
      const result = await this.findSignalByNameJS(childId, signalName, visited, globalSearchAttempted);
      if (result !== null) {
        return result;
      }
    }

    // Not found in children — search parent module chain.
    if (module.parentModuleId > 0 && !visited.has(module.parentModuleId)) {
      const result = await this.findSignalByNameJS(module.parentModuleId, signalName, visited, globalSearchAttempted);
      if (result !== null) {
        return result;
      }
    }

    // Last resort: global search across ALL modules. This handles the case
    // where the signal is in a sibling or unrelated module that shares the
    // same source file.
    if (!globalSearchAttempted) {
      console.log(`[KdbManager] Signal not found in module tree, trying global search: ${signalName}`);
      const allModules = this.getAllModuleIds();
      for (const mid of allModules) {
        if (visited.has(mid)) continue;
        const result = await this.findSignalByNameJS(mid, signalName, visited, true);
        if (result !== null) {
          console.log(`[KdbManager] Found signal via global search: ${signalName} at globalId=${result} (module ${mid})`);
          return result;
        }
      }
    }

    return null;
  }

  /**
   * Get all module IDs in the design.
   */
  private getAllModuleIds(): number[] {
    const ids: number[] = [];
    // modules is a flat array where index (id-1) = module id; iterate all
    for (let i = 0; i < this.modules.length; i++) {
      if (this.modules[i]) {
        ids.push(i + 1); // +1 because module IDs are 1-based
      }
    }
    return ids;
  }

  /**
   * Get signal index (0-based) within a module by global ID
   * @param moduleId Module ID (1-based)
   * @param globalId Signal global ID
   * @returns Signal index within module (0-based), or -1 if not found
   */
  async getSignalIndexInModule(moduleId: number, globalId: number): Promise<number> {
    const module = this.getModuleById(moduleId);
    if (!module) return -1;

    const signalDefs = await this.getSignalDefs(moduleId);
    const localIndex = globalId - module.signalInstsStartId;

    if (localIndex >= 0 && localIndex < signalDefs.length) {
      return localIndex;
    }

    return -1;
  }

  /**
   * Store KDB in WASM memory for fast lookup
   */
  async storeKdbInWasmMemory(): Promise<void> {
    if (!this.currentKdbId || !wasmManager.isInitialized()) {
      console.warn('[KdbManager] Cannot store KDB in WASM: not initialized');
      return;
    }

    try {
      // Get the raw KDB data from IndexedDB or re-download
      // For now, we'll skip this as the data is already in JS memory
      // TODO: Implement storing KDB data in WASM memory when loading
      console.log('[KdbManager] KDB storage in WASM memory not yet implemented');
    } catch (error) {
      console.error('[KdbManager] Failed to store KDB in WASM memory:', error);
    }
  }

  /**
   * Get design name
   */
  async getDesignName(): Promise<string> {
    if (!this.currentKdbId) return '';
    const header = await indexedDBManager.getKnowledgeBaseHeader(this.currentKdbId);
    return header?.projectName || this.currentKdbId;
  }

  /**
   * Clear current KDB and all stored data
   */
  async clear(): Promise<void> {
    this.currentKdbId = null;
    this.modules = [];
    this.hierarchies = [];
    this.signalDefsCache.clear();
    this.signalsView = null;
    this.signalCount = 0;
    await indexedDBManager.clearAll();
    console.log('[KdbManager] Cleared all data');
  }

  // ==================== Private Helpers ====================

  private moduleToTreeNode(module: Module, id: number): TreeNode {
    return {
      id,
      name: module.name,
      fullName: this.calculateModuleFullName(id),
      isInstance: module.isInstance,
      hasChildren: module.childModuleIds.length > 0,
      childModuleIds: module.childModuleIds,
    };
  }
}

// Singleton instance
export const kdbManager = new KdbManager();
