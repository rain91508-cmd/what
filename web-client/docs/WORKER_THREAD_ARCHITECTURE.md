# Worker Thread 架构设计文档

## 概述

本文档描述将波形渲染从主线程迁移到 Worker Thread 的架构设计。目标是将耗时的 WASM 计算和波形渲染移出主线程，避免 UI 卡顿，提升用户体验。

## 当前架构问题

```
主线程 (UI Thread)
├── React 组件渲染 ← 被阻塞！
├── 用户交互处理 ← 被阻塞！
├── WASM 数据获取 (fetch_and_get_segments) ← 耗时操作
├── WASM 段计算 (get_segments) ← 耗时操作
├── 波形渲染 (Canvas 绘制) ← 耗时操作
└── 其他 UI 更新 ← 被阻塞！
```

**问题**：所有操作都在主线程，WASM 计算和渲染会阻塞 UI，导致：
- 拖动波形时卡顿
- 缩放时无响应
- 大量信号时浏览器假死

## 目标架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        主线程 (Main Thread)                          │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              React 组件层 (WaveformWindow.tsx)                │  │
│  │  - 用户交互处理 (鼠标事件、滚动、缩放)                          │  │
│  │  - 状态管理 (viewport、signal list、cursor)                   │  │
│  │  - 调用 WaveformProviderInterface                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              ↓                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │          WaveformProviderInterface (TypeScript 接口)          │  │
│  │  - 定义稳定的 API 契约                                         │  │
│  │  - 与具体实现解耦                                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              ↓                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │         WorkerWaveformProvider (Worker 通信包装器)             │  │
│  │  - 管理 Worker 实例                                            │  │
│  │  - 发送/接收消息                                               │  │
│  │  - Promise 封装                                                │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              ↓ postMessage                          │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│                      Worker Thread (Dedicated Worker)                │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              WaveformWorker (消息处理主循环)                   │  │
│  │  - 接收主线程消息                                              │  │
│  │  - 分发到对应处理函数                                          │  │
│  │  - 发送结果回主线程                                            │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              ↓                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              WASM 层 (Rust/WASM 模块)                          │  │
│  │  - WaveformDataProvider                                        │  │
│  │  - fetch_and_get_segments()                                    │  │
│  │  - OPFS 缓存读写                                               │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              ↓                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              渲染引擎 (OffscreenCanvas 渲染)                   │  │
│  │  - 接收 segments 数据                                          │  │
│  │  - 在 Worker 中绘制到 OffscreenCanvas                          │  │
│  │  - 将绘制好的 bitmap 传回主线程                                │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. WaveformProviderInterface (接口层)

定义所有对外暴露的方法，与实现解耦。

```typescript
// core/waveformProviderInterface.ts

export interface RenderSegment {
  x0: number;
  x1: number;
  y: number;
  value: ValueInfo;
  signalName: string;
}

export interface ValueInfo {
  valueType: string;
  displayStr: string;
  width: number;
  hasXZ: boolean;
  minValue?: string;
  maxValue?: string;
  isMinMax: boolean;
}

export interface WasmSignalInfo {
  globalId: number;
  name: string;
  row: number;
  width: number;
  drawSigId: number;
  bitExtract?: { parentName: string; msb: number; lsb: number };
}

export interface ViewportConfig {
  timeStart: number;
  timeEnd: number;
}

export interface CanvasConfig {
  width: number;
  height: number;
  rowHeight: number;
}

export interface ProviderConfig {
  serverUrl: string;
  waveformName: string;
  signalPrefix: string;
  spaceBeforeBracket: boolean;
  timeStamp: number;
  enableOpfs?: boolean;
  enableMemoryCache?: boolean;
}

/**
 * 波形数据提供者接口
 * 定义所有对外暴露的方法，与具体实现解耦
 */
export interface WaveformProviderInterface {
  // ==================== 生命周期 ====================
  
  /**
   * 初始化提供者
   */
  initialize(config: ProviderConfig): Promise<void>;
  
  /**
   * 销毁提供者，释放资源
   */
  dispose(): Promise<void>;
  
  // ==================== 配置设置 ====================
  
  /**
   * 设置视口范围
   */
  setViewport(config: ViewportConfig): void;
  
  /**
   * 设置画布尺寸
   */
  setCanvasDimensions(config: CanvasConfig): void;
  
  /**
   * 设置信号列表
   */
  setSignalList(signals: WasmSignalInfo[]): void;
  
  /**
   * 设置显示格式
   */
  setDisplayFormat(format: 'hex' | 'bin' | 'oct' | 'dec'): void;
  
  // ==================== 数据获取 ====================
  
  /**
   * 获取指定时间点的信号值
   */
  getSignalValueAtTime(signalName: string, time: number): Promise<ValueInfo | null>;
  
  /**
   * 查找指定时间点前后的跳变
   */
  findTransitionsAround(
    signalName: string, 
    time: number
  ): Promise<{ prev: number | null; next: number | null }>;
  
  // ==================== 渲染 ====================
  
  /**
   * 获取渲染段（用于主线程渲染模式）
   */
  fetchAndGetSegments(signalNames: string[]): Promise<RenderSegment[]>;
  
  /**
   * 渲染波形到 OffscreenCanvas（用于 Worker 渲染模式）
   * @returns ImageBitmap 或 transfer 对象
   */
  renderWaveform(
    signalNames: string[],
    offscreenCanvas: OffscreenCanvas
  ): Promise<ImageBitmap>;
  
  // ==================== 缓存管理 ====================
  
  /**
   * 清除所有缓存
   */
  clearCache(): Promise<void>;
  
  /**
   * 设置 OPFS 缓存启用状态
   */
  setOpfsEnabled(enabled: boolean): void;
  
  /**
   * 设置内存缓存启用状态
   */
  setMemoryCacheEnabled(enabled: boolean): void;
  
  // ==================== 属性 ====================
  
  readonly viewportTimeStart: number;
  readonly viewportTimeEnd: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly isOpfsEnabled: boolean;
  readonly isMemoryCacheEnabled: boolean;
}
```

### 2. WorkerWaveformProvider (Worker 通信层)

在主线程中，通过 postMessage 与 Worker 通信。

