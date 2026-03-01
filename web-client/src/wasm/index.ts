// ============================================
// WASM Layer - Web-based HDL Analysis Toolkit
// ============================================
// 
// Architecture: JS (UI/Scheduling) <-> WASM (Data Processing)
// 
// WASM Responsibilities (per hint2.md):
// - FST block decompression
// - Time window clipping
// - Multi-resolution downsampling (LoD)
// - Data compression/decompression
// - Output: TypedArray for WebGL
//
// JS Responsibilities:
// - Cache management
// - Viewport logic
// - WebGL call scheduling
// - UI interaction

import type { LoDLevelType, Transition, SignalBlock } from '../types';

// WASM Module Interface
export interface WasmModule {
  // Memory management
  memory: WebAssembly.Memory;
  
  // FST Parsing functions
  fst_open: (ptr: number, len: number) => number;
  fst_close: (handle: number) => void;
  fst_get_signal_count: (handle: number) => number;
  fst_get_time_range: (handle: number, startPtr: number, endPtr: number) => void;
  
  // Chunk decoding
  decode_chunk: (
    chunkPtr: number,
    chunkLen: number,
    level: number,
    outPtr: number,
    outLen: number
  ) => number;
  
  // LoD generation
  generate_lod: (
    inputPtr: number,
    inputLen: number,
    level: LoDLevelType,
    outPtr: number,
    outLen: number
  ) => number;
  
  // Value formatting
  format_value: (
    valuePtr: number,
    valueLen: number,
    width: number,
    format: number,
    outPtr: number,
    outLen: number
  ) => number;
}

// WASM Instance Manager
class WasmManager {
  private module: WasmModule | null = null;
  private initialized = false;
  
  async initialize(wasmUrl?: string): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Dynamic import of WASM module
      // In production, this would load the compiled .wasm file
      const wasmModule = await WebAssembly.instantiateStreaming(
        fetch(wasmUrl || '/wasm/hwda_wasm.wasm'),
        {
          env: {
            memory: new WebAssembly.Memory({ initial: 256, maximum: 16384 }),
            abort: () => console.error('WASM abort'),
            __wbindgen_throw: (ptr: number, len: number) => {
              console.error('WASM throw:', ptr, len);
            },
          },
        }
      );
      
      this.module = wasmModule.instance.exports as unknown as WasmModule;
      this.initialized = true;
      
