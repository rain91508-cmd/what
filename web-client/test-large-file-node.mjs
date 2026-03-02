// ============================================
// Large File Test - Node.js Version
// ============================================
// This script tests the large file detection logic
// and other non-browser-dependent functionality

import { LargeFileController } from './src/services/largeFileController.ts';

const TEST_CONFIG = {
  LARGE_FILE_THRESHOLD: 2 * 1024 * 1024, // 2MB
};

function log(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const icons = {
    info: 'ℹ️',
    success: '✅',
    error: '❌',
    warn: '⚠️',
  };
  console.log(`[${timestamp}] ${icons[type] || 'ℹ️'} ${message}`);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================
// Test 1: Large File Detection
// ============================================

function testLargeFileDetection() {
  log('\n=== Testing Large File Detection ===', 'info');
  
  const testCases = [
    { size: 1024 * 1024, expected: false, name: '1MB file' },
    { size: 2 * 1024 * 1024, expected: false, name: '2MB file (at threshold)' },
    { size: 2 * 1024 * 1024 + 1, expected: true, name: '2MB+1 file' },
    { size: 10 * 1024 * 1024, expected: true, name: '10MB file' },
    { size: 100 * 1024 * 1024, expected: true, name: '100MB file' },
  ];
  
  let passed = 0;
  
  for (const testCase of testCases) {
    const metadata = {
      id: 1,
      path: '/test/file.v',
      name: 'file.v',
      fullName: '/test/file.v',
      size: testCase.size,
      totalLines: Math.floor(testCase.size / 50),
      kdbId: 'test',
    };
    
    const isLarge = LargeFileController.isLargeFile(metadata);
    const testPassed = isLarge === testCase.expected;
    
    log(
      `${testCase.name} (${formatBytes(testCase.size)}): ` +
      `${isLarge ? 'LARGE' : 'SMALL'} mode ` +
      `${testPassed ? '✅ PASS' : '❌ FAIL'}`,
      testPassed ? 'success' : 'error'
    );
    
    if (testPassed) passed++;
  }
  
  log(`Detection tests: ${passed}/${testCases.length} passed`, passed === testCases.length ? 'success' : 'error');
  return passed === testCases.length;
}

// ============================================
// Test 2: File Metadata Structure
// ============================================

function testFileMetadata() {
  log('\n=== Testing File Metadata Structure ===', 'info');
  
  const metadata = {
    id: 1,
    path: '/test/design.v',
    name: 'design.v',
    fullName: '/test/design.v',
    size: 5 * 1024 * 1024, // 5MB
    totalLines: 100000,
    kdbId: 'test-kdb',
  };
  
  const isLarge = LargeFileController.isLargeFile(metadata);
  
  log(`File: ${metadata.name}`, 'info');
  log(`Size: ${formatBytes(metadata.size)}`, 'info');
  log(`Lines: ${metadata.totalLines}`, 'info');
  log(`Mode: ${isLarge ? 'LARGE' : 'SMALL'}`, isLarge ? 'success' : 'info');
  
  return isLarge === true;
}

// ============================================
// Test 3: Window State Calculation
// ============================================

function testWindowState() {
  log('\n=== Testing Window State Calculation ===', 'info');
  
  const WINDOW_SIZE = 2000;
  const BUFFER_LINES = 1000;
  
  const testCases = [
    { visibleStart: 1, visibleEnd: 50, expectedStart: 1, desc: 'Start of file' },
    { visibleStart: 5000, visibleEnd: 5050, expectedStart: 4000, desc: 'Middle of file' },
    { visibleStart: 99000, visibleEnd: 99050, expectedStart: 98000, desc: 'End of file' },
  ];
  
  let passed = 0;
  
  for (const test of testCases) {
    const newStart = Math.max(1, test.visibleStart - BUFFER_LINES);
    const newEnd = test.visibleEnd + BUFFER_LINES;
    
    const startCorrect = newStart === test.expectedStart;
    
    log(
      `${test.desc}: Window ${newStart}-${newEnd} ` +
      `(expected start: ${test.expectedStart}) ` +
      `${startCorrect ? '✅' : '❌'}`,
      startCorrect ? 'success' : 'error'
    );
    
    if (startCorrect) passed++;
  }
  
  log(`Window tests: ${passed}/${testCases.length} passed`, passed === testCases.length ? 'success' : 'error');
  return passed === testCases.length;
}

// ============================================
// Main Test Runner
// ============================================

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     Large File Test Suite (Node.js)                    ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  
  const results = {
    detection: false,
    metadata: false,
    window: false,
  };
  
  try {
    results.detection = testLargeFileDetection();
    results.metadata = testFileMetadata();
    results.window = testWindowState();
  } catch (error) {
    log(`Test suite failed: ${error.message}`, 'error');
    console.error(error);
  }
  
  // Summary
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║                    Test Summary                        ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  
  const testNames = {
    detection: 'Large File Detection',
    metadata: 'File Metadata Structure',
    window: 'Window State Calculation',
  };
  
  let passed = 0;
  let total = 0;
  
  for (const [key, result] of Object.entries(results)) {
    const status = result ? '✅ PASS' : '❌ FAIL';
    log(`${status} - ${testNames[key]}`, result ? 'success' : 'error');
    if (result) passed++;
    total++;
  }
  
  console.log('─────────────────────────────────────────────────────────');
  console.log(`   Total: ${passed}/${total} tests passed`);
  console.log('─────────────────────────────────────────────────────────\n');
  
  return passed === total;
}

// Run tests
runAllTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});