```typescript
// wasm/workerWaveformProvider.ts

import { 
  WaveformProviderInterface, 
  RenderSegment, 
  ValueInfo,
  WasmSignalInfo,
  ViewportConfig,
  CanvasConfig,
  ProviderConfig 
} from '../core/waveformProviderInterface';

interface PendingMessage {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: number;
}

/**
 * Worker 模式下的波形提供者实现
 * 通过 postMessage 与 Worker 线程通信
 */
export class WorkerWaveformProvider implements WaveformProviderInterface {
  private worker: Worker;
  private messageId = 0;
  private pendingMessages = new Map<number, PendingMessage>();
  private config: ProviderConfig | null = null;
  private viewport: ViewportConfig = { timeStart: 0, timeEnd: 1000 };
  private canvas: CanvasConfig = { width: 800, height: 600, rowHeight: 24 };
  private _isOpfsEnabled = false;
  private _isMemoryCacheEnabled = true;
  
  // 默认超时时间 30 秒
  private readonly DEFAULT_TIMEOUT = 30000;
  
  constructor() {
    // 创建 Worker
    this.worker = new Worker(
      new URL('../workers/waveformWorker.ts', import.meta.url),
      { type: 'module' }
    );
    
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);
  }
  
  private handleMessage(event: MessageEvent) {
    const { type, id, data, error, success } = event.data;
    
    const pending = this.pendingMessages.get(id);
    if (!pending) {
      console.warn(`[WorkerProvider] Received message for unknown id: ${id}`);
      return;
    }
    
    clearTimeout(pending.timeout);
    this.pendingMessages.delete(id);
    
    if (type === 'ERROR' || !success) {
      pending.reject(new WaveformProviderError(error || 'Unknown error'));
    } else {
      pending.resolve(data);
    }
  }
  
  private handleError(error: ErrorEvent) {
    console.error('[WorkerProvider] Worker error:', error);
    // 拒绝所有 pending 的消息
    this.pendingMessages.forEach((pending, id) => {
      clearTimeout(pending.timeout);
      pending.reject(new WaveformProviderError(`Worker error: ${error.message}`));
    });
    this.pendingMessages.clear();
  }
  
  private sendMessage<T>(
    type: string, 
    payload: any, 
    timeout: number = this.DEFAULT_TIMEOUT
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      
      // 设置超时
      const timeoutId = window.setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new WaveformProviderError(`Operation timeout after ${timeout}ms`));
      }, timeout);
      
      this.pendingMessages.set(id, {
        resolve,
        reject,
        timeout: timeoutId
      });
      
      // 发送消息到 Worker
      this.worker.postMessage({ type, payload, id });
    });
  }
  
  // ==================== 生命周期 ====================
  
  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
    await this.sendMessage('INITIALIZE', { config });
    this._isOpfsEnabled = config.enableOpfs ?? false;
    this._isMemoryCacheEnabled = config.enableMemoryCache ?? true;
  }
  
  async dispose(): Promise<void> {
    // 取消所有 pending 操作
    this.pendingMessages.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(new WaveformProviderError('Provider disposed'));
    });
    this.pendingMessages.clear();
    
    // 通知 Worker 清理资源
    await this.sendMessage('DISPOSE', {});
    
    // 终止 Worker
    this.worker.terminate();
  }
  
  // ==================== 配置设置 ====================
  
  setViewport(config: ViewportConfig): void {
    this.viewport = config;
    // 同步方法不等待结果，提高响应速度
    this.worker.postMessage({
      type: 'SET_VIEWPORT',
      payload: { config },
      id: ++this.messageId
    });
  }
  
  setCanvasDimensions(config: CanvasConfig): void {
    this.canvas = config;
    this.worker.postMessage({
      type: 'SET_CANVAS_DIMENSIONS',
      payload: { config },
      id: ++this.messageId
    });
  }
  
  async setSignalList(signals: WasmSignalInfo[]): Promise<void> {
    await this.sendMessage('SET_SIGNAL_LIST', { signals });
  }
  
  async setDisplayFormat(format: 'hex' | 'bin' | 'oct' | 'dec'): Promise<void> {
    await this.sendMessage('SET_DISPLAY_FORMAT', { format });
  }
  
  // ==================== 数据获取 ====================
  
  async getSignalValueAtTime(signalName: string, time: number): Promise<ValueInfo | null> {
    return this.sendMessage('GET_SIGNAL_VALUE_AT_TIME', { signalName, time });
  }
  
  async findTransitionsAround(
    signalName: string, 
    time: number
  ): Promise<{ prev: number | null; next: number | null }> {
    return this.sendMessage('FIND_TRANSITIONS_AROUND', { signalName, time });
  }
  
  // ==================== 渲染 ====================
  
  async fetchAndGetSegments(signalNames: string[]): Promise<RenderSegment[]> {
    return this.sendMessage('FETCH_AND_GET_SEGMENTS', { signalNames });
  }
  
  async renderWaveform(
    signalNames: string[],
    offscreenCanvas: OffscreenCanvas
  ): Promise<ImageBitmap> {
    // 将 OffscreenCanvas 通过 Transfer 传给 Worker
    return this.sendMessage(
      'RENDER_WAVEFORM',
      { signalNames, canvas: offscreenCanvas },
      60000 // 渲染超时 60 秒
    );
  }
  
  // ==================== 缓存管理 ====================
  
  async clearCache(): Promise<void> {
    await this.sendMessage('CLEAR_CACHE', {});
  }
  
  setOpfsEnabled(enabled: boolean): void {
    this._isOpfsEnabled = enabled;
    this.worker.postMessage({
      type: 'SET_OPFS_ENABLED',
      payload: { enabled },
      id: ++this.messageId
    });
  }
  
  setMemoryCacheEnabled(enabled: boolean): void {
    this._isMemoryCacheEnabled = enabled;
    this.worker.postMessage({
      type: 'SET_MEMORY_CACHE_ENABLED',
      payload: { enabled },
      id: ++this.messageId
    });
  }
  
  // ==================== 属性 ====================
  
  get viewportTimeStart(): number {
    return this.viewport.timeStart;
  }
  
  get viewportTimeEnd(): number {
    return this.viewport.timeEnd;
  }
  
  get canvasWidth(): number {
    return this.canvas.width;
  }
  
  get canvasHeight(): number {
    return this.canvas.height;
  }
  
  get isOpfsEnabled(): boolean {
    return this._isOpfsEnabled;
  }
  
  get isMemoryCacheEnabled(): boolean {
    return this._isMemoryCacheEnabled;
  }
}

export class WaveformProviderError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'WaveformProviderError';
  }
}
```

### 3. WaveformWorker (Worker 线程)

Worker 线程中运行 WASM 和渲染引擎。

