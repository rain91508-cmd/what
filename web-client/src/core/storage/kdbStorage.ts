// ============================================
// KDB Storage - Bridge between WASM and IndexedDB
// ============================================
// Exposes IndexedDB operations to WASM as global functions
// Updated for new KDB structure (SignalDef + SignalInst split)

import { indexedDBManager } from './indexedDB';

/**
 * Store knowledge base metadata
 * WASM stores: { id, header, hierarchies }
 */
async function store_knowledge_base(id: string, data: any): Promise<void> {
  console.log('[KdbStorage] Storing knowledge base:', id);
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  // Handle both Map (from serde_wasm_bindgen) and plain object
  const getValue = (key: string) => {
    if (data instanceof Map) {
      return data.get(key);
    }
    return data[key];
  };
  
  // Store knowledge base with new structure
  const record = {
    id,
    header: getValue('header') || {},
    hierarchies: getValue('hierarchies') || [],
  };
  console.log('[KdbStorage] Storing record:', record);
  await db.put('knowledge-base', record);
  console.log('[KdbStorage] Stored successfully');
}

/**
 * Convert Map to plain object recursively
 */
function convertToPlainObject(value: any): any {
  if (value instanceof Map) {
    const obj: any = {};
    for (const [key, val] of value.entries()) {
      obj[key] = convertToPlainObject(val);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(convertToPlainObject);
  }
  return value;
}

/**
 * Store module
 * WASM stores: { name, parentModuleId, definition, signalDefs, isInstance, childModuleIds, defModuleId, signalInstsStartId }
 */
async function store_module(id: number, data: any, kdbId: string): Promise<void> {
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  // Handle both Map (from serde_wasm_bindgen) and plain object
  const getValue = (key: string) => {
    if (data instanceof Map) {
      return data.get(key);
    }
    return data[key];
  };
  
  // Convert signalDefs from Map to plain objects
  const signalDefs = getValue('signalDefs') || [];
  const plainSignalDefs = signalDefs.map(convertToPlainObject);
  
  await db.put('modules', {
    id,
    name: getValue('name'),
    parentModuleId: getValue('parentModuleId') || 0,
    definition: convertToPlainObject(getValue('definition')),
    signalDefs: plainSignalDefs,
    isInstance: getValue('isInstance') || false,
    childModuleIds: getValue('childModuleIds') || [],
    defModuleId: getValue('defModuleId') || 0,
    signalInstsStartId: getValue('signalInstsStartId') || 0,
    kdbId,
  });
}

/**
 * Store signal instance
 * WASM calls: store_signal_inst(globalIndex, data, kdbId)
 */
async function store_signal_inst(globalIndex: number, data: any, kdbId: string): Promise<void> {
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  // Handle both Map (from serde_wasm_bindgen) and plain object
  const getValue = (key: string) => {
    if (data instanceof Map) {
      return data.get(key);
    }
    return data[key];
  };
  
  await db.put('signal-insts', {
    index: globalIndex,
    msb: getValue('msb') || 0,
    lsb: getValue('lsb') || 0,
    parentModuleId: getValue('parentModuleId') || 0,
    driverSignalGlobalIds: getValue('driverSignalGlobalIds') || [],
    driverLines: (getValue('driverLines') || []).map(convertToPlainObject),
    kdbId,
  });
}

/**
 * Store source file info (metadata only)
 * WASM calls: store_source_file_info(id, path, name, fullName, totalLines, lineIndexOffset, kdbId)
 */
async function store_source_file_info(
  id: number, 
  path: string, 
  name: string, 
  fullName: string, 
  totalLines: number, 
  lineIndexOffset: number[],
  kdbId: string
): Promise<void> {
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  console.log('[KdbStorage] Storing source file info:', id, 'path:', path, 'totalLines:', totalLines, 'indexOffsets:', lineIndexOffset?.length || 0);
  
  await db.put('source-file-info', {
    id,
    path,
    name,
    fullName,
    totalLines,
    lineIndexOffset: lineIndexOffset || [],  // Store index offset for fast seeking
    kdbId,
  });
}

/**
 * Store source file content (large data) to OPFS (Origin Private File System)
 * WASM calls: store_source_file_content_opfs(id, content, kdbId)
 * Uses OPFS for better performance with large files
 */
async function store_source_file_content_opfs(id: number, content: Uint8Array, kdbId: string): Promise<void> {
  console.log('[KdbStorage] Storing source file content to OPFS:', id, 'content length:', content?.length || 0);
  
  try {
    // Get OPFS root directory
    const root = await navigator.storage.getDirectory();
    
    // Create/get KDB-specific directory
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: true });
    
    // Create/get file handle
    const fileName = `file_${id}.content`;
    const fileHandle = await kdbDir.getFileHandle(fileName, { create: true });
    
    // Write content using FileSystemWritableFileStream
    // Create a new Uint8Array view to ensure we only write the actual data
    const writable = await fileHandle.createWritable();
    const contentView = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    await writable.write(contentView as any);
    await writable.close();
    
    console.log('[KdbStorage] Stored content to OPFS:', fileName);
  } catch (e) {
    console.error('[KdbStorage] Failed to store content to OPFS:', e);
    throw e;
  }
}

