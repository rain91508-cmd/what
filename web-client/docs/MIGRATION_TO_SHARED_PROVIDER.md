# 迁移到共享 Provider 实现指南

## 概述

本文档描述如何将 WaveformWindow 从每个 Tab 独立 Provider 迁移到共享 Provider 架构。

## 架构变化

### 旧架构（每个 Tab 独立 Provider）

```
每个 WaveformWindow (Tab)
├── 创建自己的 Provider
├── 管理自己的状态
└── 销毁时清理 Provider
```

### 新架构（共享 Provider）

```
App (Provider Context)
├── 创建共享 Provider
└── 所有 Tab 共享同一个 Provider

每个 WaveformWindow (Tab)
├── 使用共享 Provider
├── 注册自己的 Canvas
├── 传递参数调用方法
└── 注销自己的 Canvas
```

## 关键修改点

### 1. App.tsx - 添加 Provider Context

```tsx
// App.tsx
import { WaveformProviderProvider } from './contexts/WaveformProviderContext';

function App() {
  return (
    <WaveformProviderProvider
      serverUrl="http://localhost:8080"
      waveformName={currentWaveform}
      // ... 其他配置
    >
      <TabPanel />
    </WaveformProviderProvider>
  );
}
```

### 2. WaveformWindow.tsx - 使用共享 Provider

#### 2.1 导入共享 Provider Hook

```tsx
import { useWaveformProvider } from '../contexts/WaveformProviderContext';
```

#### 2.2 获取共享 Provider

```tsx
function WaveformWindow({ tabId, ...props }: WaveformWindowProps) {
  const { provider, isLoading } = useWaveformProvider();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasIdRef = useRef<string>(`canvas-${tabId}`);
  
  // 不再需要自己创建 Provider
  // const wasmProviderRef = useRef<WaveformProviderAdapter | null>(null);
  // const [providerReady, setProviderReady] = useState(false);
  
  // 使用共享 Provider
  const providerReady = !isLoading && provider !== null;
```

#### 2.3 注册 Canvas（Tab 创建时）

```tsx
useEffect(() => {
  if (!provider || !canvasRef.current) return;
  
  // 创建 OffscreenCanvas
  const offscreenCanvas = canvasRef.current.transferControlToOffscreen();
  
  // 注册 Canvas 到共享 Provider
  provider.registerCanvas(canvasIdRef.current, offscreenCanvas);
  
  // 清理时注销 Canvas
  return () => {
    provider.unregisterCanvas(canvasIdRef.current);
  };
}, [provider]);
```

#### 2.4 修改 Render 调用（传递参数）

```tsx
// 旧代码
const renderWaveform = async () => {
  if (!wasmProviderRef.current) return;
  
  // Provider 保存了状态
  wasmProviderRef.current.setSignalList(signals);
  wasmProviderRef.current.setViewport(viewport.timeStart, viewport.timeEnd);
  wasmProviderRef.current.setCanvasDimensions(width, height, 24);
  
  await wasmProviderRef.current.renderWaveform(signalNames);
};

// 新代码
const renderWaveform = async () => {
  if (!provider) return;
  
  // 所有参数通过方法传递
  await provider.renderWaveform({
    canvasId: canvasIdRef.current,  // 指定 Canvas ID
    signals: wasmSignals,            // 信号列表
    viewport: {                      // 视口
      startTime: viewport.timeStart,
      endTime: viewport.timeEnd,
      width,
      height,
    },
    canvasConfig: {                  // Canvas 配置
      width,
      height,
      rowHeight: 24,
    },
    displayFormat: 'hex',            // 显示格式
    timeConfig: {                    // 时间配置
      displayUnit: 'ps',
      lod0Unit: 1,
      displayUnitPerLoD0Unit: 1,
    },
  });
};
```

#### 2.5 修改数据获取调用（传递参数）

```tsx
// 旧代码
const value = await wasmProviderRef.current.getSignalValueAtTime(
  signalName, 
  time
);

// 新代码
const value = await provider.getSignalValueAtTime(
  signalName,
  time,
  signals  // 需要传递信号列表
);
```

#### 2.6 修改 cursor 吸附调用（传递参数）

```tsx
// 旧代码
const transitions = await wasmProviderRef.current.findTransitionsAround(
  signalName, 
  time
);

// 新代码
const transitions = await provider.findTransitionsAround(
  signalName,
  time,
  signals  // 需要传递信号列表
);
```

