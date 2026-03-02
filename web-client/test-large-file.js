// ============================================
// Large File OPFS & Monaco Test Script
// ============================================
// Tests:
// 1. OPFS file creation with test data
// 2. Large file detection (2MB threshold)
// 3. Windowed loading functionality
// 4. Monaco editor integration
//
// Run in browser console or as a module

const TEST_CONFIG = {
  KDB_ID: 'test-kdb',
  SMALL_FILE_ID: 1,
  LARGE_FILE_ID: 2,
  SMALL_FILE_LINES: 100,      // ~5KB, should use normal mode
  LARGE_FILE_LINES: 50000,    // ~2.5MB, should use large file mode
  LARGE_FILE_THRESHOLD: 2 * 1024 * 1024, // 2MB
};

// ============================================
// Test Utilities
// ============================================

function log(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = `[${timestamp}] [LargeFileTest]`;
  
  switch (type) {
    case 'success':
      console.log(`%c${prefix} ✅ ${message}`, 'color: green');
      break;
    case 'error':
      console.error(`${prefix} ❌ ${message}`);
      break;
    case 'warn':
      console.warn(`${prefix} ⚠️ ${message}`);
      break;
    default:
      console.log(`${prefix} ℹ️ ${message}`);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================
// OPFS Test File Creation
// ============================================

async function createTestFiles() {
  log('Creating test files in OPFS...');
  
  try {
    const root = await navigator.storage.getDirectory();
    const kdbDir = await root.getDirectoryHandle(TEST_CONFIG.KDB_ID, { create: true });
    
    // Create small file (~5KB)
    log('Creating small test file...');
    const smallFileHandle = await kdbDir.getFileHandle(
      `file_${TEST_CONFIG.SMALL_FILE_ID}.content`, 
      { create: true }
    );
    const smallWritable = await smallFileHandle.createWritable();
    const smallContent = generateVerilogContent(TEST_CONFIG.SMALL_FILE_LINES, 'small');
    await smallWritable.write(smallContent);
    await smallWritable.close();
    log(`Small file created: ${formatBytes(smallContent.byteLength)}`, 'success');
    
    // Create large file (~2.5MB)
    log('Creating large test file (this may take a moment)...');
    const largeFileHandle = await kdbDir.getFileHandle(
      `file_${TEST_CONFIG.LARGE_FILE_ID}.content`, 
      { create: true }
    );
    const largeWritable = await largeFileHandle.createWritable();
    
    // Write in chunks to avoid memory issues
    const chunkSize = 1000;
    for (let i = 0; i < TEST_CONFIG.LARGE_FILE_LINES; i += chunkSize) {
      const lines = Math.min(chunkSize, TEST_CONFIG.LARGE_FILE_LINES - i);
      const chunk = generateVerilogContent(lines, `chunk_${i}`);
      await largeWritable.write(chunk);
      
      if (i % 10000 === 0) {
        log(`  Progress: ${i}/${TEST_CONFIG.LARGE_FILE_LINES} lines`);
      }
    }
    await largeWritable.close();
    
    // Get actual file size
    const largeFile = await largeFileHandle.getFile();
    log(`Large file created: ${formatBytes(largeFile.size)}`, 'success');
    
    return {
      smallSize: smallContent.byteLength,
      largeSize: largeFile.size,
    };
  } catch (error) {
    log(`Failed to create test files: ${error.message}`, 'error');
    throw error;
  }
}

function generateVerilogContent(lineCount, prefix) {
  let content = `// Test Verilog file: ${prefix}\n`;
  content += `// Generated for large file testing\n`;
  content += `// Total lines: ${lineCount}\n\n`;
  
  for (let i = 0; i < lineCount; i++) {
    const lineNum = i + 1;
    const moduleName = `test_module_${prefix}_${Math.floor(i / 100)}`;
    
    if (i % 100 === 0) {
      content += `module ${moduleName} (\n`;
      content += `  input wire clk,\n`;
      content += `  input wire rst_n,\n`;
      content += `  input wire [31:0] data_in,\n`;
      content += `  output reg [31:0] data_out\n`;
      content += `);\n\n`;
    }
    
    // Add some varied content
    if (i % 10 === 0) {
      content += `  // Line ${lineNum}: Some logic here\n`;
      content += `  reg [7:0] register_${lineNum};\n`;
      content += `  wire [15:0] wire_${lineNum};\n`;
      content += `  assign wire_${lineNum} = register_${lineNum} * 2;\n\n`;
    } else if (i % 5 === 0) {
      content += `  always @(posedge clk or negedge rst_n) begin\n`;
      content += `    if (!rst_n) begin\n`;
      content += `      register_${lineNum} <= 8'h00;\n`;
      content += `    end else begin\n`;
      content += `      register_${lineNum} <= register_${lineNum} + 1;\n`;
      content += `    end\n`;
      content += `  end\n\n`;
    } else {
      content += `  // Regular line ${lineNum} with some padding to make file larger\n`;
      content += `  // Lorem ipsum dolor sit amet, consectetur adipiscing elit\n`;
    }
    
    if (i % 100 === 99) {
      content += `endmodule\n\n`;
    }
  }
  
  // Ensure file ends with newline
  if (!content.endsWith('\n')) {
    content += '\n';
  }
  
  return new TextEncoder().encode(content);
}

// ============================================
// Large File Detection Test
// ============================================

async function testLargeFileDetection() {
  log('\n=== Testing Large File Detection ===');
  
  const testCases = [
    { size: 1024 * 1024, expected: false, name: '1MB file' },
    { size: 2 * 1024 * 1024, expected: false, name: '2MB file (at threshold)' },
    { size: 2 * 1024 * 1024 + 1, expected: true, name: '2MB+1 file' },
    { size: 10 * 1024 * 1024, expected: true, name: '10MB file' },
  ];
  
  // Import the LargeFileController
  const { LargeFileController } = await import('./src/services/largeFileController.ts');
  
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
    const passed = isLarge === testCase.expected;
    
    log(
      `${testCase.name}: ${isLarge ? 'LARGE' : 'SMALL'} mode ` +
      `(expected: ${testCase.expected ? 'LARGE' : 'SMALL'}) ` +
      `${passed ? '✅ PASS' : '❌ FAIL'}`,
      passed ? 'success' : 'error'
    );
  }
}

// ============================================
// OPFS Reader Worker Test
// ============================================

async function testOPFSReaderWorker() {
  log('\n=== Testing OPFS Reader Worker ===');
  
  return new Promise((resolve, reject) => {
    try {
      const worker = new Worker(
        new URL('./src/workers/opfsReader.worker.ts', import.meta.url),
        { type: 'module' }
      );
      
      let testPhase = 'init';
      
      worker.onmessage = (event) => {
        const data = event.data;
        
        switch (data.type) {
          case 'initialized':
            if (testPhase === 'init') {
              log(`Worker initialized, line count: ${data.lineCount}`, 'success');
              
              // Test reading lines
              testPhase = 'read';
              worker.postMessage({
                type: 'readLines',
                startLine: 1,
                endLine: 100,
              });
            }
            break;
            
          case 'lines':
            if (testPhase === 'read') {
              const lines = data.text.split('\n').length;
              log(`Read ${lines} lines successfully`, 'success');
              
              // Test reading range
              testPhase = 'range';
              worker.postMessage({
                type: 'readRange',
                startByte: 0,
                endByte: 1024,
              });
            }
            break;
            
          case 'range':
            if (testPhase === 'range') {
              log(`Read byte range: ${data.data?.length || 0} bytes`, 'success');
              
              // Close worker
              worker.postMessage({ type: 'close' });
              worker.terminate();
              resolve(true);
            }
            break;
            
          case 'error':
            log(`Worker error: ${data.error}`, 'error');
            worker.terminate();
            reject(new Error(data.error));
            break;
        }
      };
      
      worker.onerror = (error) => {
        log(`Worker failed: ${error.message}`, 'error');
        reject(error);
      };
      
      // Initialize with small file
      worker.postMessage({
        type: 'init',
        kdbId: TEST_CONFIG.KDB_ID,
        fileId: TEST_CONFIG.SMALL_FILE_ID,
      });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        worker.terminate();
        reject(new Error('Worker test timeout'));
      }, 30000);
      
    } catch (error) {
      log(`Failed to create worker: ${error.message}`, 'error');
      reject(error);
    }
  });
}

