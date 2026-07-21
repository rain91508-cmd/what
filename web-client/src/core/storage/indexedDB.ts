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
import { isOpfsAvailable } from '../../utils/opfsUtils';
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
const DB_VERSION = 8;  // v8: source-file-content dropped if lingering + reclaim tombstoned
                       // LevelDB space left by prior heavy stores (signal-insts / modules
                       // / source-file-content once lived in IDB; deleteObjectStore does
                       // not free the physical .blob bytes, so a real deleteDatabase is
                       // performed when such a store is dropped).

class IndexedDBManager {
  private db: IDBPDatabase<HWDBSchema> | null = null;
  private initialized = false;

  // The source-file stores are written as ONE bundled record per KDB (see
  // kdbStorage.flushBatch) because this IDB backend costs ~0.4s per put(). We
  // cache the unpacked bundle per kdbId so the per-file reads below are O(1)
  // and never re-read the whole blob. Invalidated on clear.
  private _activeKdbId = '';
  private _infoListCache = new Map<string, SourceFileInfo[]>();
  private _infoMapCache = new Map<string, Map<number, SourceFileInfo>>();
  private _lineIdxCache = new Map<string, Map<number, number[]>>();

  /** Record which KDB is currently being written/read (set by the flush path). */
  setActiveKdb(kdbId: string): void {
    this._activeKdbId = kdbId;
  }

