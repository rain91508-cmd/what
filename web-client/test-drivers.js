// ============================================
// Test script for driver information
// Loads simple.kdb from localhost:8080 and prints all signals with drivers
// ============================================

const API_BASE = 'http://localhost:8080';

async function fetchKdbList() {
  console.log('[Test] Fetching KDB list...');
  const response = await fetch(`${API_BASE}/api/kdb/list`);
  const data = await response.json();
  console.log('[Test] KDB List:', JSON.stringify(data, null, 2));
  return data;
}

async function fetchKdbInfo(kdbName) {
  console.log(`[Test] Fetching KDB info: ${kdbName}`);
  const response = await fetch(`${API_BASE}/api/kdb/${kdbName}/info`);
  const data = await response.json();
  console.log('[Test] KDB Info:', JSON.stringify(data, null, 2));
  return data;
}

async function fetchKdbBinary(kdbName) {
  console.log(`[Test] Downloading KDB binary: ${kdbName}`);
  const response = await fetch(`${API_BASE}/api/kdb/${kdbName}`);
  const contentType = response.headers.get('content-type');
  console.log('[Test] Content-Type:', contentType);

  const arrayBuffer = await response.arrayBuffer();
  console.log('[Test] Downloaded', arrayBuffer.byteLength, 'bytes');

  // Print first 200 bytes as hex for debugging
  const bytes = new Uint8Array(arrayBuffer.slice(0, 200));
  const hexString = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log('[Test] First 200 bytes (hex):');
  console.log(hexString.match(/.{1,48}/g).join('\n'));

  return arrayBuffer;
}

async function main() {
  try {
    console.log('[Test] Starting driver analysis test...\n');

    // 1. List available KDBs
    const listData = await fetchKdbList();

    if (!listData.data || !listData.data.kdbs || listData.data.kdbs.length === 0) {
      console.log('[Test] No KDB files found');
      return;
    }

    // 2. Get first KDB info
    const kdbName = listData.data.kdbs[0].name;
    console.log(`\n[Test] Using KDB: ${kdbName}\n`);

    const infoData = await fetchKdbInfo(kdbName);

    // 3. Download binary KDB data
    console.log('');
    const binaryData = await fetchKdbBinary(kdbName);

    console.log('\n[Test] Binary KDB data downloaded successfully');
    console.log('[Test] Note: To decode protobuf data, you need to use the WASM module or protobuf library');
    console.log('[Test] The web client uses WASM to decode this data in the browser');

    console.log('\n[Test] Done!');
  } catch (error) {
    console.error('[Test] Error:', error);
    console.error('[Test] Stack:', error.stack);
  }
}

// Run the test
main();
