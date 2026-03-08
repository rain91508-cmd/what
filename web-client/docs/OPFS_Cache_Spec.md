# OPFS 本地缓存架构设计规范

## 1. 设计原则

- **信号 ID 由 JS 管理**：JS 在构建 signal_list 时分配 draw_sig_id
- **Group 静态分片**：signal_id 单调递增，永不复用，避免 group 数据重组
- **Tile 时间分片**：按 LOD 级别倍增时间跨度
- **三级缓存**：Memory LRU → OPFS LRU → Server
- **Immutable 数据**：已有 tile/group 数据永不修改，只追加新 group
- **向后兼容**：支持老的直接服务器访问方式作为 fallback

## 2. 全局常量配置

```typescript
// 全局配置（所有波形共享，硬编码）
// 注意：与服务器 API 保持一致
const CONFIG = {
  // LOD 配置：分辨率倍数（与服务器一致：bucket_size = 2^level）
  LOD_MULTIPLIER: 2,               // 每级 LOD 时间跨度 ×2
  
  // LOD 0 基准（原始数据）
  LOD0_RESOLUTION: 1,              // 1 time_unit
  
  // Tile 配置（2的幂次，便于对齐）
  TILE_SPAN_MULTIPLIER: 256,       // LOD0 的 tile 跨度 = 256 time_units (2^8)
  
  // Group 配置
  GROUP_SIZE: 256,                 // 每个 group 256 个信号
  
  // 缓存限制
  MEMORY_CACHE_MAX: 50 * 1024 * 1024,   // 50MB
  OPFS_CACHE_MAX: 1 * 1024 * 1024 * 1024, // 1GB
  OPFS_GC_TRIGGER: 0.9 * 1024 * 1024 * 1024, // 900MB 触发 GC
  OPFS_GC_TARGET: 0.7 * 1024 * 1024 * 1024,  // 700MB 目标
  
  // 功能开关
  ENABLE_OPFS_CACHE: true,         // 是否启用 OPFS 缓存
};

// LOD 时间跨度计算
// tile_span = 256 * 2^lod
function getTileSpan(lod: number): number {
  return CONFIG.TILE_SPAN_MULTIPLIER * Math.pow(CONFIG.LOD_MULTIPLIER, lod);
}

// LOD 分辨率计算（与服务器一致）
// resolution = 2^lod
function getResolution(lod: number): number {
  return Math.pow(CONFIG.LOD_MULTIPLIER, lod);
}

// LOD 选择算法
// 选择最小的 lod，使得 resolution >= time_span / canvas_width
function selectLod(timeSpan: number, canvasWidth: number): number {
  const timePerPixel = timeSpan / canvasWidth;
  for (let lod = 0; lod <= 32; lod++) {
    if (getResolution(lod) >= timePerPixel) {
      return lod;
    }
  }
  return 32; // max lod
}
```

## 3. OPFS 目录结构

```
/wave_cache/                            # OPFS 缓存根目录（可选，不存在则使用 fallback）
├── {waveform_name}/                    # 每个波形独立目录
│   ├── signals.json                    # global_id 到 draw_sig_id 映射
│   ├── lod0/                           # LOD 0: 原始数据
│   │   ├── tile_0000/
│   │   │   ├── group_0.bin            # draw_sig_id 0-255
│   │   │   ├── group_1.bin            # draw_sig_id 256-511
│   │   │   └── ...
│   │   ├── tile_0001/
│   │   └── ...
│   ├── lod1/                           # LOD 1: 16x 压缩
│   ├── lod2/                           # LOD 2: 256x 压缩
│   └── lod3/                           # LOD 3: 4096x 压缩
│
└── _index/                             # 全局索引（IndexedDB）
    └── tile_index.json                 # tile 访问记录（用于 GC）
```

### Fallback 模式

当 `ENABLE_OPFS_CACHE = false` 或 OPFS 不可用时：
- 跳过所有 OPFS 相关逻辑
- 直接从服务器获取数据
- 只使用 Memory LRU 缓存