```typescript
// workers/waveformWorker.ts

import { WaveformDataProvider } from '../wasm-pkg/hwda_wasm.js';
import { init } from '../wasm-pkg/hwda_wasm.js';

// Worker 内部状态
let wasmProvider: WaveformDataProvider | null = null;
let wasmInitialized = false;

// 渲染器（在 Worker 中使用 OffscreenCanvas 渲染）
class WorkerWaveformRenderer {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  
  initialize(canvas: OffscreenCanvas): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) {
      throw new Error('Failed to get 2D context from OffscreenCanvas');
    }
  }
  
  render(segments: any[], canvasWidth: number, canvasHeight: number): ImageBitmap {
    if (!this.canvas || !this.ctx) {
      throw new Error('Renderer not initialized');
    }
    
    // 清空画布
    this.ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    // 绘制网格线
    this.drawGrid(canvasWidth, canvasHeight);
    
    // 绘制波形段
    for (const segment of segments) {
      this.drawSegment(segment);
    }
    
    // 返回绘制的位图
    return this.canvas.transferToImageBitmap();
  }
  
  private drawGrid(width: number, height: number): void {
    if (!this.ctx) return;
    
    this.ctx.strokeStyle = '#e0e0e0';
    this.ctx.lineWidth = 1;
    
    // 绘制水平网格线
    for (let y = 0; y < height; y += 24) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }
  }
  
  private drawSegment(segment: any): void {
    if (!this.ctx) return;
    
    const { x0, x1, y, value } = segment;
    
    // 根据值类型选择颜色
    let color = '#000000';
    if (value.valueType === 'zero') color = '#0066cc';
    else if (value.valueType === 'one') color = '#cc0000';
    else if (value.valueType === 'all_x') color = '#999999';
    else if (value.valueType === 'all_z') color = '#ff8800';
    
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    
    // 绘制水平线
    this.ctx.beginPath();
    this.ctx.moveTo(x0, y);
    this.ctx.lineTo(x1, y);
    this.ctx.stroke();
    
    // 如果是多 bit 值，绘制值文本
    if (value.width > 1) {
      this.ctx.fillStyle = color;
      this.ctx.font = '10px monospace';
      this.ctx.textAlign = 'center';
      const centerX = (x0 + x1) / 2;
      this.ctx.fillText(value.displayStr, centerX, y - 5);
    }
  }
}

const renderer = new WorkerWaveformRenderer();

// 消息处理主循环
self.onmessage = async (event) => {
  const { type, payload, id } = event.data;
  
  try {
    switch (type) {
      // ==================== 生命周期 ====================
      
      case 'INITIALIZE': {
        if (!wasmInitialized) {
          await init();
          wasmInitialized = true;
        }
        
        const { config } = payload;
        wasmProvider = new WaveformDataProvider(
          config.serverUrl,
          config.waveformName,
          config.signalPrefix,
          config.spaceBeforeBracket,
          BigInt(config.timeStamp)
        );
        
        // 初始化 OPFS...
        if (config.enableOpfs) {
          // ... OPFS 初始化代码
        }
        
        self.postMessage({ type: 'RESULT', id, success: true });
        break;
      }
      
      case 'DISPOSE': {
        if (wasmProvider) {
          // 清理 WASM 资源
          wasmProvider = null;
        }
        self.postMessage({ type: 'RESULT', id, success: true });
        break;
      }
      
      // ==================== 配置设置 ====================
      
      case 'SET_VIEWPORT': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        const { config } = payload;
        wasmProvider.set_viewport(config.timeStart, config.timeEnd);
        self.postMessage({ type: 'RESULT', id, success: true });
        break;
      }
      
      case 'SET_CANVAS_DIMENSIONS': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        const { config } = payload;
        wasmProvider.set_canvas_dimensions(config.width, config.height, config.rowHeight);
        self.postMessage({ type: 'RESULT', id, success: true });
        break;
      }
      
      case 'SET_SIGNAL_LIST': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        const { signals } = payload;
        wasmProvider.set_draw_list(signals);
        self.postMessage({ type: 'RESULT', id, success: true });
        break;
      }
      
      case 'SET_DISPLAY_FORMAT': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        const { format } = payload;
        wasmProvider.display_format = format;
        self.postMessage({ type: 'RESULT', id, success: true });
        break;
      }
      
      // ==================== 数据获取 ====================
      
      case 'GET_SIGNAL_VALUE_AT_TIME': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        const { signalName, time } = payload;
        const value = wasmProvider.get_signal_value_at_time(signalName, time);
        self.postMessage({ type: 'RESULT', id, success: true, data: value });
        break;
      }
      
      case 'FIND_TRANSITIONS_AROUND': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        const { signalName, time } = payload;
        const transitions = wasmProvider.find_transitions_around(signalName, time);
        self.postMessage({ type: 'RESULT', id, success: true, data: transitions });
        break;
      }
      
      // ==================== 渲染 ====================
      
      case 'FETCH_AND_GET_SEGMENTS': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        const { signalNames } = payload;
        const segments = await wasmProvider.fetch_and_get_segments(signalNames);
        self.postMessage({ type: 'RESULT', id, success: true, data: segments });
        break;
      }
      
      case 'RENDER_WAVEFORM': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        const { signalNames, canvas } = payload;
        
        // 获取 segments
        const segments = await wasmProvider.fetch_and_get_segments(signalNames);
        
        // 初始化渲染器
        renderer.initialize(canvas);
        
        // 在 Worker 中渲染
        const canvasWidth = wasmProvider.canvas_width;
        const canvasHeight = wasmProvider.canvas_height;
        const bitmap = renderer.render(segments, canvasWidth, canvasHeight);
        
        // 返回 ImageBitmap（通过 Transfer）
        self.postMessage(
          { type: 'RESULT', id, success: true, data: bitmap },
          { transfer: [bitmap] }
        );
        break;
      }
      
      // ==================== 缓存管理 ====================
      
      case 'CLEAR_CACHE': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        wasmProvider.clear_cache();
        self.postMessage({ type: 'RESULT', id, success: true });
        break;
      }
      
      case 'SET_OPFS_ENABLED': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        const { enabled } = payload;
        wasmProvider.set_opfs_enabled(enabled);
        self.postMessage({ type: 'RESULT', id, success: true });
        break;
      }
      
      case 'SET_MEMORY_CACHE_ENABLED': {
        if (!wasmProvider) throw new Error('Provider not initialized');
        const { enabled } = payload;
        wasmProvider.set_memory_cache_enabled(enabled);
        self.postMessage({ type: 'RESULT', id, success: true });
        break;
      }
      
      default: {
        throw new Error(`Unknown message type: ${type}`);
      }
    }
  } catch (error) {
    self.postMessage({
      type: 'ERROR',
      id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

// Worker 错误处理
self.onerror = (error) => {
  console.error('[WaveformWorker] Uncaught error:', error);
};
```

### 4. 工厂函数

```typescript
// wasm/waveformProviderFactory.ts

import { WaveformProviderInterface, ProviderConfig } from '../core/waveformProviderInterface';
import { WorkerWaveformProvider } from './workerWaveformProvider';

export interface FactoryConfig extends ProviderConfig {
  /**
   * 是否使用 Worker 模式
   * @default false
   */
  useWorker?: boolean;
}

/**
 * 创建波形提供者
 * 根据配置选择直接模式或 Worker 模式
 */
export async function createWaveformProvider(
  config: FactoryConfig
): Promise<WaveformProviderInterface> {
  const { useWorker = false, ...providerConfig } = config;
  
  if (useWorker) {
    // 检查浏览器是否支持 Worker
    if (typeof Worker === 'undefined') {
      console.warn('[Factory] Worker not supported, falling back to direct mode');
      // 回退到直接模式
      return createDirectProvider(providerConfig);
    }
    
    // 检查是否支持 OffscreenCanvas
    if (typeof OffscreenCanvas === 'undefined') {
      console.warn('[Factory] OffscreenCanvas not supported, falling back to direct mode');
      return createDirectProvider(providerConfig);
    }
    
    console.log('[Factory] Creating WorkerWaveformProvider');
    const provider = new WorkerWaveformProvider();
    await provider.initialize(providerConfig);
    return provider;
  } else {
    return createDirectProvider(providerConfig);
  }
}

/**
 * 创建直接模式提供者（当前实现）
 */
async function createDirectProvider(
  config: ProviderConfig
): Promise<WaveformProviderInterface> {
  // 导入直接模式实现
  const { WasmWaveformProvider } = await import('./wasmWaveformProvider');
  const { createProvider } = await import('./waveformProvider');
  
  console.log('[Factory] Creating WasmWaveformProvider (direct mode)');
  const wasmProvider = await createProvider(
    config.serverUrl,
    config.waveformName,
    config.signalPrefix,
    config.spaceBeforeBracket,
    config.timeStamp,
    config.enableOpfs
  );
  
  return new WasmWaveformProvider(wasmProvider);
}

/**
 * 检查当前环境是否支持 Worker 模式
 */
export function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}
```

### 5. React Hook 封装

```typescript
// hooks/useWaveformProvider.ts

import { useEffect, useRef, useCallback } from 'react';
import { WaveformProviderInterface } from '../core/waveformProviderInterface';
import { createWaveformProvider, isWorkerSupported } from '../wasm/waveformProviderFactory';

interface UseWaveformProviderOptions {
  serverUrl: string;
  waveformName: string;
  signalPrefix: string;
  spaceBeforeBracket: boolean;
  timeStamp: number;
  enableOpfs?: boolean;
  enableMemoryCache?: boolean;
  preferWorker?: boolean;
}

interface UseWaveformProviderResult {
  provider: WaveformProviderInterface | null;
  isLoading: boolean;
  error: Error | null;
  isWorkerMode: boolean;
}

/**
 * React Hook for waveform provider
 * 自动管理 provider 生命周期
 */
export function useWaveformProvider(
  options: UseWaveformProviderOptions
): UseWaveformProviderResult {
  const providerRef = useRef<WaveformProviderInterface | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isWorkerMode, setIsWorkerMode] = useState(false);
  
  useEffect(() => {
    let mounted = true;
    
    const init = async () => {
      try {
        setIsLoading(true);
        setError(null);
        
        const useWorker = options.preferWorker && isWorkerSupported();
        
        const provider = await createWaveformProvider({
          ...options,
          useWorker
        });
        
        if (mounted) {
          providerRef.current = provider;
          setIsWorkerMode(useWorker);
          setIsLoading(false);
        } else {
          // 组件已卸载，清理资源
          await provider.dispose();
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
    };
    
    init();
    
    return () => {
      mounted = false;
      if (providerRef.current) {
        providerRef.current.dispose();
        providerRef.current = null;
      }
    };
  }, [
    options.serverUrl,
    options.waveformName,
    options.signalPrefix,
    options.spaceBeforeBracket,
    options.timeStamp
  ]);
  
  return {
    provider: providerRef.current,
    isLoading,
    error,
    isWorkerMode
  };
}
```

