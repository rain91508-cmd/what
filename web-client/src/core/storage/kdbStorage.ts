// ============================================
// KDB Storage - Bridge between WASM and IndexedDB
// ============================================
// Exposes IndexedDB operations to WASM as global functions
// Updated for new KDB structure (SignalDef + SignalInst split)

import { indexedDBManager } from './indexedDB';

/**
 * Store knowledge base metadata
 * WASM stores: { id, header, hierarchies }
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
 * WASM stores: { name, parentModuleId, definition, signalDefs, isInstance, childModuleIds, defModuleId, signalInstsStartId }
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
  
  // Convert signalDefs from Map to plain objects
  const signalDefs = getValue('signalDefs') || [];
  const plainSignalDefs = signalDefs.map(convertToPlainObject);
  
  await db.put('modules', {
    id,
    name: getValue('name'),
    parentModuleId: getValue('parentModuleId') || 0,
    definition: convertToPlainObject(getValue('definition')),
    signalDefs: plainSignalDefs,
    isInstance: getValue('isInstance') || false,
    childModuleIds: getValue('childModuleIds') || [],
    defModuleId: getValue('defModuleId') || 0,
    signalInstsStartId: getValue('signalInstsStartId') || 0,
    kdbId,
  });
}

/**
 * Store signal instance
 * WASM calls: store_signal_inst(globalIndex, data, kdbId)
 */
async function store_signal_inst(globalIndex: number, data: any, kdbId: string): Promise<void> {
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
  
  await db.put('signal-insts', {
    index: globalIndex,
    msb: getValue('msb') || 0,
    lsb: getValue('lsb') || 0,
    parentModuleId: getValue('parentModuleId') || 0,
    driverSignalGlobalIds: getValue('driverSignalGlobalIds') || [],
    driverLines: (getValue('driverLines') || []).map(convertToPlainObject),
    kdbId,
  });
}

/**
 * Store source file
 * WASM calls: store_source_file(id, path, content, kdbId)
 */
async function store_source_file(id: number, path: string, content: string, kdbId: string): Promise<void> {
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  console.log('[KdbStorage] Storing source file:', id, 'path:', path, 'content length:', content?.length || 0);
  
  await db.put('source-files', {
    id,
    path,
    content,
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
  const stores = ['modules', 'signal-insts', 'source-files'];
  
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
  (window as any).store_signal_inst = store_signal_inst;
  (window as any).store_source_file = store_source_file;
  (window as any).clear_kdb_data = clear_kdb_data;
  console.log('[KdbStorage] Functions exposed to global scope');
}

// Export for use in other modules
export {
  store_knowledge_base,
  store_module,
  store_signal_inst,
  store_source_file,
  clear_kdb_data,
};