## 4. 信号 ID 管理（JS 端）

### 4.1 信号元数据结构（简化版）

```json
// signals.json（每个波形一个，只保存 ID 映射）
{
  "version": 1,
  "next_draw_sig_id": 500,           // 下一个分配的 draw_sig_id
  "signal_map": {
    "0": 0,                          // global_id -> draw_sig_id
    "1": 1,
    "15": 2,
    "100": 3
  }
}
```

其他信号信息（name, width, hierarchy）通过 global_id 查询 KDB 获取。

### 4.2 JS 信号 ID 管理器

```typescript
class SignalIdManager {
  private waveform: string;
  private metadata: {
    next_draw_sig_id: number;
    signal_map: Map<number, number>;  // global_id -> draw_sig_id
  };

  constructor(waveform: string) {
    this.waveform = waveform;
    this.metadata = this.loadMetadata();
  }

  // 获取或创建 draw_sig_id
  getOrCreateDrawSigId(global_id: number): number {
    const existing = this.metadata.signal_map.get(global_id);
    if (existing !== undefined) {
      return existing;
    }

    // 分配新 ID（单调递增）
    const draw_sig_id = this.metadata.next_draw_sig_id++;
    this.metadata.signal_map.set(global_id, draw_sig_id);
    this.saveMetadata();
    return draw_sig_id;
  }

  // 批量获取 draw_sig_id
  getDrawSigIds(global_ids: number[]): Map<number, number> {
    const result = new Map<number, number>();
    for (const global_id of global_ids) {
      const draw_sig_id = this.metadata.signal_map.get(global_id);
      if (draw_sig_id !== undefined) {
        result.set(global_id, draw_sig_id);
      }
    }
    return result;
  }

  // 获取 group_id
  getGroupId(draw_sig_id: number): number {
    return Math.floor(draw_sig_id / CONFIG.GROUP_SIZE);
  }

  private loadMetadata() {
    // 尝试从 OPFS 加载
    // 如果不存在或 OPFS 不可用，创建新的
  }

  private saveMetadata() {
    // 保存到 OPFS（如果可用）
  }
}
```

### 4.3 UI Signal 转 WASM Signal

```typescript
// UI 传递的信号
interface UISignal {
  global_id: number;      // KDB 的 global_id（正整数）
  name: string;           // 信号名称（显示用）
  row: number;            // 显示行号
  width?: number;         // 位宽
}

// 构建 WASM 信号列表
function buildWasmSignals(
  uiSignals: UISignal[],
  waveformName: string
): Array<{ 
  global_id: number; 
  name: string;
  row: number; 
  width: number; 
  draw_sig_id: number;
}> {
  const manager = getSignalIdManager(waveformName);

  return uiSignals.map((uiSig) => {
    const width = uiSig.width || 1;
    const draw_sig_id = manager.getOrCreateDrawSigId(uiSig.global_id);

    return {
      global_id: uiSig.global_id,
      name: uiSig.name,
      row: uiSig.row,
      width,
      draw_sig_id,           // 关键：带上 draw_sig_id
    };
  });
}
```

## 5. Group Bin 文件格式（V2）

### 5.1 文件布局

```
┌─────────────────────────────────────────────────────────────┐
│ GroupBinHeaderV2 (16 bytes)                                 │
├─────────────────────────────────────────────────────────────┤
│ SignalDirectory (1024 bytes = 256 slots × 4 bytes)          │
├─────────────────────────────────────────────────────────────┤
│ Data Area (variable size)                                   │
│  ├── SignalData 0                                           │
│  ├── SignalData 1                                           │
│  └── ...                                                    │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 GroupBinHeaderV2 (16 bytes)

```rust
pub struct GroupBinHeaderV2 {
    pub magic: u32,           // 0x47524F55 ("GROU")
    pub version: u8,          // 2
    pub reserved: u8,         // 0
    pub signal_count: u16,    // 实际信号数量
    pub data_area_offset: u32, // 数据区域偏移 (16 + 1024 = 1040)
    pub reserved2: [u8; 4],   // 0
}
```

### 5.3 SignalDirectory (1024 bytes)

- 256 个固定 slots，每个 slot 4 bytes
- **索引方式**: `index = draw_sig_id % 256`
- **Entry 格式**: `[exists: 1 bit][offset: 31 bits]`
  - Bit 31 (MSB): 1 = signal 存在, 0 = 空 slot
  - Bits 0-30: signal data 在 data area 中的偏移

```rust
pub struct SignalDirectory {
    pub entries: [u32; 256],  // 256 slots
}

