# HWDA Server API 文档

硬件设计分析器数据服务器 (Hardware Design Analyzer Data Server) API 文档。

## 更新日志

### 2026-03-10

#### LoD Tile 对齐规则优化
- **重要**: LoD 1+ 生成时，tile 起始时间必须对齐到 bucket 大小
- **对齐规则**: `aligned_start = (tile_start / bucket_size) * bucket_size`
- **范围**: 使用 `[aligned_start, tile_end]` 而不是 `[tile_start, tile_end]` 来计算 buckets
- **Bucket 数量**: 使用向上取整确保至少有 1 个 bucket：`total_buckets = ceil((tile_end - aligned_start) / bucket_size)`
- **修复**: 服务器和 fst-tile-reader 都必须遵循相同的对齐规则

### 2026-03-09

#### LoD 算法优化
- **修复**: Start Value 不再参与 bucket 计算，只作为 tile 起始点的参考值单独输出
- **修复**: 输出 first/last pair 的条件改为 bucket 内有多个 transitions（时间不同），而不是值不同
- **优化**: 改进了 LoD 生成算法，确保 bucket 计数准确

#### 新增缓存管理 API
- **新增**: `POST /api/cache/clear` - 清除所有缓存
- **新增**: `POST /api/cache/wave-chunk/clear` - 清除波形数据块缓存
- **新增**: `POST /api/cache/wave-metadata/clear` - 清除波形元数据缓存
- **新增**: 启动参数 `--clear-cache-on-startup` - 启动时自动清除所有缓存

## 基础信息

- **Base URL**: `http://localhost:8080`
- **默认端口**: 8080
- **数据格式**: JSON
- **编码**: UTF-8
- **CORS**: 支持跨域请求

## 通用响应格式

所有 API 响应遵循统一的格式：

```json
{
  "status": "success" | "error",
  "data": { ... },
  "error": null | "错误信息"
}
```

## API 端点列表

### 1. 健康检查与统计

#### 1.1 健康检查

```http
GET /health
```

**描述**: 检查服务器运行状态

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "status": "healthy",
    "timestamp": "2026-03-03T08:35:32.343Z"
  },
  "error": null
}
```

**字段说明**:
- `status`: 服务器状态 ("healthy" 表示正常)
- `timestamp`: ISO 8601 格式的时间戳

---

#### 1.2 获取服务器统计信息

```http
GET /stats
```

**描述**: 获取服务器运行统计信息

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "stats": {
      "total_requests": 150,
      "kdb_requests": 45,
      "wave_requests": 95,
      "cache_hits": 120,
      "cache_misses": 30,
      "errors": 0
    }
  },
  "error": null
}
```

**字段说明**:
- `total_requests`: 总请求数
- `kdb_requests`: 知识库相关请求数
- `wave_requests`: 波形数据相关请求数
- `cache_hits`: 缓存命中次数
- `cache_misses`: 缓存未命中次数
- `errors`: 错误次数

---

#### 1.3 获取服务器配置

```http
GET /config
```

**描述**: 获取服务器配置信息（不包含敏感信息）

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "config": {
      "port": 8080,
      "host": "0.0.0.0",
      "kdb_dir": "tests/kdb",
      "wave_dir": "tests/waves",
      "max_connections": 1000,
      "cache_capacity_mb": 512,
      "chunk_size_kb": 64,
      "enable_cors": true,
      "enable_auth": false,
      "rate_limit": 100
    }
  },
  "error": null
}
```

---

#### 1.4 清除所有缓存

```http
POST /api/cache/clear
```

**描述**: 清除服务器的所有缓存数据

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "message": "All caches cleared successfully"
  },
  "error": null
}
```

**使用场景**:
- 数据文件更新后需要刷新缓存
- 调试时确保获取最新数据
- 内存不足时释放缓存空间

---

#### 1.5 清除波形数据块缓存

```http
POST /api/cache/wave-chunk/clear
```

**描述**: 仅清除波形数据块缓存

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "message": "Wave chunk cache cleared successfully"
  },
  "error": null
}
```

---

#### 1.6 清除波形元数据缓存

```http
POST /api/cache/wave-metadata/clear
```

**描述**: 仅清除波形元数据缓存

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "message": "Wave metadata cache cleared successfully"
  },
  "error": null
}
```

---

#### 1.7 启动参数说明

**`--clear-cache-on-startup`**

**描述**: 服务器启动时自动清除所有缓存

**使用示例**:
```bash
hwda-server --port 8080 --wave-dir ./waves --kdb-dir ./kdb --clear-cache-on-startup
```

**使用场景**:
- 开发调试时确保每次启动都使用最新数据
- 数据文件更新后重启服务器
- 避免缓存数据不一致问题

---

### 2. 知识库 (KDB) API

#### 2.1 获取知识库列表

```http
GET /api/kdb
```

**描述**: 获取所有可用的知识库文件列表，包含缓存验证元数据

