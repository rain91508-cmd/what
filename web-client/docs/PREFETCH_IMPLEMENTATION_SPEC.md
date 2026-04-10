# Waveform Prefetch 实现规范

## 概述

本文档描述 Waveform Prefetch 功能的实现规范，包括架构设计、线程安全机制和执行流程。

## 设计目标

1. **并行执行**：Prefetch 和 Render 可以同时进行，互不阻塞
2. **共享缓存**：Prefetch 写入的数据，Render 可以立即使用
3. **线程安全**：多线程并发访问缓存时保证数据一致性
4. **性能优化**：通过预取减少用户滚动时的等待时间

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                     Waveform Worker                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         全局共享 OpfsCacheManager (线程安全)          │   │
│  │  ┌─────────────┐        ┌─────────────────────┐     │   │
│  │  │  Memory LRU │        │    OPFS (JS 回调)    │     │   │
│  │  │    Cache    │        │                     │     │   │
│  │  │ (Arc<Mutex>)│        │  (全局AtomicBool锁)  │     │   │
│  │  └──────┬──────┘        └──────────┬──────────┘     │   │
│  │         │                          │                 │   │
│  │         └───────────┬──────────────┘                 │   │
│  │                     │                                 │   │
│  │   全局共享 (所有实例通过 Arc 引用)                      │   │
│  └─────────────────────┬────────────────────────────────┘   │
│                        │                                     │
│           ┌────────────┼────────────┐                       │
│           │            │            │                       │
│           ▼            ▼            ▼                       │
│  ┌──────────────┐ ┌──────────┐ ┌──────────────┐            │
│  │    Render    │ │  Prefetch │ │   Prefetch   │            │
│  │              │ │   (task1)  │ │   (task2)    │            │
│  │ signal_data  │ │            │ │              │            │
│  │  (独立HashMap)│ │ 共享读写   │ │  共享写      │            │
│  │              │ │ 全局Cache   │ │  全局Cache   │            │
│  └──────────────┘ └──────────┘ └──────────────┘            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. MemoryLruCache - 线程安全内存缓存

**位置**：`src/opfs_cache.rs`

**设计**：
- 使用 `Arc<Mutex<HashMap<>>>` 包装内部状态
- 实现 `Clone` trait，克隆时共享底层数据
- 所有方法使用 `&self` 而不是 `&mut self`

**关键代码**：
```rust
pub struct MemoryLruCache {
    cache: Arc<Mutex<HashMap<String, LruEntry>>>,
    max_size: usize,
    current_size: Arc<Mutex<usize>>,
    access_counter: Arc<Mutex<u64>>,
}

impl MemoryLruCache {
    pub fn get(&self, key: &str) -> Option<Vec<u8>> { ... }
    pub fn set(&self, key: String, data: Vec<u8>) { ... }
}

impl Clone for MemoryLruCache {
    fn clone(&self) -> Self { ... }
}
```

### 2. OpfsCacheManager - 线程安全缓存管理器

**位置**：`src/opfs_cache.rs`

**设计**：
- 所有可变字段使用 `RwLock` 保护
- `enabled`、`memory_cache_enabled`、`waveform_name`、回调函数都使用 `RwLock`
- 实现 `Clone` trait，克隆时共享所有内部状态

**关键代码**：
```rust
pub struct OpfsCacheManager {
    enabled: RwLock<bool>,
    memory_cache_enabled: RwLock<bool>,
    memory_cache: MemoryLruCache,  // 已经是线程安全的
    waveform_name: RwLock<String>,
    opfs_read: RwLock<Option<js_sys::Function>>,
    opfs_write: RwLock<Option<js_sys::Function>>,
    opfs_exists: RwLock<Option<js_sys::Function>>,
}

impl OpfsCacheManager {
    pub fn is_enabled(&self) -> bool { ... }
    pub fn is_memory_cache_enabled(&self) -> bool { ... }
    pub async fn read(&self, block: &DataBlock) -> Result<...> { ... }
    pub async fn write(&self, block: &DataBlock, data: Vec<u8>) -> Result<...> { ... }
}
```

### 3. 全局共享实例

**位置**：`src/opfs_cache.rs`

**设计**：
- 使用 `OnceLock` 创建全局单例
- 所有 Render 和 Prefetch 任务共享同一个实例

**关键代码**：
```rust
static GLOBAL_OPFS_CACHE: OnceLock<OpfsCacheManager> = OnceLock::new();

pub fn init_global_cache(
    opfs_read: js_sys::Function,
    opfs_write: js_sys::Function,
    opfs_exists: js_sys::Function,
    enabled: bool,
) {
    let cache = OpfsCacheManager::new();
    cache.init(opfs_read, opfs_write, opfs_exists, enabled);
    GLOBAL_OPFS_CACHE.set(cache).ok();
}

pub fn get_global_cache() -> Option<&'static OpfsCacheManager> {
    GLOBAL_OPFS_CACHE.get()
}
```

### 4. WaveformDataProvider - 使用共享 Cache

**位置**：`src/waveform_provider.rs`

**设计**：
- 使用 `Arc<OpfsCacheManager>` 持有共享 cache
- `signal_data` 保持独立（每个 provider 有自己的 HashMap）

**关键代码**：
```rust
pub struct WaveformDataProvider {
    // ... 其他字段
    opfs_cache: Arc<OpfsCacheManager>,
    signal_data: HashMap<String, SignalWaveData>,  // 独立的
    // ...
}
```

## 线程安全机制

### 1. Memory Cache 保护

