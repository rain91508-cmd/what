// WASM-based KDB parser
// Re-exports storage functions for use in other modules
// Note: Actual KDB parsing is now done in kdbDownload.worker.ts

// Re-export storage functions for use in other modules
export {
  store_knowledge_base,
  store_module,
  store_signal_inst,
  store_source_file_info,
  store_source_file_content_opfs,
  get_source_file_content,
  get_source_file_content_by_range,
  get_source_file_lines_by_range,
  clear_kdb_data,
} from '../../core/storage/kdbStorage';
