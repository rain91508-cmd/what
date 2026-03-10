/**
 * WASM Waveform Data Provider Integration
 * 
 * This module initializes the WASM module and provides a JavaScript interface
 * for the WaveformDataProvider.
 */

import init, { WaveformDataProvider } from '../../wasm-pkg/hwda_wasm.js';
import { getSignalIdManager, SignalIdManager } from '../core/cache/signalIdManager';
import { opfsRead, opfsWrite, opfsExists, isOpfsSupported } from '../core/cache/opfsAccess';

let wasmInitialized = false;
let provider: WaveformDataProvider | null = null;
let signalIdManager: SignalIdManager | null = null;
let opfsEnabled = false;

/**
 * Initialize WASM module
 */
export async function initWasm(): Promise<void> {
  if (wasmInitialized) return;
  
  await init();
  wasmInitialized = true;
  console.log('[WASM] Module initialized');
}

/**
 * Check if OPFS is supported
 */
export function checkOpfsSupport(): boolean {
  return isOpfsSupported();
}

/**
 * Enable/disable OPFS cache
 * Can be called before or after provider creation
 */
export function setOpfsEnabled(enabled: boolean): void {
  opfsEnabled = enabled && isOpfsSupported();
  
  // If provider exists, update it dynamically
  if (provider) {
    provider.set_opfs_enabled(opfsEnabled);
    console.log(`[WaveformProvider] OPFS cache ${opfsEnabled ? 'enabled' : 'disabled'} (dynamic)`);
  } else {
    console.log(`[WaveformProvider] OPFS cache ${opfsEnabled ? 'enabled' : 'disabled'} (will apply on create)`);
  }
}

/**
 * Check if OPFS cache is enabled
 */
export function isOpfsEnabled(): boolean {
  // If provider exists, get actual state from provider
  if (provider) {
    return provider.opfs_enabled;
  }
  return opfsEnabled;
}

/**
 * Enable/disable Memory LRU cache
 * When disabled, memory cache will be cleared and not used
 */
export function setMemoryCacheEnabled(enabled: boolean): void {
  if (provider) {
    provider.set_memory_cache_enabled(enabled);
    console.log(`[WaveformProvider] Memory cache ${enabled ? 'enabled' : 'disabled'}`);
  } else {
    console.warn('[WaveformProvider] Cannot set memory cache: provider not created');
  }
}

/**
 * Check if Memory LRU cache is enabled
 */
export function isMemoryCacheEnabled(): boolean {
  if (provider) {
    return provider.memory_cache_enabled;
  }
  return true; // Default to enabled
}

/**
 * Create a new waveform data provider
 * @param timeStamp Waveform modification timestamp for CDN cache (from wave_info.modified_time)
 * @param enableOpfs Whether to enable OPFS cache (defaults to current global setting)
 */
export async function createProvider(
  serverUrl: string,
  waveformName: string,
  signalPrefix: string,
  spaceBeforeBracket: boolean,
  timeStamp: number = 0,
  enableOpfs: boolean = opfsEnabled
): Promise<WaveformDataProvider> {
  if (!wasmInitialized) {
    throw new Error('WASM not initialized. Call initWasm() first.');
  }
  
  provider = new WaveformDataProvider(
    serverUrl,
    waveformName,
    signalPrefix,
    spaceBeforeBracket,
    BigInt(timeStamp)
  );
  
  // Initialize SignalIdManager
  signalIdManager = await getSignalIdManager(waveformName);
  
  // Initialize OPFS callbacks
  // Convert async functions to JS functions that return Promises
  const readCallback = new Function('path', `
    return window.opfsReadWrapper(path);
  `);
  const writeCallback = new Function('path', 'data', `
    return window.opfsWriteWrapper(path, data);
  `);
  const existsCallback = new Function('path', `
    return window.opfsExistsWrapper(path);
  `);
  
  // Register global wrappers for WASM to call
  (window as any).opfsReadWrapper = async (path: string): Promise<Uint8Array | null> => {
    return await opfsRead(path);
  };
  
  (window as any).opfsWriteWrapper = async (path: string, data: Uint8Array): Promise<void> => {
    await opfsWrite(path, data);
  };
  
  (window as any).opfsExistsWrapper = async (path: string): Promise<boolean> => {
    return await opfsExists(path);
  };
  
  // Initialize WASM with OPFS callbacks
  provider.init_with_opfs(
    readCallback as any,
    writeCallback as any,
    existsCallback as any,
    enableOpfs
  );
  
  console.log(`[WaveformProvider] Created provider for ${waveformName}, OPFS=${enableOpfs}`);
  
  return provider;
}

/**
 * Get the current provider instance
 */
export function getProvider(): WaveformDataProvider | null {
  return provider;
}

/**
 * Get the current SignalIdManager
 */
export function getSignalManager(): SignalIdManager | null {
  return signalIdManager;
}

/**
 * Build WASM signal list from UI signals
 * This assigns draw_sig_id to each signal using global_id (per waveform)
 * 
 * Note: draw_sig_id is used for cache group management. Since cache is per waveform
 * and only one waveform can be opened at a time, we use global_id to ensure the same
 * signal gets the same draw_sig_id.
 */
export async function buildWasmSignals(
  uiSignals: Array<{
    global_id: number;  // KDB global ID (used for draw_sig_id mapping)
    name: string;
    row: number;
    width?: number;
  }>,
  waveformName: string
): Promise<Array<{
  global_id: number;
  name: string;
  row: number;
  width: number;
  draw_sig_id: number;
}>> {
  const manager = await getSignalIdManager(waveformName);
  
  return uiSignals.map((uiSig) => {
    const width = uiSig.width || 1;
    // Use global_id for draw_sig_id (per waveform, as per spec)
    const draw_sig_id = manager.getOrCreateDrawSigId(uiSig.global_id);
    
    return {
      global_id: uiSig.global_id,
      name: uiSig.name,
      row: uiSig.row,
      width,
      draw_sig_id,
    };
  });
}

/**
 * Update provider settings (prefix and spaceBeforeBracket)
 * This should be called after signal search finds the correct settings
 */
export function updateProviderSettings(
  signalPrefix: string,
  spaceBeforeBracket: boolean
): void {
  if (!provider) {
    console.warn('[WASM] Cannot update settings: provider not created');
    return;
  }
  
  // Update settings using setters (call the wasm-bindgen generated methods)
  provider.signal_prefix = signalPrefix;
  provider.space_before_bracket = spaceBeforeBracket;
  
  // console.log(`[WASM] Updated provider settings: prefix='${signalPrefix}', spaceBeforeBracket=${spaceBeforeBracket}`);
}

/**
 * Test signal name conversion
 */
export function testNameConversion(
  localName: string,
  serverUrl: string = 'http://localhost:8080',
  waveformName: string = 'test',
  signalPrefix: string = 'work@',
  spaceBeforeBracket: boolean = true
): string {
  if (!wasmInitialized) {
    throw new Error('WASM not initialized. Call initWasm() first.');
  }
  
  const testProvider = new WaveformDataProvider(
    serverUrl,
    waveformName,
    signalPrefix,
    spaceBeforeBracket,
    BigInt(0)
  );
  
  return testProvider.test_name_conversion(localName);
}

/**
 * Clear all cache data
 */
export async function clearCache(): Promise<void> {
  if (provider) {
    provider.clear_cache();
  }
  if (signalIdManager) {
    await signalIdManager.clear();
  }
}

export { WaveformDataProvider };