```rust
// 读取
pub fn get(&self, key: &str) -> Option<Vec<u8>> {
    let mut cache = self.cache.lock().unwrap();
    if let Some(entry) = cache.get_mut(key) {
        entry.last_access = current_count;
        return Some(entry.data.clone());
    }
    None
}

// 写入
pub fn set(&self, key: String, data: Vec<u8>) {
    let mut cache = self.cache.lock().unwrap();
    let mut current_size = self.current_size.lock().unwrap();
    // ... 写入逻辑
}
```

### 2. OPFS 操作保护

```rust
// 全局锁
static OPFS_LOCK: AtomicBool = AtomicBool::new(false);

async fn acquire_opfs_lock() {
    while OPFS_LOCK.swap(true, Ordering::Acquire) {
        // Spinlock with yield
    }
}

fn release_opfs_lock() {
    OPFS_LOCK.store(false, Ordering::Release);
}

// 使用
pub async fn read(&self, block: &DataBlock) -> Result<...> {
    // 1. 检查内存缓存（无锁）
    if let Some(data) = self.memory_cache.get(&path) {
        return Ok(Some(data));
    }
    
    // 2. OPFS 操作（加锁）
    acquire_opfs_lock().await;
    let result = opfs_read.call1(...);
    let data_js = wasm_bindgen_futures::JsFuture::from(promise).await;
    release_opfs_lock();
    
    // 3. 存入内存缓存
    self.memory_cache.set(path, data.clone());
}
```

## Prefetch 执行流程

### 1. 触发时机

```typescript
// handleRenderWaveform 函数中
// Render 完成后，延迟 500ms 触发
schedulePrefetch(signalNames);
```

### 2. Worker 层调度

```typescript
function schedulePrefetch(signalNames: string[]): void {
    // 取消之前的 timer
    cancelPendingPrefetch();
    
    pendingPrefetchSignals = signalNames;
    
    // 延迟 500ms 执行
    prefetchTimer = setTimeout(() => {
        if (wasmProvider && pendingPrefetchSignals) {
            // 直接调用，不加入队列
            wasmProvider.prefetch_tiles_async(signalsToPrefetch);
        }
    }, PREFETCH_DELAY_MS);
}
```

### 3. WASM 层异步执行

```rust
#[wasm_bindgen]
pub fn prefetch_tiles_async(&self, signal_names: Vec<String>) {
    // Clone Arc 共享 cache
    let opfs_cache = self.opfs_cache.clone();
    
    wasm_bindgen_futures::spawn_local(async move {
        let mut prefetch_provider = WaveformDataProvider {
            // ...
            signal_data: HashMap::new(),  // 独立的
            opfs_cache,  // 共享的
            // ...
        };
        
        prefetch_provider.prefetch_tiles_internal(&signal_names).await;
    });
}
```

### 4. 预取范围计算

```rust
async fn prefetch_tiles_internal(&mut self, signal_names: &[String]) -> Result<(), JsValue> {
    // 获取当前 LOD
    let current_lod = self.current_lod.unwrap_or_else(|| select_lod(&self.viewport, self.canvas_width));
    
    // 预取范围：current ± 2
    let min_lod = current_lod.saturating_sub(2);
    let max_lod = (current_lod + 2).min(32);
    
    for lod in min_lod..=max_lod {
        // 计算 tile 范围
        let tile_span = OpfsCacheManager::get_tile_span(lod);
        let current_start_tile = self.viewport.time_start as u64 / tile_span;
        let current_end_tile = self.viewport.time_end as u64 / tile_span;
        let current_tile_count = current_end_tile - current_start_tile + 1;
        
        // 预取倍数：当前 LOD 前后 4x，其他 LOD 前后 1x
        let prefetch_multiplier = if lod == current_lod { 4 } else { 1 };
        let prefetch_range = prefetch_multiplier * current_tile_count;
        
        // 向前/向后预取
        // ...
    }
}
```

## 共享行为

### 共享数据
- **Memory LRU Cache**：完全共享，Prefetch 写入立即可见
- **OPFS 存储**：通过全局锁保护，串行访问

### 独立数据
- **signal_data**：每个 `WaveformDataProvider` 有自己的 HashMap
- **viewport、canvas 等配置**：各自独立

## 性能考虑

1. **锁粒度**：
   - Memory Cache：每个操作独立加锁，锁持有时间短
   - OPFS：全局锁，但 OPFS 本身是异步 I/O，不会阻塞 CPU

2. **并发性**：
   - Render 和 Prefetch 可以真正并行执行
   - 只有 OPFS 操作需要串行化

3. **内存效率**：
   - 只有一个 Memory Cache 实例
   - 通过 LRU 策略自动淘汰旧数据

## 错误处理

1. **Prefetch 失败不影响 Render**：Prefetch 错误只记录日志
2. **部分失败可接受**：某些 tile 预取失败不影响其他 tile
3. **网络错误重试**：由调用方（Worker）控制重试策略

## 调试信息

关键日志输出：
```
[WASM] Prefetch async started for N signals
[WASM] Prefetch: X tiles need fetch from server for LOD Y
[WASM] Prefetch: fetching from server - LOD X tile Y num_tiles Z signals W
[WASM] Prefetch: successfully stored N bytes to OPFS for tile X
[WASM] Prefetch async completed
```

## 相关文件

- `src/opfs_cache.rs` - Cache 实现
- `src/waveform_provider.rs` - Provider 实现
- `src/workers/waveformWorker.ts` - Worker 调用

## 版本历史

- **2024-XX-XX** - 初始实现：串行 Prefetch
- **2024-XX-XX** - 优化：异步 Prefetch，不阻塞 Render
- **2024-XX-XX** - 优化：全局共享 Cache，Render 和 Prefetch 并行