/**
 * Get full source file content from OPFS
 * Returns: string (UTF-8 decoded)
 */
async function get_source_file_content(fileId: number, kdbId: string): Promise<string | null> {
  console.log('[KdbStorage] Getting full content from OPFS:', fileId);
  
  try {
    // Get OPFS root directory
    const root = await navigator.storage.getDirectory();
    
    // Get KDB-specific directory
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
    
    // Get file handle
    const fileName = `file_${fileId}.content`;
    const fileHandle = await kdbDir.getFileHandle(fileName, { create: false });
    
    // Get file and read all content
    const file = await fileHandle.getFile();
    const arrayBuffer = await file.arrayBuffer();
    
    // Decode UTF-8 bytes to string
    const content = new TextDecoder().decode(arrayBuffer);
    
    console.log('[KdbStorage] Read', content.length, 'chars from OPFS');
    return content;
  } catch (e) {
    console.error('[KdbStorage] Failed to get content from OPFS:', e);
    return null;
  }
}

/**
 * Get source file content by byte range from OPFS
 * Uses index offset for efficient seeking
 * WASM calls: get_source_file_content_by_range(fileId, startByte, endByte, kdbId)
 * Returns: Uint8Array of the requested range
 */
async function get_source_file_content_by_range(
  fileId: number, 
  startByte: number, 
  endByte: number, 
  kdbId: string
): Promise<Uint8Array> {
  console.log('[KdbStorage] Getting content by range from OPFS:', fileId, 'bytes', startByte, '-', endByte);
  
  try {
    // Get OPFS root directory
    const root = await navigator.storage.getDirectory();
    
    // Get KDB-specific directory
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
    
    // Get file handle
    const fileName = `file_${fileId}.content`;
    const fileHandle = await kdbDir.getFileHandle(fileName, { create: false });
    
    // Get file
    const file = await fileHandle.getFile();
    
    // Read specific byte range using slice
    const slice = file.slice(startByte, endByte);
    const arrayBuffer = await slice.arrayBuffer();
    
    console.log('[KdbStorage] Read', arrayBuffer.byteLength, 'bytes from OPFS');
    return new Uint8Array(arrayBuffer);
  } catch (e) {
    console.error('[KdbStorage] Failed to get content by range from OPFS:', e);
    throw e;
  }
}

/**
 * Get source file content by line range using index offset
 * First gets the line_index_offset from IndexedDB, then reads from OPFS
 */
async function get_source_file_lines_by_range(
  fileId: number,
  startLine: number,
  endLine: number,
  kdbId: string
): Promise<string[]> {
  console.log('[KdbStorage] Getting lines by range:', fileId, 'lines', startLine, '-', endLine);
  
  // 1. Get file info from IndexedDB (contains line_index_offset)
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');
  
  const fileInfo = await db.get('source-file-info', fileId);
  if (!fileInfo || fileInfo.kdbId !== kdbId) {
    throw new Error(`File info not found: ${fileId}`);
  }
  
  const lineIndexOffset: number[] = fileInfo.lineIndexOffset || [];
  const totalLines: number = fileInfo.totalLines || 0;
  
  // Validate line range
  if (startLine < 1 || endLine < 1 || startLine > totalLines) {
    throw new Error(`Invalid line range: ${startLine}-${endLine}, total: ${totalLines}`);
  }
  
  endLine = Math.min(endLine, totalLines);
  
  // 2. Calculate byte range using index offset
  // Find the index slot for startLine (every 256 lines)
  const startIndexSlot = Math.floor((startLine - 1) / 256);
  const startByteOffset = lineIndexOffset[startIndexSlot] || 0;
  
  // For endLine, we need to read until we find the end
  // For simplicity, read from startByteOffset to end of file, then parse lines
  // A more optimized version would estimate the end byte
  
  // 3. Read content from OPFS
  const root = await navigator.storage.getDirectory();
  const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
  const fileHandle = await kdbDir.getFileHandle(`file_${fileId}.content`, { create: false });
  const file = await fileHandle.getFile();
  
  // Read from calculated start offset to end of file
  const slice = file.slice(startByteOffset);
  const arrayBuffer = await slice.arrayBuffer();
  const content = new Uint8Array(arrayBuffer);
  
  // 4. Parse lines
  const lines: string[] = [];
  let currentLine = startIndexSlot * 256 + 1;
  let pos = 0;
  
  // Skip lines until we reach startLine
  while (currentLine < startLine && pos < content.length) {
    if (content[pos] === 0x0A) { // '\n'
      currentLine++;
    }
    pos++;
  }
  
  // Read lines from startLine to endLine
  while (currentLine <= endLine && pos < content.length) {
    let lineStart = pos;
    // Find end of line
    while (pos < content.length && content[pos] !== 0x0A && content[pos] !== 0x0D) {
      pos++;
    }
    // Extract line as UTF-8 string
    const lineBytes = content.slice(lineStart, pos);
    const line = new TextDecoder().decode(lineBytes);
    lines.push(line);
    currentLine++;
    // Skip newline characters
    if (pos < content.length && content[pos] === 0x0D) pos++; // '\r'
    if (pos < content.length && content[pos] === 0x0A) pos++; // '\n'
  }
  
  console.log('[KdbStorage] Read', lines.length, 'lines');
  return lines;
}