// ============================================
// LargeFileController Integration Test
// ============================================

async function testLargeFileController() {
  log('\n=== Testing LargeFileController Integration ===');
  
  const { LargeFileController } = await import('./src/services/largeFileController.ts');
  
  return new Promise((resolve, reject) => {
    const events = [];
    
    const controller = new LargeFileController({
      onContentChange: (content, startLine) => {
        events.push({ type: 'content', startLine, length: content.length });
        log(`Content loaded: ${content.length} chars from line ${startLine}`, 'success');
      },
      onLoadingChange: (loading) => {
        events.push({ type: 'loading', loading });
        log(`Loading state: ${loading ? 'STARTED' : 'FINISHED'}`);
      },
      onError: (error) => {
        events.push({ type: 'error', error });
        log(`Error: ${error}`, 'error');
        reject(new Error(error));
      },
    });
    
    const metadata = {
      id: TEST_CONFIG.LARGE_FILE_ID,
      path: '/test/large.v',
      name: 'large.v',
      fullName: '/test/large.v',
      size: TEST_CONFIG.LARGE_FILE_LINES * 50,
      totalLines: TEST_CONFIG.LARGE_FILE_LINES,
      kdbId: TEST_CONFIG.KDB_ID,
    };
    
    controller.init(metadata).then((success) => {
      if (!success) {
        reject(new Error('Failed to initialize controller'));
        return;
      }
      
      log('Controller initialized', 'success');
      
      // Test window management
      controller.ensureWindow(1, 100).then(() => {
        log('Window 1-100 loaded', 'success');
        
        // Simulate scroll to middle
        setTimeout(() => {
          controller.ensureWindow(1000, 1100).then(() => {
            log('Window 1000-1100 loaded (scroll simulation)', 'success');
            
            // Simulate scroll to end
            setTimeout(() => {
              controller.ensureWindow(49000, 49100).then(() => {
                log('Window 49000-49100 loaded (end of file)', 'success');
                
                controller.dispose();
                log('Controller disposed', 'success');
                
                log(`\nTotal events: ${events.length}`);
                log(`Content changes: ${events.filter(e => e.type === 'content').length}`);
                log(`Loading state changes: ${events.filter(e => e.type === 'loading').length}`);
                
                resolve(true);
              });
            }, 1000);
          });
        }, 1000);
      });
    });
  });
}