**查询参数**:
- `checksum`: 可选，用于 CDN 缓存刷新（服务器不处理，建议从 KDB info 的 `checksum` 字段获取）

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "kdbs": [
      {
        "name": "riscv2",
        "file_size": 8461,
        "is_valid": true,
        "modified_time": 1772495135,
        "checksum": "f660bbd6e780de9a393680d611192d7037338d2847d5b2468e93706ec2789791"
      },
      {
        "name": "simple",
        "file_size": 816,
        "is_valid": true,
        "modified_time": 1772495129,
        "checksum": "abc123..."
      }
    ],
    "summary": {
      "total": 5,
      "valid": 4,
      "invalid": 1
    }
  },
  "error": null
}
```

**字段说明**:
- `name`: 知识库名称（文件名，不含扩展名）
- `file_size`: 文件大小（字节）
- `is_valid`: 是否为有效的 KDB 文件
- `modified_time`: 文件修改时间（Unix 时间戳）
- `checksum`: SHA256 校验和（用于缓存验证）
- `summary`: 统计信息
  - `total`: 总文件数
  - `valid`: 有效文件数
  - `invalid`: 无效文件数

---

#### 2.2 获取知识库元信息

```http
GET /api/kdb/{name}
```

**描述**: 获取指定知识库的详细元信息

**路径参数**:
- `name`: 知识库名称（如 "riscv2"）

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "kdb_info": {
      "design_name": "riscv2",
      "version": "1.0.0",
      "signal_count": 0,
      "module_count": 0,
      "file_size": 8461,
      "checksum": "f660bbd6e780de9a393680d611192d7037338d2847d5b2468e93706ec2789791"
    }
  },
  "error": null
}
```

**字段说明**:
- `design_name`: 设计名称
- `version`: 版本号
- `signal_count`: 信号数量（待实现）
- `module_count`: 模块数量（待实现）
- `file_size`: 文件大小（字节）
- `checksum`: SHA256 校验和

**错误响应**:
- `404 Not Found`: 知识库不存在

---

#### 2.3 下载知识库文件

```http
GET /api/kdb/{name}/file
```

**描述**: 下载知识库文件，支持 HTTP Range 请求

**路径参数**:
- `name`: 知识库名称

**请求头**:
- `Range`: 可选，支持断点续传（如 `bytes=0-1023`）

**响应**:
- 成功: 返回文件内容（`Content-Type: application/octet-stream`）
- 带 Range: 返回 206 Partial Content

**示例**:
```bash
# 下载整个文件
curl -O http://localhost:8080/api/kdb/riscv2/file

# 下载部分内容（断点续传）
curl -H "Range: bytes=0-1023" http://localhost:8080/api/kdb/riscv2/file
```

---

### 3. 波形数据 API

#### 3.1 获取波形文件列表

```http
GET /api/wave/list
```

**描述**: 获取所有可用的波形文件列表，包含缓存验证元数据

**查询参数**:
- `limit`: 可选，限制返回数量
- `offset`: 可选，偏移量（分页）

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "waves": [
      {
        "name": "riscv2",
        "file_size": 52894,
        "is_valid": true,
        "modified_time": 1772113415,
        "checksum": "226af898e9dfa042..."
      },
      {
        "name": "riscv",
        "file_size": 6868739,
        "is_valid": true,
        "modified_time": 1772519659,
        "checksum": "abc123..."
      }
    ]
  },
  "error": null
}
```

**字段说明**:
- `name`: 波形文件名（不含扩展名）
- `file_size`: 文件大小（字节）
- `is_valid`: 是否为有效的 FST 文件
- `modified_time`: 文件修改时间（Unix 时间戳）
- `checksum`: SHA256 校验和

---

#### 3.2 获取波形文件元信息

```http
GET /api/wave/{waveform_name}/info
```

**描述**: 获取波形文件的详细元信息

**路径参数**:
- `waveform_name`: 波形文件名（如 "riscv2"）

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "wave_info": {
      "name": "riscv2",
      "file_size": 52894,
      "signal_count": 2,
      "start_time": 0,
      "end_time": 14277227000000,
      "time_unit": "1ps",
      "time_precision": "1ps",
      "version": "Chronologic Simulation VCS Release T-2022.06-SP2-1_Full64",
      "date": "Mon Feb 16 08:27:28 2026\n"
    }
  },
  "error": null
}
```

**字段说明**:
- `name`: 波形名称
- `file_size`: 文件大小（字节）
- `signal_count`: 信号数量
- `start_time`: 起始时间（与 `time_unit` 单位一致）
- `end_time`: 结束时间（与 `time_unit` 单位一致）
- `time_unit`: FST 文件时间单位（如 "1ps", "1ns"）
- `time_precision`: 时间精度（与 `time_unit` 相同）
- `version`: 波形文件版本/生成工具
- `date`: 生成日期