pub struct SignalDirectoryEntry {
    pub exists: bool,         // Bit 31
    pub offset: u32,          // Bits 0-30 (max 2GB offset)
}
```

### 5.4 SignalData 格式

```
┌─────────────────────────────────────────────────────────────┐
│ draw_sig_id: u32 (4 bytes)                                  │
├─────────────────────────────────────────────────────────────┤
│ transition_count: u32 (4 bytes)                             │
├─────────────────────────────────────────────────────────────┤
│ Transition 0                                                │
│ ├── time: u64 (8 bytes)        // bucket offset (0-255)     │
│ ├── value_len: u8 (1 byte)                                  │
│ └── value: [u8; value_len]    // 二进制值                   │
├─────────────────────────────────────────────────────────────┤
│ Transition 1                                                │
│ ├── time: u64 (8 bytes)                                     │
│ ├── value_len: u8 (1 byte)                                  │
│ └── value: [u8; value_len]                                  │
├─────────────────────────────────────────────────────────────┤
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘
```

### 5.5 Value 格式

```
单 bit 信号:
  value_len = 1
  value[0] = 0 或 1

多 bit 信号（小端序）:
  value_len = 1-8（根据位宽）
  value = [LSB, ..., MSB]

例如 32-bit 值 0x12345678:
  value_len = 4
  value = [0x78, 0x56, 0x34, 0x12]
```

### 5.6 Group 分片策略

每个 group 文件最多存储 256 个 signals（draw_sig_id 0-255）。

**冲突处理**：
- Signal A: draw_sig_id = 0 → group_0.bin, index = 0
- Signal B: draw_sig_id = 1 → group_0.bin, index = 1
- Signal C: draw_sig_id = 257 → group_1.bin, index = 1

不同的 group 文件避免冲突。

## 6. WASM 接口设计

### 6.1 初始化与配置

```rust
#[wasm_bindgen]
impl WaveformDataProvider {
    /// 初始化（传入 JS 的 OPFS 访问回调和配置）
    /// 
    /// # Arguments
    /// * `opfs_read` - JS 回调: (path: string) -> Promise<Uint8Array | null>
    /// * `opfs_write` - JS 回调: (path: string, data: Uint8Array) -> Promise<()>
    /// * `opfs_exists` - JS 回调: (path: string) -> Promise<bool>
    /// * `enable_opfs` - 是否启用 OPFS 缓存（向后兼容开关）
    #[wasm_bindgen]
    pub fn init_with_opfs(
        &mut self,
        opfs_read: js_sys::Function,
        opfs_write: js_sys::Function,
        opfs_exists: js_sys::Function,
        enable_opfs: bool,
    );
    
    /// 设置 draw list（带 draw_sig_id）
    /// 
    /// # Arguments
    /// * `signals_js` - Array of { global_id, name, row, width, draw_sig_id }
    #[wasm_bindgen]
    pub fn set_draw_list(&mut self, signals_js: JsValue) -> Result<(), JsValue>;
    
    /// 设置 viewport
    #[wasm_bindgen]
    pub fn set_viewport(&mut self, time_start: f64, time_end: f64);
    
