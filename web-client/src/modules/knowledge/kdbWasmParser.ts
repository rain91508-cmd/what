// WASM-based KDB parser
// Uses Rust WASM module for zstd decompression and direct IndexedDB storage

import init, { parse_and_store_kdb } from '../../../wasm-pkg/hwda_wasm';
// Import kdbStorage to ensure functions are exposed to global scope
import '../../core/storage/kdbStorage';

let wasmInitialized = false;

/**
 * Initialize WASM module
 */
async function initWasm(): Promise<void> {
  if (wasmInitialized) return;
  
  try {
    await init();
    wasmInitialized = true;
    console.log('[KdbWasmParser] WASM module initialized');
  } catch (error) {
    console.error('[KdbWasmParser] Failed to initialize WASM:', error);
    throw error;
  }
}

/**
 * Parse KDB data using WASM and store directly to IndexedDB
 * @param kdbId KDB identifier
 * @param data KDB binary data
 * @param onMessage Optional callback for progress messages
 * @returns Design name on success, null on failure
 */
export async function parseKdbWithWasm(
  kdbId: string, 
  data: ArrayBuffer,
  onMessage?: (msg: string) => void
): Promise<string | null> {
  try {
    await initWasm();
    
    const uint8Array = new Uint8Array(data);
    console.log('[KdbWasmParser] Parsing KDB with WASM, size:', uint8Array.length);
    onMessage?.('Parsing KDB with WASM...');
    
    // Call WASM function to parse and store KDB
    const designName = await parse_and_store_kdb(kdbId, uint8Array);
    
    console.log('[KdbWasmParser] KDB parsed and stored successfully:', designName);
    onMessage?.(`WASM parsing complete: ${designName}`);
    return designName;
  } catch (error) {
    console.error('[KdbWasmParser] Failed to parse KDB:', error);
    onMessage?.(`WASM parsing failed: ${error}`);
    return null;
  }
}

/**
 * Check if WASM is available
 */
export function isWasmAvailable(): boolean {
  return wasmInitialized;
}

// Re-export storage functions for use in other modules
export {
  store_knowledge_base,
  store_module,
  store_source_file_info,
  store_source_file_content,
  clear_kdb_data,
} from '../../core/storage/kdbStorage';