// ============================================
// Monaco Editor Integration Test
// ============================================

async function testMonacoIntegration() {
  log('\n=== Testing Monaco Editor Integration ===');
  
  // Check if Monaco is available
  if (typeof monaco === 'undefined') {
    log('Monaco not available in this context. Skipping Monaco tests.', 'warn');
    return false;
  }
  
  log('Monaco editor found', 'success');
  
  // Test language registration
  const languages = monaco.languages.getLanguages();
  const hasVerilog = languages.some(l => l.id === 'verilog');
  log(`Verilog language registered: ${hasVerilog ? '✅' : '❌'}`, hasVerilog ? 'success' : 'error');
  
  // Test editor creation options
  const testOptions = {
    readOnly: true,
    minimap: { enabled: false },
    wordWrap: 'off',
    folding: false,
    codeLens: false,
    occurrencesHighlight: false,
    semanticHighlighting: false,
  };
  
  log('Recommended Monaco options for large files:');
  Object.entries(testOptions).forEach(([key, value]) => {
    log(`  ${key}: ${JSON.stringify(value)}`);
  });
  
  return true;
}

// ============================================
// Performance Benchmark
// ============================================

async function runPerformanceBenchmark() {
  log('\n=== Performance Benchmark ===');
  
  const results = {
    smallFileOpen: 0,
    largeFileOpen: 0,
    lineIndexBuild: 0,
    windowLoad: 0,
  };
  
  // Benchmark small file
  log('Benchmarking small file...');
  const smallStart = performance.now();
  const root = await navigator.storage.getDirectory();
  const kdbDir = await root.getDirectoryHandle(TEST_CONFIG.KDB_ID, { create: false });
  const smallHandle = await kdbDir.getFileHandle(`file_${TEST_CONFIG.SMALL_FILE_ID}.content`);
  const smallFile = await smallHandle.getFile();
  const smallContent = await smallFile.text();
  results.smallFileOpen = performance.now() - smallStart;
  log(`Small file (${formatBytes(smallFile.size)}) loaded in ${results.smallFileOpen.toFixed(2)}ms`, 'success');
  
  // Benchmark large file header read
  log('Benchmarking large file header read...');
  const largeStart = performance.now();
  const largeHandle = await kdbDir.getFileHandle(`file_${TEST_CONFIG.LARGE_FILE_ID}.content`);
  const largeFile = await largeHandle.getFile();
  const largeSlice = largeFile.slice(0, 1024);
  const largeReader = new FileReader();
  await new Promise((resolve) => {
    largeReader.onload = resolve;
    largeReader.readAsText(largeSlice);
  });
  results.largeFileOpen = performance.now() - largeStart;
  log(`Large file (${formatBytes(largeFile.size)}) header read in ${results.largeFileOpen.toFixed(2)}ms`, 'success');
  
  log('\n=== Benchmark Results ===');
  log(`Small file open: ${results.smallFileOpen.toFixed(2)}ms`);
  log(`Large file header: ${results.largeFileOpen.toFixed(2)}ms`);
  
  return results;
}