## 使用方式

### 在 WaveformWindow 中使用

```typescript
// WaveformWindow.tsx

import { useWaveformProvider } from './hooks/useWaveformProvider';

function WaveformWindow() {
  const { provider, isLoading, error, isWorkerMode } = useWaveformProvider({
    serverUrl: 'http://localhost:8080',
    waveformName: 'test',
    signalPrefix: 'work@',
    spaceBeforeBracket: true,
    timeStamp: Date.now(),
    enableOpfs: true,
    preferWorker: true  // 优先使用 Worker 模式
  });
  
  // 使用 provider - 代码与之前完全相同！
  const renderWaveform = async () => {
    if (!provider) return;
    
    provider.setViewport({ timeStart: 0, timeEnd: 1000 });
    
    // Worker 模式下，这会在 Worker 中执行，不阻塞 UI
    const segments = await provider.fetchAndGetSegments(signalNames);
    
    // 或者使用 Worker 渲染
    const canvas = canvasRef.current;
    const offscreen = canvas.transferControlToOffscreen();
    const bitmap = await provider.renderWaveform(signalNames, offscreen);
    
    // 在主线程显示
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
  };
  
  return (
    <div>
      {isWorkerMode && <span>Worker Mode</span>}
      {isLoading && <span>Loading...</span>}
      {error && <span>Error: {error.message}</span>}
      {/* ... */}
    </div>
  );
}
```

## 迁移步骤

### 第一阶段：创建接口和直接模式包装器（向后兼容）

1. 创建 `WaveformProviderInterface`
2. 创建 `WasmWaveformProvider`（包装现有 WASM 调用）
3. 更新工厂函数支持两种模式
4. 更新 `WaveformWindow` 使用接口
5. **验证**：功能完全不变

### 第二阶段：实现 Worker 模式

1. 创建 `WaveformWorker`
2. 创建 `WorkerWaveformProvider`
3. 实现 Worker 中的渲染器
4. 更新工厂函数支持 `useWorker` 选项
5. **测试**：Worker 模式功能正常

### 第三阶段：渐进式启用

1. 默认 `useWorker: false`
2. 开发环境启用 Worker 测试
3. 生产环境灰度发布（部分用户启用）
4. 监控性能和稳定性
5. 默认 `useWorker: true`

### 第四阶段：优化

1. Worker 池（多个 Worker 并行处理）
2. 渲染缓存
3. 增量更新
4. 取消长时间操作

## 关键问题解决方案

### 1. 参数同步问题

**问题**：主线程发送渲染命令后，如果用户继续操作（如拖动视口），参数会变化，如何保证 Worker 使用的是发送时的参数？

**解决方案：消息传递时复制参数**

```typescript
// wasm/workerWaveformProvider.ts

class WorkerWaveformProvider {
  private viewport: ViewportConfig = { timeStart: 0, timeEnd: 1000 };
  private canvas: CanvasConfig = { width: 800, height: 600, rowHeight: 24 };
  private signalList: WasmSignalInfo[] = [];
  
  /**
   * 设置视口 - 立即更新本地状态
   */
  setViewport(config: ViewportConfig): void {
    // 复制参数，避免引用问题
    this.viewport = { ...config };
    
    // 发送消息到 Worker（异步，不等待）
    this.worker.postMessage({
      type: 'SET_VIEWPORT',
      payload: { 
        config: { ...config }  // 再次复制，确保 Worker 收到的是快照
      },
      id: ++this.messageId
    });
  }
  
  /**
   * 渲染波形 - 发送时复制所有必要参数
   */
  async renderWaveform(signalNames: string[]): Promise<ImageBitmap> {
    // 关键：发送时复制所有参数，形成不可变快照
    const renderParams = {
      signalNames: [...signalNames],           // 复制数组
      viewport: { ...this.viewport },          // 复制视口配置
      canvas: { ...this.canvas },              // 复制画布配置
      signalList: this.signalList.map(s => ({ ...s }))  // 深拷贝信号列表
    };
    
    return this.sendMessage('RENDER_WAVEFORM', renderParams);
  }
}
```

**Worker 中：使用消息中的参数，不依赖共享状态**

```typescript
// workers/waveformWorker.ts

self.onmessage = async (event) => {
  const { type, payload, id } = event.data;
  
  switch (type) {
    case 'RENDER_WAVEFORM': {
      // 使用消息中的参数，不访问外部变量
      const { signalNames, viewport, canvas, signalList } = payload;
      
      // 使用这些参数设置 WASM 状态
      wasmProvider.set_viewport(viewport.timeStart, viewport.timeEnd);
      wasmProvider.set_canvas_dimensions(canvas.width, canvas.height, canvas.rowHeight);
      wasmProvider.set_draw_list(signalList);
      
      // 使用这些参数计算（即使主线程参数已变化，这里不受影响）
      const segments = await wasmProvider.fetch_and_get_segments(signalNames);
      
      // 渲染并返回结果
      const bitmap = renderToBitmap(segments, canvas);
      self.postMessage(
        { type: 'RESULT', id, success: true, data: bitmap },
        { transfer: [bitmap] }
      );
      break;
    }
  }
};
```

**参数同步流程**

```
时间点  主线程操作                          Worker 状态
─────────────────────────────────────────────────────────
t0      用户拖动视口到 A 位置
        viewport = { timeStart: 100, timeEnd: 200 }
        
t1      调用 renderWaveform()
        复制参数: { viewport: {100, 200}, ... }
        发送消息 ───────────────────────→   接收消息
                                            使用 {100, 200}
                                            
t2      用户继续拖动到 B 位置              正在计算...
        viewport = { timeStart: 150, timeEnd: 250 }
        
t3      再次调用 renderWaveform()          仍在计算...
        复制参数: { viewport: {150, 250}, ... }
        （新命令，旧命令继续执行）
        
t4                                          完成计算
                                            返回结果（基于 t1 的参数）
```

### 2. Render 命令去重与防抖

**问题**：用户快速拖动视口时，会发送大量渲染命令，如何跳过未处理的老命令，只执行最新的？

**解决方案：仅对 Render 命令实施防抖 + 去重**

**设计原则**：
- **Render 命令**（`fetch_and_get_segments` + 绘制）：耗时操作，需要防抖和去重
- **其他命令**（`set_viewport`、`get_signal_value_at_time` 等）：轻量操作，直接发送，无需复杂机制

