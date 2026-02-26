// ============================================
// LRU Cache - Memory Hot Layer
// ============================================
// 
// Responsibilities (per spec.md & hint3.md):
// - Frame-level render cache (extremely fast, volatile)
// - Store GPU-ready data (already LOD-processed, viewport-clipped)
// - O(1) hit, O(1) eviction
// - TypedArray-based, no JSON, no object fragmentation
//
// Data Formats:
// - RenderChunk: GPU-ready segments (Float32Array)
// - Not transition lists (those go in OPFS)

import type { RenderChunk, LoDLevelType } from '../../types';

interface CacheNode<T> {
  key: string;
  data: T;
  size: number;
  timestamp: number;
  prev: CacheNode<T> | null;
  next: CacheNode<T> | null;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  currentSize: number;
  maxSize: number;
  entryCount: number;
}

class LRUCache<T> {
  private cache: Map<string, CacheNode<T>> = new Map();
  private head: CacheNode<T> | null = null;
  private tail: CacheNode<T> | null = null;
  private currentSize = 0;
  private maxSize: number;
  private stats: CacheStats;

  constructor(maxSizeBytes: number = 100 * 1024 * 1024) {
    // Default 100MB
    this.maxSize = maxSizeBytes;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      currentSize: 0,
      maxSize: maxSizeBytes,
      entryCount: 0,
    };
  }

  // Generate cache key
  static generateKey(signalId: string, lodLevel: LoDLevelType, chunkId: number): string {
    return `${signalId}:${lodLevel}:${chunkId}`;
  }

  // Parse cache key
  static parseKey(key: string): { signalId: string; lodLevel: LoDLevelType; chunkId: number } {
    const parts = key.split(':');
    return {
      signalId: parts[0],
      lodLevel: parseInt(parts[1], 10) as LoDLevelType,
      chunkId: parseInt(parts[2], 10),
    };
  }

  // Get item from cache
  get(key: string): T | null {
    const node = this.cache.get(key);
    
    if (node) {
      // Move to front (most recently used)
      this.moveToFront(node);
      this.stats.hits++;
      return node.data;
    }
    
    this.stats.misses++;
    return null;
  }

  // Put item in cache
  put(key: string, data: T, sizeBytes: number): void {
    // Check if already exists
    const existingNode = this.cache.get(key);
    if (existingNode) {
      // Update existing
      this.currentSize -= existingNode.size;
      existingNode.data = data;
      existingNode.size = sizeBytes;
      existingNode.timestamp = Date.now();
      this.currentSize += sizeBytes;
      this.moveToFront(existingNode);
      return;
    }

    // Create new node
    const newNode: CacheNode<T> = {
      key,
      data,
      size: sizeBytes,
      timestamp: Date.now(),
      prev: null,
      next: null,
    };

    // Add to cache
    this.cache.set(key, newNode);
    this.addToFront(newNode);
    this.currentSize += sizeBytes;
    this.stats.entryCount++;

    // Evict if necessary
    while (this.currentSize > this.maxSize && this.tail) {
      this.evictLRU();
    }
  }

  // Check if key exists
  has(key: string): boolean {
    return this.cache.has(key);
  }

  // Remove item from cache
  remove(key: string): boolean {
    const node = this.cache.get(key);
    if (!node) return false;

    this.removeNode(node);
    this.cache.delete(key);
    this.currentSize -= node.size;
    this.stats.entryCount--;
    return true;
  }

  // Clear all items
  clear(): void {
    this.cache.clear();
    this.head = null;
    this.tail = null;
    this.currentSize = 0;
    this.stats.entryCount = 0;
  }

  // Get cache statistics
  getStats(): CacheStats {
    return {
      ...this.stats,
      currentSize: this.currentSize,
      entryCount: this.cache.size,
    };
  }

  // Get all keys
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  // Get cache size
  size(): number {
    return this.currentSize;
  }

  // Private: Add node to front of list
  private addToFront(node: CacheNode<T>): void {
    node.next = this.head;
    node.prev = null;
    
    if (this.head) {
      this.head.prev = node;
    }
    
    this.head = node;
    
    if (!this.tail) {
      this.tail = node;
    }
  }

  // Private: Move node to front
  private moveToFront(node: CacheNode<T>): void {
    if (node === this.head) return;
    
    this.removeNode(node);
    this.addToFront(node);
  }

  // Private: Remove node from list
  private removeNode(node: CacheNode<T>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
  }

  // Private: Evict least recently used item
  private evictLRU(): void {
    if (!this.tail) return;

    const key = this.tail.key;
    const size = this.tail.size;
    
    this.removeNode(this.tail);
    this.cache.delete(key);
    
    this.currentSize -= size;
    this.stats.evictions++;
    this.stats.entryCount--;
  }
}

// Specialized cache for render chunks
class RenderChunkCache extends LRUCache<RenderChunk> {
  constructor(maxSizeBytes: number = 100 * 1024 * 1024) {
    super(maxSizeBytes);
  }

  // Calculate size of render chunk
  static calculateSize(chunk: RenderChunk): number {
    // Float32Array: 4 bytes per element
    const segmentSize = chunk.segmentBuffer.byteLength;
    const metaSize = chunk.textMeta ? chunk.textMeta.length * 32 : 0; // Estimate
    return segmentSize + metaSize + 64; // Overhead
  }

  // Put render chunk with auto size calculation
  putChunk(signalId: string, lodLevel: LoDLevelType, chunkId: number, chunk: RenderChunk): void {
    const key = LRUCache.generateKey(signalId, lodLevel, chunkId);
    const size = RenderChunkCache.calculateSize(chunk);
    this.put(key, chunk, size);
  }

  // Get render chunk
  getChunk(signalId: string, lodLevel: LoDLevelType, chunkId: number): RenderChunk | null {
    const key = LRUCache.generateKey(signalId, lodLevel, chunkId);
    return this.get(key);
  }

  // Check if chunk exists
  hasChunk(signalId: string, lodLevel: LoDLevelType, chunkId: number): boolean {
    const key = LRUCache.generateKey(signalId, lodLevel, chunkId);
    return this.has(key);
  }

  // Remove chunk
  removeChunk(signalId: string, lodLevel: LoDLevelType, chunkId: number): boolean {
    const key = LRUCache.generateKey(signalId, lodLevel, chunkId);
    return this.remove(key);
  }

  // Evict all chunks for a signal
  evictSignal(signalId: string): number {
    let count = 0;
    const keysToRemove: string[] = [];

    for (const key of this.keys()) {
      const parsed = LRUCache.parseKey(key);
      if (parsed.signalId === signalId) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      if (this.remove(key)) {
        count++;
      }
    }

    return count;
  }

  // Evict all chunks for a LOD level
  evictLOD(lodLevel: LoDLevelType): number {
    let count = 0;
    const keysToRemove: string[] = [];

    for (const key of this.keys()) {
      const parsed = LRUCache.parseKey(key);
      if (parsed.lodLevel === lodLevel) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      if (this.remove(key)) {
        count++;
      }
    }

    return count;
  }
}

// Singleton instance for global render cache
export const renderCache = new RenderChunkCache();

export { LRUCache, RenderChunkCache };
export type { CacheStats };
