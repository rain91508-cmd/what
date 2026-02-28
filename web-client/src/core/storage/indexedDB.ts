// ============================================
// IndexedDB Storage - Knowledge Base & Metadata
// ============================================
// 
// New Architecture (per interpreter-implementation.md):
// - Module.id removed, use array index + 1
// - Signal split into SignalDef and SignalInst
// - SignalInst stored in global allSignalInsts array
//

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { 
  Module, 
  SignalInst,
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
      hierarchies: DesignHierarchy[];
      timestamp: number;
    };
    indexes: { 'by-timestamp': number };
  };
  'modules': {
    key: number;  // module id (1-based, matching proto array index + 1)
    value: {
      id: number;  // 1-based ID
      name: string;
      parentModuleId: number;
      definition: {
        fileId: number;
        startLine: number;
        endLine: number;
      };
      signalDefs: {
        name: string;
        type: number;
        declaration?: {
          fileId: number;
          line: number;
        };
        direction: number;
      }[];
      isInstance: boolean;
      childModuleIds: number[];
      defModuleId: number;
      signalInstsStartId: number;
      kdbId: string;
    };
    indexes: { 
      'by-kdb': string;
    };
  };
  'signal-insts': {
    key: number;  // global index (0-based)
    value: {
      index: number;  // global index
      msb: number;
      lsb: number;
      parentModuleId: number;
      driverSignalGlobalIds: number[];
      driverLines: {
        fileId: number;
        line: number;
      }[];
      kdbId: string;
    };
    indexes: { 'by-kdb': string };
  };
  'source-files': {
    key: number;  // file id (1-based)
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
const DB_VERSION = 3;  // Increment version for new schema

class IndexedDBManager {
  private db: IDBPDatabase<HWDBSchema> | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.db = await openDB<HWDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion) {
        // Delete old stores if upgrading
        if (oldVersion < 3) {
          const storeNames = Array.from(db.objectStoreNames);
          storeNames.forEach(name => {
            try {
              db.deleteObjectStore(name);
            } catch (e) {
              // Ignore errors for non-existent stores
            }
          });
        }

        // Knowledge Base store - stores header and hierarchies
        const kdbStore = db.createObjectStore('knowledge-base', { keyPath: 'id' });
        kdbStore.createIndex('by-timestamp', 'timestamp');

        // Modules store - key is 1-based ID
        const moduleStore = db.createObjectStore('modules', { keyPath: 'id' });
        moduleStore.createIndex('by-kdb', 'kdbId');

        // Signal instances store - key is global index (0-based)
        const signalStore = db.createObjectStore('signal-insts', { keyPath: 'index' });
        signalStore.createIndex('by-kdb', 'kdbId');

        // Source files store - key is 1-based ID
        const sourceStore = db.createObjectStore('source-files', { keyPath: 'id' });
        sourceStore.createIndex('by-kdb', 'kdbId');

        // Metadata store
        db.createObjectStore('metadata', { keyPath: 'key' });
      },
    });

    this.initialized = true;
    console.log('[IndexedDB] Initialized successfully (v3)');
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
    hierarchies: DesignHierarchy[]
  ): Promise<void> {
    const db = this.getDB();
    await db.put('knowledge-base', {
      id,
      header,
      hierarchies,
      timestamp: Date.now(),
    });
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

  // ============================================
  // Module Operations
  // ============================================
  
  async storeModule(module: Module, kdbId: string): Promise<void> {
    const db = this.getDB();
    const id = this.getModuleId(module, kdbId);
    await db.put('modules', {
      id,
      name: module.name,
      parentModuleId: module.parentModuleId,
      definition: module.definition,
      signalDefs: module.signalDefs.map(def => ({
        name: def.name,
        type: def.type,
        declaration: def.declaration,
        direction: def.direction,
      })),
      isInstance: module.isInstance,
      childModuleIds: module.childModuleIds,
      defModuleId: module.defModuleId,
      signalInstsStartId: module.signalInstsStartId,
      kdbId,
    });
  }

  async getModule(id: number): Promise<Module | null> {
    const db = this.getDB();
    const result = await db.get('modules', id);
    if (!result) return null;
    const { kdbId, ...module } = result;
    return {
      ...module,
      signalDefs: module.signalDefs.map(def => ({
        name: def.name,
        type: def.type,
        declaration: def.declaration,
        direction: def.direction,
      })),
    } as Module;
  }

  async getAllModules(kdbId: string): Promise<Module[]> {
    const db = this.getDB();
    const results = await db.getAllFromIndex('modules', 'by-kdb', kdbId);
    return results
      .sort((a, b) => a.id - b.id)
      .map(r => {
        const { kdbId, ...module } = r;
        return {
          ...module,
          signalDefs: module.signalDefs.map(def => ({
            name: def.name,
            type: def.type,
            declaration: def.declaration,
            direction: def.direction,
          })),
        } as Module;
      });
  }

  // ============================================
  // Signal Instance Operations
  // ============================================
  
  async storeSignalInst(inst: SignalInst, globalIndex: number, kdbId: string): Promise<void> {
    const db = this.getDB();
    await db.put('signal-insts', {
      index: globalIndex,
      msb: inst.msb,
      lsb: inst.lsb,
      parentModuleId: inst.parentModuleId,
      driverSignalGlobalIds: inst.driverSignalGlobalIds,
      driverLines: inst.driverLines,
      kdbId,
    });
  }

  async getSignalInst(globalIndex: number): Promise<SignalInst | null> {
    const db = this.getDB();
    const result = await db.get('signal-insts', globalIndex);
    if (!result) return null;
    const { kdbId, index, ...inst } = result;
    return inst as SignalInst;
  }

  async getAllSignalInsts(kdbId: string): Promise<SignalInst[]> {
    const db = this.getDB();
    const results = await db.getAllFromIndex('signal-insts', 'by-kdb', kdbId);
    return results
      .sort((a, b) => a.index - b.index)
      .map(r => {
        const { kdbId, index, ...inst } = r;
        return inst as SignalInst;
      });
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

    // Clear signal instances
    const signalIndex = db.transaction('signal-insts').store.index('by-kdb');
    let signalCursor = await signalIndex.openCursor(kdbId);
    const signalIndices: number[] = [];
    while (signalCursor) {
      signalIndices.push(signalCursor.value.index);
      signalCursor = await signalCursor.continue();
    }
    for (const idx of signalIndices) {
      await db.delete('signal-insts', idx);
    }

    // Clear source files
    const fileIndex = db.transaction('source-files').store.index('by-kdb');
    let fileCursor = await fileIndex.openCursor(kdbId);
    const fileIds: number[] = [];
    while (fileCursor) {
      fileIds.push(fileCursor.value.id);
      fileCursor = await fileCursor.continue();
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
    
    await db.clear('knowledge-base');
    await db.clear('modules');
    await db.clear('signal-insts');
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

  // ============================================
  // Private Helpers
  // ============================================
  
  private moduleIdMap = new Map<string, number>();
  private nextModuleId = 1;

  private getModuleId(module: Module, kdbId: string): number {
    const key = `${kdbId}:${module.name}:${module.parentModuleId}`;
    if (!this.moduleIdMap.has(key)) {
      this.moduleIdMap.set(key, this.nextModuleId++);
    }
    return this.moduleIdMap.get(key)!;
  }
}

export const indexedDBManager = new IndexedDBManager();