      console.log('[WASM] Module initialized successfully');
    } catch (error) {
      console.error('[WASM] Failed to initialize:', error);
      throw error;
    }
  }
  
  isInitialized(): boolean {
    return this.initialized && this.module !== null;
  }
  
  getModule(): WasmModule {
    if (!this.module) {
      throw new Error('WASM module not initialized');
    }
    return this.module;
  }
  
  // High-level API for chunk decoding
  decodeChunk(chunkData: ArrayBuffer, level: LoDLevelType): SignalBlock[] {
    if (!this.module) {
      throw new Error('WASM module not initialized');
    }
    
    // Allocate memory for input
    const inputLen = chunkData.byteLength;
    const inputPtr = this.malloc(inputLen);
    
    // Copy data to WASM memory
    const memory = new Uint8Array(this.module.memory.buffer);
    memory.set(new Uint8Array(chunkData), inputPtr);
    
    // Allocate output buffer (estimate)
    const outLen = inputLen * 4;
    const outPtr = this.malloc(outLen);
    
    // Call WASM function
    const resultLen = this.module.decode_chunk(inputPtr, inputLen, level, outPtr, outLen);
    
    // Read result
    const result = new Uint8Array(this.module.memory.buffer, outPtr, resultLen);
    const blocks = this.parseSignalBlocks(result);
    
    // Free memory
    this.free(inputPtr);
    this.free(outPtr);
    
    return blocks;
  }
  
  // High-level API for LoD generation
  generateLoD(
    transitions: Transition[],
    level: LoDLevelType
  ): Transition[] {
    if (!this.module) {
      throw new Error('WASM module not initialized');
    }
    
    // Serialize transitions to binary format
    const inputData = this.serializeTransitions(transitions);
    const inputLen = inputData.byteLength;
    const inputPtr = this.malloc(inputLen);
    
    const memory = new Uint8Array(this.module.memory.buffer);
    memory.set(new Uint8Array(inputData), inputPtr);
    
    // Allocate output
    const outLen = inputLen * 2;
    const outPtr = this.malloc(outLen);
    
    // Call WASM
    const resultLen = this.module.generate_lod(inputPtr, inputLen, level, outPtr, outLen);
    
    // Parse result
    const result = new Uint8Array(this.module.memory.buffer, outPtr, resultLen);
    const outputTransitions = this.parseTransitions(result);
    
    // Cleanup
    this.free(inputPtr);
    this.free(outPtr);
    
    return outputTransitions;
  }
  
  // Memory management helpers
  private malloc(_size: number): number {
    // In real implementation, this would use wasm-bindgen's allocator
    // For now, simplified version
    return 0;
  }
  
  private free(_ptr: number): void {
    // In real implementation, this would use wasm-bindgen's allocator
  }
  
  private parseSignalBlocks(data: Uint8Array): SignalBlock[] {
    // Parse binary format to SignalBlock array
    // Format: [count: u32] + [SignalBlock...]
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint32(0, true);
    const blocks: SignalBlock[] = [];
    
    let offset = 4;
    for (let i = 0; i < count; i++) {
      const handle = view.getUint32(offset, true);
      const transitionCount = view.getUint32(offset + 4, true);
      offset += 8;
      
      const transitions: Transition[] = [];
      for (let j = 0; j < transitionCount; j++) {
        const time = Number(view.getBigUint64(offset, true));
        const valueLen = view.getUint16(offset + 8, true);
        offset += 10;
        
        const valueBytes = data.slice(offset, offset + valueLen);
        const value = new TextDecoder().decode(valueBytes);
        offset += valueLen;
        
        transitions.push({ time, value });
      }
      
      blocks.push({ handle, transitions });
    }
    
    return blocks;
  }
  
  private serializeTransitions(transitions: Transition[]): ArrayBuffer {
    // Calculate size
    let size = 4; // count
    for (const t of transitions) {
      size += 8 + 2 + new TextEncoder().encode(t.value).length; // time + len + value
    }
    
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    let offset = 0;
    
    view.setUint32(offset, transitions.length, true);
    offset += 4;
    
    for (const t of transitions) {
      view.setBigUint64(offset, BigInt(t.time), true);
      offset += 8;
      
      const valueBytes = new TextEncoder().encode(t.value);
      view.setUint16(offset, valueBytes.length, true);
      offset += 2;
      
      new Uint8Array(buffer, offset, valueBytes.length).set(valueBytes);
      offset += valueBytes.length;
    }
    
    return buffer;
  }
  
  private parseTransitions(data: Uint8Array): Transition[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint32(0, true);
    const transitions: Transition[] = [];
    
    let offset = 4;
    for (let i = 0; i < count; i++) {
      const time = Number(view.getBigUint64(offset, true));
      const valueLen = view.getUint16(offset + 8, true);
      offset += 10;
      
      const valueBytes = data.slice(offset, offset + valueLen);
      const value = new TextDecoder().decode(valueBytes);
      offset += valueLen;
      
      transitions.push({ time, value });
    }
    
    return transitions;
  }
}

// Singleton instance
export const wasmManager = new WasmManager();

// React hook for WASM
export function useWasm() {
  return {
    initialize: (url?: string) => wasmManager.initialize(url),
    isInitialized: () => wasmManager.isInitialized(),
    decodeChunk: (data: ArrayBuffer, level: LoDLevelType) => 
      wasmManager.decodeChunk(data, level),
    generateLoD: (transitions: Transition[], level: LoDLevelType) =>
      wasmManager.generateLoD(transitions, level),
  };
}
