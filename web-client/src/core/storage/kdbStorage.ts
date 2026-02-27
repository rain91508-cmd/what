// ============================================
// KDB Storage - Bridge between WASM and IndexedDB
// ============================================
// Exposes IndexedDB operations to WASM as global functions

import { indexedDBManager } from './indexedDB';

/**
 * Store knowledge base metadata
 * WASM stores: { id, header, topModuleIds, hierarchies }
 */
async function store_knowledge_base(id: string, data: any): Promise<void> {
  console.log('[KdbStorage] Storing knowledge base:', id);
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  // Handle both Map (from serde_wasm_bindgen) and plain object
  const getValue = (key: string) => {
    if (data instanceof Map) {
      return data.get(key);
    }
    return data[key];
  };
  
  // Store knowledge base with new structure
  const record = {
    id,
    header: getValue('header') || {},
    topModuleIds: getValue('topModuleIds') || [],
    hierarchies: getValue('hierarchies') || [],
  };
  console.log('[KdbStorage] Storing record:', record);
  await db.put('knowledge-base', record);
  console.log('[KdbStorage] Stored successfully');
}

/**
 * Convert Map to plain object recursively
 */
function convertToPlainObject(value: any): any {
  if (value instanceof Map) {
    const obj: any = {};
    for (const [key, val] of value.entries()) {
      obj[key] = convertToPlainObject(val);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(convertToPlainObject);
  }
  return value;
}

/**
 * Store module
 * WASM stores: { id, name, fullName, parentModuleId, fileId, isInstance, signals, childModuleIds }
 */
async function store_module(id: number, data: any, kdbId: string): Promise<void> {
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  // Handle both Map (from serde_wasm_bindgen) and plain object
  const getValue = (key: string) => {
    if (data instanceof Map) {
      return data.get(key);
    }
    return data[key];
  };
  
  // Convert signals from Map to plain objects
  const signals = getValue('signals') || [];
  const plainSignals = signals.map(convertToPlainObject);
  
  await db.put('modules', {
    id,
    name: getValue('name'),
    fullName: getValue('fullName'),
    parentModuleId: getValue('parentModuleId'),
    fileId: getValue('fileId'),
    isInstance: getValue('isInstance'),
    signals: plainSignals,
    childModuleIds: getValue('childModuleIds') || [],
    kdbId,
  });
}

/**
 * Store source file
 * WASM stores: { id, path, content }
 */
async function store_source_file(id: number, data: any, kdbId: string): Promise<void> {
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  // Handle both Map (from serde_wasm_bindgen) and plain object
  const getValue = (key: string) => {
    if (data instanceof Map) {
      return data.get(key);
    }
    return data[key];
  };
  
  await db.put('source-files', {
    id,
    path: getValue('path'),
    content: getValue('content'),
    kdbId,
  });
}

/**
 * Clear all data for a KDB
 */
async function clear_kdb_data(kdbId: string): Promise<void> {
  console.log('[KdbStorage] Clearing data for KDB:', kdbId);
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');

  // Clear knowledge base
  await db.delete('knowledge-base', kdbId);

  // Get all keys to delete from each store
  const stores = ['modules', 'source-files'];
  
  for (const storeName of stores) {
    try {
      // Get all keys for this kdbId
      const index = db.transaction(storeName).store.index('by-kdb');
      const keys: (string | number)[] = [];
      let cursor = await index.openCursor(kdbId);
      
      while (cursor) {
        const key = cursor.primaryKey;
        if (key !== undefined) {
          keys.push(key as string | number);
        }
        cursor = await cursor.continue();
      }
      
      // Delete all collected keys in a new transaction
      if (keys.length > 0) {
        const tx = db.transaction(storeName, 'readwrite');
        for (const key of keys) {
          await tx.store.delete(key);
        }
        await tx.done;
        console.log(`[KdbStorage] Cleared ${keys.length} items from ${storeName}`);
      }
    } catch (e) {
      console.warn(`[KdbStorage] Error clearing ${storeName}:`, e);
    }
  }

  console.log('[KdbStorage] Cleared data for KDB:', kdbId);
}

// Expose functions to global scope for WASM
if (typeof window !== 'undefined') {
  (window as any).store_knowledge_base = store_knowledge_base;
  (window as any).store_module = store_module;
  (window as any).store_source_file = store_source_file;
  (window as any).clear_kdb_data = clear_kdb_data;
  console.log('[KdbStorage] Functions exposed to global scope');
}

// Export for use in other modules
export {
  store_knowledge_base,
  store_module,
  store_source_file,
  clear_kdb_data,
};
