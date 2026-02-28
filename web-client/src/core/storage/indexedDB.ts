// ============================================
// IndexedDB Storage - Knowledge Base & Metadata
// ============================================
// 
// New Architecture (per kdb-refactor-plan.md):
// - Store KDB data in hierarchical structure matching proto
// - Support on-demand loading
// - Use numeric IDs as keys (matching KDB proto)

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { 
  KnowledgeBase, 
  Module, 
  Signal, 
  SourceFile,
  DesignHierarchy 
} from '../../types/kdb';

// New schema matching KDB proto structure
interface HWDBSchema extends DBSchema {
  'knowledge-base': {
    key: string;
    value: {
      id: string;
      header: {
        version: string;
        projectName: string;
        createdAt: string;
      };
      topModuleIds: number[];
      hierarchies: DesignHierarchy[];
      timestamp: number;
    };
    indexes: { 'by-timestamp': number };
  };
  'modules': {
    key: number;  // module id (numeric, matching proto)
    value: {
      id: number;
      name: string;
      fullName: string;
      parentModuleId: number;
      fileId: number;
      isInstance: boolean;
      signals: Signal[];
      childModuleIds: number[];
      kdbId: string;
    };
    indexes: { 
      'by-kdb': string;
      'by-full-name': string;
    };
  };
  'source-files': {
    key: number;  // file id (numeric, matching proto)
    value: {
      id: number;
      path: string;
      content: string;
      kdbId: string;
      timestamp: number;
    };
    indexes: { 'by-kdb': string };
  };
  'metadata': {
    key: string;
    value: {
      key: string;
      value: unknown;
      timestamp: number;
    };
  };
}

const DB_NAME = 'hwda-database';
const DB_VERSION = 2;  // Increment version for schema change

