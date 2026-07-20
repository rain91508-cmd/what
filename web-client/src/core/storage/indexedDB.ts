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
  // Note: 'modules' store removed — module skeletons + signal definitions now
  // live in OPFS as flat binary files (modules.bin / module_signal_defs.bin).
  // See kdbStorage.ts. They are read via kdbStorage.get_module_skeletons /
  // get_module_signal_defs, not IndexedDB.
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
  // Heavy per-256-line byte offsets used only for on-demand line seeking when a
  // file is opened. Kept separate from `source-file-info` so the Files tab (which
  // reads `source-file-info`) NEVER materialises these large arrays into memory.
  'source-file-line-index': {
    key: number;  // file id (1-based)
    value: {
      id: number;
      lineIndexOffset: number[];
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
const DB_VERSION = 7;  // v7: modules store dropped — module data moved to OPFS (modules.bin / module_signal_defs.bin)

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

        // v7: drop the modules store — modules + signal definitions moved to OPFS
        // (modules.bin / module_signal_defs.bin). See kdbStorage.ts.
        if (oldVersion < 7) {
          const rawDb = db as unknown as IDBDatabase;
          if (rawDb.objectStoreNames.contains('modules')) {
            try {
              console.log('[IndexedDB] Deleting store: modules (moved to OPFS)');
              rawDb.deleteObjectStore('modules');
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

        // Note: signal-insts store intentionally NOT created — signals + drivers
        // are stored in OPFS as flat binary arrays (signals.bin / drivers.bin).

        // Source file info store - stores metadata only (content is in OPFS)
        if (!db.objectStoreNames.contains('source-file-info')) {
          const sourceInfoStore = db.createObjectStore('source-file-info', { keyPath: 'id' });
          sourceInfoStore.createIndex('by-kdb', 'kdbId');
        }

        // Source file line-offset index: the heavy per-256-line byte offsets used
        // only for on-demand line seeking when a file is opened. Kept in its own
        // store so the lightweight `source-file-info` (Files tab) never loads them.
        if (!db.objectStoreNames.contains('source-file-line-index')) {
          const lineIdxStore = db.createObjectStore('source-file-line-index', { keyPath: 'id' });
          lineIdxStore.createIndex('by-kdb', 'kdbId');
        }

        // Note: source-file-content store removed - content now stored in OPFS

        // Metadata store
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'key' });
        }
      },
    });

    this.initialized = true;
    console.log('[IndexedDB] Initialized successfully (v6 - line-index split into its own store)');
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
  // Module Operations — REMOVED (now in OPFS)
  // ============================================
  // Modules + signal definitions now live in OPFS as flat binary files
  // (modules.bin / module_signal_defs.bin). They are read via
  // kdbStorage.get_module_skeletons / get_module_signal_defs, invoked directly
  // by kdbManager (not through this IndexedDB manager).

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

  async storeSourceFileLineIndex(id: number, lineIndexOffset: number[], kdbId: string): Promise<void> {
    const db = this.getDB();
    await db.put('source-file-line-index', { id, lineIndexOffset, kdbId });
  }

  /**
   * Fetch the heavy per-256-line byte-offset index for a single file. Used only
   * when a source file is actually opened (line seeking). Stored separately from
   * `source-file-info` so the Files tab never loads it.
   */
  async getSourceFileLineIndex(id: number): Promise<number[]> {
    const db = this.getDB();
    const rec = await db.get('source-file-line-index', id);
    return (rec && (rec as any).lineIndexOffset) || [];
  }

  /**
   * Load source-file *skeletons* (id/path/name/fullName/totalLines only) for a
   * KDB. The Files tab only needs the file name/path to render the list and must
   * NEVER load the heavy `lineIndexOffset` arrays (now stored separately in
   * `source-file-line-index` and only read when a file is actually opened).
   *
   * This method is strictly cursor-based: it never calls `getAll`, which would
   * structure-clone every file's `lineIndexOffset` (tens of thousands of u32s per
   * file × thousands of files) into JS memory at once and OOM the renderer
   * (~1.6 GB on large designs). Walking a cursor and keeping only the lightweight
   * fields keeps the peak footprint at one record's worth of data.
   */
  async getSourceFileInfoSkeletons(kdbId: string): Promise<SourceFileInfo[]> {
    const db = this.getDB();
    const out: SourceFileInfo[] = [];
    const seen = new Set<number>();
    const collect = (r: any): void => {
      if (!r || seen.has(r.id)) return;
      seen.add(r.id);
      out.push({
        id: r.id,
        path: r.path,
        name: r.name,
        fullName: r.fullName,
        totalLines: r.totalLines,
        kdbId: r.kdbId,
      });
    };

    // Primary (fast + memory-friendly): walk a cursor over the by-kdb index.
    // `source-file-info` no longer carries `lineIndexOffset`, so each value is
    // tiny; the cursor keeps at most one record in memory at a time.
    try {
      const index = db.transaction('source-file-info').store.index('by-kdb');
      let cursor = await index.openCursor(kdbId);
      while (cursor) {
        collect(cursor.value as any);
        cursor = await cursor.continue();
      }
      if (out.length > 0) return out;
    } catch (e) {
      console.warn('[IndexedDB] source-file-info index cursor failed, falling back to full-store scan:', e);
    }

    // Fallback 1: scan the whole store one record at a time, filtering by kdbId
    // in JS. Does not depend on the `by-kdb` index, so it works against a
    // pre-existing DB whose store predates the index. Memory-safe: we keep only
    // the lightweight fields, dropping any `lineIndexOffset` per record.
    try {
      const store = db.transaction('source-file-info').store;
      let cursor = await store.openCursor();
      while (cursor) {
        const r = cursor.value as any;
        if (r && r.kdbId === kdbId) collect(r);
        cursor = await cursor.continue();
      }
      if (out.length > 0) return out;
    } catch (e) {
      console.warn('[IndexedDB] source-file-info full-store scan failed:', e);
    }

    // Last resort: cursor-scan the entire store without a kdbId filter. Still
    // memory-safe (per-record drop) and only reached when the kdbId-filtered
    // scans matched nothing (e.g. a kdbId/index edge case). Returns the lightweight
    // skeletons only, so memory stays bounded — never the heavy offset arrays.
    try {
      const store = db.transaction('source-file-info').store;
      let cursor = await store.openCursor();
      while (cursor) {
        collect(cursor.value as any);
        cursor = await cursor.continue();
      }
      if (out.length > 0) {
        console.warn(
          `[IndexedDB] source-file-info: kdbId-filtered scans matched 0; returning all ${out.length} skeletons (possible kdbId/index mismatch)`
        );
      }
    } catch (e) {
      console.warn('[IndexedDB] source-file-info last-resort scan failed:', e);
    }
    return out;
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
    await db.clear('source-file-info');
    await db.clear('source-file-line-index');
    // Note: signals/drivers live in OPFS (cleared separately); source-file-content also in OPFS

    console.log(`[IndexedDB] Cleared data for KDB: ${kdbId}`);
  }

  /**
   * Clear all data from all stores
   */
  async clearAll(): Promise<void> {
    const db = this.getDB();
    
    await db.clear('knowledge-base');
    await db.clear('source-file-info');
    await db.clear('source-file-line-index');
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
      // Open at the CURRENT version (no version arg) purely to inspect the schema.
      // IMPORTANT: never pass DB_VERSION here — opening an older DB at a higher
      // version with no upgrade callback silently bumps the version WITHOUT
      // creating the new stores, after which the real initialize() open sees a
      // matching version, skips the upgrade, and the stores are missing forever.
      const existingDb = await openDB(DB_NAME);

      // Check if we have the old 'source-files' store (indicates old schema)
      const hasOldStore = existingDb.objectStoreNames.contains('source-files');
      // Check if we have the deprecated 'source-file-content' store (content now in OPFS)
      const hasDeprecatedContentStore = existingDb.objectStoreNames.contains('source-file-content');
      const hasNewInfoStore = existingDb.objectStoreNames.contains('source-file-info');
      // The line-offset index store must exist too (added alongside the split).
      const hasLineIndexStore = existingDb.objectStoreNames.contains('source-file-line-index');

      existingDb.close();

      if (hasOldStore || hasDeprecatedContentStore || !hasNewInfoStore || !hasLineIndexStore) {
        console.log('[IndexedDB] Detected outdated/incomplete schema, needs reset:', {
          hasOldStore,
          hasDeprecatedContentStore,
          hasNewInfoStore,
          hasLineIndexStore,
        });
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
}

export const indexedDBManager = new IndexedDBManager();