**注意**: 
- 所有时间值（`start_time`, `end_time`）的单位与 `time_unit` 一致
- 例如：如果 `time_unit` 为 "1ps"，则 `start_time=1000` 表示 1000ps
- 客户端需要根据 `time_unit` 解析时间值

---

#### 3.3 获取信号列表

```http
GET /api/wave/{waveform_name}/signals
```

**描述**: 获取波形文件中所有信号的列表，支持过滤和分页

**路径参数**:
- `waveform_name`: 波形文件名

**查询参数**:
- `name_regex`: 可选，信号名称正则表达式过滤
- `handle_from`: 可选，起始 handle（包含）
- `handle_to`: 可选，结束 handle（包含）
- `limit`: 可选，限制返回数量
- `offset`: 可选，偏移量

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "waveform_name": "riscv2",
    "signal_count": 2,
    "signals": [
      {
        "name": "clk",
        "handle": 1,
        "width": 1,
        "type": "VcdReg",
        "direction": "Implicit"
      },
      {
        "name": "reset",
        "handle": 2,
        "width": 1,
        "type": "VcdReg",
        "direction": "Implicit"
      }
    ]
  },
  "error": null
}
```

**字段说明**:
- `name`: 信号名称
- `handle`: 信号句柄（唯一标识）
- `width`: 信号位宽
- `type`: 信号类型（如 VcdReg, VcdWire 等）
- `direction`: 信号方向（如 Input, Output, Implicit 等）
- `start_time`: 信号起始时间（飞秒 fs）
- `end_time`: 信号结束时间（飞秒 fs）

---

#### 3.4 获取信号元信息

```http
GET /api/wave/{waveform_name}/signals/{signal_name}/info
```

**描述**: 获取指定信号的详细元信息

**路径参数**:
- `waveform_name`: 波形文件名
- `signal_name`: 信号名称（URL 编码）

**响应示例**:
```json
{
  "status": "success",
  "data": {
    "name": "clk",
    "handle": 1,
    "width": 1,
    "type": "VcdReg",
    "direction": "Implicit",
    "start_time": 0,
    "end_time": 14277227000
  },
  "error": null
}
```

---

#### 3.5 获取波形数据（支持多信号）

```http
GET /api/wave/{waveform_name}/lod/{lod}/time/{start}/{end}/compress/{compress}/signals/{signal_names}/data
```

**描述**: 获取一个或多个信号的波形数据，LoD、时间范围、压缩算法均在路径中

**路径参数**:
- `waveform_name`: 波形文件名
- `lod`: LoD (Level of Detail) 层级 0-32
- `start`: 起始时间（与波形文件的 `time_unit` 单位一致），`-` 表示从 0 开始
- `end`: 结束时间（与波形文件的 `time_unit` 单位一致），`-` 表示到文件结束
- `compress`: 压缩算法（`none`, `zstd`, `lz4`）
- `signal_names`: 信号名称，逗号分隔多个信号

**信号名编码（必须 Base64）**:
- 所有信号名必须使用 Base64 编码，格式: `b64:base64encodedstring`
- 编码对象: 整个逗号分隔的信号列表
- 示例: `clk,reset,data` → `b64:Y2xrLHJlc2V0LGRhdGE=`

**查询参数**:
- `time_stamp`: 可选，用于 CDN 缓存刷新（服务器不处理，建议从波形 info 的 `date` 字段获取）

**示例**:
- 单个信号: `/api/wave/riscv2/lod/0/time/0/1000000/compress/none/signals/b64:Y2xr/data`
- 多个信号: `/api/wave/riscv2/lod/0/time/0/-/compress/zstd/signals/b64:Y2xrLHJlc2V0LGRhdGE=/data`
- 带时间戳: `/api/wave/riscv2/lod/0/time/0/1000000/compress/none/signals/b64:xxx/data?time_stamp=1772690121`

---

#### 3.6 获取波形数据（Tile-based 模式）

```http
GET /api/wave/{waveform_name}/lod/{lod}/tile/{start}/{span}/{num}/compress/{compress}/signals/{signal_names}/data
```

**描述**: 获取多个连续的 tiles 波形数据，每个 tile 是一个独立的时间范围

**与 time 模式的区别**:
- `time` 模式: 获取单个连续时间范围的波形数据
- `tile` 模式: 获取多个连续的 tiles，每个 tile 独立处理边界值

**路径参数**:
- `waveform_name`: 波形文件名
- `lod`: LoD (Level of Detail) 层级 0-20
- `start`: 第一个 tile 的起始时间
- `span`: 每个 tile 的时间跨度
- `num`: tile 数量（1-100）
- `compress`: 压缩算法（`none`, `zstd`, `lz4`）
- `signal_names`: 信号名称，逗号分隔多个信号

**示例**:
- 获取 10 个 tiles，每个 1000000 时间单位: `/api/wave/riscv2/lod/2/tile/0/1000000/10/compress/zstd/signals/b64:xxx/data`

**响应数据格式（二进制）**:

Tile-based API 返回 MultiTileChunk 格式：

```
+------------------+
| MultiTileHeader  | 40 bytes
| (多Tile文件头)    |
+------------------+
| TileOffsetTable  | 8 bytes × num_tiles
| (Tile偏移表)      |
+------------------+
| Tile 1 Data      | 变长 (标准 Chunk 格式)
| (Tile 1数据)      |
+------------------+
| Tile 2 Data      | 变长 (标准 Chunk 格式)
| (Tile 2数据)      |
+------------------+
| ...              |
+------------------+
| Tile N Data      | 变长 (标准 Chunk 格式)
| (Tile N数据)      |
+------------------+
```

**MultiTileHeader 结构（40字节）**:

| 偏移 | 大小 | 字段 | 说明 |
|------|------|------|------|
| 0 | 4B | magic | 魔数 0x57415449 ("WATI") |
| 4 | 2B | version | 版本号 (当前为 1) |
| 6 | 2B | lod | LoD 层级 |
| 8 | 4B | num_tiles | Tile 数量 |
| 12 | 8B | start_time | 起始时间 |
| 20 | 8B | tile_span | 每个 tile 的时间跨度 |
| 28 | 4B | signal_count | 信号数量 |
| 32 | 4B | reserved | 保留 |
| 36 | 4B | compression | 压缩类型 |

**TileOffsetEntry 结构（8字节）**:

| 偏移 | 大小 | 字段 | 说明 |
|------|------|------|------|
| 0 | 8B | offset | Tile 数据偏移量 |

**每个 Tile 的数据格式**: 与标准 Chunk 格式相同

**使用场景**:
- 波形查看器需要预加载多个视口的数据
- 分页显示大量波形数据
- 提高多段数据请求的吞吐量（减少 HTTP 请求次数）

---

#### 3.7 信号名编码格式

**支持两种编码格式**:

| 格式 | 说明 | 适用场景 |
|------|------|---------|
| `b64:` | 普通 Base64 编码 | 单个信号 |
| `trie:` | Trie 树压缩编码 | 多个信号（自动提取公共前缀） |

**Trie 压缩优势**:
- 自动提取公共前缀，减少 URL 长度
- 多个信号有公共前缀时压缩率更高
- CDN 缓存友好

**示例**:
```
原始信号列表:
tb_top.u_dut.sig1,tb_top.u_dut.sig2,tb_top.u_dut.sig3