    /// 设置 canvas 尺寸
    #[wasm_bindgen]
    pub fn set_canvas(&mut self, width: f64, height: f64, row_height: f64);
}
```

### 6.2 数据准备（核心接口）

```rust
#[wasm_bindgen]
impl WaveformDataProvider {
    /// 批量获取信号数据（内部处理三级缓存）
    /// 
    /// 这是 JS 调用的主入口。WASM 内部：
    /// 1. 计算需要哪些 tiles
    /// 2. 检查 cache per signal per tile
    /// 3. cache hit: 读取 group 文件，解析为 bucket_data
    /// 4. cache miss: 从服务器获取，解析 chunk 数据，存储为 bucket_data
    /// 
    /// # Arguments
    /// * `signal_names` - 信号名称列表
    #[wasm_bindgen]
    pub async fn fetch_signals_data_batch(&mut self, signal_names: Vec<String>) -> Result<(), JsValue>;
    
    /// 生成渲染用的 segments
    #[wasm_bindgen]
    pub fn get_segments(&self) -> Result<JsValue, JsValue>;
    
    /// 获取缺失数据的信号列表（调试用）
    #[wasm_bindgen]
    pub fn get_missing_signals(&self) -> JsValue;
    
    /// 清除所有缓存数据（切换波形时调用）
    #[wasm_bindgen]
    pub fn clear_cache(&mut self);
}
```

### 6.3 Fallback 兼容接口

```rust
#[wasm_bindgen]
impl WaveformDataProvider {
    /// 【兼容老版本】直接设置信号数据（不经过缓存）
    /// 
    /// 用于：
    /// - OPFS 禁用时的 fallback
    /// - 调试和测试
    /// - 小数据量快速渲染
    #[wasm_bindgen]
    pub fn set_signal_data_direct(&mut self, data_js: JsValue) -> Result<(), JsValue>;
}
```

## 7. 数据加载流程

### 7.1 完整流程（启用 OPFS）

```
JS: renderWaveform()
  │
  ├── 1. 构建 draw list（分配 draw_sig_id）
  │     └── buildWasmSignals(uiSignals)
  │
  ├── 2. 初始化 WASM
  │     ├── wasm.init_with_opfs(opfsCallbacks, enable_opfs=true)
  │     ├── wasm.set_draw_list(wasmSignals)
  │     ├── wasm.set_viewport()
  │     └── wasm.set_canvas()
  │
  ├── 3. WASM 获取数据
  │     └── wasm.fetch_signals_data_batch(signal_names)
  │         │
  │         ├── 计算所需 tiles
  │         ├── 对每个 tile 的每个 signal:
  │         │   ├── 检查 cache
  │         │   │   ├── cache hit: 读取 group 文件
  │         │   │   │   └── 解析为 bucket_data
  │         │   │   └── cache miss: 标记为 missing
  │         │   └── 合并到 signal_data.bucket_data
  │         │
  │         ├── 如有 missing signals:
  │         │   └── 从服务器获取 chunk 数据
  │         │       ├── 解析 chunk 为 transitions
  │         │       ├── 转换为 bucket_data
  ��         │       └── 写入 cache (group bin 格式)
  │         │
  │         └── 所有数据存入 signal_data
  │
  └── 4. 获取 segments 并渲染
      ├── segments = wasm.get_segments()
      │   └── 遍历 bucket_data，生成 RenderSegment
      └── renderer.render(segments)
```

### 7.2 Cache Hit 处理流程

```rust
// 1. 构建 cache key
let block = DataBlock::new(lod, tile_id, group_id);
let path = block.to_path(&self.waveform_name);  // "lod25/tile_0000/group_0.bin"

// 2. 从 OPFS 读取
match self.opfs_cache.read_signal_from_group(&path, draw_sig_id).await {
    Ok(Some(signal_data)) => {
        // 3. 转换为 transitions
        let transitions: Vec<Transition> = signal_data.transitions
            .into_iter()
            .map(|t| Transition { time: t.time, value })
            .collect();
        
        // 4. 解析为 bucket_data
        let (start_value, buckets) = self.parse_buckets_from_transitions(&transitions);
        
        // 5. 存储到 signal_data
        existing.bucket_data.push((tile_start, buckets));
    }
    Ok(None) => { /* cache miss */ }
    Err(e) => { /* error */ }
}
```

### 7.3 Server Fetch 处理流程

```rust
// 1. 构建 URL
let url = format!("{}/api/wave/{}/lod/{}/tile/{}/{}/{}/...",
    server_url, waveform_name, lod, start_time, tile_span, num_tiles);