```typescript
// core/renderScheduler.ts

interface RenderTask {
  id: number;
  signalNames: string[];
  viewport: ViewportConfig;
  timestamp: number;
}

/**
 * 渲染调度器 - 仅管理 Render 命令
 * 
 * 设计原则：
 * 1. 只有 render 命令需要防抖和去重
 * 2. 其他命令（set_viewport、get_value 等）直接发送，不经过此调度器
 * 3. 使用任务 ID 机制，自动跳过过期的 render 请求
 */
export class RenderScheduler {
  private worker: Worker;
  private currentTaskId = 0;
  private pendingTask: RenderTask | null = null;
  private isRendering = false;
  private debounceTimer: number | null = null;
  
  // 防抖延迟（毫秒）- 根据用户体验调整
  private readonly DEBOUNCE_DELAY = 50;
  
  constructor(worker: Worker) {
    this.worker = worker;
  }
  
  /**
   * 请求渲染（带防抖）
   * 
   * 适用场景：拖动、缩放等连续操作
   * 快速连续调用时，只会在停止操作 50ms 后执行最后一次
   */
  requestRender(signalNames: string[], viewport: ViewportConfig): void {
    // 生成新任务 ID（递增）
    const taskId = ++this.currentTaskId;
    
    // 创建任务（复制参数，形成不可变快照）
    const task: RenderTask = {
      id: taskId,
      signalNames: [...signalNames],
      viewport: { ...viewport },
      timestamp: Date.now()
    };
    
    // 取消之前的防抖定时器（如果有）
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    // 保存为待处理任务（覆盖之前的待处理任务）
    this.pendingTask = task;
    
    // 设置新的防抖定时器
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.executeRender();
    }, this.DEBOUNCE_DELAY);
  }
  
  /**
   * 立即执行渲染（跳过防抖）
   * 
   * 适用场景：
   * - 初始化首次渲染
   * - 强制刷新
   * - 用户明确触发的操作（如点击刷新按钮）
   */
  requestRenderImmediate(signalNames: string[], viewport: ViewportConfig): Promise<void> {
    // 取消防抖定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    
    // 生成新任务
    const taskId = ++this.currentTaskId;
    this.pendingTask = {
      id: taskId,
      signalNames: [...signalNames],
      viewport: { ...viewport },
      timestamp: Date.now()
    };
    
    return this.executeRender();
  }
  
  /**
   * 执行渲染任务
   * 
   * 核心逻辑：
   * 1. 检查是否有待处理任务
   * 2. 检查是否正在渲染（避免并发）
   * 3. 检查任务是否过期（不是最新的）
   * 4. 发送命令到 Worker
   * 5. 完成后检查是否有新的待处理任务
   */
  private async executeRender(): Promise<void> {
    // 如果没有待处理任务，直接返回
    if (!this.pendingTask) return;
    
    // 如果正在渲染，不中断当前渲染，等待完成后再处理新任务
    // 这样保证渲染的完整性，避免画面闪烁
    if (this.isRendering) {
      console.log('[RenderScheduler] Render in progress, new task will be processed after completion');
      return;
    }
    
    // 获取待处理任务并清空队列
    const task = this.pendingTask;
    this.pendingTask = null;
    
    // 关键：检查任务是否已过期（不是最新的）
    // 如果在此期间用户又触发了新的 render，currentTaskId 会增加
    if (task.id !== this.currentTaskId) {
      console.log(`[RenderScheduler] Task ${task.id} is outdated (current: ${this.currentTaskId}), skipping`);
      return;
    }
    
    this.isRendering = true;
    
    try {
      console.log(`[RenderScheduler] Executing render task ${task.id}`);
      
      // 发送渲染命令到 Worker
      await this.sendRenderCommand(task);
      
    } catch (error) {
      console.error(`[RenderScheduler] Render task ${task.id} failed:`, error);
      // 可以选择重试或通知上层
      this.onRenderError?.(error as Error);
    } finally {
      this.isRendering = false;
      
      // 检查是否有新的待处理任务（在渲染期间积累的）
      if (this.pendingTask) {
        console.log('[RenderScheduler] Processing pending task after completion');
        await this.executeRender();
      }
    }
  }
  
  /**
   * 发送渲染命令到 Worker
   */
  private sendRenderCommand(task: RenderTask): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = task.id;
      
      // 设置超时（30秒）
      const timeout = setTimeout(() => {
        reject(new Error(`Render timeout for task ${id}`));
      }, 30000);
      
      // 监听 Worker 响应
      const handler = (event: MessageEvent) => {
        const { type: responseType, id: responseId, data, error } = event.data;
        
        // 只处理对应本次请求的响应
        if (responseId !== id) return;
        
        clearTimeout(timeout);
        this.worker.removeEventListener('message', handler);
        
        if (responseType === 'ERROR') {
          reject(new Error(error));
        } else {
          // 通知外部渲染完成
          this.onRenderComplete?.(data);
          resolve();
        }
      };
      
      this.worker.addEventListener('message', handler);
      
      // 发送渲染命令
      this.worker.postMessage({
        type: 'RENDER_WAVEFORM',
        payload: {
          commandId: task.id,
          signalNames: task.signalNames,
          viewport: task.viewport
        },
        id
      });
    });
  }
  
  /**
   * 渲染完成回调
   */
  onRenderComplete?: (bitmap: ImageBitmap) => void;
  
  /**
   * 渲染错误回调
   */
  onRenderError?: (error: Error) => void;
  
  /**
   * 取消所有待处理的渲染任务
   * 
   * 适用场景：
   * - 组件卸载
   * - 切换波形文件
   * - 用户取消操作
   */
  cancelPending(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingTask = null;
    // 注意：不取消正在进行的渲染，保证画面完整性
    console.log('[RenderScheduler] Pending render tasks cancelled');
  }
  
  /**
   * 销毁调度器
   */
  destroy(): void {
    this.cancelPending();
    // 注意：不终止 Worker，由上层管理 Worker 生命周期
  }
}

/**
 * 其他命令直接发送（不经过调度器）
 * 
 * 这些命令轻量，无需防抖和去重：
 * - set_viewport: 只是设置状态
 * - set_canvas_dimensions: 只是设置状态
 * - get_signal_value_at_time: 查询操作，快速返回
 * - find_transitions_around: 查询操作，快速返回
 * - clear_cache: 清理操作
 */
export function sendDirectCommand<T>(
  worker: Worker,
  type: string,
  payload: any,
  timeout: number = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.random();
    
    const timeoutId = setTimeout(() => {
      reject(new Error(`Command ${type} timeout`));
    }, timeout);
    
    const handler = (event: MessageEvent) => {
      const { type: responseType, id: responseId, data, error } = event.data;
      if (responseId !== id) return;
      
      clearTimeout(timeoutId);
      worker.removeEventListener('message', handler);
      
      if (responseType === 'ERROR') {
        reject(new Error(error));
      } else {
        resolve(data);
      }
    };
    
    worker.addEventListener('message', handler);
    worker.postMessage({ type, payload, id });
  });
}
```

**在 WorkerWaveformProvider 中使用**

```typescript
// wasm/workerWaveformProvider.ts

import { RenderScheduler } from '../core/renderScheduler';

export class WorkerWaveformProvider implements WaveformProviderInterface {
  private worker: Worker;
  private scheduler: RenderScheduler;
  private canvas: HTMLCanvasElement | null = null;
  
  constructor() {
    this.worker = new Worker(
      new URL('../workers/waveformWorker.ts', import.meta.url),
      { type: 'module' }
    );
    
    // 创建渲染调度器
    this.scheduler = new RenderScheduler(this.worker);
    
    // 设置渲染完成回调
    this.scheduler.onRenderComplete = (bitmap) => {
      this.displayBitmap(bitmap);
    };
  }
  
  /**
   * 请求渲染（带防抖）
   * 适合拖动、缩放等连续操作
   */
  requestRender(signalNames: string[]): void {
    this.scheduler.requestRender(signalNames, this.viewport);
  }
  
  /**
   * 立即渲染（无防抖）
   * 适合初始化、强制刷新等场景
   */
  async renderImmediate(signalNames: string[]): Promise<void> {
    await this.scheduler.requestRenderImmediate(signalNames, this.viewport);
  }
  
  /**
   * 显示渲染结果
   */
  private displayBitmap(bitmap: ImageBitmap): void {
    if (!this.canvas) return;
    
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    
    // 清空画布
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    // 绘制位图
    ctx.drawImage(bitmap, 0, 0);
    
    // 释放位图内存
    bitmap.close();
  }
  
  /**
   * 设置视口 - 触发渲染
   */
  setViewport(config: ViewportConfig): void {
    this.viewport = { ...config };
    // 视口变化时自动请求渲染（带防抖）
    this.requestRender(this.currentSignalNames);
  }
  
  dispose(): void {
    this.scheduler.destroy();
    this.worker.terminate();
  }
}
```

**使用示例**