Trie 压缩后:
前缀: tb_top.u_dut.
后缀: sig1,sig2,sig3

URL: /api/wave/riscv2/lod/0/signals/trie:base64encodedstring/data
```

**URL 对比**:

| 场景 | 原始长度 | Base64 编码 | Trie 压缩 | 节省 |
|------|---------|------------|-----------|------|
| 1 个信号 | ~20 chars | ~28 chars | ~28 chars | - |
| 3 个信号（有公共前缀） | ~60 chars | ~80 chars | ~40 chars | ~50% |
| 10 个信号（有公共前缀） | ~200 chars | ~268 chars | ~80 chars | ~70% |

**查询参数**:
- `time_stamp`: 可选，用于 CDN 缓存刷新（服务器不处理，建议从波形 info 的 `date` 字段获取）

**时间单位说明**:
- 时间参数的单位与波形文件的 `time_unit` 一致
- 例如：如果波形文件的 `time_unit` 为 "1ps"，则 `start=1000` 表示 1000ps

**请求头**:
- `Range`: 可选，支持断点续传（如 `bytes=0-1023`）

**响应**:
- 成功: 返回二进制波形数据（`Content-Type: application/octet-stream`）
- 带 Range: 返回 206 Partial Content

**响应头**:
- `Content-Length`: 数据长度
- `Content-Range`: 数据范围（如果有 Range 请求）
- `Accept-Ranges`: bytes
- `Cache-Control`: `public, max-age=3600, immutable`（CDN 缓存优化）

**响应数据格式（二进制）**:

服务器返回的二进制数据采用自定义 chunk 格式，结构如下：

```
+------------------+
|   ChunkHeader    | 32 bytes
|   (文件头)       |
+------------------+
| SignalBlockHeader| 17 bytes × 信号数
|   (信号块表)     |
+------------------+
| Compressed Data  |
|   (压缩数据区)   |
+------------------+
```

**ChunkHeader 结构（32字节）**:

| 偏移 | 大小 | 字段 | 说明 |
|------|------|------|------|
| 0 | 4B | magic | 魔数 0x57415645 ("WAVE") |
| 4 | 2B | version | 版本号 (当前为 1) |
| 6 | 2B | level | LoD 层级 |
| 8 | 4B | chunk_id | Chunk ID |
| 12 | 8B | time_start | 起始时间 |
| 20 | 8B | time_end | 结束时间 |
| 28 | 4B | signal_count | 信号数量 |

**SignalBlockHeader 结构（17字节）**:

| 偏移 | 大小 | 字段 | 说明 |
|------|------|------|------|
| 0 | 4B | signal_handle | 信号句柄 |
| 4 | 4B | time_array_offset | 时间数组偏移 |
| 8 | 4B | value_array_offset | 值数组偏移 |
| 12 | 4B | transition_count | 转换点数量（不包含 start value）|
| 16 | 1B | compression | 压缩类型 (0=无, 1=zstd, 2=lz4) |

**数据区格式（仿 FST 格式）**：

- **时间数组**: `[start_time, t0, t1, t2, ...]` (u64 数组，小端序)
  - 第一个元素 `start_time` 是特殊的 start value 时间戳（值为 0xFFFFFFFFFFFFFFFF）
  - 后续元素是实际的转换点时间戳
  - `transition_count` 只统计实际转换点数量，不包含 start value
- **值数组**: `[start_type, start_len, start_value..., type0, len0, value0..., ...]` (变长格式)
  - 第一个值是 start value（tile 起始时刻的信号值）
  - 后续值是实际转换点的值
  - `type`: u8，值类型 (0=Numeric, 1=String, 2=Real, 3=BinaryCompressed)
  - `len`: u16，值字节长度
  - `value`: 值字节数组

**值类型说明**:

| 类型 | 值 | 格式 | 说明 |
|------|-----|------|------|
| Numeric | 0 | ASCII 字符串 | "0", "1", "X", "Z", "b1010", "bX1Z0" |
| String | 1 | ASCII 字符串 | "Hello" (非 null-terminated) |
| Real | 2 | f64 (8 bytes) | IEEE 754 双精度浮点数 |
| BinaryCompressed | 3 | 二进制字节 | 紧凑二进制，MSB在前 |

**值存储示例**:

```
Numeric "b1010":
[type=0, len=6, "b", "1", "0", "1", "0"]
-> [0x00, 0x06, 0x00, 0x62, 0x31, 0x30, 0x31, 0x30]

