// ============================================
// Knowledge Module - Index
// ============================================
//
// This module provides:
// - kdbManager: On-demand KDB loading and querying
// - WASM parser for KDB decompression and parsing
// - Storage bridge for IndexedDB

// Export KDB Manager (new on-demand loading architecture)
export { kdbManager, type TreeNode } from './kdbManager';

// Export WASM parser
export { parseKdbWithWasm, isWasmAvailable } from './kdbWasmParser';

// Export storage functions
export {
  store_knowledge_base,
  store_module,
  store_source_file,
  clear_kdb_data,
} from '../../core/storage/kdbStorage';

// Legacy exports (for backward compatibility during migration)
// These will be removed in a future update
export { knowledgeManager, KnowledgeManagerImpl } from './knowledgeManager';