### 3. 移除旧的 Provider 创建逻辑

```tsx
// 移除整个 useEffect（创建 Provider 的逻辑）
// 因为 Provider 现在在 App 级别创建

// 移除这些代码：
// useEffect(() => {
//   const initProvider = async () => {
//     const provider = await createWaveformProvider({...});
//     wasmProviderRef.current = provider;
//     setProviderReady(true);
//   };
//   initProvider();
//   
//   return () => {
//     wasmProviderRef.current?.dispose();
//   };
// }, [...]);
```

### 4. 修改信号值查询 useEffect

```tsx
// 监听 cursor 变化，更新信号值
useEffect(() => {
  const updateSignalValues = async () => {
    if (!cursor.visible || !provider) return;
    
    const values = new Map<string, string>();
    
    for (const signal of displaySignals) {
      const signalName = signal.fullName || signal.name;
      
      // 传递 signals 参数
      const valueInfo = await provider.getSignalValueAtTime(
        signalName,
        cursor.position,
        wasmSignals  // 需要传递信号列表
      );
      
      if (valueInfo) {
        values.set(signalName, valueInfo.displayStr);
      }
    }
    
    setSignalValues(values);
  };
  
  updateSignalValues();
}, [cursor.position, cursor.visible, displaySignals, provider]);
```

### 5. 修改 cursor 吸附逻辑

```tsx
const handleCanvasMouseDown = async (e: React.MouseEvent) => {
  // ... 计算 clickTime ...
  
  if (provider && targetNode?.type === 'signal') {
    const signalName = targetNode.signal.fullName || targetNode.signal.name;
    
    // 传递 signals 参数
    const transitions = await provider.findTransitionsAround(
      signalName,
      clickTime,
      wasmSignals  // 需要传递信号列表
    );
    
    // ... 处理吸附 ...
  }
};
```

## 需要传递的参数总结

### renderWaveform

```typescript
{
  canvasId: string;              // Canvas ID
  signals: WasmSignalInfo[];     // 信号列表
  viewport: ViewportConfig;      // 视口配置
  canvasConfig: CanvasConfig;    // Canvas 配置
  displayFormat: DisplayFormat;  // 显示格式
  timeConfig: TimeConfig;        // 时间配置
}
```

### getSignalValueAtTime

```typescript
(
  signalName: string,      // 信号名称
  time: number,            // 时间点
  signals: WasmSignalInfo[] // 信号列表（新增）
) => Promise<ValueInfo | null>
```

### findTransitionsAround

```typescript
(
  signalName: string,      // 信号名称
  time: number,            // 时间点
  signals: WasmSignalInfo[] // 信号列表（新增）
) => Promise<{ prev: number | null; next: number | null }>
```

### fetchAndGetSegments

```typescript
(
  signalNames: string[],      // 信号名称列表
  viewport: ViewportConfig,   // 视口配置（新增）
  signals: WasmSignalInfo[]   // 信号列表（新增）
) => Promise<RenderSegment[]>
```

## 注意事项

1. **信号列表转换**：需要将 React 的 `Signal` 类型转换为 `WasmSignalInfo` 类型

```typescript
const wasmSignals = signals.map((sig, index) => ({
  globalId: sig.unique_id,
  name: sig.fullName || sig.name,
  row: index,
  width: sig.width,
  drawSigId: sig.unique_id,
  bitExtract: sig.msb !== sig.lsb ? {
    parentName: sig.fullName || sig.name,
    msb: sig.msb,
    lsb: sig.lsb,
  } : undefined,
}));
```

2. **Canvas ID 生成**：使用 `canvas-${tabId}` 格式确保唯一性

3. **错误处理**：共享 Provider 的错误会影响所有 Tab，需要更好的错误边界

4. **并发控制**：Worker 内部有请求队列，但 UI 层面也需要考虑并发

## 测试清单

- [ ] 单个 Tab 正常渲染
- [ ] 多个 Tab 同时打开正常渲染
- [ ] Tab 切换正常
- [ ] Tab 关闭后资源释放
- [ ] Cursor 吸附功能正常
- [ ] 信号值显示正常
- [ ] 缩放/拖动正常
- [ ] 性能无明显下降