class IndexedDBManager {
  private db: IDBPDatabase<HWDBSchema> | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.db = await openDB<HWDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion) {
        // Delete old stores if upgrading from v1
        if (oldVersion < 2) {
          // Delete old stores
          if (db.objectStoreNames.contains('signals')) {
            db.deleteObjectStore('signals');
          }
          if (db.objectStoreNames.contains('instances')) {
            db.deleteObjectStore('instances');
          }
          if (db.objectStoreNames.contains('modules')) {
            db.deleteObjectStore('modules');
          }
          if (db.objectStoreNames.contains('knowledge-base')) {
            db.deleteObjectStore('knowledge-base');
          }
          if (db.objectStoreNames.contains('source-files')) {
            db.deleteObjectStore('source-files');
          }
        }

        // Knowledge Base store - stores header and hierarchies only
        const kdbStore = db.createObjectStore('knowledge-base', { keyPath: 'id' });
        kdbStore.createIndex('by-timestamp', 'timestamp');

        // Modules store - key is numeric id (matching proto)
        const moduleStore = db.createObjectStore('modules', { keyPath: 'id' });
        moduleStore.createIndex('by-kdb', 'kdbId');
        moduleStore.createIndex('by-full-name', 'fullName');

        // Source files store - key is numeric id (matching proto)
        const sourceStore = db.createObjectStore('source-files', { keyPath: 'id' });
        sourceStore.createIndex('by-kdb', 'kdbId');

        // Metadata store
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'key' });
        }
      },
    });

    this.initialized = true;
    console.log('[IndexedDB] Initialized successfully (v2)');
  }

  isInitialized(): boolean {
    return this.initialized && this.db !== null;
  }

  private getDB(): IDBPDatabase<HWDBSchema> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }
    return this.db;
  }

  // ============================================
  // Knowledge Base Operations
  // ============================================
  
  async storeKnowledgeBase(
    id: string,
    header: { version: string; projectName: string; createdAt: string },
    topModuleIds: number[],
    hierarchies: DesignHierarchy[]
  ): Promise<void> {
    const db = this.getDB();
    await db.put('knowledge-base', {
      id,
      header,
      topModuleIds,
      hierarchies,
      timestamp: Date.now(),
    });
  }

  async getKnowledgeBase(id: string): Promise<{
    header: { version: string; projectName: string; createdAt: string };
    topModuleIds: number[];
    hierarchies: DesignHierarchy[];
  } | null> {
    const db = this.getDB();
    const result = await db.get('knowledge-base', id);
    if (!result) return null;
    return {
      header: result.header,
      topModuleIds: result.topModuleIds,
      hierarchies: result.hierarchies,
    };
  }

  async getKnowledgeBaseHeader(id: string): Promise<{ version: string; projectName: string; createdAt: string } | null> {
    const db = this.getDB();
    const result = await db.get('knowledge-base', id);
    return result?.header || null;
  }

  async getKnowledgeBaseHierarchies(id: string): Promise<DesignHierarchy[] | null> {
    const db = this.getDB();
    const result = await db.get('knowledge-base', id);
    return result?.hierarchies || null;
  }

  async getTopModuleIds(id: string): Promise<number[] | null> {
    console.log('[IndexedDBManager] getTopModuleIds for:', id);
    const db = this.getDB();
    const result = await db.get('knowledge-base', id);
    console.log('[IndexedDBManager] knowledge-base result:', result);
    return result?.topModuleIds || null;
  }

  // ============================================
  // Module Operations
  // ============================================
  
  async storeModule(module: Module, kdbId: string): Promise<void> {
    const db = this.getDB();
    await db.put('modules', {
      ...module,
      kdbId,
    });
  }

  async getModule(id: number): Promise<Module | null> {
    const db = this.getDB();
    const result = await db.get('modules', id);
    if (!result) return null;
    const { kdbId, ...module } = result;
    return module as Module;
  }

  async getModulesByIds(ids: number[]): Promise<Module[]> {
    const db = this.getDB();
    const modules: Module[] = [];
    for (const id of ids) {
      const result = await db.get('modules', id);
      if (result) {
        const { kdbId, ...module } = result;
        modules.push(module as Module);
      }
    }
    return modules;
  }

  async getModulesByKdb(kdbId: string): Promise<Module[]> {
    const db = this.getDB();
    const results = await db.getAllFromIndex('modules', 'by-kdb', kdbId);
    return results.map(r => {
      const { kdbId, ...module } = r;
      return module as Module;
    });
  }

  async getModuleByFullName(fullName: string): Promise<Module | null> {
    const db = this.getDB();
    const result = await db.getFromIndex('modules', 'by-full-name', fullName);
    if (!result) return null;
    const { kdbId, ...module } = result;
    return module as Module;
  }

  // ============================================
  // Source File Operations
  // ============================================
  
  async storeSourceFile(file: SourceFile, kdbId: string): Promise<void> {
    const db = this.getDB();
    await db.put('source-files', {
      ...file,
      kdbId,
      timestamp: Date.now(),
    });
  }

  async getSourceFile(id: number): Promise<SourceFile | null> {
    const db = this.getDB();
    const result = await db.get('source-files', id);
    if (!result) return null;
    const { kdbId, timestamp, ...file } = result;
    return file as SourceFile;
  }

  async getSourceFilesByKdb(kdbId: string): Promise<SourceFile[]> {
    const db = this.getDB();
    const results = await db.getAllFromIndex('source-files', 'by-kdb', kdbId);
    return results.map(r => {
      const { kdbId, timestamp, ...file } = r;
      return file as SourceFile;
    });
  }

  // ============================================
  // Cleanup Operations
  // ============================================
  
  async clearKdbData(kdbId: string): Promise<void> {
    const db = this.getDB();

    // Clear knowledge base
    await db.delete('knowledge-base', kdbId);

    // Clear modules
    const moduleIndex = db.transaction('modules').store.index('by-kdb');
    let cursor = await moduleIndex.openCursor(kdbId);
    const moduleIds: number[] = [];
    while (cursor) {
      moduleIds.push(cursor.value.id);
      cursor = await cursor.continue();
    }
    for (const id of moduleIds) {
      await db.delete('modules', id);
    }

    // Clear source files
    const fileIndex = db.transaction('source-files').store.index('by-kdb');
    cursor = await fileIndex.openCursor(kdbId);
    const fileIds: number[] = [];
    while (cursor) {
      fileIds.push(cursor.value.id);
      cursor = await cursor.continue();
    }
    for (const id of fileIds) {
      await db.delete('source-files', id);
    }

    console.log(`[IndexedDB] Cleared data for KDB: ${kdbId}`);
  }

  /**
   * Clear all data from all stores
   */
  async clearAll(): Promise<void> {
    const db = this.getDB();
    
    // Clear all stores
    await db.clear('knowledge-base');
    await db.clear('modules');
    await db.clear('source-files');
    await db.clear('metadata');
    
    console.log('[IndexedDB] Cleared all data');
  }

  // ============================================
  // Metadata Operations
  // ============================================
  
  async setMetadata(key: string, value: unknown): Promise<void> {
    const db = this.getDB();
    await db.put('metadata', {
      key,
      value,
      timestamp: Date.now(),
    });
  }

  async getMetadata(key: string): Promise<unknown | null> {
    const db = this.getDB();
    const result = await db.get('metadata', key);
    return result?.value || null;
  }
}

export const indexedDBManager = new IndexedDBManager();