// 2. 获取 chunk 数据
let chunk_data = fetch(&url).await?;

// 3. 解析 chunk
let chunk_signals = self.parse_server_chunk(&chunk_data)?;

// 4. 对每个 signal:
for signal in chunk_signals {
    // 4.1 转换为 transitions
    let transitions = signal.transitions;
    
    // 4.2 解析为 bucket_data
    let (start_value, buckets) = self.parse_buckets_from_transitions(&transitions);
    
    // 4.3 存储到 signal_data
    existing.bucket_data.push((tile_start, buckets));
    
    // 4.4 写入 cache (如果启用)
    if enable_opfs {
        let group_data = GroupData { signals: vec![signal] };
        let bin_data = serialize_group_data_v2(&group_data);
        self.opfs_cache.write(&path, &bin_data).await?;
    }
}
```

### 7.4 计算所需数据块

```rust
fn compute_required_tiles(&self, lod: u32) -> Vec<u64> {
    let tile_span = get_tile_span(lod);
    let start_tile = self.viewport.time_start as u64 / tile_span;
    let end_tile = self.viewport.time_end as u64 / tile_span;
    
    (start_tile..=end_tile).collect()
}

fn compute_groups(&self) -> Vec<u32> {
    let mut groups = HashSet::new();
    for signal in &self.signals {
        let group_id = signal.draw_sig_id / CONFIG.GROUP_SIZE;
        groups.insert(group_id);
    }
    groups.into_iter().collect()
}
```

## 8. WASM/JS 职责分工

### 8.1 架构原则

**WASM 负责（核心逻辑）**：
- 数据解析：解析服务器返回的 chunk 数据
- 缓存管理：Memory LRU 缓存的读写
- OPFS 控制：决定何时读写 OPFS，组织数据格式
- 数据序列化：将信号数据序列化为 Group Bin 格式
- 渲染计算：生成渲染用的 segments

**JS 负责（环境适配）**：
- 网络请求：从服务器获取数据
- OPFS 访问：提供 OPFS 读写回调（WASM 调用 JS 函数）
- ID 管理：分配和维护 draw_sig_id
- UI 交互：用户操作和状态管理

### 8.2 数据流

```
Server (Binary Chunk)
    │
    ▼
JS: fetch() -> ArrayBuffer
    │
    ▼
WASM: fetch_signals_data_batch()
    │
    ├── 解析 chunk（复用现有逻辑）
    ├── 按 (lod, tile, group) 重组
    ├── 序列化为 Group Bin
    │
    ├── OPFS 写入？───► JS 回调 opfs_write(path, data)
    │                      └── navigator.storage.getDirectory()
    │
    └── Memory LRU 缓存
```

### 8.3 为什么 WASM 控制 OPFS？

1. **性能**：WASM 直接处理二进制数据，避免 JS-WASM 之间多次数据拷贝
2. **一致性**：缓存逻辑集中在 WASM，JS 只负责提供存储访问能力
3. **简化 JS**：JS 代码更简单，只关注网络请求和 UI
4. **可移植性**：WASM 逻辑可以在不同环境中复用（如原生应用）

## 9. 数据一致性保证

### 9.1 First/Last Pair 处理

**Server 返回**：
- 每个 bucket 可能有 1 或 2 个 transitions
- 2 个 transitions = first/last pair（相同 offset）

**Cache 存储**：
- 保持原始 transitions 格式（不合并）
- 相同 offset 的两个 transitions 都存储

**Memory 解析**：
- `parse_buckets_from_transitions` 识别 first/last pair
- 生成 `BucketData { first, last: Some(last) }`

### 9.2 跨 Tile 连续性

**问题**：tile 1 的 start value 应该是 tile 0 的 last value

**解决方案**：
```rust
// generate_lod_segments_from_buckets 中
let mut cross_tile_value: Option<String> = None;

