// ============================================
// IndexedDB Storage - Knowledge Base & Metadata
// ============================================
// 
// New Architecture (per interpreter-implementation.md):
// - Module.id removed, use array index + 1
// - Signal split into SignalDef and SignalInst
// - SignalInst stored in global allSignalInsts array
//

import { openDB, deleteDB, DBSchema, IDBPDatabase } from 'idb';
import type { 
  Module, 
  SignalDef,
  SourceFileInfo,
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
  // Note: 'signal-insts' store removed — signals + drivers now live in OPFS as
  // flat binary arrays (signals.bin / drivers.bin). See kdbStorage.ts.
  'source-file-info': {
    key: number;  // file id (1-based)
    value: {
      id: number;
      path: string;
      name: string;
      fullName: string;
      totalLines: number;
      kdbId: string;
    };
    indexes: { 'by-kdb': string };
  };
  // Note: source-file-content store removed - content now stored in OPFS
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
const DB_VERSION = 5;  // v5: signal-insts store removed (signals/drivers now in OPFS)

class IndexedDBManager {
  private db: IDBPDatabase<HWDBSchema> | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Check if we need to force reset (e.g., when schema changes significantly)
    const needsReset = await this.checkIfNeedsReset();
    if (needsReset) {
      console.log('[IndexedDB] Force resetting database due to schema change...');
      await this.forceReset();
    }

    this.db = await openDB<HWDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion) {
        console.log(`[IndexedDB] Upgrading from version ${oldVersion} to ${_newVersion}`);
        
        // Delete old stores if upgrading from v3 or below
        if (oldVersion < 4) {
          const storeNames = Array.from(db.objectStoreNames);
          storeNames.forEach(name => {
            try {
              console.log(`[IndexedDB] Deleting old store: ${name}`);
              db.deleteObjectStore(name);
            } catch (e) {
              // Ignore errors for non-existent stores
            }
          });
        }

        // v5: drop the signal-insts store — signals/drivers moved to OPFS.
        if (oldVersion < 5) {
          const rawDb = db as unknown as IDBDatabase;
          if (rawDb.objectStoreNames.contains('signal-insts')) {
            try {
              console.log('[IndexedDB] Deleting store: signal-insts (moved to OPFS)');
              rawDb.deleteObjectStore('signal-insts');
            } catch (e) {
              // Ignore errors for non-existent store
            }
          }
        }

        // Knowledge Base store - stores header and hierarchies
        if (!db.objectStoreNames.contains('knowledge-base')) {
          const kdbStore = db.createObjectStore('knowledge-base', { keyPath: 'id' });
          kdbStore.createIndex('by-timestamp', 'timestamp');
        }

        // Modules store - key is 1-based ID
        if (!db.objectStoreNames.contains('modules')) {
          const moduleStore = db.createObjectStore('modules', { keyPath: 'id' });
          moduleStore.createIndex('by-kdb', 'kdbId');
        }

        // Note: signal-insts store intentionally NOT created — signals + drivers
        // are stored in OPFS as flat binary arrays (signals.bin / drivers.bin).

        // Source file info store - stores metadata only (content is in OPFS)
        if (!db.objectStoreNames.contains('source-file-info')) {
          const sourceInfoStore = db.createObjectStore('source-file-info', { keyPath: 'id' });
          sourceInfoStore.createIndex('by-kdb', 'kdbId');
        }

        // Note: source-file-content store removed - content now stored in OPFS

        // Metadata store
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'key' });
        }
      },
    });

    this.initialized = true;
    console.log('[IndexedDB] Initialized successfully (v5 - signals/drivers in OPFS)');
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

  /**
   * Load module *skeletons* (navigation metadata only) for a KDB, WITHOUT the
   * heavy signalDefs arrays. This keeps the renderer's memory bounded at load
   * time — the navigation tree only needs name/parent/children/etc. Fetching all
   * modules via getAllFromIndex would instead structure-clone every SignalDef
   * (~2M objects for large designs) into JS memory at once and OOM the renderer.
   * Skipping getAllFromIndex is essential; we walk a cursor over the by-kdb index
   * and keep only the lightweight fields. For a single kdbId the index entries
   * share the same index key, so the cursor yields them in primary-key (id)
   * ascending order — i.e. out[id-1] has module id === id.
   */
  async getModuleSkeletons(kdbId: string): Promise<Module[]> {
    const db = this.getDB();
    const out: Module[] = [];
    const index = db.transaction('modules').store.index('by-kdb');
    let cursor = await index.openCursor(kdbId);
    while (cursor) {
      const r = cursor.value;
      out.push({
        name: r.name,
        parentModuleId: r.parentModuleId,
        definition: r.definition,
        signalDefs: [],
        isInstance: r.isInstance,
        childModuleIds: r.childModuleIds,
        defModuleId: r.defModuleId,
        signalInstsStartId: r.signalInstsStartId,
      } as Module);
      cursor = await cursor.continue();
    }
    return out;
  }

  /**
   * Fetch only the signalDefs for a single module, on demand. The heavy signal
   * definitions are NOT held in memory for all modules; they are pulled lazily
   * (and cached by the caller) when a module's signals are actually viewed.
   */
  async getModuleSignalDefs(moduleId: number): Promise<SignalDef[]> {
    const db = this.getDB();
    const result = await db.get('modules', moduleId);
    if (!result) return [];
    return result.signalDefs.map(def => ({
      name: def.name,
      type: def.type,
      declaration: def.declaration,
      direction: def.direction,
    }));
  }

  // ============================================
  // Signal Instance Operations
  // ============================================
  // Removed: signals + drivers now live in OPFS (signals.bin / drivers.bin),
  // read via kdbStorage.get_signals_buffer / get_drivers_by_range.

  // ============================================
  // Source File Info Operations (metadata only)
  // ============================================
  
  async storeSourceFileInfo(info: SourceFileInfo): Promise<void> {
    const db = this.getDB();
    await db.put('source-file-info', info);
  }

  async getSourceFileInfo(id: number): Promise<SourceFileInfo | null> {
    const db = this.getDB();
    return (await db.get('source-file-info', id)) || null;
  }

  async getSourceFileInfoByKdb(kdbId: string): Promise<SourceFileInfo[]> {
    const db = this.getDB();
    return await db.getAllFromIndex('source-file-info', 'by-kdb', kdbId);
  }

  // ============================================
  // Cleanup Operations
  // ============================================
  
  async clearKdbData(kdbId: string): Promise<void> {
    const db = this.getDB();

    // Fast path: truncate each object store with a single native operation
    // instead of a cursor-collect + per-record delete (which is extremely slow
    // for millions of signal instances). This app loads one KDB at a time, so
    // truncating the whole store is equivalent here.
    await db.clear('knowledge-base');
    await db.clear('modules');
    await db.clear('source-file-info');
    // Note: signals/drivers live in OPFS (cleared separately); source-file-content also in OPFS

    console.log(`[IndexedDB] Cleared data for KDB: ${kdbId}`);
  }

  /**
   * Clear all data from all stores
   */
  async clearAll(): Promise<void> {
    const db = this.getDB();
    
    await db.clear('knowledge-base');
    await db.clear('modules');
    await db.clear('source-file-info');
    // Note: signals/drivers live in OPFS (signals.bin/drivers.bin) — cleared by
    // kdbStorage.clear_kdb_data via removeEntry on the KDB's OPFS directory.
    // Note: source-file-content store removed - content is in OPFS
    await db.clear('metadata');
    
    console.log('[IndexedDB] Cleared all data');
  }

  /**
   * Check if database needs to be reset due to schema changes
   * Uses a metadata flag to track schema version
   */
  private async checkIfNeedsReset(): Promise<boolean> {
    try {
      // Try to open the database without upgrading to check current state
      const existingDb = await openDB(DB_NAME, DB_VERSION);
      
      // Check if we have the old 'source-files' store (indicates old schema)
      const hasOldStore = existingDb.objectStoreNames.contains('source-files');
      // Check if we have the deprecated 'source-file-content' store (content now in OPFS)
      const hasDeprecatedContentStore = existingDb.objectStoreNames.contains('source-file-content');
      const hasNewInfoStore = existingDb.objectStoreNames.contains('source-file-info');
      
      existingDb.close();
      
      if (hasOldStore || hasDeprecatedContentStore || !hasNewInfoStore) {
        console.log('[IndexedDB] Detected old schema, needs reset:', { hasOldStore, hasDeprecatedContentStore, hasNewInfoStore });
        return true;
      }
      
      return false;
    } catch (e) {
      // Database doesn't exist or other error, no need to reset
      return false;
    }
  }

  /**
   * Force reset the database by deleting and recreating it
   */
  private async forceReset(): Promise<void> {
    try {
      // Close current connection if any
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      
      // Delete the entire database
      await deleteDB(DB_NAME);
      console.log('[IndexedDB] Database deleted for reset');
      
      // Reset initialization flag
      this.initialized = false;
    } catch (e) {
      console.error('[IndexedDB] Error during force reset:', e);
    }
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
