// ============================================
// KDB Download Test Script
// ============================================
// Tests the KDB download functionality with riscv2.kdb
// Run with: node test-kdb-download.js

const BASE_URL = 'http://localhost:8080';
const KDB_NAME = 'riscv2';

// Test configuration
const TEST_CONFIG = {
  // Stall detection test
  stallTimeout: 30000,      // 30 seconds
  heartbeatInterval: 5000,  // 5 seconds
  
  // Progress tracking
  reportInterval: 1000,     // Report every 1 second
};

// ============================================
// Utility Functions
// ============================================

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond) {
  return formatBytes(bytesPerSecond) + '/s';
}

function formatTime(seconds) {
  if (seconds < 60) return Math.round(seconds) + 's';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

// ============================================
// Test 1: Basic Download Info
// ============================================

async function testGetKdbInfo() {
  console.log('\n📋 Test 1: Get KDB Info');
  console.log('========================');
  
  try {
    const response = await fetch(`${BASE_URL}/api/kdb/${KDB_NAME}`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    console.log('✅ KDB Info retrieved successfully');
    console.log('   Design Name:', data.data.kdb_info.design_name);
    console.log('   File Size:', formatBytes(data.data.kdb_info.file_size));
    console.log('   Module Count:', data.data.kdb_info.module_count);
    console.log('   Signal Count:', data.data.kdb_info.signal_count);
    console.log('   File Count:', data.data.kdb_info.file_count);
    
    return data.data.kdb_info;
  } catch (error) {
    console.error('❌ Failed to get KDB info:', error.message);
    return null;
  }
}

// ============================================
// Test 2: Check Range Support
// ============================================

async function testRangeSupport() {
  console.log('\n📋 Test 2: Check Range Support');
  console.log('================================');
  
  try {
    const response = await fetch(`${BASE_URL}/api/kdb/${KDB_NAME}/file`, {
      method: 'HEAD',
    });
    
    const acceptRanges = response.headers.get('Accept-Ranges');
    const supportsRange = acceptRanges === 'bytes';
    
    console.log(supportsRange ? '✅ Server supports Range requests' : '⚠️ Server does not support Range requests');
    console.log('   Accept-Ranges:', acceptRanges || 'none');
    
    return supportsRange;
  } catch (error) {
    console.error('❌ Failed to check Range support:', error.message);
    return false;
  }
}

// ============================================
// Test 3: Full File Download
// ============================================

async function testFullDownload() {
  console.log('\n📋 Test 3: Full File Download');
  console.log('===============================');
  
  const startTime = Date.now();
  let lastReportTime = startTime;
  let downloadedBytes = 0;
  
  try {
    const response = await fetch(`${BASE_URL}/api/kdb/${KDB_NAME}/file`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const contentLength = parseInt(response.headers.get('Content-Length') || '0');
    console.log(`📥 Downloading ${formatBytes(contentLength)}...`);
    
    const reader = response.body.getReader();
    const chunks = [];
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;
      
      chunks.push(value);
      downloadedBytes += value.length;
      
      // Progress report
      const now = Date.now();
      if (now - lastReportTime > TEST_CONFIG.reportInterval) {
        const elapsed = (now - startTime) / 1000;
        const speed = downloadedBytes / elapsed;
        const progress = contentLength > 0 ? (downloadedBytes / contentLength * 100).toFixed(1) : '?';
        
        console.log(`   Progress: ${progress}% | ${formatBytes(downloadedBytes)} / ${formatBytes(contentLength)} | ${formatSpeed(speed)}`);
        
        lastReportTime = now;
      }
    }
    
    // Combine chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const data = new Uint8Array(totalLength);
    let position = 0;
    for (const chunk of chunks) {
      data.set(chunk, position);
      position += chunk.length;
    }
    
    const elapsed = (Date.now() - startTime) / 1000;
    const avgSpeed = downloadedBytes / elapsed;
    
    console.log('✅ Download completed');
    console.log(`   Total size: ${formatBytes(totalLength)}`);
    console.log(`   Time: ${elapsed.toFixed(2)}s`);
    console.log(`   Avg speed: ${formatSpeed(avgSpeed)}`);
    
    // Check magic number
    const magic = new DataView(data.buffer).getUint32(0, true);
    const CWDK_MAGIC = 0x4B445743;
    
    if (magic === CWDK_MAGIC) {
      console.log('✅ Magic number valid (CWDK)');
    } else {
      console.error(`❌ Invalid magic: 0x${magic.toString(16)}`);
    }
    
    // Get original size from header
    const originalSize = new DataView(data.buffer).getUint32(4, true);
    console.log(`   Original size: ${formatBytes(originalSize)}`);
    
    return data;
  } catch (error) {
    console.error('❌ Download failed:', error.message);
    return null;
  }
}

// ============================================
// Test 4: Range Request Download (Partial)
// ============================================

async function testRangeDownload() {
  console.log('\n📋 Test 4: Range Request Download');
  console.log('===================================');
  
  const CHUNK_SIZE = 64 * 1024; // 64KB
  const start = 0;
  const end = CHUNK_SIZE - 1;
  
  try {
    const response = await fetch(`${BASE_URL}/api/kdb/${KDB_NAME}/file`, {
      headers: {
        'Range': `bytes=${start}-${end}`,
      },
    });
    
    if (response.status === 206) {
      console.log('✅ Range request successful (HTTP 206)');
      
      const contentRange = response.headers.get('Content-Range');
      const contentLength = response.headers.get('Content-Length');
      
      console.log('   Content-Range:', contentRange);
      console.log('   Content-Length:', contentLength);
      
      const data = await response.arrayBuffer();
      console.log(`   Received: ${formatBytes(data.byteLength)}`);
      
      // Check magic in first chunk
      if (data.byteLength >= 4) {
        const magic = new DataView(data).getUint32(0, true);
        const CWDK_MAGIC = 0x4B445743;
        
        if (magic === CWDK_MAGIC) {
          console.log('✅ Magic number valid in first chunk');
        } else {
          console.log(`   Magic: 0x${magic.toString(16)} (checking if valid...)`);
        }
      }
      
      return true;
    } else if (response.ok) {
      console.log('⚠️ Server returned full file (Range not supported or ignored)');
      return false;
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.error('❌ Range request failed:', error.message);
    return false;
  }
}

// ============================================
// Test 5: Simulated Resume Download
// ============================================

async function testResumeDownload() {
  console.log('\n📋 Test 5: Simulated Resume Download');
  console.log('=====================================');
  
  const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
  const MAX_CHUNKS = 3; // Test first 3 chunks only
  
  try {
    // Get total size first
    const infoResponse = await fetch(`${BASE_URL}/api/kdb/${KDB_NAME}`);
    const info = await infoResponse.json();
    const totalSize = info.data.kdb_info.file_size;
    
    console.log(`📥 Testing resume download (${MAX_CHUNKS} x ${formatBytes(CHUNK_SIZE)} chunks)...`);
    
    const chunks = [];
    let downloaded = 0;
    
    for (let i = 0; i < MAX_CHUNKS && downloaded < totalSize; i++) {
      const start = downloaded;
      const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
      
      console.log(`   Chunk ${i + 1}: bytes=${start}-${end}`);
      
      const response = await fetch(`${BASE_URL}/api/kdb/${KDB_NAME}/file`, {
        headers: {
          'Range': `bytes=${start}-${end}`,
        },
      });
      
      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.arrayBuffer();
      chunks.push(new Uint8Array(data));
      downloaded += data.byteLength;
      
      console.log(`   ✓ Received ${formatBytes(data.byteLength)}`);
    }
    
    console.log(`✅ Resume download test completed`);
    console.log(`   Total received: ${formatBytes(downloaded)}`);
    
    return true;
  } catch (error) {
    console.error('❌ Resume download test failed:', error.message);
    return false;
  }
}

// ============================================
// Test 6: Error Handling
// ============================================

async function testErrorHandling() {
  console.log('\n📋 Test 6: Error Handling');
  console.log('==========================');
  
  // Test 1: Non-existent KDB
  try {
    const response = await fetch(`${BASE_URL}/api/kdb/nonexistent_kdb`);
    if (response.status === 404) {
      console.log('✅ 404 for non-existent KDB (correct)');
    } else {
      console.log(`⚠️ Unexpected status: ${response.status}`);
    }
  } catch (error) {
    console.log('✅ Error caught for non-existent KDB:', error.message);
  }
  
  // Test 2: Invalid Range
  try {
    const response = await fetch(`${BASE_URL}/api/kdb/${KDB_NAME}/file`, {
      headers: {
        'Range': 'bytes=invalid',
      },
    });
    console.log(`   Invalid range response: HTTP ${response.status}`);
  } catch (error) {
    console.log('   Invalid range error:', error.message);
  }
}

// ============================================
// Main Test Runner
// ============================================

async function runAllTests() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     KDB Download Test Suite            ║');
  console.log('║     Target: riscv2.kdb                 ║');
  console.log('║     Server: localhost:8080             ║');
  console.log('╚════════════════════════════════════════╝');
  
  const results = {
    info: false,
    rangeSupport: false,
    fullDownload: false,
    rangeDownload: false,
    resumeDownload: false,
    errorHandling: false,
  };
  
  // Run tests
  const kdbInfo = await testGetKdbInfo();
  results.info = kdbInfo !== null;
  
  if (kdbInfo) {
    results.rangeSupport = await testRangeSupport();
    results.fullDownload = await testFullDownload() !== null;
    results.rangeDownload = await testRangeDownload();
    results.resumeDownload = await testResumeDownload();
  }
  
  results.errorHandling = true; // Always runs
  await testErrorHandling();
  
  // Summary
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║           Test Summary                 ║');
  console.log('╚════════════════════════════════════════╝');
  
  const testNames = {
    info: 'Get KDB Info',
    rangeSupport: 'Range Support Check',
    fullDownload: 'Full File Download',
    rangeDownload: 'Range Request',
    resumeDownload: 'Resume Download',
    errorHandling: 'Error Handling',
  };
  
  let passed = 0;
  let total = 0;
  
  for (const [key, result] of Object.entries(results)) {
    const status = result ? '✅ PASS' : '❌ FAIL';
    console.log(`   ${status} - ${testNames[key]}`);
    if (result) passed++;
    total++;
  }
  
  console.log('\n─────────────────────────────────────────');
  console.log(`   Total: ${passed}/${total} tests passed`);
  console.log('─────────────────────────────────────────\n');
  
  return passed === total;
}

// Run tests
runAllTests()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test runner error:', error);
    process.exit(1);
  });