for (tile_idx, (tile_start, buckets)) in bucket_data.iter().enumerate() {
    let start_value = if tile_idx == 0 {
        // First tile: use tile's start value
        get_start_value_from_tile_info()
    } else {
        // Subsequent tiles: use last value from previous tile
        cross_tile_value.clone().unwrap_or_else(|| "0".to_string())
    };
    
    // ... process buckets ...
    
    // Update cross_tile_value for next tile
    cross_tile_value = Some(current_value.clone());
}
```

### 9.3 Tile 顺序保证

**问题**：HashMap 的迭代顺序不确定

**解决方案**：
```rust
// Server fetch: sort tile_ids
let mut tile_ids: Vec<u64> = tile_missing_signals.keys().cloned().collect();
tile_ids.sort();

// Cache hit: tiles processed in order of tiles_to_fetch
for (tile_idx, tile_id) in tiles_to_fetch.iter().enumerate() {
    // ...
}
```

## 10. OPFS GC 回收策略

### 10.1 IndexedDB 索引

```typescript
// IndexedDB: tile_cache_index
interface TileIndexEntry {
  key: string;                    // "{waveform}/lod{l}/tile{t}/group{g}"
  waveform: string;
  lod: number;
  tile: number;
  group: number;
  size: number;
  last_access: number;
  access_count: number;
}
```

### 10.2 GC 策略

```rust
impl WaveformCache {
    /// 执行 GC（由 JS 定期调用）
    pub async fn run_gc(&mut self) -> Result<(), JsValue> {
        if !self.enable_opfs {
            return Ok(());  // OPFS 禁用，跳过
        }
        
        // 获取存储配额信息（通过 JS）
        let estimate = self.js_storage_estimate().await?;
        let usage = estimate.usage.unwrap_or(0);
        
        if usage < CONFIG.OPFS_GC_TRIGGER {
            return Ok(());  // 未达到触发阈值
        }
        
        // 从 IndexedDB 获取所有 tile
        let mut tiles = self.js_indexeddb_get_all().await?;
        
        // 排序：优先删除高 LOD + 最少访问
        tiles.sort_by(|a, b| {
            if a.lod != b.lod {
                return b.lod.cmp(&a.lod);  // LOD 高的优先
            }
            a.last_access.cmp(&b.last_access)  // 旧的优先
        });
        
        // 删除直到低于目标
        let mut current_size = usage;
        for tile in tiles {
            if current_size < CONFIG.OPFS_GC_TARGET {
                break;
            }
            
            // 删除 OPFS 文件
            self.js_opfs_delete(&tile.key).await?;
            
            // 删除索引
            self.js_indexeddb_delete(&tile.key).await?;
            
            current_size -= tile.size;
        }
        
        Ok(())
    }
}
```

## 11. JS 端调用示例

### 11.1 正常模式（启用 OPFS）

```typescript
class WaveformController {
  private wasm: WaveformDataProvider;
  private signalIdManager: SignalIdManager;
  private enableOpfs: boolean = true;
  
  async init() {
    // 检查 OPFS 支持
    if (!('storage' in navigator && 'getDirectory' in navigator.storage)) {
      console.warn('[Waveform] OPFS not supported, using fallback mode');
      this.enableOpfs = false;
    }
    
    // 初始化 WASM
    this.wasm = new WaveformDataProvider();
    this.wasm.init_with_opfs(
      this.opfsRead.bind(this),
      this.opfsWrite.bind(this),
      this.opfsExists.bind(this),
      this.enableOpfs
    );
  }
  
  async render(viewport: Viewport, signalList: UISignal[]) {
    // 1. 构建 draw list
    const wasmSignals = signalList.map(s => ({
      global_id: s.global_id,
      name: s.name,
      row: s.row,
      width: s.width || 1,
      draw_sig_id: this.signalIdManager.getOrCreateId(s.global_id),
    }));
    
    // 2. 设置 WASM
    this.wasm.set_draw_list(wasmSignals);
    this.wasm.set_viewport(viewport.timeStart, viewport.timeEnd);
    this.wasm.set_canvas(width, height, 24);
    
    // 3. WASM 获取数据（内部处理 cache/server）
    const signalNames = wasmSignals.map(s => s.name);
    await this.wasm.fetch_signals_data_batch(signalNames);
    
    // 4. 渲染
    const segments = this.wasm.get_segments();
    renderer.render(segments);
  }
  
