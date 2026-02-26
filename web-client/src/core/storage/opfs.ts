// ============================================
// OPFS Storage - Waveform Data (Warm Layer)
// ============================================
// 
// Responsibilities (per spec.md & hint3.md):
// - Store waveform cache files (FST chunks)
// - Store decompressed blocks
// - Store LOD pyramid data
// - Support streaming read/write
//
// Directory Structure (per hint3.md):
// /opfs/waves/
// └── <wave_id>/
//     ├── meta.json              # Waveform metadata (<10KB)
//     ├── signals.bin            # Signal table (compact binary)
//     ├── level_0/               # LoD 0 - Original precision
//     │   ├── chunk_000000.bin
//     │   ├── chunk_000001.bin
//     │   └── ...
//     ├── level_1/               # LoD 1 - 2x downsampling
//     └── ...

import type { LoDLevelType } from '../../types';

// Chunk Header Structure (32 bytes)
interface ChunkHeader {
  magic: number;        // u32: 'WAVE' = 0x57415645
  version: number;      // u16: 1
  level: number;        // u16: LoD level
  chunkId: number;      // u32: chunk index
  timeStart: bigint;    // u64: start time
  timeEnd: bigint;      // u64: end time
  signalCount: number;  // u32: number of signals
}

// Signal Block Header (17 bytes)
interface SignalBlockHeader {
  signalHandle: number;      // u32
  timeArrayOffset: number;   // u32
  valueArrayOffset: number;  // u32
  transitionCount: number;   // u32
  compression: number;       // u8: 0=none, 1=zstd, 2=lz4
}

interface WaveMeta {
  version: number;
  waveId: string;
  timeBegin: number;
  timeEnd: number;
  timeUnit: string;
  levels: number;
  baseChunkNs: number;
  signalCount: number;
  chunkSizeBytes: number;
  signalsMetaOffset: number;
}