String "Hello":
[type=1, len=5, "H", "e", "l", "l", "o"]
-> [0x01, 0x05, 0x00, 0x48, 0x65, 0x6C, 0x6C, 0x6F]

Real 3.14:
[type=2, len=8, f64_bytes...]
-> [0x02, 0x08, 0x00, ...8 bytes...]
```

**四态逻辑支持**:

- **0**: 逻辑 0
- **1**: 逻辑 1
- **X**: 未知状态
- **Z**: 高阻状态

LoD 降采样时遵循四态逻辑规则：
- 0 vs 1: min=0, max=1
- 任何值 vs X: 结果=X
- 任何值 vs Z: 结果=Z

---

**不同 LoD 的数据组织关系**:

| LoD | 数据组织 | 说明 |
|-----|---------|------|
| **LoD 0** | 原始转换点序列 | `[t0,v0], [t1,v1], [t2,v2], ...` |
| **LoD 1+** | Min/Max 降采样 | `[t0,min], [t0,max], [t1,min], [t1,max], ...` |

**LoD 1+ 数据特点**:
- **相同时间戳**: 同一个 bucket 的 min 和 max 有相同的时间戳
- **顺序存储**: 先存 min，再存 max（如果 min ≠ max）
- **扁平结构**: min 和 max 是独立的转换点，没有层级关系

**示例对比**:

```
原始数据 (LoD 0):
时间:  0    100   200   300   400   500   600   700
值:    0     1     0     1     1     0     1     0

LoD 1 (bucket_size=2):
时间:  0     0     200   200   400   400   600   600
值:    0(min) 1(max) 0(min) 1(max) 0(min) 1(max) 0(min) 1(max)
       └─ bucket 0 ─┘└─ bucket 1 ─┘└─ bucket 2 ─┘└─ bucket 3 ─┘

LoD 2 (bucket_size=4):
时间:  0     0     400   400
值:    0(min) 1(max) 0(min) 1(max)
       └─ bucket 0 ─┘└─ bucket 1 ─┘
```

**客户端解析规则（重要）**:

LoD 1+ 的 min/max 通过以下规则区分：
1. **按时间戳分组**：相同时间戳的 transition 属于同一个 bucket
2. **顺序规则**：每个时间戳的第一个值为 min，第二个值为 max（如果存在）
3. **数量判断**：
   - 1 个值：min = max（bucket 内值无变化）
   - 2 个值：第一个是 min，第二个是 max（bucket 内值有变化）

**边界值处理（重要）**:

当请求的时间范围内没有 transition 时，服务器会返回一个**起始边界值**，使用特殊时间戳标记：
- **特殊时间戳**：`0xFFFFFFFFFFFFFFFF` (u64::MAX)
- **含义**：该值表示请求时间范围起始点的信号值
- **用途**：客户端可以用这个值绘制水平线

```javascript
const BOUNDARY_TIME_START = 0xFFFFFFFFFFFFFFFFn;

