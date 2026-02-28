// ============================================
// Knowledge Base Manager - KDB Download & Storage
// ============================================
//
// New Architecture (per kdb-refactor-plan.md):
// - On-demand loading: only load what's needed for display
// - Use numeric IDs as keys (matching KDB proto)
// - Tree traversal using childModuleIds
//

import { apiService } from '../../services/api';
import { indexedDBManager } from '../../core/storage/indexedDB';
import { parseKdbWithWasm } from './kdbWasmParser';
import type { Module, Signal, SourceFile, DesignHierarchy } from '../../types/kdb';

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

  /**
   * Check if KDB is available on server
   * Only returns valid KDBs (is_valid = true)
   */
  async checkServerKdb(): Promise<{ available: boolean; name?: string; size?: number }> {
    try {
      const response = await apiService.getKdbList();
      if (response.status === 'success' && response.data && response.data.kdbs && response.data.kdbs.length > 0) {
        // Filter only valid KDBs
        const validKdbs = response.data.kdbs.filter((kdb: any) => kdb.is_valid);
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
   * Uses HTTP Range for resumable download
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
      // Download KDB file
      const kdbData = await apiService.downloadKdb(kdbName, onProgress);
      if (!kdbData) {
        throw new Error('Failed to download KDB');
      }

      console.log('[KdbManager] Download complete, starting WASM parsing...');

      // Parse KDB using WASM - it will store data directly to IndexedDB
      const success = await this.parseKdb(kdbData, kdbName, (msg) => {
        console.log('[KdbManager]', msg);
      });

      if (success) {
        this.currentKdbId = kdbName;
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
   * Parse KDB binary data and store to IndexedDB via WASM
   * Supports both 'KDB\x00' and 'CWDK' magic numbers
   */
  private async parseKdb(data: ArrayBuffer, kdbId: string, onMessage?: (msg: string) => void): Promise<boolean> {
    // Check magic number
    const view = new DataView(data);
    const magic = view.getUint32(0, true); // little-endian

    // Support CWDK format (zstd compressed)
    if (magic === 0x4B445743) { // "CWDK"
      console.log('[KdbManager] Detected CWDK format, using WASM parser');
      onMessage?.('Detected CWDK format (zstd compressed)');
      
      // Use WASM parser - it will store data directly to IndexedDB
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

    // Legacy KDB\x00 format
    const magicStr = String.fromCharCode(...new Uint8Array(data, 0, 4));
    if (magicStr === 'KDB\x00') {
      console.log('[KdbManager] Detected legacy KDB format');
      onMessage?.('Detected legacy KDB format (not supported)');
      return false;
    }

    console.warn('[KdbManager] Invalid KDB magic number:', magicStr || magic.toString(16));
    onMessage?.(`Invalid KDB magic number: ${magicStr || magic.toString(16)}`);
    return false;
  }

  // ==================== On-Demand Loading API ====================

  /**
   * Get top-level modules for tree root
   * Returns tree nodes for display
   */
  async getTopLevelModules(): Promise<TreeNode[]> {
    console.log('[KdbManager] getTopLevelModules called, currentKdbId:', this.currentKdbId);
    if (!this.currentKdbId) return [];
    
    const topModuleIds = await indexedDBManager.getTopModuleIds(this.currentKdbId);
    console.log('[KdbManager] topModuleIds:', topModuleIds);
    if (!topModuleIds || topModuleIds.length === 0) return [];
    
    const modules = await indexedDBManager.getModulesByIds(topModuleIds);
    console.log('[KdbManager] modules from DB:', modules);
    return modules.map(m => this.moduleToTreeNode(m));
  }

  /**
   * Get child modules for lazy loading
   * @param parentId - Parent module ID
   */
  async getChildModules(parentId: number): Promise<TreeNode[]> {
    console.log('[KdbManager] getChildModules called for parentId:', parentId);
    if (!this.currentKdbId) return [];
    
    const parent = await indexedDBManager.getModule(parentId);
    console.log('[KdbManager] parent module:', parent);
    if (!parent || !parent.childModuleIds || parent.childModuleIds.length === 0) {
      console.log('[KdbManager] No child modules found');
      return [];
    }
    
    console.log('[KdbManager] childModuleIds:', parent.childModuleIds);
    const children = await indexedDBManager.getModulesByIds(parent.childModuleIds);
    console.log('[KdbManager] children from DB:', children);
    return children.map(m => this.moduleToTreeNode(m));
  }

  /**
   * Get module details by ID
   */
  async getModule(id: number): Promise<Module | null> {
    return indexedDBManager.getModule(id);
  }

  /**
   * Get module by full name
   */
  async getModuleByFullName(fullName: string): Promise<Module | null> {
    return indexedDBManager.getModuleByFullName(fullName);
  }

  /**
   * Get signals for a module
   * Signals are embedded in module, so this just returns module.signals
   */
  async getModuleSignals(moduleId: number): Promise<Signal[]> {
    console.log('[KdbManager] getModuleSignals called for moduleId:', moduleId);
    const module = await indexedDBManager.getModule(moduleId);
    console.log('[KdbManager] module from DB:', module);
    console.log('[KdbManager] module.signals:', module?.signals);
    return module?.signals || [];
  }

  /**
   * Get source file content by ID
   */
  async getSourceFile(id: number): Promise<SourceFile | null> {
    return indexedDBManager.getSourceFile(id);
  }

  /**
   * Get source file by path (using index lookup)
   */
  async getSourceFileByPath(path: string): Promise<SourceFile | null> {
    if (!this.currentKdbId) return null;
    
    const files = await indexedDBManager.getSourceFilesByKdb(this.currentKdbId);
    return files.find(f => f.path === path) || null;
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
    return this.currentKdbId !== null;
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
    // Clear all IndexedDB data
    await indexedDBManager.clearAll();
    console.log('[KdbManager] Cleared all data');
  }

  // ==================== Private Helpers ====================

  private moduleToTreeNode(module: Module): TreeNode {
    return {
      id: module.id,
      name: module.name,
      fullName: module.fullName,
      isInstance: module.isInstance,
      hasChildren: module.childModuleIds.length > 0,
      childModuleIds: module.childModuleIds,
    };
  }
}

// Singleton instance
export const kdbManager = new KdbManager();
