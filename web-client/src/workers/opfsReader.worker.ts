// ============================================
// OPFS Reader Worker
// ============================================
// Reads file content from OPFS in chunks
// Supports line-based reading with sparse line index
//
// Architecture:
// - Main Thread -> Worker -> OPFS Sync Access Handle
// - Returns text content for requested line ranges
// - Maintains file handle for efficient random access

// Type declarations for OPFS Sync Access Handle (not yet in standard lib)
declare interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
  getSize(): number;
}

declare interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

// ============================================
// Types
// ============================================

interface OPFSReaderMessage {
  type: 'init' | 'readLines' | 'readRange' | 'close';
  kdbId?: string;
  fileId?: number;
  startLine?: number;
  endLine?: number;
  startByte?: number;
  endByte?: number;
}

interface OPFSReaderResponse {
  type: 'initialized' | 'lines' | 'range' | 'error';
  text?: string;
  data?: Uint8Array;
  lineCount?: number;
  error?: string;
}

// KDB unpacked data lives under a `kdb/` subfolder in OPFS so it is clearly
// separated from the `wave_cache` directory used for waveform data.
async function getKdbDir(
  root: FileSystemDirectoryHandle,
  kdbId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  const kdbParent = await root.getDirectoryHandle('kdb', { create });
  return await kdbParent.getDirectoryHandle(kdbId, { create });
}

// ============================================
// State
// ============================================

let syncHandle: FileSystemSyncAccessHandle | null = null;
let fileSize: number = 0;
let fileBase: number = 0; // Absolute offset of this file inside source_content.bin
let lineIndex: number[] = []; // Sparse line index: lineIndex[n] = byte offset of line (256*n + 1)
const LINE_INDEX_STRIDE = 256; // One checkpoint every 256 lines

// Per-file offset index for the concatenated source_content.bin (see
// kdbDownload.worker.ts). Maps fileId -> { start, len }.
async function loadSourceIndex(
  kdbId: string,
): Promise<Map<number, { start: number; len: number }> | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const kdbDir = await getKdbDir(root, kdbId, false);
    const fh = await kdbDir.getFileHandle('source_index.bin', { create: false });
    const file = await fh.getFile();
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const count = dv.getUint32(0, true);
    const map = new Map<number, { start: number; len: number }>();
    let off = 4;
    for (let i = 0; i < count; i++) {
      const id = dv.getUint32(off, true);
      const start = dv.getUint32(off + 4, true);
      const len = dv.getUint32(off + 8, true);
      map.set(id, { start, len });
      off += 12;
    }
    return map;
  } catch {
    return null;
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Read a chunk of bytes from the file
 */
function readChunkAt(offset: number, length: number): Uint8Array {
  if (!syncHandle) throw new Error('OPFS not initialized');
  if (offset < 0) offset = 0;
  const avail = Math.max(0, fileSize - offset);
  const len = Math.min(length, avail);
  if (len <= 0) return new Uint8Array(0);
  const buffer = new Uint8Array(len);
  const bytesRead = syncHandle.read(buffer, { at: fileBase + offset });
  return buffer.subarray(0, bytesRead);
}

/**
 * Build sparse line index for the file
 * Only indexes every LINE_INDEX_STRIDE lines to save memory
 */
async function buildLineIndex(): Promise<number> {
  if (!syncHandle) throw new Error('OPFS not initialized');
  
  const chunkSize = 128 * 1024; // 128KB chunks
  let offset = 0;
  let lineCount = 0;
  lineIndex = [0]; // Line 1 starts at byte 0
  
  while (offset < fileSize) {
    const chunk = readChunkAt(offset, Math.min(chunkSize, fileSize - offset));
    
    // Count newlines in this chunk
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0A) { // '\n'
        lineCount++;
        // Index every LINE_INDEX_STRIDE lines
        if (lineCount % LINE_INDEX_STRIDE === 0) {
          lineIndex.push(offset + i + 1);
        }
      }
    }
    
    offset += chunk.length;
  }
  
  return lineCount + 1; // +1 because line count = newline count + 1
}

/**
 * Find the byte offset for a given line number
 * Uses sparse index + linear scan within the chunk
 */