// LoD 1+ 解析示例（包含边界值处理）
function parseLodTransitions(transitions) {
  const result = [];
  let boundaryValue = null;
  let i = 0;
  
  while (i < transitions.length) {
    const time = transitions[i].time;
    
    // 检查是否是边界值
    if (time === BOUNDARY_TIME_START) {
      boundaryValue = transitions[i].value;
      i++;
      continue;
    }
    
    const values = [];
    
    // 收集相同时间戳的所有值
    while (i < transitions.length && transitions[i].time === time) {
      values.push(transitions[i].value);
      i++;
    }
    
    // 解析 min/max
    if (values.length === 1) {
      result.push({ time, min: values[0], max: values[0] });
    } else {
      // 依赖顺序：第一个是 min，第二个是 max
      result.push({ time, min: values[0], max: values[1] });
    }
  }
  
  return { transitions: result, boundaryValue };
}

// 绘制波形（考虑边界值）
function drawWaveform(canvas, parsedData, timeRange) {
  const { transitions, boundaryValue } = parsedData;
  const [startTime, endTime] = timeRange;
  
  if (transitions.length === 0 && boundaryValue !== null) {
    // 没有 transition，使用边界值绘制水平线
    drawHorizontalLine(canvas, startTime, endTime, boundaryValue);
  } else {
    // 正常绘制 transitions
    for (const trans of transitions) {
      drawTransition(canvas, trans);
    }
  }
}
```

**客户端处理建议**:
- LoD 0: 直接绘制每个转换点
- LoD 1+: 按时间戳分组，相同时间戳的取 min 和 max 绘制为垂直线段

**示例**:
```bash
# 获取完整波形数据（end="-" 表示到文件结束）
curl "http://localhost:8080/api/wave/riscv2/lod/0/time/0/-/compress/none/signals/b64:Y2xr/data"

# 获取指定时间范围的波形数据（LoD 2，zstd 压缩）
curl "http://localhost:8080/api/wave/riscv2/lod/2/time/0/1000000/compress/zstd/signals/b64:Y2xr/data" -o clk.zst

# 获取带时间戳的波形数据（用于 CDN 缓存刷新）
curl "http://localhost:8080/api/wave/riscv2/lod/0/time/0/1000000/compress/none/signals/b64:Y2xr/data?time_stamp=1772690121"

# 获取 KDB 列表（带 checksum 用于 CDN 缓存）
curl "http://localhost:8080/api/kdb?checksum=abc123"
```

**客户端解析示例（JavaScript）**:
```javascript
// 解析 chunk 数据
function parseWaveChunk(buffer) {
  const view = new DataView(buffer);
  
  // 解析 ChunkHeader
  const header = {
    magic: view.getUint32(0, true),
    version: view.getUint16(4, true),
    level: view.getUint16(6, true),  // LoD 层级
    chunk_id: view.getUint32(8, true),
    time_start: view.getBigUint64(12, true),
    time_end: view.getBigUint64(20, true),
    signal_count: view.getUint32(28, true)
  };
  
  // 解析 SignalBlockHeader
  let offset = 32;
  const signals = [];
  for (let i = 0; i < header.signal_count; i++) {
    signals.push({
      handle: view.getUint32(offset, true),
      time_offset: view.getUint32(offset + 4, true),
      value_offset: view.getUint32(offset + 8, true),
      transition_count: view.getUint32(offset + 12, true),
      compression: view.getUint8(offset + 16)
    });
    offset += 17;
  }
  
  return { header, signals };
}

// 处理 LoD 1+ 的 min/max 数据（按时间戳分组）
function groupTransitionsByTime(transitions) {
  const groups = new Map();
  
  for (const trans of transitions) {
    if (!groups.has(trans.time)) {
      groups.set(trans.time, []);
    }
    groups.get(trans.time).push(trans.value);
  }
  
  // 返回 [{time, min, max}, ...]
  return Array.from(groups.entries()).map(([time, values]) => ({
    time,
    min: values.length > 0 ? values[0] : null,
    max: values.length > 1 ? values[1] : values[0]
  }));
}

