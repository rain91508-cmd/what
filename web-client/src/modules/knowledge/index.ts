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
  store_signal_inst,
  store_source_file_info,
  store_source_file_content_opfs,
  get_source_file_content_by_range,
  get_source_file_lines_by_range,
  clear_kdb_data,
} from '../../core/storage/kdbStorage';