  // OPFS 回调
  async opfsRead(path: string): Promise<Uint8Array | null> {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getEntry(`wave_cache/${path}`);
      const file = await fileHandle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }
  
  async opfsWrite(path: string, data: Uint8Array): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const dirPath = path.substring(0, path.lastIndexOf('/'));
    const fileName = path.substring(path.lastIndexOf('/') + 1);
    
    // 递归创建目录
    const dir = await this.mkdirp(root, `wave_cache/${dirPath}`);
    
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  }
}
```

### 11.2 Fallback 模式（禁用 OPFS）

```typescript
async renderFallback(viewport: Viewport, signalList: UISignal[]) {
  // 简化流程，直接使用老接口
  this.wasm.init_with_opfs(null, null, null, false);
  
  // 使用兼容接口
  const signalNames = signalList.map(s => s.name);
  await this.wasm.fetch_signals_data_batch(signalNames);
  
  const segments = this.wasm.get_segments();
  renderer.render(segments);
}
```

## 12. 性能指标

| 指标 | 目标值 | 说明 |
|------|--------|------|
| Memory 缓存命中 | > 80% | 常用数据常驻内存 |
| OPFS 缓存命中 | > 60% | 减少服务器请求 |
| 首次加载时间 | < 2s | 冷启动性能 |
| 平移响应 | < 100ms | 预取命中时 |
| Zoom 响应 | < 200ms | LOD 切换时 |
| 最大支持信号 | 100k+ | draw_sig_id 线性递增 |
| 最大时间点 | 10B+ | 64-bit time |
| Fallback 切换 | < 50ms | 检测到 OPFS 失败时 |

## 13. 实现优先级

1. **P0**: WASM 接口改造（支持 fallback）
2. **P0**: Group bin 文件格式 V2
3. **P0**: Signal ID 管理（JS 端）
4. **P1**: Memory LRU 缓存
5. **P1**: OPFS 读写接口
6. **P2**: OPFS GC 回收
7. **P2**: 预取策略
8. **P2**: 性能监控

## 14. 向后兼容说明

### 14.1 检测 OPFS 支持

```typescript
function checkOpfsSupport(): boolean {
  return 'storage' in navigator && 
         'getDirectory' in navigator.storage &&
         'FileSystemFileHandle' in window;
}
```

### 14.2 渐进式启用

```typescript
// 第一阶段：默认禁用，手动开启
const ENABLE_OPFS = localStorage.getItem('enable_opfs') === 'true';

// 第二阶段：自动检测，失败 fallback
const ENABLE_OPFS = checkOpfsSupport();

// 第三阶段：默认启用，可手动禁用
const ENABLE_OPFS = localStorage.getItem('disable_opfs') !== 'true';
```

### 14.3 调试开关

```typescript
// URL 参数控制
// ?opfs=off    - 强制禁用 OPFS
// ?opfs=on     - 强制启用 OPFS
// ?opfs=auto   - 自动检测（默认）

const urlParams = new URLSearchParams(window.location.search);
const opfsMode = urlParams.get('opfs') || 'auto';

const enableOpfs = opfsMode === 'on' || 
                   (opfsMode === 'auto' && checkOpfsSupport());
```

---

**版本**: 1.3
**日期**: 2026-03-08
**更新**: 
- 更新 Group Bin 文件格式为 V2（16 bytes header + 256 slots directory）
- 补充 SignalData 包含 draw_sig_id 的说明
- 更新数据加载流程，匹配实际实现
- 补充数据一致性保证章节（first/last pair、跨 tile 连续性）
- 补充 tile 顺序保证说明
**作者**: AI Assistant