function findLineOffset(targetLine: number): number {
  if (targetLine <= 1) return 0;
  
  // Find nearest checkpoint
  const checkpointIndex = Math.floor((targetLine - 1) / LINE_INDEX_STRIDE);
  const checkpointLine = checkpointIndex * LINE_INDEX_STRIDE + 1;
  
  if (checkpointIndex >= lineIndex.length) {
    // Beyond indexed range, estimate from last checkpoint
    return lineIndex[lineIndex.length - 1] || 0;
  }
  
  let offset = lineIndex[checkpointIndex];
  let currentLine = checkpointLine;
  
  // Scan forward to find exact line
  const scanChunk = readChunkAt(offset, Math.min(64 * 1024, fileSize - offset));
  
  for (let i = 0; i < scanChunk.length && currentLine < targetLine; i++) {
    if (scanChunk[i] === 0x0A) { // '\n'
      currentLine++;
      if (currentLine === targetLine) {
        return offset + i + 1;
      }
    }
  }
  
  return offset;
}

/**
 * Read lines from startLine to endLine (inclusive)
 */
async function readLines(startLine: number, endLine: number): Promise<string> {
  if (!syncHandle) throw new Error('OPFS not initialized');
  
  const startOffset = findLineOffset(startLine);
  const endOffset = findLineOffset(endLine + 1);
  
  // Read the range
  const length = endOffset - startOffset;
  if (length <= 0) return '';
  
  const buffer = readChunkAt(startOffset, length);
  return new TextDecoder().decode(buffer);
}

/**
 * Read byte range directly
 */
async function readByteRange(startByte: number, endByte: number): Promise<Uint8Array> {
  if (!syncHandle) throw new Error('OPFS not initialized');
  
  const length = endByte - startByte;
  return readChunkAt(startByte, length);
}

// ============================================
// Message Handler
// ============================================

self.onmessage = async (event: MessageEvent<OPFSReaderMessage>) => {
  const { type, kdbId, fileId, startLine, endLine, startByte, endByte } = event.data;
  
  try {
    switch (type) {
      case 'init':
        if (!kdbId || !fileId) {
          throw new Error('Missing kdbId or fileId');
        }
        
        try {
          // Open OPFS file. Prefer the concatenated source_content.bin (new
          // layout) using this file's offset from source_index.bin; fall back to
          // the legacy per-file `file_${fileId}.content` for older data.
          const root = await navigator.storage.getDirectory();
          const kdbDir = await getKdbDir(root, kdbId, false);
          const index = await loadSourceIndex(kdbId);
          const entry = index?.get(fileId);
          
          let fileHandle: any;
          if (entry) {
            fileBase = entry.start;
            fileHandle = await kdbDir.getFileHandle('source_content.bin', { create: false });
            syncHandle = await (fileHandle as any).createSyncAccessHandle();
            fileSize = entry.len;
          } else {
            fileBase = 0;
            fileHandle = await kdbDir.getFileHandle(`file_${fileId}.content`, { create: false });
            syncHandle = await (fileHandle as any).createSyncAccessHandle();
            fileSize = syncHandle!.getSize();
          }
          
          // Build line index
          const lineCount = await buildLineIndex();
          
          postMessage({
            type: 'initialized',
            lineCount,
          } as OPFSReaderResponse);
        } catch (error) {
          postMessage({
            type: 'error',
            error: `Init failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          } as OPFSReaderResponse);
        }
        break;
        
      case 'readLines':
        if (startLine === undefined || endLine === undefined) {
          throw new Error('Missing startLine or endLine');
        }
        
        const text = await readLines(startLine, endLine);
        postMessage({
          type: 'lines',
          text,
        } as OPFSReaderResponse);
        break;
        
      case 'readRange':
        if (startByte === undefined || endByte === undefined) {
          throw new Error('Missing startByte or endByte');
        }
        
        const data = await readByteRange(startByte, endByte);
        postMessage({
          type: 'range',
          data,
        } as OPFSReaderResponse);
        break;
        
      case 'close':
        if (syncHandle) {
          syncHandle.close();
          syncHandle = null;
        }
        postMessage({ type: 'initialized' } as OPFSReaderResponse);
        break;
    }
  } catch (error) {
    postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    } as OPFSReaderResponse);
  }
};

export {};
