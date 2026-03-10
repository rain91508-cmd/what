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

## 改进后的目标架构（共享 Provider + 参数化 Render）

```
┌─────────────────────────────────────────────────────────────────────┐
│                        主线程 (Main Thread)                          │
│                                                                     │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐                         │
│  │  Tab 1  │    │  Tab 2  │    │  Tab 3  │                         │
│  │ (React) │    │ (React) │    │ (React) │                         │
│  │         │    │         │    │         │                         │
│  │ Canvas 1│    │ Canvas 2│    │ Canvas 3│                         │
│  │(Offscr) │    │(Offscr) │    │(Offscr) │                         │
│  └────┬────┘    └────┬────┘    └────┬────┘                         │
│       │              │              │                               │
│       │   每个 Tab 有自己的 Canvas，但共享 Provider                 │
│       │              │              │                               │
│       └──────────────┼──────────────┘                               │
│                      │                                              │
│              ┌───────┴───────┐                                     │
│              │  Shared       │                                     │
│              │  Provider     │                                     │
│              │  (Context)    │                                     │
│              │  - 无状态      │                                     │
│              │  - 参数化 Render│                                    │
│              └───────┬───────┘                                     │
└──────────────────────┼─────────────────────────────────────────────┘
                       │
┌──────────────────────┼─────────────────────────────────────────────┐
│              Worker Thread (Shared)                                 │
│  ┌───────────────────┴─────────────────────────────────────────┐   │
│  │              WASM Instance (Single)                         │   │
│  │  ┌─────────────────────────────────────────────────────┐   │   │
│  │  │  Stateless Data Provider                            │   │   │
│  │  │  - fetch_and_get_segments(signals, viewport, ...)   │   │   │
│  │  │  - get_signal_value_at_time(signal, time)           │   │   │
│  │  │  - find_transitions_around(signal, time)            │   │   │
│  │  │  - render(canvas, signals, viewport, ...)           │   │   │
│  │  │                                                     │   │   │
│  │  │  所有操作通过参数传递，不保存状态                    │   │   │
│  │  └─────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  关键特性：                                                          │
│  1. 一个 WASM 实例服务所有 Tab                                       │
│  2. Render 时传递所有参数（signals, viewport, canvas）               │
│  3. 每个 Tab 有自己的 OffscreenCanvas                                │
│  4. 切换 Tab 只需更换 render 参数，无需切换 Provider                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 架构优势

| 特性 | 说明 |
|------|------|
| **内存节省** | 只有一个 WASM 实例，节省内存 |
| **状态清晰** | Provider 无状态，所有参数通过 render 传递 |
| **并发安全** | 每个 Tab 有自己的 Canvas，不会互相覆盖 |
| **切换快速** | Tab 切换只需更换参数，无需重新初始化 |

### 关键设计原则

1. **Provider 无状态化**
   - 不保存 `signalList`、`viewport`、`canvas` 等状态
   - 所有操作通过参数传递

2. **参数化 Render**
   ```typescript
   // 改进后的 Render 接口
   render(params: {
     canvasId: string,             // Canvas ID（Worker 中通过 ID 获取 Canvas）
     signals: SignalInfo[],        // 当前可见信号列表
     viewport: ViewportConfig,     // 当前视口
     canvasConfig: CanvasConfig,   // Canvas 尺寸
     displayFormat: DisplayFormat, // 显示格式
   }): Promise<void>
   ```

3. **信号列表作为参数**
   - 只传递可见区域的信号（通常不多）
   - 不缓存信号列表在 Provider 中

4. **Canvas 绑定到 Tab**
   - 每个 Tab 创建自己的 OffscreenCanvas
   - Render 时将 Canvas 作为参数传入

### 实现示例

#### 1. 改进后的 Provider 接口

```typescript
// core/waveformProviderInterface.ts

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
  
  // ==================== 数据获取（无状态）====================
  
  /**
   * 获取指定时间点的信号值
   * 参数中包含信号列表，不依赖 Provider 状态
   */
  getSignalValueAtTime(
    signalName: string, 
    time: number,
    signals: SignalInfo[]  // 传递信号列表
  ): Promise<ValueInfo | null>;
  
  /**
   * 查找指定时间点前后的跳变
   */
  findTransitionsAround(
    signalName: string, 
    time: number,
    signals: SignalInfo[]  // 传递信号列表
  ): Promise<{ prev: number | null; next: number | null }>;
  
  // ==================== 渲染（参数化）====================
  
  /**
   * 获取渲染段（用于主线程渲染模式）
   */
  fetchAndGetSegments(
    signalNames: string[],
    viewport: ViewportConfig,
    signals: SignalInfo[]  // 传递信号列表
  ): Promise<RenderSegment[]>;
  
  /**
   * 渲染波形到 OffscreenCanvas（参数化）
   * 
   * @param params 包含所有渲染参数
   */
  renderWaveform(params: {
    canvasId: string;              // Canvas ID（Worker 中通过 ID 获取 Canvas）
    signals: SignalInfo[];         // 信号列表
    viewport: ViewportConfig;      // 视口
    canvasConfig: CanvasConfig;    // Canvas 配置
    displayFormat: DisplayFormat;  // 显示格式
    timeConfig: TimeConfig;        // 时间配置
  }): Promise<void>;
  
  // ==================== 缓存管理 ====================
  
  clearCache(): Promise<void>;
  setOpfsEnabled(enabled: boolean): void;
  setMemoryCacheEnabled(enabled: boolean): void;
}
```

#### 2. 共享 Provider 的 Context

```typescript
// contexts/WaveformProviderContext.tsx

