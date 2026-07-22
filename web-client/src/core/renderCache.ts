/**
 * RenderCache - 渲染结果缓存
 * 
 * 功能：
 * 1. 基于参数哈希的渲染结果缓存
 * 2. LRU 淘汰策略
 * 3. 内存限制管理
 * 
 * 适用场景：
 * - 用户缩放/平移后回到相同视图
 * - 重复打开相同的信号组合
 * - 快速前后导航
 */

import { ViewportConfig, RenderResult } from './waveformProviderInterface';

interface CacheEntry {
  key: string;
  result: RenderResult;
  lastAccessed: number;
  accessCount: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  currentSize: number;
  maxSize: number;
}

export class RenderCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly maxSize: number;
  private readonly maxMemoryMB: number;
  private stats: CacheStats;

  constructor(maxSize: number = 50, maxMemoryMB: number = 100) {
    this.maxSize = maxSize;
    this.maxMemoryMB = maxMemoryMB;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      currentSize: 0,
      maxSize
    };
  }

  /**
   * 生成缓存键
   * @param lodLevel 当前 LoD 级别，避免不同 LoD 的结果碰撞
   */
  generateKey(signalNames: string[], viewport: ViewportConfig, lodLevel?: number): string {
    const signalsKey = signalNames.slice().sort().join(',');
    const viewportKey = `${viewport.startTime},${viewport.endTime},${viewport.width},${viewport.height}`;
    const lodKey = lodLevel !== undefined ? `|lod=${lodLevel}` : '';
    return `${signalsKey}|${viewportKey}${lodKey}`;
  }

  /**
   * 获取缓存的渲染结果
   */
  get(signalNames: string[], viewport: ViewportConfig, lodLevel?: number): RenderResult | null {
    const key = this.generateKey(signalNames, viewport, lodLevel);
    const entry = this.cache.get(key);

    if (entry) {
      // 更新访问信息
      entry.lastAccessed = Date.now();
      entry.accessCount++;
      this.stats.hits++;
      return entry.result;
    }

    this.stats.misses++;
    return null;
  }

  /**
   * 存储渲染结果到缓存
   */
  set(signalNames: string[], viewport: ViewportConfig, result: RenderResult, lodLevel?: number): void {
    const key = this.generateKey(signalNames, viewport, lodLevel);

    // 检查是否已存在
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      entry.result = result;
      entry.lastAccessed = Date.now();
      entry.accessCount++;
      return;
    }

    // 检查内存限制
    if (this.estimateMemoryUsage() > this.maxMemoryMB) {
      this.evictLRU();
    }

    // 检查容量限制
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    // 添加新条目
    this.cache.set(key, {
      key,
      result,
      lastAccessed: Date.now(),
      accessCount: 1
    });

    this.stats.currentSize = this.cache.size;
  }

  /**
   * 检查是否有缓存
   */
  has(signalNames: string[], viewport: ViewportConfig, lodLevel?: number): boolean {
    const key = this.generateKey(signalNames, viewport, lodLevel);
    return this.cache.has(key);
  }

  /**
   * 清除所有缓存
   */
  clear(): void {
    this.cache.clear();
    this.stats.currentSize = 0;
    this.stats.evictions = 0;
  }

  /**
   * 清除特定信号的缓存
   */
  clearForSignals(signalNames: string[]): void {
    const signalsSet = new Set(signalNames);
    
    for (const [key, _entry] of this.cache.entries()) {
      // 解析缓存键中的信号列表
      const cachedSignals = key.split('|')[0].split(',');
      const hasOverlap = cachedSignals.some(s => signalsSet.has(s));
      
      if (hasOverlap) {
        this.cache.delete(key);
        this.stats.evictions++;
      }
    }

    this.stats.currentSize = this.cache.size;
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * 获取命中率
   */
  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * LRU 淘汰策略
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
      this.stats.currentSize = this.cache.size;
    }
  }

  /**
   * 估算内存使用量（MB）
   */
  private estimateMemoryUsage(): number {
    let totalBytes = 0;

    for (const entry of this.cache.values()) {
      // 估算 ImageBitmap 内存（假设每个像素 4 字节）
      if (entry.result.imageBitmap) {
        totalBytes += entry.result.imageBitmap.width * 
                      entry.result.imageBitmap.height * 4;
      }

      // 估算 segments 数据
      if (entry.result.segments) {
        for (const segments of Object.values(entry.result.segments)) {
          const segs = segments as unknown as { length: number }[];
          totalBytes += segs.length * 8; // 每个点 8 字节（x, y 各 float）
        }
      }
    }

    return totalBytes / (1024 * 1024);
  }

  /**
   * 获取缓存键列表（用于调试）
   */
  getKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    return this.cache.size;
  }
}

// 导出单例实例
export const globalRenderCache = new RenderCache();