/**
 * Clear all data for a KDB
 */
async function clear_kdb_data(kdbId: string): Promise<void> {
  console.log('[KdbStorage] Clearing data for KDB:', kdbId);
  await indexedDBManager.initialize();
  const db = (indexedDBManager as any).db;
  if (!db) throw new Error('IndexedDB not initialized');

  // Clear knowledge base
  await db.delete('knowledge-base', kdbId);

  // Get all keys to delete from each store (note: source-file-content removed, now in OPFS)
  const stores = ['modules', 'signal-insts', 'source-file-info'];
  
  for (const storeName of stores) {
    try {
      // Get all keys for this kdbId
      const index = db.transaction(storeName).store.index('by-kdb');
      const keys: (string | number)[] = [];
      let cursor = await index.openCursor(kdbId);
      
      while (cursor) {
        const key = cursor.primaryKey;
        if (key !== undefined) {
          keys.push(key as string | number);
        }
        cursor = await cursor.continue();
      }
      
      // Delete all collected keys in a new transaction
      if (keys.length > 0) {
        const tx = db.transaction(storeName, 'readwrite');
        for (const key of keys) {
          await tx.store.delete(key);
        }
        await tx.done;
        console.log(`[KdbStorage] Cleared ${keys.length} items from ${storeName}`);
      }
    } catch (e) {
      console.warn(`[KdbStorage] Error clearing ${storeName}:`, e);
    }
  }
  
  // Clear file contents from OPFS
  try {
    const root = await navigator.storage.getDirectory();
    const kdbDir = await root.getDirectoryHandle(kdbId, { create: false });
    
    // Remove all files in the KDB directory
    // Note: OPFS doesn't have a direct "clear directory" API, so we iterate
    // @ts-ignore - FileSystemDirectoryHandle iteration
    for await (const [name, handle] of kdbDir.entries()) {
      try {
        await kdbDir.removeEntry(name, { recursive: true });
        console.log(`[KdbStorage] Removed OPFS entry: ${name}`);
      } catch (e) {
        console.warn(`[KdbStorage] Error removing OPFS entry ${name}:`, e);
      }
    }
    
    // Try to remove the directory itself
    try {
      await root.removeEntry(kdbId);
      console.log(`[KdbStorage] Removed OPFS directory: ${kdbId}`);
    } catch (e) {
      // Directory might not be empty or might not exist
      console.log(`[KdbStorage] Could not remove OPFS directory (may not be empty): ${kdbId}`);
    }
  } catch (e) {
    // Directory might not exist
    console.log(`[KdbStorage] OPFS directory not found for KDB: ${kdbId}`);
  }

  console.log('[KdbStorage] Cleared data for KDB:', kdbId);
}

// Expose functions to global scope for WASM
if (typeof window !== 'undefined') {
  (window as any).store_knowledge_base = store_knowledge_base;
  (window as any).store_module = store_module;
  (window as any).store_signal_inst = store_signal_inst;
  (window as any).store_source_file_info = store_source_file_info;
  (window as any).store_source_file_content_opfs = store_source_file_content_opfs;
  (window as any).get_source_file_content = get_source_file_content;
  (window as any).get_source_file_content_by_range = get_source_file_content_by_range;
  (window as any).get_source_file_lines_by_range = get_source_file_lines_by_range;
  (window as any).clear_kdb_data = clear_kdb_data;
  console.log('[KdbStorage] Functions exposed to global scope');
}

// Export for use in other modules
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
};