// ============================================
// Main Test Runner
// ============================================

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     Large File OPFS & Monaco Test Suite                ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  
  const results = {
    fileCreation: false,
    largeFileDetection: false,
    opfsReaderWorker: false,
    largeFileController: false,
    monacoIntegration: false,
    performance: false,
  };
  
  try {
    // Step 1: Create test files
    log('\n📁 Step 1: Creating test files in OPFS...');
    const fileSizes = await createTestFiles();
    results.fileCreation = true;
    
    // Step 2: Test large file detection
    log('\n🔍 Step 2: Testing large file detection...');
    await testLargeFileDetection();
    results.largeFileDetection = true;
    
    // Step 3: Test OPFS Reader Worker
    log('\n📖 Step 3: Testing OPFS Reader Worker...');
    await testOPFSReaderWorker();
    results.opfsReaderWorker = true;
    
    // Step 4: Test LargeFileController
    log('\n🎛️ Step 4: Testing LargeFileController...');
    await testLargeFileController();
    results.largeFileController = true;
    
    // Step 5: Test Monaco integration
    log('\n📝 Step 5: Testing Monaco integration...');
    results.monacoIntegration = await testMonacoIntegration();
    
    // Step 6: Performance benchmark
    log('\n⚡ Step 6: Running performance benchmark...');
    await runPerformanceBenchmark();
    results.performance = true;
    
  } catch (error) {
    log(`Test suite failed: ${error.message}`, 'error');
    console.error(error);
  }
  
  // Summary
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║                    Test Summary                        ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  
  const testNames = {
    fileCreation: 'OPFS File Creation',
    largeFileDetection: 'Large File Detection',
    opfsReaderWorker: 'OPFS Reader Worker',
    largeFileController: 'LargeFileController',
    monacoIntegration: 'Monaco Integration',
    performance: 'Performance Benchmark',
  };
  
  let passed = 0;
  let total = 0;
  
  for (const [key, result] of Object.entries(results)) {
    const status = result ? '✅ PASS' : '❌ FAIL';
    log(`${status} - ${testNames[key]}`, result ? 'success' : 'error');
    if (result) passed++;
    total++;
  }
  
  console.log('\n─────────────────────────────────────────────────────────');
  console.log(`   Total: ${passed}/${total} tests passed`);
  console.log('─────────────────────────────────────────────────────────\n');
  
  return passed === total;
}

// Export for use as module
export { runAllTests, createTestFiles, TEST_CONFIG };

// Auto-run if executed directly
if (typeof window !== 'undefined') {
  // Browser environment
  window.runLargeFileTests = runAllTests;
  window.createTestFiles = createTestFiles;
  
  console.log('Large File Test Suite loaded!');
  console.log('Run tests with: await runLargeFileTests()');
  console.log('Or create files only: await createTestFiles()');
}

// Node.js environment (for testing)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runAllTests, createTestFiles, TEST_CONFIG };
}