import { createContext, useContext, useEffect, useState } from 'react';
import { WaveformProviderInterface } from '../core/waveformProviderInterface';
import { createWaveformProvider } from '../wasm/waveformProviderFactory';

const WaveformProviderContext = createContext<WaveformProviderInterface | null>(null);

/**
 * 共享 Provider Provider
 * 
 * 在 App 级别提供，所有 Tab 共享同一个 Provider 实例
 */
export function SharedWaveformProvider({ children }: { children: React.ReactNode }) {
  const [provider, setProvider] = useState<WaveformProviderInterface | null>(null);
  
  useEffect(() => {
    // 创建共享 Provider
    createWaveformProvider({
      useWorker: true,
      // ... 其他配置
    }).then(setProvider);
    
    return () => {
      provider?.dispose();
    };
  }, []);
  
  if (!provider) return <div>Loading...</div>;
  
  return (
    <WaveformProviderContext.Provider value={provider}>
      {children}
    </WaveformProviderContext.Provider>
  );
}

export function useSharedWaveformProvider() {
  return useContext(WaveformProviderContext);
}
```

#### 3. Tab 中使用共享 Provider

```typescript
// WaveformWindow.tsx

import { useSharedWaveformProvider } from '../contexts/WaveformProviderContext';

function WaveformWindow({ tabId }: { tabId: string }) {
  const provider = useSharedWaveformProvider();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<OffscreenCanvas | null>(null);
  
  // 每个 Tab 自己的状态
  const [signals, setSignals] = useState<SignalInfo[]>([]);
  const [viewport, setViewport] = useState<ViewportConfig>({ timeStart: 0, timeEnd: 1000 });
  
  useEffect(() => {
    // 创建 OffscreenCanvas（每个 Tab 自己的）
    if (canvasRef.current && !offscreenCanvasRef.current) {
      offscreenCanvasRef.current = canvasRef.current.transferControlToOffscreen();
    }
  }, []);
  
  // Render 时传递所有参数
  const render = async () => {
    if (!provider || !offscreenCanvasRef.current) return;
    
    await provider.renderWaveform({
      canvas: offscreenCanvasRef.current,  // Tab 自己的 Canvas
      signals,                              // Tab 自己的信号列表
      viewport,                             // Tab 自己的视口
      canvasConfig: { width: 800, height: 600, rowHeight: 24 },
      displayFormat: 'hex',
      timeConfig: { displayUnit: 'ps', lod0Unit: 1 },
    });
  };
  
  // 信号值查询（传递信号列表）
  const getSignalValue = async (signalName: string, time: number) => {
    if (!provider) return null;
    
    return provider.getSignalValueAtTime(signalName, time, signals);
  };
  
  return <canvas ref={canvasRef} width={800} height={600} />;
}
```

#### 4. Worker 中的参数化 Render

```typescript
// workers/waveformWorker.ts