```typescript
// WaveformWindow.tsx

function WaveformWindow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const providerRef = useRef<WorkerWaveformProvider | null>(null);
  
  useEffect(() => {
    // 初始化 Provider
    const provider = new WorkerWaveformProvider();
    provider.setCanvas(canvasRef.current);
    providerRef.current = provider;
    
    return () => {
      provider.dispose();
    };
  }, []);
  
  // 处理视口变化（拖动、缩放）
  const handleViewportChange = (newViewport: ViewportConfig) => {
    const provider = providerRef.current;
    if (!provider) return;
    
    // 快速连续调用时，只会在停止操作 50ms 后执行最后一次渲染
    provider.setViewport(newViewport);
    // 内部自动触发：scheduler.requestRender(signals, newViewport)
  };
  
  // 强制刷新（无防抖）
  const handleForceRefresh = async () => {
    const provider = providerRef.current;
    if (!provider) return;
    
    // 立即执行，不等待防抖
    await provider.renderImmediate(signalNames);
  };
  
  return (
    <canvas 
      ref={canvasRef}
      onMouseMove={(e) => {
        // 拖动时频繁触发，但渲染会防抖
        handleViewportChange(calculateViewport(e));
      }}
    />
  );
}
```

**防抖 + 命令去重流程**

```
时间轴：
─────────────────────────────────────────────────────────

用户拖动视口：
  ↓
t0: 视口变化到 A ──→ requestRender(A) 
                      设置防抖定时器 (50ms)
  ↓
t10: 视口变化到 B ──→ requestRender(B)
                      取消 t0 的定时器
                      设置新的防抖定时器
  ↓
t20: 视口变化到 C ──→ requestRender(C)
                      取消 t10 的定时器
                      设置新的防抖定时器
  ↓
t70: 防抖触发 ──────→ 执行 render(C)
                      （只执行最后一次）
  ↓
t80: 渲染完成 ──────→ 显示结果

结果：虽然视口变化了 3 次，但只渲染 1 次（最新的）
```

**快速操作时的处理**

```
场景：用户快速拖动，上一次渲染还没完成

时间轴：
─────────────────────────────────────────────────────────

t0: 开始渲染 A ─────────────────────────→ 渲染中...
  ↓
t30: 视口变化到 B ──→ requestRender(B)
                      防抖等待...
  ↓
t50: 视口变化到 C ──→ requestRender(C)
                      防抖等待...
  ↓
t80: 渲染 A 完成 ───→ 检查 pendingTask
                      发现 C，开始渲染 C
  ↓
t130: 渲染 C 完成 ──→ 显示结果

结果：跳过了 B，直接渲染最新的 C
```

### 3. 总结

| 机制 | 作用 | 适用场景 |
|------|------|---------|
| **参数复制** | 确保 Worker 使用发送时的参数快照 | 所有 Worker 通信 |
| **防抖 (50ms)** | 减少频繁触发时的渲染次数 | 拖动、缩放等连续操作 |
| **命令去重** | 跳过过期的渲染任务 | 渲染速度跟不上操作速度时 |
| **任务队列** | 顺序执行渲染，避免并发冲突 | 所有渲染操作 |

**优势**：
1. **性能优化**：减少不必要的渲染计算
2. **响应性**：主线程始终可响应用户交互
3. **一致性**：始终显示最新的波形状态
4. **资源节约**：避免内存和 CPU 浪费

## Canvas 渲染位置选择

### 方案对比

| 方案 | 渲染位置 | 数据传输 | 核心 API | 特点 |
|------|---------|---------|---------|------|
| **A** | **Worker 直接绘制** | **无需传输**（绘制即显示） | `transferControlToOffscreen()` | Worker 直接操作 Canvas，绘制立即可见 |
| **B** | 主线程渲染 | segments[] → 主线程 | 普通 Canvas | 主线程执行所有绘制逻辑 |
| **C** | Worker 渲染 + 显式提交 | 无需传输，但需 `commit()` | `OffscreenCanvas` + `commit()` | 需要手动提交，浏览器支持差 |

### 推荐方案：Worker 直接绘制（方案 A）

**核心思想**：使用 `transferControlToOffscreen()` 将 Canvas 控制权转移给 Worker，Worker 直接绘制，**无需传输任何数据**，绘制结果立即显示在屏幕上。

```typescript
// 主线程：创建 OffscreenCanvas 并传给 Worker
const canvas = document.getElementById('waveform') as HTMLCanvasElement;
const offscreen = canvas.transferControlToOffscreen();  // 转移控制权

// 将 OffscreenCanvas 传给 Worker
worker.postMessage(
  { type: 'INIT_CANVAS', canvas: offscreen },
  { transfer: [offscreen] }  // 转移所有权
);

// 之后主线程不能再访问这个 canvas
```

```typescript
// Worker 中：直接操作 Canvas
self.onmessage = (event) => {
  const { type, canvas } = event.data;
  
  if (type === 'INIT_CANVAS') {
    // 获取 2D 上下文
    const ctx = canvas.getContext('2d');
    
    // 直接在 Worker 中绘制
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 绘制波形...
    drawWaveform(ctx, segments);
    
    // 注意：不需要传回主线程，绘制直接生效！
  }
};
```

### 实际架构

```
主线程 (Main Thread)              Worker Thread (Dedicated Worker)
├─ React 组件                      ├─ WASM 数据计算
├─ 用户交互处理                      ├─ Segment 生成
├─ 创建 OffscreenCanvas             ├─ 直接绘制到 OffscreenCanvas
│   ↓ transferControlToOffscreen()  │   ↓
└─ 转移给 Worker ─────────────────→ ├─ 绘制完成即显示
                                    │   （无需传回主线程）
                                    └─ 可选：发送完成通知
```

### 代码实现

**主线程**

```typescript
// WaveformWindow.tsx

function WaveformWindow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  
  useEffect(() => {
    // 创建 Worker
    const worker = new Worker(
      new URL('../workers/waveformWorker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;
    
    // 获取 Canvas 并转移控制权
    const canvas = canvasRef.current;
    if (canvas) {
      const offscreen = canvas.transferControlToOffscreen();
      
      // 将 OffscreenCanvas 传给 Worker
      worker.postMessage(
        { 
          type: 'INIT', 
          canvas: offscreen,
          config: { width: canvas.width, height: canvas.height }
        },
        { transfer: [offscreen] }  // 关键：转移所有权
      );
    }
    
    return () => {
      worker.terminate();
    };
  }, []);
  
  // 请求渲染 - 只需发送参数，无需接收位图
  const requestRender = (viewport: ViewportConfig, signals: string[]) => {
    workerRef.current?.postMessage({
      type: 'RENDER',
      payload: { viewport, signals }
    });
  };
  
  return <canvas ref={canvasRef} width={800} height={600} />;
}
```

**Worker 线程**

```typescript
// workers/waveformWorker.ts

import { WaveformDataProvider } from '../wasm-pkg/hwda_wasm.js';

let wasmProvider: WaveformDataProvider | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = async (event) => {
  const { type, payload } = event.data;
  
  switch (type) {
    case 'INIT': {
      // 接收 OffscreenCanvas
      canvas = payload.canvas;
      ctx = canvas.getContext('2d');
      
      // 初始化 WASM
      wasmProvider = new WaveformDataProvider(/* ... */);
      break;
    }
    
    case 'RENDER': {
      if (!canvas || !ctx || !wasmProvider) return;
      
      const { viewport, signals } = payload;
      
      // 1. 设置视口
      wasmProvider.set_viewport(viewport.timeStart, viewport.timeEnd);
      
      // 2. 获取 segments（耗时操作）
      const segments = await wasmProvider.fetch_and_get_segments(signals);
      
      // 3. 直接在 Worker 中绘制（不阻塞主线程！）
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // 绘制网格
      drawGrid(ctx, canvas.width, canvas.height);
      
      // 绘制波形段
      for (const segment of segments) {
        drawSegment(ctx, segment);
      }
      
      // 4. 可选：通知主线程渲染完成
      self.postMessage({ type: 'RENDER_COMPLETE' });
      
      // 注意：不需要 transfer ImageBitmap，绘制已经生效！
      break;
    }
  }
};

function drawGrid(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number) {
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  
  for (let y = 0; y < height; y += 24) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawSegment(ctx: OffscreenCanvasRenderingContext2D, segment: any) {
  const { x0, x1, y, value } = segment;
  
  ctx.strokeStyle = getColorForValue(value);
  ctx.lineWidth = 2;
  
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  
  // 绘制值文本
  if (value.width > 1) {
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(value.displayStr, (x0 + x1) / 2, y - 5);
  }
}
```

