# HWDA Server API 文档

硬件设计分析器数据服务器 (Hardware Design Analyzer Data Server) API 文档。

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

### 2. 知识库 (KDB) API

#### 2.1 获取知识库列表

```http
GET /api/kdb
```

**描述**: 获取所有可用的知识库文件列表，包含缓存验证元数据

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
      "end_time": 14277227000,
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
- `start_time`: 起始时间（飞秒 fs）
- `end_time`: 结束时间（飞秒 fs）
- `time_unit`: 时间单位
- `time_precision`: 时间精度
- `version`: 波形文件版本/生成工具
- `date`: 生成日期

**注意**: 所有时间值都以**飞秒 (fs)** 为单位，这是服务器内部处理的最小时间精度。

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

#### 3.5 获取波形数据

```http
GET /api/wave/{waveform_name}/signals/{signal_name}/data
```

**描述**: 获取指定信号的波形数据，支持 LoD、压缩和 HTTP Range

**路径参数**:
- `waveform_name`: 波形文件名
- `signal_name`: 信号名称（URL 编码）

**查询参数**:
- `lod`: 可选，LoD (Level of Detail) 层级 0-11，默认 0
- `start`: 可选，起始时间（飞秒 fs），默认 0
- `end`: 可选，结束时间（飞秒 fs），默认文件结束时间
- `compress`: 可选，压缩算法（"none", "zstd", "lz4"），默认 "none"

**时间单位说明**:
- API 使用**飞秒 (fs, femtoseconds)** 作为时间单位
- 1 fs = 10^-15 秒
- 服务器会自动将 fs 转换为 FST 文件内部的时间单位
- 支持的最小时间精度为 1 fs

**请求头**:
- `Range`: 可选，支持断点续传（如 `bytes=0-1023`）

**响应**:
- 成功: 返回二进制波形数据（`Content-Type: application/octet-stream`）
- 带 Range: 返回 206 Partial Content

**响应头**:
- `Content-Length`: 数据长度
- `Content-Range`: 数据范围（如果有 Range 请求）
- `Accept-Ranges`: bytes

**示例**:
```bash
# 获取完整波形数据
curl "http://localhost:8080/api/wave/riscv2/signals/clk/data"

# 获取指定时间范围的波形数据（LoD 2）
curl "http://localhost:8080/api/wave/riscv2/signals/clk/data?lod=2&start=0&end=1000000"

# 获取压缩的波形数据
curl "http://localhost:8080/api/wave/riscv2/signals/clk/data?compress=zstd" -o clk.zst
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
| Invalid LoD level | LoD 层级无效（必须在 0-11 范围内） |
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

LoD 是基于**数据点数量**的降采样，与时间窗口无关：

| LoD Level | Bucket Size | 数据压缩率 | 说明 |
|-----------|-------------|-----------|------|
| 0 | 1 | 1:1 | **原始数据**，不做任何处理 |
| 1 | 2 | 2:1 | 每 2 个转换点合并为 min/max |
| 2 | 4 | 4:1 | 每 4 个转换点合并为 min/max |
| n | 2^n | 2^n:1 | 每 2^n 个转换点合并为 min/max |
| 10 | 1024 | 1024:1 | 每 1024 个转换点合并为 min/max |
| 11 | 2048 | 2048:1 | 最大压缩层级 |

**重要说明：**
- **LoD 0** 使用 FST 文件的**原始数据**，不做任何降采样
- **LoD 1+** 使用 **Min/Max Bucket** 算法进行降采样
- 时间值**保持不变**，只减少转换点的数量
- 每个 bucket 保留该时间段内的最小值和最大值，确保波形特征不丢失

**使用建议：**
- `lod=0`: 需要完整精度时使用（如放大查看细节）
- `lod=2-5`: 适合正常查看波形（平衡精度和性能）
- `lod=8-11`: 适合远距离查看波形趋势（最大压缩）

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

// 3. 获取特定信号的波形数据（LoD 2，压缩）
const waveData = await fetch(
  '/api/wave/riscv2/signals/clk/data?lod=2&compress=zstd'
).then(r => r.arrayBuffer());

// 4. 解压数据（如果是压缩的）
const decompressed = await decompress(waveData, 'zstd');
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-03-03 | 初始版本 |
