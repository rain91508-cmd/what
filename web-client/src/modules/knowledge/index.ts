// ============================================
// Knowledge Module - Index
// ============================================
//
// This module provides:
// - kdbManager: On-demand KDB loading and querying
// - KDB Download Manager with Web Worker for streaming download
// - Storage bridge for IndexedDB and OPFS

// Export KDB Manager (new on-demand loading architecture)
export { kdbManager, type TreeNode } from './kdbManager';

// Export KDB Download Manager (Web Worker based streaming download)
export { kdbDownloadManager, type KDBDownloadProgress, type KDBDownloadResult } from '../../services/kdbDownloadManager';

// Export storage functions
export {
  store_knowledge_base,
  store_signals_opfs,
  store_drivers_opfs,
  store_source_file_info,
  store_source_file_content_opfs,
  get_source_file_content,
  get_source_file_content_by_range,
  get_source_file_lines_by_range,
  get_signals_buffer,
  get_drivers_by_range,
  clear_kdb_data,
} from '../../core/storage/kdbStorage';
