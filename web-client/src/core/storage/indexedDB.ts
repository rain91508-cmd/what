// ============================================
// IndexedDB Storage - Knowledge Base & Metadata
// ============================================
// 
// Responsibilities (per spec.md & hint3.md):
// - Store Knowledge Base (.kdb) metadata
// - Store design metadata (signal index, module info, hierarchy)
// - Store source file cache
// - Support structured queries and indexing

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { KnowledgeBase, Signal, Module, Instance } from '../../types';

interface HWDBSchema extends DBSchema {
  'knowledge-base': {
    key: string;
    value: {
      id: string;
      version: number;
      data: KnowledgeBase;
      checksum: string;
      timestamp: number;
    };
    indexes: { 'by-version': number; 'by-timestamp': number };
  };
  'signals': {
    key: string;
    value: {
      fullPath: string;
      signal: Signal;
      kdbId: string;
    };
    indexes: { 'by-kdb': string; 'by-name': string };
  };
  'modules': {
    key: string;
    value: {
      name: string;
      module: Module;
      kdbId: string;
    };
    indexes: { 'by-kdb': string };
  };
  'instances': {
    key: string;
    value: {
      fullPath: string;
      instance: Instance;
      kdbId: string;
    };
    indexes: { 'by-kdb': string; 'by-parent': string };
  };
  'source-files': {
    key: string;
    value: {
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
const DB_VERSION = 1;

class IndexedDBManager {
  private db: IDBPDatabase<HWDBSchema> | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.db = await openDB<HWDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Knowledge Base store
        const kdbStore = db.createObjectStore('knowledge-base', { keyPath: 'id' });
        kdbStore.createIndex('by-version', 'version');
        kdbStore.createIndex('by-timestamp', 'timestamp');

        // Signals store
        const signalStore = db.createObjectStore('signals', { keyPath: 'fullPath' });
        signalStore.createIndex('by-kdb', 'kdbId');
        signalStore.createIndex('by-name', 'signal.name');

        // Modules store
        const moduleStore = db.createObjectStore('modules', { keyPath: 'name' });
        moduleStore.createIndex('by-kdb', 'kdbId');

        // Instances store
        const instanceStore = db.createObjectStore('instances', { keyPath: 'fullPath' });
        instanceStore.createIndex('by-kdb', 'kdbId');
        instanceStore.createIndex('by-parent', 'instance.parentPath');

        // Source files store
        const sourceStore = db.createObjectStore('source-files', { keyPath: 'path' });
        sourceStore.createIndex('by-kdb', 'kdbId');

        // Metadata store
        db.createObjectStore('metadata', { keyPath: 'key' });
      },
    });

    this.initialized = true;
    console.log('[IndexedDB] Initialized successfully');
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

  // Knowledge Base operations
  async storeKnowledgeBase(
    id: string,
    data: KnowledgeBase,
    checksum: string
  ): Promise<void> {
    const db = this.getDB();
    const tx = db.transaction('knowledge-base', 'readwrite');
    
    await tx.store.put({
      id,
      version: data.version,
      data,
      checksum,
      timestamp: Date.now(),
    });

    // Store signals
    const signalTx = db.transaction('signals', 'readwrite');
    for (const [fullPath, signal] of data.signals) {
      await signalTx.store.put({
        fullPath,
        signal,
        kdbId: id,
      });
    }
    await signalTx.done;

    // Store modules
    const moduleTx = db.transaction('modules', 'readwrite');
    for (const [name, module] of data.modules) {
      await moduleTx.store.put({
        name,
        module,
        kdbId: id,
      });
    }
    await moduleTx.done;

    // Store instances
    const instanceTx = db.transaction('instances', 'readwrite');
    for (const [fullPath, instance] of data.instances) {
      await instanceTx.store.put({
        fullPath,
        instance,
        kdbId: id,
      });
    }
    await instanceTx.done;

    // Store source files
    const sourceTx = db.transaction('source-files', 'readwrite');
    for (const [path, content] of data.sourceFiles) {
      await sourceTx.store.put({
        path,
        content,
        kdbId: id,
        timestamp: Date.now(),
      });
    }
    await sourceTx.done;

    await tx.done;
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBase | null> {
    const db = this.getDB();
    const result = await db.get('knowledge-base', id);
    return result?.data || null;
  }

  async getKnowledgeBaseInfo(id: string): Promise<{ version: number; checksum: string; timestamp: number } | null> {
    const db = this.getDB();
    const result = await db.get('knowledge-base', id);
    if (!result) return null;
    return {
      version: result.version,
      checksum: result.checksum,
      timestamp: result.timestamp,
    };
  }

  // Signal queries
  async getSignal(fullPath: string): Promise<Signal | null> {
    const db = this.getDB();
    const result = await db.get('signals', fullPath);
    return result?.signal || null;
  }

  async querySignalsByKdb(kdbId: string): Promise<Signal[]> {
    const db = this.getDB();
    const results = await db.getAllFromIndex('signals', 'by-kdb', kdbId);
    return results.map(r => r.signal);
  }

  async searchSignalsByName(kdbId: string, pattern: string): Promise<Signal[]> {
    const db = this.getDB();
    const allSignals = await db.getAllFromIndex('signals', 'by-kdb', kdbId);
    const regex = new RegExp(pattern, 'i');
    return allSignals
      .filter(r => regex.test(r.signal.name))
      .map(r => r.signal);
  }

  // Module queries
  async getModule(name: string): Promise<Module | null> {
    const db = this.getDB();
    const result = await db.get('modules', name);
    return result?.module || null;
  }

  async getAllModules(kdbId: string): Promise<Module[]> {
    const db = this.getDB();
    const results = await db.getAllFromIndex('modules', 'by-kdb', kdbId);
    return results.map(r => r.module);
  }

  // Instance queries
  async getInstance(fullPath: string): Promise<Instance | null> {
    const db = this.getDB();
    const result = await db.get('instances', fullPath);
    return result?.instance || null;
  }

  async getChildInstances(parentPath: string): Promise<Instance[]> {
    const db = this.getDB();
    const results = await db.getAllFromIndex('instances', 'by-parent', parentPath);
    return results.map(r => r.instance);
  }

  // Source file operations
  async getSourceFile(path: string): Promise<string | null> {
    const db = this.getDB();
    const result = await db.get('source-files', path);
    return result?.content || null;
  }

  async getAllSourceFiles(kdbId: string): Promise<Map<string, string>> {
    const db = this.getDB();
    const results = await db.getAllFromIndex('source-files', 'by-kdb', kdbId);
    const map = new Map<string, string>();
    for (const r of results) {
      map.set(r.path, r.content);
    }
    return map;
  }

  // Metadata operations
  async setMetadata(key: string, value: unknown): Promise<void> {
    const db = this.getDB();
    await db.put('metadata', {
      key,
      value,
      timestamp: Date.now(),
    });
  }

  async getMetadata<T>(key: string): Promise<T | null> {
    const db = this.getDB();
    const result = await db.get('metadata', key);
    return (result?.value as T) || null;
  }

  // Clear all data
  async clear(): Promise<void> {
    const db = this.getDB();
    await db.clear('knowledge-base');
    await db.clear('signals');
    await db.clear('modules');
    await db.clear('instances');
    await db.clear('source-files');
    await db.clear('metadata');
  }
}

// Singleton instance
export const indexedDBManager = new IndexedDBManager();