### 两种模式的对比

#### 模式 1：Worker 绘制，传输 ImageBitmap（旧方案）

```typescript
// Worker
const bitmap = canvas.transferToImageBitmap();
self.postMessage({ bitmap }, { transfer: [bitmap] });

// 主线程
ctx.drawImage(bitmap, 0, 0);
```

**缺点**：
- 需要传输位图数据
- 主线程仍需执行 drawImage
- 双缓冲管理复杂

#### 模式 2：Worker 直接绘制（推荐方案）

```typescript
// 主线程：转移 Canvas 控制权
const offscreen = canvas.transferControlToOffscreen();
worker.postMessage({ canvas: offscreen }, { transfer: [offscreen] });

// Worker：直接绘制
ctx.fillRect(0, 0, width, height);  // 直接显示！
```

**优点**：
- 零数据传输开销
- 主线程完全自由
- 最简单的架构

### 浏览器兼容性

| 特性 | Chrome | Firefox | Safari | Edge |
|------|--------|---------|--------|------|
| OffscreenCanvas | ✓ 69+ | ✓ 105+ | ✗ | ✓ 79+ |
| transferControlToOffscreen | ✓ | ✓ | ✗ | ✓ |

**降级策略**：Safari 不支持时，回退到主线程渲染模式。

### 总结

| 问题 | 答案 |
|------|------|
| Canvas 更新必须在主线程吗？ | **不需要**，可以在 Worker 中完成 |
| 如何实现？ | 使用 `transferControlToOffscreen()` 转移 Canvas 控制权 |
| 性能如何？ | **最优**，零数据传输，主线程完全自由 |
| 兼容性？ | Chrome/Firefox/Edge 支持，Safari 不支持 |
| 推荐方案？ | Worker 直接绘制 + Safari 降级到主线程 |

## 错误处理与边界情况

### 1. 错误分类与处理策略

| 错误类型 | 场景 | 处理策略 | 用户反馈 |
|---------|------|---------|---------|
| **Worker 初始化失败** | 浏览器不支持 Worker | 降级到直接模式 | 静默处理，无感知 |
| **WASM 加载失败** | 网络问题、文件损坏 | 显示错误提示，提供重试 | "波形引擎加载失败，请刷新重试" |
| **渲染超时** | 信号过多、计算复杂 | 取消当前渲染，保留上次结果 | 显示加载超时提示 |
| **Worker 崩溃** | 内存不足、代码错误 | 自动重启 Worker，恢复状态 | 短暂白屏后自动恢复 |
| **网络请求失败** | 服务器不可用 | 重试 3 次，使用缓存数据 | "使用缓存数据，可能不是最新" |
| **OPFS 操作失败** | 存储空间不足、权限问题 | 禁用 OPFS，使用内存缓存 | 静默降级 |

### 2. Worker 生命周期管理

```typescript
// core/workerLifecycleManager.ts

interface WorkerState {
  worker: Worker;
  isReady: boolean;
  lastActivity: number;
  errorCount: number;
}

/**
 * Worker 生命周期管理器
 * 
 * 职责：
 * 1. 自动重启崩溃的 Worker
 * 2. 监控 Worker 健康状态
 * 3. 状态恢复
 */
export class WorkerLifecycleManager {
  private workerState: WorkerState | null = null;
  private config: ProviderConfig | null = null;
  private readonly MAX_ERROR_COUNT = 3;
  private readonly RESTART_DELAY = 1000;
  
  /**
   * 创建或获取 Worker
   */
  async getWorker(config: ProviderConfig): Promise<Worker> {
    if (this.workerState?.isReady) {
      return this.workerState.worker;
    }
    
    return this.createWorker(config);
  }
  
  /**
   * 创建新 Worker
   */
  private async createWorker(config: ProviderConfig): Promise<Worker> {
    this.config = config;
    
    const worker = new Worker(
      new URL('../workers/waveformWorker.ts', import.meta.url),
      { type: 'module' }
    );
    
    this.workerState = {
      worker,
      isReady: false,
      lastActivity: Date.now(),
      errorCount: 0
    };
    
    // 设置错误处理
    worker.onerror = (error) => this.handleWorkerError(error);
    worker.onmessageerror = (error) => this.handleWorkerError(error);
    
    // 初始化 Worker
    await this.initializeWorker(worker, config);
    
    this.workerState.isReady = true;
    return worker;
  }
  
  /**
   * 初始化 Worker
   */
  private async initializeWorker(worker: Worker, config: ProviderConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Worker initialization timeout'));
      }, 10000);
      
      const handler = (event: MessageEvent) => {
        const { type, success, error } = event.data;
        
        if (type === 'INIT_RESULT') {
          clearTimeout(timeout);
          worker.removeEventListener('message', handler);
          
          if (success) {
            resolve();
          } else {
            reject(new Error(error || 'Worker initialization failed'));
          }
        }
      };
      
      worker.addEventListener('message', handler);
      worker.postMessage({ type: 'INITIALIZE', payload: { config } });
    });
  }
  
  /**
   * 处理 Worker 错误
   */
  private handleWorkerError(error: ErrorEvent | MessageEvent): void {
    console.error('[WorkerLifecycle] Worker error:', error);
    
    if (!this.workerState) return;
    
    this.workerState.errorCount++;
    this.workerState.isReady = false;
    
    // 如果错误次数过多，停止自动重启
    if (this.workerState.errorCount >= this.MAX_ERROR_COUNT) {
      console.error('[WorkerLifecycle] Max error count reached, stopping auto-restart');
      this.onWorkerFatalError?.(new Error('Worker crashed too many times'));
      return;
    }
    
    // 自动重启
    console.log(`[WorkerLifecycle] Restarting worker (attempt ${this.workerState.errorCount})...`);
    setTimeout(() => {
      if (this.config) {
        this.createWorker(this.config)
          .then(() => {
            console.log('[WorkerLifecycle] Worker restarted successfully');
            this.onWorkerRestart?.();
          })
          .catch((err) => {
            console.error('[WorkerLifecycle] Failed to restart worker:', err);
          });
      }
    }, this.RESTART_DELAY);
  }
  
  /**
   * 销毁 Worker
   */
  destroy(): void {
    if (this.workerState) {
      this.workerState.worker.terminate();
      this.workerState = null;
    }
  }
  
  // 回调
  onWorkerFatalError?: (error: Error) => void;
  onWorkerRestart?: () => void;
}
```

### 3. 内存管理

```typescript
// core/memoryManager.ts

/**
 * 内存管理器
 * 
 * 防止 Worker 内存泄漏和溢出
 */
export class MemoryManager {
  private readonly MAX_MEMORY_MB = 512;
  private readonly CHECK_INTERVAL = 30000; // 30秒检查一次
  private checkTimer: number | null = null;
  
  /**
   * 开始监控内存使用
   */
  startMonitoring(worker: Worker): void {
    this.checkTimer = window.setInterval(() => {
      this.checkMemory(worker);
    }, this.CHECK_INTERVAL);
  }
  
  /**
   * 检查内存使用
   */
  private checkMemory(worker: Worker): void {
    // 发送内存检查命令
    worker.postMessage({ type: 'CHECK_MEMORY' });
  }
  
  /**
   * 处理内存报告
   */
  handleMemoryReport(usedMB: number): void {
    console.log(`[MemoryManager] Memory usage: ${usedMB}MB`);
    
    if (usedMB > this.MAX_MEMORY_MB) {
      console.warn(`[MemoryManager] Memory limit exceeded: ${usedMB}MB > ${this.MAX_MEMORY_MB}MB`);
      this.onMemoryLimitExceeded?.();
    }
  }
  
  /**
   * 清理内存
   */
  cleanup(worker: Worker): void {
    worker.postMessage({ type: 'CLEANUP_MEMORY' });
  }
  
  /**
   * 停止监控
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }
  
  onMemoryLimitExceeded?: () => void;
}
```

