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
import { get_source_file_content } from '../../core/storage/kdbStorage';
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
}

class KdbManager {
  private currentKdbId: string | null = null;
  private downloading = false;
  // Cache for modules and signal instances (loaded on demand)
  private modules: Module[] = [];
  private allSignalInsts: SignalInst[] = [];

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
    onProgress?: (downloaded: number, total: number) => void
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
          onProgress?.(progress.loaded, progress.total);
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
   * Load KDB data from IndexedDB into memory
   */
  private async loadKdbData(): Promise<void> {
    if (!this.currentKdbId) return;
    
    // Load all modules
    this.modules = await indexedDBManager.getAllModules(this.currentKdbId);
    
    // Load all signal instances
    this.allSignalInsts = await indexedDBManager.getAllSignalInsts(this.currentKdbId);
    
    console.log(`[KdbManager] Loaded ${this.modules.length} modules and ${this.allSignalInsts.length} signal instances`);
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
   * Get signal instance by global ID (0-based index in allSignalInsts)
   */
  getSignalInstByGlobalId(globalId: number): SignalInst | null {
    if (globalId < 0 || globalId >= this.allSignalInsts.length) return null;
    return this.allSignalInsts[globalId];
  }

  /**
   * Get signal definition for a module
   * For instances, gets from definition module
   */
  getSignalDefs(moduleId: number): SignalDef[] {
    const module = this.getModuleById(moduleId);
    if (!module) return [];
    
    if (module.isInstance && module.defModuleId > 0) {
      // Instance: get signal defs from definition module
      const defModule = this.getModuleById(module.defModuleId);
      return defModule?.signalDefs || [];
    }
    
    // Definition: use own signal defs
    return module.signalDefs || [];
  }

  /**
   * Build complete Signal object from SignalDef + SignalInst
   * Computed on demand for UI display
   */
  buildSignal(globalId: number): Signal | null {
    const inst = this.getSignalInstByGlobalId(globalId);
    if (!inst) return null;
    
    const module = this.getModuleById(inst.parentModuleId);
    if (!module) return null;
    
    // Get signal defs
    const signalDefs = this.getSignalDefs(inst.parentModuleId);
    
    // Calculate local index within module
    const localIndex = globalId - module.signalInstsStartId;
    if (localIndex < 0 || localIndex >= signalDefs.length) return null;
    
    const def = signalDefs[localIndex];
    
    return {
      globalId,
      localIndex,
      name: def.name,
      fullName: this.calculateSignalFullName(inst.parentModuleId, def.name),
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
   * Returns array of DriverLocation containing driver signal global ID and source line
   * @param signalGlobalId - Global ID of the signal in allSignalInsts array
   * @returns Array of DriverLocation or empty array if signal not found or has no drivers
   */
  getDriverBySignalId(signalGlobalId: number): import('../../types/kdb').DriverLocation[] {
    const inst = this.getSignalInstByGlobalId(signalGlobalId);
    if (!inst) {
      console.warn(`[KdbManager] Signal instance not found for globalId: ${signalGlobalId}`);
      return [];
    }
    
    return inst.driverLocations || [];
  }

  // ==================== On-Demand Loading API ====================

  /**
   * Get top-level modules for tree root
   */
  async getTopLevelModules(): Promise<TreeNode[]> {
    console.log('[KdbManager] getTopLevelModules called');
    if (!this.currentKdbId || this.modules.length === 0) return [];
    
    // Find top-level modules (parentModuleId === 0)
    const topModules = this.modules
      .map((m, index) => ({ module: m, id: index + 1 }))
      .filter(({ module }) => module.parentModuleId === 0);
    
    console.log('[KdbManager] top modules:', topModules.length);
    return topModules.map(({ module, id }) => this.moduleToTreeNode(module, id));
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
    
    const signalDefs = this.getSignalDefs(moduleId);
    const signals: Signal[] = [];
    
    for (let i = 0; i < signalDefs.length; i++) {
      const globalId = module.signalInstsStartId + i;
      const signal = this.buildSignal(globalId);
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
  getModuleSignalCount(moduleId: number): number {
    const signalDefs = this.getSignalDefs(moduleId);
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
    
    const signalDefs = this.getSignalDefs(moduleId);
    const signals: Signal[] = [];
    
    const endIndex = Math.min(offset + limit, signalDefs.length);
    
    for (let i = offset; i < endIndex; i++) {
      const globalId = module.signalInstsStartId + i;
      const signal = this.buildSignal(globalId);
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
    
    const signalDefs = this.getSignalDefs(moduleId);
    const signals: Signal[] = [];
    
    if (direction === 'forward') {
      // Search forward from startIndex
      let currentIndex = startIndex;
      let firstMatchIndex = -1;
      let lastMatchIndex = -1;
      
      while (currentIndex < signalDefs.length && signals.length < limit) {
        const globalId = module.signalInstsStartId + currentIndex;
        const signal = this.buildSignal(globalId);
        
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
        const signal = this.buildSignal(globalId);
        
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
    return indexedDBManager.getSourceFileInfo(id);
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
    const fileInfo = await indexedDBManager.getSourceFileInfo(id);
    return fileInfo?.totalLines || 0;
  }

  /**
   * Get all source file info in current KDB
   */
  async getAllSourceFileInfo(): Promise<SourceFileInfo[]> {
    if (!this.currentKdbId) return [];
    return indexedDBManager.getSourceFileInfoByKdb(this.currentKdbId);
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
   * JS fallback for finding signal by name
   */
  private async findSignalByNameJS(moduleId: number, signalName: string): Promise<number | null> {
    const module = this.getModuleById(moduleId);
    if (!module) return null;

    const signalDefs = this.getSignalDefs(moduleId);
    const BATCH_SIZE = 100;

    for (let i = 0; i < signalDefs.length; i += BATCH_SIZE) {
      const endIndex = Math.min(i + BATCH_SIZE, signalDefs.length);

      for (let j = i; j < endIndex; j++) {
        const signalDef = signalDefs[j];
        if (signalDef.name === signalName) {
          const globalId = module.signalInstsStartId + j;
          console.log(`[KdbManager] Found signal via JS: ${signalName} at globalId=${globalId}`);
          return globalId;
        }
      }

      // Yield to allow UI updates between batches
      if (endIndex < signalDefs.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return null;
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
    this.allSignalInsts = [];
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