class OPFSManager {
  private rootDir: FileSystemDirectoryHandle | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // @ts-ignore - OPFS API may not be in all TypeScript definitions
      this.rootDir = await navigator.storage.getDirectory();
      this.initialized = true;
      console.log('[OPFS] Initialized successfully');
    } catch (error) {
      console.error('[OPFS] Failed to initialize:', error);
      throw error;
    }
  }

  isInitialized(): boolean {
    return this.initialized && this.rootDir !== null;
  }

  isSupported(): boolean {
    return 'storage' in navigator && 'getDirectory' in navigator.storage;
  }

  private getRoot(): FileSystemDirectoryHandle {
    if (!this.rootDir) {
      throw new Error('OPFS not initialized');
    }
    return this.rootDir;
  }

  // Create directory structure for a waveform
  async createWaveformDirectory(waveId: string): Promise<void> {
    const root = this.getRoot();
    
    // Create waves directory
    const wavesDir = await root.getDirectoryHandle('waves', { create: true });
    
    // Create waveform-specific directory
    const waveDir = await wavesDir.getDirectoryHandle(waveId, { create: true });
    
    // Create level directories
    for (let level = 0; level <= 11; level++) {
      await waveDir.getDirectoryHandle(`level_${level}`, { create: true });
    }
  }

  // Store waveform metadata
  async storeWaveformMeta(waveId: string, meta: WaveMeta): Promise<void> {
    const root = this.getRoot();
    const wavesDir = await root.getDirectoryHandle('waves');
    const waveDir = await wavesDir.getDirectoryHandle(waveId);
    
    const fileHandle = await waveDir.getFileHandle('meta.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(meta));
    await writable.close();
  }

  // Get waveform metadata
  async getWaveformMeta(waveId: string): Promise<WaveMeta | null> {
    try {
      const root = this.getRoot();
      const wavesDir = await root.getDirectoryHandle('waves');
      const waveDir = await wavesDir.getDirectoryHandle(waveId);
      
      const fileHandle = await waveDir.getFileHandle('meta.json');
      const file = await fileHandle.getFile();
      const content = await file.text();
      
      return JSON.parse(content) as WaveMeta;
    } catch {
      return null;
    }
  }

  // Store signal table
  async storeSignalsBin(waveId: string, data: ArrayBuffer): Promise<void> {
    const root = this.getRoot();
    const wavesDir = await root.getDirectoryHandle('waves');
    const waveDir = await wavesDir.getDirectoryHandle(waveId);
    
    const fileHandle = await waveDir.getFileHandle('signals.bin', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  // Get signal table
  async getSignalsBin(waveId: string): Promise<ArrayBuffer | null> {
    try {
      const root = this.getRoot();
      const wavesDir = await root.getDirectoryHandle('waves');
      const waveDir = await wavesDir.getDirectoryHandle(waveId);
      
      const fileHandle = await waveDir.getFileHandle('signals.bin');
      const file = await fileHandle.getFile();
      
      return await file.arrayBuffer();
    } catch {
      return null;
    }
  }

  // Store chunk data
  async storeChunk(
    waveId: string,
    level: LoDLevelType,
    chunkId: number,
    data: ArrayBuffer
  ): Promise<void> {
    const root = this.getRoot();
    const wavesDir = await root.getDirectoryHandle('waves');
    const waveDir = await wavesDir.getDirectoryHandle(waveId);
    const levelDir = await waveDir.getDirectoryHandle(`level_${level}`);
    
    const fileName = `chunk_${chunkId.toString().padStart(6, '0')}.bin`;
    const fileHandle = await levelDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  // Get chunk data
  async getChunk(
    waveId: string,
    level: LoDLevelType,
    chunkId: number
  ): Promise<ArrayBuffer | null> {
    try {
      const root = this.getRoot();
      const wavesDir = await root.getDirectoryHandle('waves');
      const waveDir = await wavesDir.getDirectoryHandle(waveId);
      const levelDir = await waveDir.getDirectoryHandle(`level_${level}`);
      
      const fileName = `chunk_${chunkId.toString().padStart(6, '0')}.bin`;
      const fileHandle = await levelDir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      
      return await file.arrayBuffer();
    } catch {
      return null;
    }
  }

  // Check if chunk exists
  async hasChunk(
    waveId: string,
    level: LoDLevelType,
    chunkId: number
  ): Promise<boolean> {
    try {
      const root = this.getRoot();
      const wavesDir = await root.getDirectoryHandle('waves');
      const waveDir = await wavesDir.getDirectoryHandle(waveId);
      const levelDir = await waveDir.getDirectoryHandle(`level_${level}`);
      
      const fileName = `chunk_${chunkId.toString().padStart(6, '0')}.bin`;
      await levelDir.getFileHandle(fileName);
      return true;
    } catch {
      return false;
    }
  }

  // Stream write chunk (for large files)
  async createChunkWritable(
    waveId: string,
    level: LoDLevelType,
    chunkId: number
  ): Promise<FileSystemWritableFileStream> {
    const root = this.getRoot();
    const wavesDir = await root.getDirectoryHandle('waves');
    const waveDir = await wavesDir.getDirectoryHandle(waveId);
    const levelDir = await waveDir.getDirectoryHandle(`level_${level}`);
    
    const fileName = `chunk_${chunkId.toString().padStart(6, '0')}.bin`;
    const fileHandle = await levelDir.getFileHandle(fileName, { create: true });
    
    return await fileHandle.createWritable();
  }

  // Delete waveform data
  async deleteWaveform(waveId: string): Promise<void> {
    try {
      const root = this.getRoot();
      const wavesDir = await root.getDirectoryHandle('waves');
      await wavesDir.removeEntry(waveId, { recursive: true });
    } catch (error) {
      console.error(`[OPFS] Failed to delete waveform ${waveId}:`, error);
    }
  }

  // List all stored waveforms
  async listWaveforms(): Promise<string[]> {
    const root = this.getRoot();
    const wavesDir = await root.getDirectoryHandle('waves');
    
    const waveforms: string[] = [];
    // @ts-ignore
    for await (const entry of wavesDir.values()) {
      if (entry.kind === 'directory') {
        waveforms.push(entry.name);
      }
    }
    
    return waveforms;
  }

  // Get storage stats
  async getStorageStats(): Promise<{
    totalWaveforms: number;
    totalSize: number;
  }> {
    const waveforms = await this.listWaveforms();
    let totalSize = 0;

    for (const waveId of waveforms) {
      totalSize += await this.calculateWaveformSize(waveId);
    }

    return {
      totalWaveforms: waveforms.length,
      totalSize,
    };
  }

  private async calculateWaveformSize(waveId: string): Promise<number> {
    let size = 0;
    
    try {
      const root = this.getRoot();
      const wavesDir = await root.getDirectoryHandle('waves');
      const waveDir = await wavesDir.getDirectoryHandle(waveId);
      
      // Get meta.json size
      try {
        const metaHandle = await waveDir.getFileHandle('meta.json');
        const metaFile = await metaHandle.getFile();
        size += metaFile.size;
      } catch {}
      
      // Get signals.bin size
      try {
        const signalsHandle = await waveDir.getFileHandle('signals.bin');
        const signalsFile = await signalsHandle.getFile();
        size += signalsFile.size;
      } catch {}
      
      // Get all chunk sizes
      for (let level = 0; level <= 11; level++) {
        try {
          const levelDir = await waveDir.getDirectoryHandle(`level_${level}`);
          // @ts-ignore
          for await (const entry of levelDir.values()) {
            if (entry.kind === 'file') {
              const fileHandle = await levelDir.getFileHandle(entry.name);
              const file = await fileHandle.getFile();
              size += file.size;
            }
          }
        } catch {}
      }
    } catch {}
    
    return size;
  }

  // Parse chunk header
  parseChunkHeader(buffer: ArrayBuffer): ChunkHeader {
    const view = new DataView(buffer);
    
    return {
      magic: view.getUint32(0, true),
      version: view.getUint16(4, true),
      level: view.getUint16(6, true),
      chunkId: view.getUint32(8, true),
      timeStart: view.getBigUint64(12, true),
      timeEnd: view.getBigUint64(20, true),
      signalCount: view.getUint32(28, true),
    };
  }

  // Validate chunk header
  validateChunkHeader(header: ChunkHeader): boolean {
    return header.magic === 0x57415645 && header.version === 1;
  }

  // Clear all data
  async clear(): Promise<void> {
    const root = this.getRoot();
    try {
      await root.removeEntry('waves', { recursive: true });
    } catch {}
  }
}

// Singleton instance
export const opfsManager = new OPFSManager();
export type { WaveMeta, ChunkHeader, SignalBlockHeader };