self.onmessage = async (event) => {
  const { type, payload, id } = event.data;
  
  switch (type) {
    case 'RENDER_WAVEFORM': {
      // 从 payload 中获取所有参数（不依赖 Worker 内部状态）
      const { 
        canvas,           // 目标 Canvas
        signals,          // 信号列表
        viewport,         // 视口
        canvasConfig,     // Canvas 配置
        displayFormat,    // 显示格式
        timeConfig        // 时间配置
      } = payload;
      
      // 使用参数设置 WASM 状态
      wasmProvider.set_viewport(viewport.timeStart, viewport.timeEnd);
      wasmProvider.set_canvas_dimensions(canvasConfig.width, canvasConfig.height, canvasConfig.rowHeight);
      wasmProvider.set_draw_list(signals);
      wasmProvider.display_format = displayFormat;
      
      // 获取 segments
      const signalNames = signals.map(s => s.name);
      const segments = await wasmProvider.fetch_and_get_segments(signalNames);
      
      // 在指定的 Canvas 上渲染
      const ctx = canvas.getContext('2d');
      renderToCanvas(ctx, segments, viewport, canvasConfig, timeConfig);
      
      // 返回成功（无需传输数据，Canvas 已经绘制完成）
      self.postMessage({ type: 'RESULT', id, success: true });
      break;
    }
    
    case 'GET_SIGNAL_VALUE_AT_TIME': {
      const { signalName, time, signals } = payload;
      
      // 使用传入的信号列表设置状态
      wasmProvider.set_draw_list(signals);
      
      const value = wasmProvider.get_signal_value_at_time(signalName, time);
      
      self.postMessage({ type: 'RESULT', id, success: true, data: value });
      break;
    }
    
    case 'FIND_TRANSITIONS_AROUND': {
      const { signalName, time, signals } = payload;
      
      // 使用传入的信号列表设置状态
      wasmProvider.set_draw_list(signals);
      
      const transitions = wasmProvider.find_transitions_around(signalName, time);
      
      self.postMessage({ type: 'RESULT', id, success: true, data: transitions });
      break;
    }
  }
};
```

#### 5. Canvas 管理（Worker 端）

Worker 可以保存 transfer 来的 OffscreenCanvas，通过 ID 管理多个 Canvas。

```typescript
// workers/waveformWorker.ts

// Canvas 管理器 - 保存所有 transfer 来的 Canvas
const canvasManager = new Map<string, OffscreenCanvas>();

self.onmessage = async (event) => {
  const { type, payload, id } = event.data;
  
  switch (type) {
    case 'REGISTER_CANVAS': {
      // Tab 创建时注册 Canvas
      const { canvasId, canvas } = payload;
      canvasManager.set(canvasId, canvas);
      self.postMessage({ type: 'RESULT', id, success: true });
      break;
    }
    
    case 'UNREGISTER_CANVAS': {
      // Tab 关闭时注销 Canvas
      const { canvasId } = payload;
      canvasManager.delete(canvasId);
      self.postMessage({ type: 'RESULT', id, success: true });
      break;
    }
    
    case 'RENDER_WAVEFORM': {
      const { 
        canvasId,         // 指定要渲染的 Canvas ID
        signals,          // 信号列表
        viewport,         // 视口
        canvasConfig,     // Canvas 配置
        displayFormat,    // 显示格式
        timeConfig        // 时间配置
      } = payload;
      
      // 从管理器获取 Canvas
      const canvas = canvasManager.get(canvasId);
      if (!canvas) {
        self.postMessage({ type: 'RESULT', id, success: false, error: 'Canvas not found' });
        break;
      }
      
      // 使用参数设置 WASM 状态
      wasmProvider.set_viewport(viewport.timeStart, viewport.timeEnd);
      wasmProvider.set_canvas_dimensions(canvasConfig.width, canvasConfig.height, canvasConfig.rowHeight);
      wasmProvider.set_draw_list(signals);
      wasmProvider.display_format = displayFormat;
      
      // 获取 segments
      const signalNames = signals.map(s => s.name);
      const segments = await wasmProvider.fetch_and_get_segments(signalNames);
      
      // 在指定的 Canvas 上渲染
      const ctx = canvas.getContext('2d');
      renderToCanvas(ctx, segments, viewport, canvasConfig, timeConfig);
      
      self.postMessage({ type: 'RESULT', id, success: true });
      break;
    }
    
    // ... 其他消息处理
  }
};
```

##### 主线程中的 Canvas 生命周期管理

```typescript
// WaveformWindow.tsx

