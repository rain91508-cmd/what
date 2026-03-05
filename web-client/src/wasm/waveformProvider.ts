/**
 * WASM Waveform Data Provider Integration
 * 
 * This module initializes the WASM module and provides a JavaScript interface
 * for the WaveformDataProvider.
 */

import init, { WaveformDataProvider } from '../../wasm-pkg/hwda_wasm.js';

let wasmInitialized = false;
let provider: WaveformDataProvider | null = null;

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
 * Create a new waveform data provider
 * @param timeStamp Waveform modification timestamp for CDN cache (from wave_info.modified_time)
 */
export function createProvider(
  serverUrl: string,
  waveformName: string,
  signalPrefix: string,
  spaceBeforeBracket: boolean,
  timeStamp: number = 0
): WaveformDataProvider {
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
  
  return provider;
}

/**
 * Get the current provider instance
 */
export function getProvider(): WaveformDataProvider | null {
  return provider;
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
  provider.set_signal_prefix(signalPrefix);
  provider.set_space_before_bracket(spaceBeforeBracket);
  
  console.log(`[WASM] Updated provider settings: prefix='${signalPrefix}', spaceBeforeBracket=${spaceBeforeBracket}`);
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
    spaceBeforeBracket
  );
  
  return testProvider.test_name_conversion(localName);
}

export { WaveformDataProvider };