// 绘制波形（考虑 LoD）
function drawWaveform(canvas, header, transitions) {
  if (header.level === 0) {
    // LoD 0: 直接绘制每个转换点
    for (let i = 0; i < transitions.length - 1; i++) {
      drawSegment(canvas, transitions[i], transitions[i + 1]);
    }
  } else {
    // LoD 1+: 按时间戳分组，绘制 min/max
    const groups = groupTransitionsByTime(transitions);
    for (const group of groups) {
      drawMinMaxSegment(canvas, group.time, group.min, group.max);
    }
  }
}
```

---

## 错误处理

### 错误响应格式

```json
{
  "status": "error",
  "data": null,
  "error": "错误描述信息"
}
```

### HTTP 状态码

| 状态码 | 描述 |
|--------|------|
| 200 OK | 请求成功 |
| 206 Partial Content | 部分数据返回（Range 请求） |
| 400 Bad Request | 请求参数错误 |
| 404 Not Found | 资源不存在 |
| 416 Range Not Satisfiable | Range 请求无效 |
| 500 Internal Server Error | 服务器内部错误 |

### 常见错误

| 错误信息 | 说明 |
|----------|------|
| KDB file not found | 知识库文件不存在 |
| Wave file not found | 波形文件不存在 |
| Signal not found | 信号不存在 |
| Invalid LoD level | LoD 层级无效（必须在 0-32 范围内） |
| Invalid time range | 时间范围无效 |
| Invalid parameter | 请求参数无效 |

---

## 缓存策略

### 客户端缓存建议

1. **使用 modified_time 和 checksum**: 
   - 比较服务器返回的 `modified_time` 或 `checksum` 与本地缓存
   - 如果一致，直接使用本地缓存
   - 如果不一致，重新下载

2. **缓存键设计**:
   ```
   kdb:{name}:checksum -> {checksum}
   wave:{name}:checksum -> {checksum}
   wave:{name}:{signal}:lod:{lod}:{start}:{end} -> {data}
   ```

3. **缓存失效策略**:
   - 定期轮询 `/api/kdb` 和 `/api/wave/list` 检查文件更新
   - 或使用文件监控机制

---

## 性能优化

### 1. LoD (Level of Detail)

使用 `lod` 参数获取不同精度的波形数据。

**LoD 工作原理：**

LoD 是基于**时间**的降采样，每个 bucket 覆盖固定的时间范围：

| LoD Level | Bucket Size (时间单位) | 说明 |
|-----------|------------------------|------|
| 0 | 1 | **原始数据**，不做任何处理 |
| 1 | 2 | 每个 bucket 覆盖 2 时间单位 |
| 2 | 4 | 每个 bucket 覆盖 4 时间单位 |
| 3 | 8 | 每个 bucket 覆盖 8 时间单位 |
| 4 | 16 | 每个 bucket 覆盖 16 时间单位 |
| 5 | 32 | 每个 bucket 覆盖 32 时间单位 |
| 6 | 64 | 每个 bucket 覆盖 64 时间单位 |
| 7 | 128 | 每个 bucket 覆盖 128 时间单位 |
| 8 | 256 | 每个 bucket 覆盖 256 时间单位 |
| 9 | 512 | 每个 bucket 覆盖 512 时间单位 |
| 10 | 1,024 | 每个 bucket 覆盖 1024 时间单位 |
| 11 | 2,048 | 每个 bucket 覆盖 2048 时间单位 |
| 12 | 4,096 | 每个 bucket 覆盖 4096 时间单位 |
| 13 | 8,192 | 每个 bucket 覆盖 8192 时间单位 |
| 14 | 16,384 | 每个 bucket 覆盖 16384 时间单位 |
| 15 | 32,768 | 每个 bucket 覆盖 32768 时间单位 |
| 16 | 65,536 | 每个 bucket 覆盖 65536 时间单位 |
| 17 | 131,072 | 每个 bucket 覆盖 ~13万 时间单位 |
| 18 | 262,144 | 每个 bucket 覆盖 ~26万 时间单位 |
| 19 | 524,288 | 每个 bucket 覆盖 ~52万 时间单位 |
| 20 | 1,048,576 | 每个 bucket 覆盖 ~100万 时间单位 |
| 21 | 2,097,152 | 每个 bucket 覆盖 ~200万 时间单位 |
| 22 | 4,194,304 | 每个 bucket 覆盖 ~400万 时间单位 |
| 23 | 8,388,608 | 每个 bucket 覆盖 ~800万 时间单位 |
| 24 | 16,777,216 | 每个 bucket 覆盖 ~1600万 时间单位 |
| 25 | 33,554,432 | 每个 bucket 覆盖 ~3300万 时间单位 |
| 26 | 67,108,864 | 每个 bucket 覆盖 ~6700万 时间单位 |
| 27 | 134,217,728 | 每个 bucket 覆盖 ~1.3亿 时间单位 |
| 28 | 268,435,456 | 每个 bucket 覆盖 ~2.7亿 时间单位 |
| 29 | 536,870,912 | 每个 bucket 覆盖 ~5.4亿 时间单位 |
| 30 | 1,073,741,824 | 每个 bucket 覆盖 ~10亿 时间单位 |
| 31 | 2,147,483,648 | 每个 bucket 覆盖 ~21亿 时间单位 |
| 32 | 4,294,967,296 | 每个 bucket 覆盖 ~43亿 时间单位 |

**重要说明：**
- **LoD 0** 使用 FST 文件的**原始数据**，不做任何降采样
- **LoD 1+** 使用 **First/Last Bucket** 算法进行降采样
- 每个 bucket 覆盖固定的时间范围 `[bucket_start, bucket_end]`
- Bucket 大小计算公式: `2^level`
- **Tile 起始对齐规则**（重要！）：
  - LoD 1+ 生成时，tile 起始时间必须对齐到 bucket 大小
  - 对齐公式：`aligned_start = (tile_start / bucket_size) * bucket_size`
  - 使用对齐后的范围 `[aligned_start, tile_end]` 来计算 buckets
  - Bucket 数量使用向上取整：`total_buckets = ceil((tile_end - aligned_start) / bucket_size)`
  - 这样确保即使 tile 完全在单个 bucket 内，也能正确计算
- **First/Last 输出规则**: 
  - 当 bucket 内只有一个 transition 时，只输出 1 个记录（first = last）
  - 当 bucket 内有多个 transitions 时，输出 2 个记录：first 和 last
  - **重要**：输出 2 个记录的条件是 **first 和 last 的时间不同**（即 bucket 内有多个不同时间的 transitions），而不是值不同
  - 时间戳使用 bucket offset（从 0 开始计数），表示 bucket 在 tile 中的位置
- **Start Value 处理**:
  - **Start Value**: 请求时间范围起始点之前的最近一个值（向前搜索）
  - Start Value 使用特殊时间戳 `0xFFFFFFFFFFFFFFFF` (BOUNDARY_TIME_START)
  - **保证每个返回的 chunk 都有 Start Value**：即使请求时间范围在波形开始点（如 time=0），也会返回默认值 'X'
  - **默认值 'X'**：1-bit 信号返回 `"X"`，n-bit 信号返回 `"bXXX...X"` (n 个 X)
  - **重要**：Start Value **不参与 bucket 计算**，它只是作为 tile 起始点的参考值单独输出
- **数据格式**:
  ```
  [Start Value] (time=BOUNDARY_TIME_START, value=tile_start之前的最近值)
  
  每个 bucket (LoD 1+):
    [first] (time=bucket_offset, value=bucket内第一个transition的值)
    [last] (time=bucket_offset, value=bucket内最后一个transition的值, 如果 bucket 内有多个 transitions)
  ```
- **空 bucket 处理**：
  - 如果 bucket 内没有任何 transitions，不输出任何记录
  - 客户端应使用上一个有数据的 bucket 的 last 值绘制
  - 如果没有上一个 bucket，使用 Start Value
- **客户端绘制建议**:
  - 只有一个 transition（first=last）：画稳定值
  - 多个 transitions（first≠last，时间不同）：画 toggling 图案（如斜线填充）
  - 空 bucket：延续上一个 bucket 的 last 值（或 Start Value）
- **Start Value 搜索算法**:
  - 使用二分法查找最小有记录的区域
  - 为每个信号单独搜索最小区域
  - 找到所有信号的公有最小区域（取并集）
  - 在公有最小区域内对所有信号确认最终值
  - 多信号处理时，最小范围二分搜索和最终结果搜索都是对多个信号一起进行

**使用建议：**
- `lod=0`: 需要完整精度时使用（如放大查看细节）
- `lod=4-6`: 适合正常查看波形（平衡精度和性能）
- `lod=8-10`: 适合远距离查看波形趋势（高级压缩）
- `lod=15-20`: 适合超大规模数据的概览（极高级压缩）
- `lod=21-27`: 适合亿级数据量的极端压缩场景
- `lod=28-32`: 适合十亿级以上数据的极粗略概览

### 2. 压缩

使用 `compress` 参数减少数据传输：
- `zstd`: 压缩率高，适合网络传输
- `lz4`: 压缩速度快，适合实时场景

### 3. HTTP Range

使用 Range 请求实现：
- 断点续传
- 分块加载
- 懒加载

---

## 使用示例

### 完整工作流程

```javascript
// 1. 获取波形列表
const waves = await fetch('/api/wave/list').then(r => r.json());

// 2. 选择波形并获取信号列表
const signals = await fetch('/api/wave/riscv2/signals').then(r => r.json());

// 3. 获取波形 info（用于获取 time_stamp）
const waveInfo = await fetch('/api/wave/riscv2/info').then(r => r.json());
const timeStamp = Date.parse(waveInfo.data.wave_info.date); // 从 date 字段获取时间戳

// 4. 编码信号名（Base64）
const signalName = 'clk';
const encodedSignal = 'b64:' + btoa(signalName);

// 5. 获取特定信号的波形数据（LoD 2，zstd 压缩，带 time_stamp 用于 CDN 缓存）
const waveData = await fetch(
  `/api/wave/riscv2/lod/2/time/0/1000000/compress/zstd/signals/${encodedSignal}/data?time_stamp=${timeStamp}`
).then(r => r.arrayBuffer());

// 6. 解压数据（如果是压缩的）
const decompressed = await decompress(waveData, 'zstd');
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-03-03 | 初始版本 |