function WaveformWindow({ tabId }: { tabId: string }) {
  const provider = useSharedWaveformProvider();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasIdRef = useRef<string>(`canvas-${tabId}`);
  
  useEffect(() => {
    if (!canvasRef.current || !provider) return;
    
    // 1. 创建 OffscreenCanvas
    const offscreenCanvas = canvasRef.current.transferControlToOffscreen();
    
    // 2. 注册 Canvas 到 Worker
    provider.registerCanvas(canvasIdRef.current, offscreenCanvas);
    
    // 3. 清理时注销 Canvas
    return () => {
      provider.unregisterCanvas(canvasIdRef.current);
    };
  }, [provider]);
  
  // Render 时只需传递 Canvas ID
  const render = async () => {
    if (!provider) return;
    
    await provider.renderWaveform({
      canvasId: canvasIdRef.current,  // 传递 Canvas ID，而不是 Canvas 本身
      signals,
      viewport,
      canvasConfig: { width: 800, height: 600, rowHeight: 24 },
      displayFormat: 'hex',
      timeConfig: { displayUnit: 'ps', lod0Unit: 1 },
    });
  };
  
  return <canvas ref={canvasRef} width={800} height={600} />;
}
```

##### Canvas 管理策略

| 策略 | 说明 |
|------|------|
| **懒注册** | Tab 首次渲染时才注册 Canvas |
| **及时注销** | Tab 关闭时立即注销，释放内存 |
| **ID 管理** | 使用 `canvas-${tabId}` 作为唯一标识 |
| **容错处理** | Render 时检查 Canvas 是否存在 |

##### Worker 状态管理

Worker 可以维护以下状态（不是完全 stateless）：

```typescript
// Worker 中可以保存的状态
const workerState = {
  // Canvas 管理（必须保存）
  canvases: new Map<string, OffscreenCanvas>(),
  
  // 可选：WASM 状态缓存（优化性能）
  lastViewport: null as ViewportConfig | null,
  lastSignals: null as SignalInfo[] | null,
  
  // 可选：渲染缓存
  renderCache: new Map<string, RenderCache>(),
};
```

这样设计的好处：
1. **Canvas 持久化**：transfer 来的 Canvas 保存在 Worker 中，避免重复 transfer
2. **快速渲染**：Render 时只需传递 Canvas ID，减少数据传输
3. **内存管理**：Tab 关闭时及时清理 Canvas
4. **灵活扩展**：Worker 可以维护其他状态（如缓存）来优化性能

### 与旧架构的对比

| 特性 | 旧架构（每个 Tab 独立 Provider） | 新架构（共享 Provider + 参数化） |
|------|-------------------------------|--------------------------------|
| **WASM 实例数** | N 个（N = Tab 数） | 1 个 |
| **Worker 数** | N 个 | 1 个 |
| **内存占用** | N × WASM 内存 | 1 × WASM 内存 |
| **Tab 切换** | 销毁/创建 Provider | 只需更换参数 |
| **Provider 状态** | 有状态（保存 signalList、viewport） | 无状态（参数传递） |
| **实现复杂度** | 简单 | 稍复杂 |
| **并发处理** | 天然隔离 | 需要请求队列 |

### 需要解决的问题

1. **并发请求队列**
   - 多个 Tab 同时请求 render 时需要排队
   - 实现请求队列，顺序处理

2. **信号列表传递开销**
   - 虽然只传递可见信号，但仍需考虑性能
   - 可以优化为只传递信号名称列表

3. **请求去重**
   - 同一 Tab 的快速连续请求需要防抖

### 迁移步骤

1. **修改 Provider 接口** - 添加参数到所有方法
2. **实现共享 Provider Context** - 在 App 级别提供
3. **修改 Worker** - 支持参数化 render
4. **更新 WaveformWindow** - 使用共享 Provider，传递参数
5. **添加请求队列** - 处理并发请求
6. **测试验证** - 确保多 Tab 正常工作

## 原始架构（每个 Tab 独立 Provider）

<details>
<summary>点击查看原始架构详情（已过时）</summary>

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

</details>

## 总结

通过引入 **共享 Provider + 参数化 Render** 架构，我们实现了：

1. **内存优化**：多个 Tab 共享一个 WASM 实例，显著减少内存占用
2. **快速切换**：Tab 切换只需更换 render 参数，无需重新初始化
3. **状态清晰**：Provider 无状态，所有参数通过 render 传递，避免状态混乱
4. **易于扩展**：可以方便地添加 Tab 切换动画、预览等功能

这种架构特别适合需要同时打开多个波形文件的场景，可以显著降低内存占用并提升切换速度。