### 4. 降级策略

```typescript
// core/providerFactory.ts

export async function createWaveformProvider(
  config: FactoryConfig
): Promise<WaveformProviderInterface> {
  const { preferWorker = true, ...providerConfig } = config;
  
  // 检查是否支持 Worker
  if (preferWorker && isWorkerSupported()) {
    try {
      console.log('[Factory] Attempting to create Worker provider...');
      const provider = await createWorkerProvider(providerConfig);
      console.log('[Factory] Worker provider created successfully');
      return provider;
    } catch (error) {
      console.warn('[Factory] Failed to create Worker provider:', error);
      console.log('[Factory] Falling back to direct mode...');
    }
  }
  
  // 降级到直接模式
  return createDirectProvider(providerConfig);
}

/**
 * 运行时降级
 * 当 Worker 在运行中失败时，可以动态切换到直接模式
 */
export class AdaptiveProvider implements WaveformProviderInterface {
  private currentProvider: WaveformProviderInterface;
  private workerFailed = false;
  
  constructor(private config: ProviderConfig) {
    this.currentProvider = new WorkerWaveformProvider();
  }
  
  async initialize(): Promise<void> {
    try {
      await this.currentProvider.initialize(this.config);
    } catch (error) {
      if (!this.workerFailed) {
        console.warn('[AdaptiveProvider] Worker failed, switching to direct mode');
        this.workerFailed = true;
        this.currentProvider = await createDirectProvider(this.config);
      } else {
        throw error;
      }
    }
  }
  
  // 其他方法委托给 currentProvider...
}
```

### 6. 渲染结果缓存

**问题**：如果输入的参数（viewport、signals）完全没变，如何避免重复渲染？

**解决方案：参数哈希缓存**

```typescript
// core/renderCache.ts

interface CacheKey {
  viewportHash: string;
  signalListHash: string;
  canvasWidth: number;
  canvasHeight: number;
}

interface CachedRender {
  key: CacheKey;
  bitmap: ImageBitmap;
  timestamp: number;
}

/**
 * 渲染结果缓存
 * 
 * 当参数完全不变时，直接使用缓存的位图，避免重复计算
 */
export class RenderCache {
  private cache: CachedRender | null = null;
  private readonly MAX_CACHE_AGE = 60000; // 缓存最大有效期 60 秒
  
  /**
   * 生成缓存键
   */
  private generateKey(
    viewport: ViewportConfig,
    signalNames: string[],
    canvas: CanvasConfig
  ): CacheKey {
    // 使用简单的哈希算法
    const viewportHash = `${viewport.timeStart.toFixed(6)}_${viewport.timeEnd.toFixed(6)}`;
    const signalListHash = signalNames.sort().join(',');
    
    return {
      viewportHash,
      signalListHash,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height
    };
  }
  
  /**
   * 检查是否有有效缓存
   */
  hasValidCache(
    viewport: ViewportConfig,
    signalNames: string[],
    canvas: CanvasConfig
  ): boolean {
    if (!this.cache) return false;
    
    // 检查缓存是否过期
    const age = Date.now() - this.cache.timestamp;
    if (age > this.MAX_CACHE_AGE) {
      this.clear();
      return false;
    }
    
    // 比较缓存键
    const currentKey = this.generateKey(viewport, signalNames, canvas);
    const cachedKey = this.cache.key;
    
    return (
      currentKey.viewportHash === cachedKey.viewportHash &&
      currentKey.signalListHash === cachedKey.signalListHash &&
      currentKey.canvasWidth === cachedKey.canvasWidth &&
      currentKey.canvasHeight === cachedKey.canvasHeight
    );
  }
  
  /**
   * 获取缓存的位图
   */
  getCache(): ImageBitmap | null {
    return this.cache?.bitmap || null;
  }
  
  /**
   * 存储渲染结果到缓存
   */
  setCache(
    viewport: ViewportConfig,
    signalNames: string[],
    canvas: CanvasConfig,
    bitmap: ImageBitmap
  ): void {
    // 清理旧缓存
    if (this.cache) {
      this.cache.bitmap.close();
    }
    
    this.cache = {
      key: this.generateKey(viewport, signalNames, canvas),
      bitmap,
      timestamp: Date.now()
    };
  }
  
  /**
   * 清理缓存
   */
  clear(): void {
    if (this.cache) {
      this.cache.bitmap.close();
      this.cache = null;
    }
  }
}

/**
 * 在 RenderScheduler 中使用缓存
 */
export class RenderScheduler {
  private renderCache = new RenderCache();
  
  async requestRender(
    signalNames: string[],
    viewport: ViewportConfig,
    canvas: CanvasConfig
  ): Promise<ImageBitmap | null> {
    // 1. 检查缓存
    if (this.renderCache.hasValidCache(viewport, signalNames, canvas)) {
      console.log('[RenderScheduler] Using cached render result');
      return this.renderCache.getCache();
    }
    
    // 2. 执行渲染
    const bitmap = await this.executeRender(signalNames, viewport, canvas);
    
    // 3. 存储到缓存
    if (bitmap) {
      this.renderCache.setCache(viewport, signalNames, canvas, bitmap);
    }
    
    return bitmap;
  }
}
```

**缓存策略**

| 场景 | 行为 |
|------|------|
| 参数完全不变 | 直接使用缓存，无需渲染 |
| 参数微小变化 | 重新渲染，更新缓存 |
| 缓存过期（60秒） | 清理缓存，重新渲染 |
| 切换波形文件 | 清理缓存 |
| 手动刷新 | 强制跳过缓存，重新渲染 |

### 5. 常见错误排查

| 现象 | 可能原因 | 排查方法 | 解决方案 |
|------|---------|---------|---------|
| Worker 不启动 | 浏览器不支持、路径错误 | 检查 `new Worker()` 是否抛出异常 | 使用直接模式降级 |
| Canvas 不显示 | OffscreenCanvas 不支持、渲染失败 | 检查 Canvas 尺寸、Worker 错误日志 | 回退到主线程渲染 |
| 渲染卡顿 | 防抖延迟过长、Worker 计算慢 | 调整 `DEBOUNCE_DELAY`、性能分析 | 优化 WASM 代码、增加 Worker |
| 内存泄漏 | WASM 内存未释放、缓存未清理 | 监控 `performance.memory` | 定期调用 `clear_cache` |
| 数据不同步 | 参数未复制、竞态条件 | 检查消息传递是否复制参数 | 使用不可变快照 |

## 性能对比

| 场景 | 主线程模式 | Worker 模式 | 提升 |
|------|-----------|------------|------|
| 100 信号初始加载 | 500ms (UI 卡顿) | 500ms (UI 流畅) | UI 响应性 |
| 拖动波形 | 卡顿 | 流畅 | 显著改善 |
| 缩放操作 | 卡顿 | 流畅 | 显著改善 |
| 大量信号 (>1000) | 浏览器假死 | 正常 | 可用性 |

## 浏览器兼容性

| 特性 | Chrome | Firefox | Safari | Edge |
|------|--------|---------|--------|------|
| Web Worker | ✓ | ✓ | ✓ | ✓ |
| OffscreenCanvas | ✓ 69+ | ✓ 105+ | ✗ | ✓ 79+ |
| Transferable ImageBitmap | ✓ | ✓ | ✓ | ✓ |

**降级策略**：不支持 Worker 或 OffscreenCanvas 的浏览器自动使用直接模式。

## 总结

通过引入 `WaveformProviderInterface` 接口层，我们实现了：

1. **架构解耦**：外部代码不依赖具体实现
2. **易于测试**：可以 mock 接口进行单元测试
3. **平滑迁移**：可以在直接模式和 Worker 模式间无缝切换
4. **渐进式优化**：可以逐步引入 Worker 池、渲染缓存等高级特性

Worker 模式将耗时的 WASM 计算和渲染移出主线程，显著提升 UI 响应性和用户体验。