  async initialize(): Promise<void> {
    if (this.initialized && this.db) return;

    // 1. Schema-level hard reset: if the stored DB is missing a current store
    //    (e.g. an old/incomplete schema), wipe and recreate it entirely.
    const needsReset = await this.checkIfNeedsReset();
    if (needsReset) {
      console.log('[IndexedDB] Force resetting database due to schema change...');
      await this.forceReset();
    }

    // Track the origin version + whether we dropped a store that may have held
    // large BLOB data, so we can reclaim the tombstoned LevelDB space afterwards.
    let upgradedFrom = 0;
    let droppedHeavyStore = false;

    this.db = await openDB<HWDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion) {
        upgradedFrom = oldVersion;
        console.log(`[IndexedDB] Upgrading from version ${oldVersion} to ${_newVersion}`);

        // Delete old stores if upgrading from v3 or below. These could contain
        // multi-GB BLOB data (e.g. source-file-content); flag for reclaim.
        if (oldVersion < 4) {
          const storeNames = Array.from(db.objectStoreNames);
          storeNames.forEach(name => {
            try {
              console.log(`[IndexedDB] Deleting old store: ${name}`);
              db.deleteObjectStore(name);
              droppedHeavyStore = true;
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
              droppedHeavyStore = true;
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
              droppedHeavyStore = true;
            } catch (e) {
              // Ignore errors for non-existent store
            }
          }
        }

        // v8: drop the deprecated source-file-content store if it still lingers.
        // Older upgrades only deleted it under oldVersion < 4, so a v4+ DB may
        // still carry its multi-GB BLOBs. Removing it here flags a reclaim so the
        // physical .blob/.leveldb bytes are finally freed.
        if (oldVersion < 8) {
          const rawDb = db as unknown as IDBDatabase;
          if (rawDb.objectStoreNames.contains('source-file-content')) {
            try {
              console.log('[IndexedDB] Deleting store: source-file-content (moved to OPFS)');
              rawDb.deleteObjectStore('source-file-content');
              droppedHeavyStore = true;
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

    // Cooperatively close if another context (e.g. the worker, or a sibling tab)
    // deletes this DB to reclaim tombstoned space. Without this, deleteDatabase
    // would block forever on our open connection and the reclaim would hang.
    this.db.onversionchange = () => {
      try { this.db?.close(); } catch { /* ignore */ }
      this.db = null;
      this.initialized = false;
    };

    this.initialized = true;
    console.log(`[IndexedDB] Initialized successfully (v${DB_VERSION})`);

    // Reclaim tombstoned LevelDB space. deleteObjectStore only removes records
    // *logically* — Chromium never frees the underlying .blob/.leveldb bytes, so a
    // DB that once held 2M signal instances or GBs of source content stays 15 GB
    // on disk forever. A real deleteDatabase is the only way to reclaim it, and it
    // must run after the connection that did the deletes is closed.
    //
    // Trigger when:
    //   - we actually dropped a heavy store this upgrade, OR
    //   - we upgraded from any pre-v8 schema (one-time reclaim of the space left
    //     by the old v4 "delete-all-stores" migration, which never compacted).
    const needsReclaim = droppedHeavyStore || (upgradedFrom >= 1 && upgradedFrom < DB_VERSION);
    if (needsReclaim) {
      console.log('[IndexedDB] Reclaiming tombstoned storage from dropped heavy store(s)...');
      await this.forceReset();
      // Reopen fresh. The recreated DB starts at version 0, so upgradedFrom becomes
      // 0 and no further reclaim runs (no infinite loop) — the stale 15 GB is gone.
      await this.initialize();
    }
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
    // Prefer the OPFS header.json (persisted by kdbStorage.store_knowledge_base),
    // which survives clear_kdb_data (that only removes the specific KDB's IDB
    // record). Falls back to the IndexedDB `knowledge-base` store.
    if (isOpfsAvailable()) {
      const opfsHeader = await this.readOpfsHeader(id);
      if (opfsHeader) return opfsHeader;
    }
    const db = this.getDB();
    const result = await db.get('knowledge-base', id);
    return result?.header || null;
  }

  /**
   * Read a cached KDB's header.json from OPFS. Returns null when OPFS is
   * unavailable or the file does not exist (e.g. a legacy cache).
   */
  private async readOpfsHeader(id: string): Promise<{ version: string; projectName: string; createdAt: string } | null> {
    try {
      const root = await navigator.storage.getDirectory();
      const kdbParent = await root.getDirectoryHandle('kdb', { create: false });
      const kdbDir = await kdbParent.getDirectoryHandle(id, { create: false });
      const fh = await kdbDir.getFileHandle('header.json', { create: false });
      const file = await fh.getFile();
      const parsed = JSON.parse(await file.text());
      return parsed?.header || null;
    } catch {
      return null;
    }
  }

  /**
   * Enumerate every cached KDB directory under OPFS `kdb/`. This is the
   * authoritative list of locally cached KDBs because the OPFS directory
   * persists independently of the per-KDB IndexedDB clears. Legacy caches that
   * predate header.json are still listed (provided their real data exists), so
   * they are not lost; only directories without a `modules.bin` are skipped.
   */
  private async listOpfsKdbHeaders(): Promise<Array<{ id: string; header: { version: string; projectName: string; createdAt: string }; timestamp: number }>> {
    if (!isOpfsAvailable()) return [];
    try {
      const root = await navigator.storage.getDirectory();
      const kdbParent = await root.getDirectoryHandle('kdb', { create: false });
      const out: Array<{ id: string; header: { version: string; projectName: string; createdAt: string }; timestamp: number }> = [];
      const entries = (kdbParent as any).entries ? (kdbParent as any).entries() : null;
      if (!entries) return [];
      for await (const [name, handle] of entries) {
        if (!handle || (handle as any).kind !== 'directory') continue;
        let header: { version: string; projectName: string; createdAt: string } | null = null;
        let timestamp = 0;
        try {
          const fh = await (handle as any).getFileHandle('header.json', { create: false });
          const file = await fh.getFile();
          const parsed = JSON.parse(await file.text());
          header = parsed?.header || null;
          timestamp = parsed?.timestamp || file.lastModified || 0;
        } catch {
          // Legacy cache without header.json: keep it only if real KDB data is
          // present, so an empty/stale directory never shows up in the list.
          try {
            await (handle as any).getFileHandle('modules.bin', { create: false });
          } catch {
            continue;
          }
        }
        out.push({
          id: name,
          header: header || { version: '', projectName: '', createdAt: '' },
          timestamp,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Whether a KDB is actually cached locally. Checks OPFS first (the real data
   * lives there), then falls back to the IndexedDB `knowledge-base` store.
   */
  async knowledgeBaseExists(kdbId: string): Promise<boolean> {
    if (isOpfsAvailable()) {
      try {
        const root = await navigator.storage.getDirectory();
        const kdbParent = await root.getDirectoryHandle('kdb', { create: false });
        const kdbDir = await kdbParent.getDirectoryHandle(kdbId, { create: false });
        await kdbDir.getFileHandle('modules.bin', { create: false });
        return true;
      } catch {
        return false;
      }
    }
    const db = this.getDB();
    const r = await db.get('knowledge-base', kdbId);
    return !!r;
  }

  async getKnowledgeBaseHierarchies(id: string): Promise<DesignHierarchy[] | null> {
    const db = this.getDB();
    const result = await db.get('knowledge-base', id);
    return result?.hierarchies || null;
  }

  /**
   * List every cached KDB recorded in the `knowledge-base` store (the local
   * IDB/OPFS cache). Returns lightweight summaries (id + header + timestamp) so
   * the "Open Cached KDB" dialog can present a selection list without loading
   * any heavy data. Sorted most-recently-stored first.
   */
  async listKnowledgeBases(): Promise<Array<{ id: string; header: { version: string; projectName: string; createdAt: string }; timestamp: number }>> {
    // The OPFS `kdb/` directory is the authoritative source of cached KDBs: it
    // persists independently of the per-KDB IndexedDB clears, so it reflects all
    // KDBs the user has ever cached (not just the most recently loaded one).
    const opfsList = await this.listOpfsKdbHeaders();
    const merged = new Map<string, { id: string; header: { version: string; projectName: string; createdAt: string }; timestamp: number }>();
    for (const o of opfsList) merged.set(o.id, o);

    // Merge any IndexedDB-only records (e.g. when OPFS is unavailable).
    try {
      const db = this.getDB();
      const all = await db.getAll('knowledge-base');
      for (const r of (all || [])) {
        if (!merged.has(r.id)) {
          merged.set(r.id, { id: r.id, header: r.header, timestamp: r.timestamp || 0 });
        }
      }
    } catch { /* ignore */ }

    return Array.from(merged.values()).sort((a, b) => b.timestamp - a.timestamp);
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
    // The active write path is the worker's kdbStorage.store_source_file_info
    // (all files bundled into one record per KDB). This per-record helper is
    // kept for compatibility and routes into the same bundle so reads stay
    // consistent. It is O(records) per call, so only use it for small inputs.
    const db = this.getDB();
    const kdbId = info.kdbId || this._activeKdbId;
    const existing: SourceFileInfo[] = (await (db as any).get('source-file-info', kdbId))?.records || [];
    existing.push(info);
    await (db as any).put('source-file-info', { id: kdbId, kdbId, records: existing });
    this._infoListCache.delete(kdbId);
    this._infoMapCache.delete(kdbId);
  }

  async getSourceFileInfo(id: number, kdbId?: string | null): Promise<SourceFileInfo | null> {
    const map = await this.getInfoMap(kdbId || this._activeKdbId);
    return map.get(id) || null;
  }

  async getSourceFileInfoByKdb(kdbId: string): Promise<SourceFileInfo[]> {
    return this.getInfoList(kdbId);
  }

  async storeSourceFileLineIndex(id: number, lineIndexOffset: number[], kdbId: string): Promise<void> {
    const db = this.getDB();
    const existing: { id: number; lineIndexOffset: number[]; kdbId: string }[] =
      (await (db as any).get('source-file-line-index', kdbId))?.records || [];
    existing.push({ id, lineIndexOffset, kdbId });
    await (db as any).put('source-file-line-index', { id: kdbId, kdbId, records: existing });
    this._lineIdxCache.delete(kdbId);
  }

  /**
   * Fetch the heavy per-256-line byte-offset index for a single file. Used only
   * when a source file is actually opened (line seeking). The whole per-KDB
   * bundle is read once and cached (keyed by kdbId), then this is an O(1) map
   * lookup — so opening a file never re-reads all 483 files' offsets.
   */
  async getSourceFileLineIndex(id: number, kdbId?: string | null): Promise<number[]> {
    const k = kdbId || this._activeKdbId;
    let map = this._lineIdxCache.get(k);
    if (!map) {
      const rec = await (this.getDB() as any).get('source-file-line-index', k);
      map = new Map<number, number[]>();
      for (const r of (rec?.records || []) as { id: number; lineIndexOffset: number[] }[]) {
        map.set(r.id, r.lineIndexOffset);
      }
      this._lineIdxCache.set(k, map);
    }
    return map.get(id) || [];
  }

  /**
   * Load source-file *skeletons* (id/path/name/fullName/totalLines only) for a
   * KDB. The Files tab only needs the file name/path to render the list and must
   * NEVER load the heavy `lineIndexOffset` arrays (now stored separately in
   * `source-file-line-index` and only read when a file is actually opened).
   *
   * The bundle is read once and cached per kdbId, so this is a single IDB get()
   * (the JSON/structured-clone of the lightweight metadata only — the heavy
   * line-offset arrays are in the separate store and not materialised here).
   */
  async getSourceFileInfoSkeletons(kdbId: string): Promise<SourceFileInfo[]> {
    return this.getInfoList(kdbId);
  }

  private async getInfoList(kdbId: string): Promise<SourceFileInfo[]> {
    if (this._infoListCache.has(kdbId)) return this._infoListCache.get(kdbId)!;
    const rec = await (this.getDB() as any).get('source-file-info', kdbId);
    const list: SourceFileInfo[] = rec?.records || [];
    this._infoListCache.set(kdbId, list);
    return list;
  }

  private async getInfoMap(kdbId: string): Promise<Map<number, SourceFileInfo>> {
    if (this._infoMapCache.has(kdbId)) return this._infoMapCache.get(kdbId)!;
    const list = await this.getInfoList(kdbId);
    const map = new Map<number, SourceFileInfo>();
    for (const r of list) map.set(r.id, r);
    this._infoMapCache.set(kdbId, map);
    return map;
  }

  // ============================================
  // Cleanup Operations
  // ============================================
  
  async clearKdbData(kdbId: string): Promise<void> {
    const db = this.getDB();

    // Delete ONLY this KDB's records (the stores are keyed per KDB: `knowledge-
    // base` and `source-file-info` use the kdbId as the primary key, and
    // `source-file-line-index` is keyed by kdbId too). This keeps other cached
    // KDBs available in the "Open Cached KDB" dialog — matching the OPFS
    // behaviour, where only the specific `kdb/<id>` directory is removed.
    // (Older code used db.clear() which wiped every cached KDB at once.)
    await db.delete('knowledge-base', kdbId);
    // `source-file-info` records are keyed by the kdbId string at runtime, though
    // its TS schema declares a numeric key. Cast to bypass the schema mismatch
    // and delete only this KDB's metadata (the active read paths filter by kdbId).
    await (db as any).delete('source-file-info', kdbId);
    // `source-file-line-index` is legacy (its data moved to OPFS) and its store
    // key is numeric, so a per-kdbId delete would not type-check / match. Clear
    // it wholesale — it is not used by the active (OPFS-backed) read paths.
    await db.clear('source-file-line-index');
    // Drop cached source-file bundles for this KDB so the next load re-reads.
    this._infoListCache.delete(kdbId);
    this._infoMapCache.delete(kdbId);
    this._lineIdxCache.delete(kdbId);
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
    this._infoListCache.clear();
    this._infoMapCache.clear();
    this._lineIdxCache.clear();
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
