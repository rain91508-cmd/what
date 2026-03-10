# WASM 接口函数文档

## 概述

本文档详细描述了波形查看器中 WASM 模块（WaveformDataProvider）提供的所有接口函数，包括它们的参数、作用、调用流程、触发条件以及调用线程。

## 线程架构

项目使用以下线程/Worker 架构：

### 主线程（Main Thread）
- 所有 WASM 接口调用
- Canvas 2D 渲染
- UI 交互
- React 组件

### Web Workers
1. **`kdbDownload.worker.ts`** - KDB 知识库文件下载
   - 流式下载
   - Zstd 解压缩
   - IndexedDB/OPFS 存储

2. **`opfsReader.worker.ts`** - OPFS 文件读取
   - 从 OPFS 读取源代码文件
   - 支持按行读取
   - 使用 Sync Access Handle 进行高效随机访问

---

## 目录

1. [初始化与管理函数](#1-初始化与管理函数)
2. [配置与设置函数](#2-配置与设置函数)
3. [信号管理函数](#3-信号管理函数)
4. [数据获取与缓存函数](#4-数据获取与缓存函数)
5. [渲染与绘制函数](#5-渲染与绘制函数)
6. [查询与辅助函数](#6-查询与辅助函数)
7. [完整调用流程](#7-完整调用流程)
8. [关键性能优化点总结](#8-关键性能优化点总结)
9. [调用位置速查表](#9-调用位置速查表)
10. [Rust 可调用的 JavaScript 函数](#10-rust-可调用的-javascript-函数)

---

## 1. 初始化与管理函数

### 1.1 `constructor` - 创建 WaveformDataProvider 实例

**文件位置**: `web-client/src/waveform_provider.rs:349-376`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn new(
    server_url: String,           // 服务器 URL
    waveform_name: String,        // 波形名称
    signal_prefix: String,        // 信号前缀（如 "work@"）
    space_before_bracket: bool,   // 是否在方括号前加空格
    time_stamp: u64,              // 波形修改时间戳（用于 CDN 缓存）
) -> Self
```

**作用**:
创建一个新的波形数据提供者实例，初始化所有内部状态。

**调用流程**:
- 在 JavaScript 层通过 `waveformProvider.ts` 中的 `createProvider()` 函数调用
- 应用启动或打开新波形时调用一次
- 不直接从 `WaveformWindow.tsx` 调用

**触发条件**:
- 用户通过 UI 选择并打开一个波形文件时
- 应用初始化阶段

---

### 1.2 `init_with_opfs` - 初始化 OPFS 缓存

**文件位置**: `web-client/src/waveform_provider.rs:386-398`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn init_with_opfs(
    &mut self,
    opfs_read: js_sys::Function,    // OPFS 读取回调函数
    opfs_write: js_sys::Function,   // OPFS 写入回调函数
    opfs_exists: js_sys::Function,  // OPFS 存在性检查回调函数
    enable_opfs: bool,               // 是否启用 OPFS 缓存
)
```

**作用**:
初始化 Origin Private File System (OPFS) 缓存系统，设置读写回调函数。

**调用流程**:
- 在 `createProvider()` 中紧接着 `constructor` 调用
- 只在应用初始化阶段调用一次
- 不直接从 `WaveformWindow.tsx` 调用

**触发条件**:
- 创建 WaveformDataProvider 实例后立即调用
- 如果浏览器支持 OPFS，会启用持久化缓存

---

## 2. 配置与设置函数

### 2.1 `set_signal_prefix` - 设置信号前缀

**文件位置**: `web-client/src/waveform_provider.rs:880-884`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn set_signal_prefix(&mut self, prefix: String)
```

**作用**:
设置信号名称前缀，用于将本地信号名转换为服务器信号名。

**调用流程**:
- 通过 JavaScript 层 `waveformProvider.ts` 中的 `updateProviderSettings()` 调用
- 在 `WaveformWindow.tsx:620-621` 中，非拖动模式且信号列表变化时调用

**触发条件**:
- 非拖动模式
- `hasSignalPrefixChanged` 为 true（即 signal_prefix 参数变化）
- 且有信号列表需要构建时

**代码位置**: `WaveformWindow.tsx:620-621`

---

### 2.2 `set_space_before_bracket` - 设置方括号前空格

**文件位置**: `web-client/src/waveform_provider.rs:887-891`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn set_space_before_bracket(&mut self, space: bool)
```

**作用**:
设置是否在信号名的方括号前添加空格（如 "signal [7:0]" vs "signal[7:0]"）。

**调用流程**:
- 通过 `updateProviderSettings()` 调用
- 与 `set_signal_prefix` 相同的调用位置和条件

**触发条件**:
- 同 `set_signal_prefix`

**代码位置**: `WaveformWindow.tsx:620-621`

---

### 2.3 `set_display_format` - 设置显示格式

**文件位置**: `web-client/src/waveform_provider.rs:900-904`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn set_display_format(&mut self, format: String)
```

**作用**:
设置信号值的显示格式（hex、bin、oct、dec）。

**调用流程**:
- 在 `WaveformWindow.tsx:631` 中直接设置属性
- 目前硬编码为 'hex'

**触发条件**:
- 非拖动模式
- 构建信号列表时设置

**代码位置**: `WaveformWindow.tsx:631`

---

### 2.4 `set_memory_cache_enabled` - 启用/禁用内存缓存

**文件位置**: `web-client/src/waveform_provider.rs:907-911`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn set_memory_cache_enabled(&mut self, enabled: bool)
```

**作用**:
启用或禁用内存 LRU 缓存。

**调用流程**:
- 通过 `waveformProvider.ts` 中的 `setMemoryCacheEnabled()` 调用
- 目前未在 `WaveformWindow.tsx` 中使用

**触发条件**:
- 目前未在正常渲染流程中触发
- 可能通过调试 UI 或配置面板调用

---

### 2.5 `set_opfs_enabled` - 启用/禁用 OPFS 缓存

**文件位置**: `web-client/src/waveform_provider.rs:920-924`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn set_opfs_enabled(&mut self, enabled: bool)
```

**作用**:
动态启用或禁用 OPFS 持久化缓存。

**调用流程**:
- 通过 `waveformProvider.ts` 中的 `setOpfsEnabled()` 调用
- 可在 provider 创建前后调用

**触发条件**:
- 用户通过配置更改缓存设置时
- 应用启动时根据默认设置初始化

---

### 2.6 `set_viewport` - 设置视口时间范围

**文件位置**: `web-client/src/waveform_provider.rs:982-986`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn set_viewport(&mut self, time_start: f64, time_end: f64)
```

**作用**:
设置当前可见的时间范围（视口）。

**调用流程**:
- 在 `WaveformWindow.tsx` 中有两个调用位置：
  1. **拖动模式**（第 571-572 行）：只在 `hasViewportChanged` 为 true 时调用
  2. **非拖动模式**（第 639-640 行）：只在 `hasViewportChanged` 或 `hasCanvasSizeChanged` 为 true 时调用

**触发条件**:
- **拖动模式**：
  - `isPanningRef.current = true`
  - `hasViewportChanged` 或 `hasCanvasSizeChanged` 为 true
- **非拖动模式**：
  - `isPanningRef.current = false`
  - `hasViewportChanged` 或 `hasCanvasSizeChanged` 为 true

**代码位置**:
- 拖动模式：`WaveformWindow.tsx:571-572`
- 非拖动模式：`WaveformWindow.tsx:639-640`

---

### 2.7 `set_canvas_dimensions` - 设置画布尺寸

**文件位置**: `web-client/src/waveform_provider.rs:1002-1025`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn set_canvas_dimensions(
    &mut self,
    width: f64,        // 画布宽度（像素）
    height: f64,       // 画布高度（像素）
    row_height: f64,   // 每行信号的高度（像素）
)
```

**作用**:
设置渲染画布的尺寸，会自动调整 time_end 以保持 time-to-pixel 比例不变。

**调用流程**:
- 在 `WaveformWindow.tsx` 中有两个调用位置：
  1. **拖动模式**（第 573-575 行）：只在 `hasCanvasSizeChanged` 为 true 时调用
  2. **非拖动模式**（第 641 行）：与 `set_viewport` 一起调用

**触发条件**:
- **拖动模式**：
  - `isPanningRef.current = true`
  - `hasCanvasSizeChanged` 为 true
- **非拖动模式**：
  - `isPanningRef.current = false`
  - `hasViewportChanged` 或 `hasCanvasSizeChanged` 为 true

**代码位置**:
- 拖动模式：`WaveformWindow.tsx:573-575`
- 非拖动模式：`WaveformWindow.tsx:641`

---

## 3. 信号管理函数

### 3.1 `set_draw_list` - 设置绘制信号列表

**文件位置**: `web-client/src/waveform_provider.rs:404-423`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn set_draw_list(&mut self, signals_js: JsValue) -> Result<(), JsValue>
```

**JavaScript 侧数据结构**（从 `buildWasmSignals` 返回）:
```typescript
Array<{
  global_id: number;    // KDB 全局 ID
  name: string;         // 信号名称
  row: number;          // 绘制行号（考虑分组标题）
  width: number;        // 信号位宽
  draw_sig_id: number;  // 用于缓存分组管理的 ID
}>
```

**作用**:
设置需要绘制的信号列表，包括它们的显示顺序和位置。

**调用流程**:
- 在 `WaveformWindow.tsx:628` 中调用
- 只在非拖动模式下调用
- 通过 `buildWasmSignals()` 先构建带 draw_sig_id 的信号列表

**触发条件**:
- 非拖动模式
- `hasSignalListChanged` 或 `hasSignalPrefixChanged` 或 `hasSpaceBeforeBracketChanged` 为 true

**代码位置**: `WaveformWindow.tsx:628`

---

## 4. 数据获取与缓存函数

### 4.1 `fetch_and_get_segments` - 获取数据并生成渲染段（合并函数）

**文件位置**: `web-client/src/waveform_provider.rs:1273-1290`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub async fn fetch_and_get_segments(
    &mut self,
    signal_names: Vec<String>,  // 信号名称列表
) -> Result<JsValue, JsValue>  // 序列化的 RenderSegment 数组
```

**作用**:
**唯一的公开数据获取接口**！合并了数据获取和 segments 计算，减少 JS-Rust 边界跨越。

**完整流程**:
```
fetch_and_get_segments(signal_names)
    │
    ├─ Step 1: fetch_signals_data_batch(signal_names) [内部函数]
    │   │
    │   ├─ 1.1 清空 signal_data 缓存
    │   ├─ 1.2 动态选择 LoD (select_lod)
    │   ├─ 1.3 过滤 bit-extract 信号 (@[...])
    │   ├─ 1.4 检查 OPFS 缓存（按 tile + signal）
    │   │       命中 → 转换为 bucket_data 存入 signal_data
    │   │       未命中 → 记录到 tile_missing_signals
    │   └─ 1.5 从服务器获取缺失数据
    │           fetch → parse_multi_tile_response → 存入 OPFS 和 signal_data
    │
    └─ Step 2: get_segments() [内部函数]
        │
        ├─ 2.1 遍历所有信号
        ├─ 2.2 处理 bit-extract 信号（从 parent 提取位数据）
        └─ 2.3 处理普通信号
            bucket_data → generate_lod_segments_from_buckets()
            transitions → 根据格式调用相应的生成函数
    │
    └─ 返回: 序列化的 RenderSegment 数组
```

**调用流程**:
- 在 `WaveformWindow.tsx` 中非拖动模式下调用
- 替换原来的 `fetch_signals_data_batch` + `get_segments` 两次调用

**触发条件**:
- 非拖动模式 (`isPanningRef.current = false`)
- 视口或信号列表变化时

**代码位置**: `WaveformWindow.tsx:674`

**优势**:
- 减少一次 JS-Rust 边界跨越
- 代码更简洁，无重复逻辑
- 自动处理缓存和 LoD 选择

---

### 4.2 `clear_cache` - 清除所有缓存

**文件位置**: `web-client/src/waveform_provider.rs:843-847`

**调用线程**: 主线程（Main Thread）

**参数**: 无

**作用**:
清除所有内存缓存数据。

**调用流程**:
- 通过 `waveformProvider.ts` 中的 `clearCache()` 调用
- 同时也会清除 SignalIdManager 的数据

**触发条件**:
- 用户手动请求清除缓存时
- 应用重置或切换波形时

---

## 5. 渲染与绘制函数

### 5.1 `get_segments` - 获取渲染段（内部函数）

**文件位置**: `web-client/src/waveform_provider.rs:1909-2000+`

**调用线程**: 主线程（Main Thread）

**可见性**: `fn`（内部函数，不暴露给 JS）

**参数**: 无

**返回值**:
```rust
Result<JsValue, JsValue>  // 序列化的 RenderSegment 数组
```

**RenderSegment 结构**:
```rust
{
  x0: f64,              // 段起始 X 坐标
  x1: f64,              // 段结束 X 坐标
  y: f64,               // Y 坐标
  value: ValueInfo,     // 值信息
  signal_name: String,  // 信号名称
}
```

**作用**:
为当前视口计算所有需要渲染的波形段。现在作为内部函数，通过 `fetch_and_get_segments` 间接调用。

**内部工作**:
1. 遍历所有信号
2. 检测数据格式（LoD 0 vs LoD 1+）
3. 根据格式生成相应的渲染段
4. 处理位提取信号（如 signal@[0]）
5. 序列化并返回

**调用方式**:
```rust
// 不再直接从 JS 调用
// 而是通过 fetch_and_get_segments 内部调用:
fetch_and_get_segments(signal_names)
    └── get_segments()  // 内部调用
```

**调用流程**:
- 在 `WaveformWindow.tsx` 中有两个调用位置：
  1. **拖动模式**（第 601-623 行）：有 viewport 变化阈值检测
  2. **非拖动模式**（第 650-667 行）：有参数变化检测

**触发条件（拖动模式）**:
- `isPanningRef.current = true`
- `shouldRecalculateSegments` 为 true，即：
  - 信号列表变化，**或**
  - canvas 尺寸变化，**或**
  - viewport 变化超过 **10%** 或 **10 个时间单位**

**触发条件（非拖动模式）**:
- `isPanningRef.current = false`
- `hasSegParamsChanged` 为 true，即：
  - 信号列表变化，**或**
  - viewport 变化超过 0.1，**或**
  - canvas 尺寸变化超过 0.5 像素

**代码位置**:
- 拖动模式：`WaveformWindow.tsx:601-623`
- 非拖动模式：`WaveformWindow.tsx:650-667`

**优化说明**:
- 拖动时有 viewport 变化阈值（10%），大幅减少调用频率
- 使用 `cachedSegmentsRef` 缓存结果，参数不变时直接复用

---

## 6. 查询与辅助函数

### 6.1 `get_signal_value_at_time` - 获取指定时间的信号值

**文件位置**: `web-client/src/waveform_provider.rs:3132-3277`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn get_signal_value_at_time(
    &self,
    signal_name: &str,  // 信号名称
    time: f64,          // 查询时间
) -> JsValue
```

**作用**:
获取指定信号在指定时间点的值，用于显示在信号值列中。

**调用流程**:
- 在 `WaveformWindow.tsx:863` 中调用
- 在 cursor 位置变化的 useEffect 中调用

**触发条件**:
- cursor 位置变化（`cursor.position` 或 `cursor.visible` 变化）
- `displaySignals` 或 `expandedSignals` 变化
- 非 mock 数据模式

**代码位置**: `WaveformWindow.tsx:863`

---

### 6.2 `find_transitions_around` - 查找时间附近的跳变

**文件位置**: `web-client/src/waveform_provider.rs:3024-3065`

**调用线程**: 主线程（Main Thread）

**参数**:
```rust
pub fn find_transitions_around(
    &self,
    signal_name: &str,  // 信号名称
    time: f64,          // 参考时间
) -> JsValue
```

**返回值**:
```javascript
[prev_time, next_time]  // 前一个和后一个跳变时间
```

**作用**:
查找指定时间附近的信号跳变点，用于 cursor 吸附功能。

**调用流程**:
- 在 `WaveformWindow.tsx:960` 中调用
- 在 `handleCanvasMouseDown` 中，点击波形区域时调用

**触发条件**:
- 用户在波形区域按下鼠标
- 非 mock 数据模式
- 有可见信号

**代码位置**: `WaveformWindow.tsx:960`

---

### 6.3 Getter 函数

**调用线程**: 主线程（Main Thread）

#### `server_url()` - 获取服务器 URL
**文件位置**: `web-client/src/waveform_provider.rs:850-853`

#### `waveform_name()` - 获取波形名称
**文件位置**: `web-client/src/waveform_provider.rs:856-859`

#### `signal_prefix()` - 获取信号前缀
**文件位置**: `web-client/src/waveform_provider.rs:862-865`

#### `space_before_bracket()` - 获取方括号前空格设置
**文件位置**: `web-client/src/waveform_provider.rs:868-871`

#### `current_lod()` - 获取当前 LoD 级别
**文件位置**: `web-client/src/waveform_provider.rs:874-877`

#### `viewport_time_start()` - 获取视口开始时间
**文件位置**: `web-client/src/waveform_provider.rs:989-992`

#### `viewport_time_end()` - 获取视口结束时间
**文件位置**: `web-client/src/waveform_provider.rs:995-998`

#### `display_format()` - 获取显示格式
**文件位置**: `web-client/src/waveform_provider.rs:894-897`

#### `memory_cache_enabled()` - 检查内存缓存是否启用
**文件位置**: `web-client/src/waveform_provider.rs:914-917`

#### `opfs_enabled()` - 检查 OPFS 缓存是否启用
**文件位置**: `web-client/src/waveform_provider.rs:927-930`

---

## 7. 完整调用流程

### 7.1 初始化流程

```
应用启动
  ↓
initWasm() - 初始化 WASM 模块
  ↓
createProvider() - 创建 WaveformDataProvider 实例
  ↓
  ├─ constructor - 创建实例
  └─ init_with_opfs - 初始化 OPFS 缓存
  ↓
WaveformWindow 组件挂载
  ↓
getProvider() - 获取 provider 实例
```

---

### 7.2 非拖动时的完整渲染流程

```
触发条件：viewport 变化、canvas 尺寸变化、信号列表变化等
  ↓
throttledRenderWaveform() - 节流（80ms 间隔）
  ↓
renderWaveform()
  ↓
├─ 构建 signalList 和 signalListHash
├─ 检查参数变化 (hasParamsChanged)
├─ 如果参数无变化，直接返回
  ↓
设置信号列表（如需要）
  ├─ updateProviderSettings() - signal_prefix 和 space_before_bracket
  ├─ buildWasmSignals() - 构建带 draw_sig_id 的信号
  └─ set_draw_list() - 设置信号列表到 WASM
  ↓
设置 viewport 和 canvas 尺寸（如需要）
  ├─ set_viewport()
  └─ set_canvas_dimensions()
  ↓
获取数据并生成 segments
  └─ fetch_and_get_segments() - 合并函数，内部调用：
      ├─ fetch_signals_data_batch() - 获取数据（内部）
      └─ get_segments() - 生成渲染段（内部）
  ↓
更新 cachedSegmentsRef
  ↓
渲染
  └─ waveformRenderer.render() - 绘制到 canvas
```

---

### 7.3 拖动时的优化渲染流程

```
用户在标尺区域按下鼠标
  ↓
setIsPanning(true) - 进入拖动模式
  ↓
初始化 lastSegmentsViewportRef - 记录起始 viewport
  ↓
鼠标移动（频繁触发）
  ↓
panUpdateTimeoutRef - 节流 viewport 更新（100ms 间隔）
  ↓
onViewportChange() - 更新 viewport
  ↓
throttledRenderWaveform() - 节流渲染（250ms 间隔）
  ↓
renderWaveform() - [拖动模式]
  ↓
设置 viewport 和 canvas 尺寸（如需要）
  ├─ set_viewport()
  └─ set_canvas_dimensions() [如有变化]
  ↓
[关键优化] 跳过 fetch_and_get_segments()！
  ↓
检查是否需要重新计算 segments (shouldRecalculateSegments)
  ├─ 信号列表变化？ → 是
  ├─ canvas 尺寸变化？ → 是
  ├─ viewport 变化 > 10% 或 10 时间单位？ → 是
  ↓
  ├─ 如果是：调用 get_segments() [内部函数，通过缓存数据]
  └─ 如果否：使用 cachedSegmentsRef
  ↓
渲染
  └─ waveformRenderer.render() - 使用缓存或新计算的 segments
  ↓
用户释放鼠标
  ↓
setIsPanning(false) - 退出拖动模式
  ↓
cleanupPanTimeout() - 确保最终 viewport 更新
  ↓
[拖动结束后] 触发完整渲染（100ms 延迟）
  └─ renderWaveform() - 完整流程，包括 fetch_and_get_segments()
```

---

### 7.4 Cursor 位置更新流程

```
Cursor 位置变化
  ↓
useEffect 触发
  ↓
遍历 displaySignals
  ↓
对每个信号调用 get_signal_value_at_time()
  ↓
处理位提取信号（如 signal@[0]）
  ↓
更新 signalValues state
  ↓
UI 显示新的信号值
```

---

### 7.5 点击波形区域流程

```
用户在波形区域按下鼠标
  ↓
计算点击时间
  ↓
[可选] 查找附近的跳变点用于吸附
  └─ find_transitions_around()
  ↓
设置 cursor 位置
  ↓
开始选择/缩放拖动
```

---

## 8. 关键性能优化点总结

### 8.1 拖动时的优化

| 优化项 | 优化前 | 优化后 | 效果 |
|--------|--------|--------|------|
| viewport 更新频率 | 每鼠标移动 | 100ms 节流 | 减少 viewport 更新次数 |
| 渲染节流间隔 | 150ms | 250ms | 减少渲染调用次数 |
| fetch_signals_data_batch | 每次渲染 | 完全跳过 | 避免频繁网络请求 |
| get_segments 阈值 | 0.1 时间单位 | 10% 或 10 时间单位 | 大幅减少计算次数 |
| segments 缓存 | 无 | 有 | 参数不变时直接复用 |

### 8.2 参数变化检测

所有 WASM 函数调用前都有参数变化检测：
- `lastRenderParamsRef` - 跟踪上次渲染参数
- `lastWasmSettingsRef` - 跟踪上次 WASM 设置
- `lastSegmentsParamsRef` - 跟踪上次 segments 参数
- `lastSegmentsViewportRef` - 拖动时跟踪上次 viewport

---

## 9. 调用位置速查表

| WASM 函数 | WaveformWindow.tsx 调用位置 | 模式 |
|-----------|----------------------------|------|
| `set_signal_prefix` | 620 | 非拖动 |
| `set_space_before_bracket` | 620 | 非拖动 |
| `set_draw_list` | 628 | 非拖动 |
| `set_viewport` | 572, 640 | 拖动/非拖动 |
| `set_canvas_dimensions` | 574, 641 | 拖动/非拖动 |
| `fetch_and_get_segments` | 674 | 非拖动 |
| `get_signal_value_at_time` | 863 | 任何 |
| `find_transitions_around` | 960 | 任何 |

**注意**: `fetch_signals_data_batch` 和 `get_segments` 已改为内部函数，不再直接从 JS 调用。请使用 `fetch_and_get_segments`。

---

## 10. Rust 可调用的 JavaScript 函数

这些函数在 JavaScript 中定义，通过 `#[wasm_bindgen]` 暴露给 Rust/WASM 调用。

### 10.1 Console 日志函数

#### `log` - 控制台输出

**文件位置**: `web-client/src/lib.rs:24-25`

**定义**:
```rust
#[wasm_bindgen(js_namespace = console)]
fn log(s: &str);
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**作用**: 在浏览器控制台输出日志信息。

**调用方式**: 通过 `console_log!` 宏调用

---

### 10.2 IndexedDB 存储函数（KDB 数据）

这些函数用于将 KDB 知识库数据存储到 IndexedDB。

#### `store_knowledge_base` - 存储知识库元数据

**文件位置**: `web-client/src/lib.rs:33`

**定义**:
```rust
#[wasm_bindgen(js_namespace = window)]
fn store_knowledge_base(id: &str, data: &JsValue) -> js_sys::Promise;
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**参数**:
- `id`: KDB ID（字符串）
- `data`: 知识库元数据对象（包含 header、hierarchies 等）

**返回值**: Promise，存储完成时 resolve

**作用**: 存储知识库的基本信息到 IndexedDB。

**调用时机**: KDB 文件解析完成后

---

#### `store_module` - 存储模块信息

**文件位置**: `web-client/src/lib.rs:36`

**定义**:
```rust
#[wasm_bindgen(js_namespace = window)]
fn store_module(id: u32, data: &JsValue, kdb_id: &str) -> js_sys::Promise;
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**参数**:
- `id`: 模块 ID（1-based）
- `data`: 模块信息对象（name、parentModuleId、signalDefs 等）
- `kdb_id`: KDB ID

**返回值**: Promise，存储完成时 resolve

**作用**: 存储单个模块的信息到 IndexedDB。

**调用时机**: KDB 解析时，遍历所有模块

---

#### `store_signal_inst` - 存储信号实例

**文件位置**: `web-client/src/lib.rs:39`

**定义**:
```rust
#[wasm_bindgen(js_namespace = window)]
fn store_signal_inst(global_index: u32, data: &JsValue, kdb_id: &str) -> js_sys::Promise;
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**参数**:
- `global_index`: 信号全局索引（0-based）
- `data`: 信号实例对象（msb、lsb、parentModuleId、driverLocations 等）
- `kdb_id`: KDB ID

**返回值**: Promise，存储完成时 resolve

**作用**: 存储单个信号实例的信息到 IndexedDB。

**调用时机**: KDB 解析时，遍历所有信号实例

---

#### `store_source_file_info` - 存储源文件元数据

**文件位置**: `web-client/src/lib.rs:43`

**定义**:
```rust
#[wasm_bindgen(js_namespace = window)]
fn store_source_file_info(
    id: u32, 
    path: &str, 
    name: &str, 
    full_name: &str, 
    total_lines: u32, 
    line_index_offset: &[i32], 
    kdb_id: &str
) -> js_sys::Promise;
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**参数**:
- `id`: 文件 ID（1-based）
- `path`: 文件路径
- `name`: 文件名
- `full_name`: 完整名称
- `total_lines`: 总行数
- `line_index_offset`: 行索引偏移数组
- `kdb_id`: KDB ID

**返回值**: Promise，存储完成时 resolve

**作用**: 存储源代码文件的元数据到 IndexedDB。

**调用时机**: KDB 解析时，遍历所有源文件

---

#### `store_source_file_content_opfs` - 存储源文件内容到 OPFS

**文件位置**: `web-client/src/lib.rs:47`

**定义**:
```rust
#[wasm_bindgen(js_namespace = window)]
fn store_source_file_content_opfs(id: u32, content: &[u8], kdb_id: &str) -> js_sys::Promise;
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**参数**:
- `id`: 文件 ID（1-based）
- `content`: 文件内容（二进制字节数组）
- `kdb_id`: KDB ID

**返回值**: Promise，存储完成时 resolve

**作用**: 存储源代码文件的内容到 OPFS（大文件存储）。

**调用时机**: KDB 解析时，遍历所有源文件内容

---

#### `get_source_file_content_by_range` - 按字节范围获取文件内容

**文件位置**: `web-client/src/lib.rs:51`

**定义**:
```rust
#[wasm_bindgen(js_namespace = window)]
fn get_source_file_content_by_range(
    file_id: u32, 
    start_byte: u32, 
    end_byte: u32, 
    kdb_id: &str
) -> js_sys::Promise;
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**参数**:
- `file_id`: 文件 ID
- `start_byte`: 起始字节位置
- `end_byte`: 结束字节位置
- `kdb_id`: KDB ID

**返回值**: Promise，resolve 时返回指定范围的内容

**作用**: 从 OPFS 读取指定字节范围的文件内容。

**调用时机**: 查看源代码时，按需读取

---

#### `clear_kdb_data` - 清除 KDB 数据

**文件位置**: `web-client/src/lib.rs:54`

**定义**:
```rust
#[wasm_bindgen(js_namespace = window)]
fn clear_kdb_data(kdb_id: &str) -> js_sys::Promise;
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**参数**:
- `kdb_id`: KDB ID

**返回值**: Promise，清除完成时 resolve

**作用**: 清除指定 KDB 的所有数据（IndexedDB + OPFS）。

**调用时机**: 重新加载或删除 KDB 时

---

### 10.3 OPFS 缓存回调函数（波形数据）

这些函数在 `init_with_opfs` 中注册，用于 WASM 内部缓存系统。

#### `opfs_read` - OPFS 读取回调

**文件位置**: `web-client/src/opfs_cache.rs:617`

**定义**:
```rust
opfs_read: Option<js_sys::Function>,
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**JS 签名**:
```typescript
(path: string) => Promise<Uint8Array | null>
```

**参数**:
- `path`: 文件路径（如 "lod25/tile_0000/group_0.bin"）

**返回值**: Promise，resolve 时返回 Uint8Array 或 null（不存在）

**作用**: 从 OPFS 读取缓存的波形数据块。

**调用时机**: 
- `prepare_data` 检查缓存时
- `fetch_signals_data_batch` 检查缓存时

---

#### `opfs_write` - OPFS 写入回调

**文件位置**: `web-client/src/opfs_cache.rs:618`

**定义**:
```rust
opfs_write: Option<js_sys::Function>,
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**JS 签名**:
```typescript
(path: string, data: Uint8Array) => Promise<void>
```

**参数**:
- `path`: 文件路径
- `data`: 要写入的二进制数据

**返回值**: Promise，写入完成时 resolve

**作用**: 将波形数据块写入 OPFS 缓存。

**调用时机**: 
- `supplement_data` 存储服务器返回的数据时

---

#### `opfs_exists` - OPFS 存在性检查回调

**文件位置**: `web-client/src/opfs_cache.rs:619`

**定义**:
```rust
opfs_exists: Option<js_sys::Function>,
```

**调用线程**: 主线程（Main Thread）

**方向**: Rust 调用 JS

**JS 签名**:
```typescript
(path: string) => Promise<boolean>
```

**参数**:
- `path`: 文件路径

**返回值**: Promise，resolve 时返回 boolean（是否存在）

**作用**: 检查指定路径的缓存文件是否存在。

**调用时机**: 
- 缓存检查流程中

---

### 10.4 JS 函数调用流程总结

```
Rust/WASM
  ↓
#[wasm_bindgen(js_namespace = window)]
  ↓
JavaScript 全局函数
  ↓
IndexedDB / OPFS 操作
```

**重要说明**:
1. 所有 JS 函数调用都是**异步**的（返回 Promise）
2. Rust 使用 `wasm_bindgen_futures::JsFuture` 来 await JS Promise
3. 这些函数都在**主线程**执行
4. KDB 下载 Worker (`kdbDownload.worker.ts`) 有独立的 WASM 实例和存储函数

---

## 附录

### A. 相关文件

- **WASM 接口定义**: `web-client/src/waveform_provider.rs`
- **JavaScript 包装层**: `web-client/src/wasm/waveformProvider.ts`
- **React 组件**: `web-client/src/components/WaveformWindow.tsx`

### B. 缩略语表

- **WASM**: WebAssembly
- **OPFS**: Origin Private File System
- **LoD**: Level of Detail（细节层次）
- **LRU**: Least Recently Used（最近最少使用）
- **CDN**: Content Delivery Network

---

**文档版本**: 1.0  
**最后更新**: 2026-03-10
