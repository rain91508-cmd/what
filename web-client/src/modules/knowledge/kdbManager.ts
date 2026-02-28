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
import { parseKdbWithWasm } from './kdbWasmParser';
import type { 
  Module, 
  Signal, 
  SignalDef, 
  SignalInst,
  SourceFile, 
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
   * Download and load KDB from server
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
      const kdbData = await apiService.downloadKdb(kdbName, onProgress);
      if (!kdbData) {
        throw new Error('Failed to download KDB');
      }

      console.log('[KdbManager] Download complete, starting WASM parsing...');

      const success = await this.parseKdb(kdbData, kdbName, (msg) => {
        console.log('[KdbManager]', msg);
      });

      if (success) {
        this.currentKdbId = kdbName;
        // Load modules and signal instances into memory
        await this.loadKdbData();
        console.log('[KdbManager] KDB loaded successfully:', kdbName);
        return true;
      }
      
      return false;
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

  /**
   * Parse KDB binary data and store to IndexedDB via WASM
   */
  private async parseKdb(data: ArrayBuffer, kdbId: string, onMessage?: (msg: string) => void): Promise<boolean> {
    const view = new DataView(data);
    const magic = view.getUint32(0, true);

    if (magic === 0x4B445743) { // "CWDK"
      console.log('[KdbManager] Detected CWDK format, using WASM parser');
      onMessage?.('Detected CWDK format (zstd compressed)');
      
      const success = await parseKdbWithWasm(kdbId, data, onMessage);
      if (success) {
        console.log('[KdbManager] WASM parsing successful, data stored to IndexedDB');
        onMessage?.('WASM parsing successful');
        return true;
      }
      
      console.warn('[KdbManager] WASM parsing failed');
      onMessage?.('WASM parsing failed');
      return false;
    }

    const magicStr = String.fromCharCode(...new Uint8Array(data, 0, 4));
    console.warn('[KdbManager] Invalid KDB magic number:', magicStr || magic.toString(16));
    onMessage?.(`Invalid KDB magic number: ${magicStr || magic.toString(16)}`);
    return false;
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
      driverSignalGlobalIds: inst.driverSignalGlobalIds,
      driverLines: inst.driverLines,
      parentModuleId: inst.parentModuleId,
    };
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
   * Get source file content by ID
   */
  async getSourceFile(id: number): Promise<SourceFile | null> {
    return indexedDBManager.getSourceFile(id);
  }

  /**
   * Get source file by path
   */
  async getSourceFileByPath(path: string): Promise<SourceFile | null> {
    if (!this.currentKdbId) return null;
    
    const files = await indexedDBManager.getSourceFilesByKdb(this.currentKdbId);
    return files.find(f => f.path === path) || null;
  }

  /**
   * Get all source files in current KDB
   */
  async getAllSourceFiles(): Promise<SourceFile[]> {
    if (!this.currentKdbId) return [];
    return indexedDBManager.getSourceFilesByKdb(this.currentKdbId);
  }

  /**
   * Get all modules
   */
  getAllModules(): Module[] {
    return this.modules;
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
