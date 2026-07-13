# HWDA Server 架构文档

## 概述

HWDA Server 是一个为硬件设计分析工具提供数据服务的高性能 HTTP 服务器。它采用 Rust + Axum 技术栈，遵循 RESTful API 设计规范，支持 HTTP Range 分块传输和 LoD (Level of Detail) 多分辨率数据。

## 设计原则

1. **性能优先**: 使用异步 IO、零拷贝传输、多级缓存
2. **模块化**: 清晰的分层架构，便于维护和扩展
3. **可靠性**: 完善的错误处理、类型安全
4. **可扩展性**: 预留扩展点，支持未来功能增强

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Client (Web Browser)                    │
│                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐ │
│  │   wHDL Module  │  │  wSignal Module│  │ Knowledge Mgr  │ │
│  └────────────────┘  └────────────────┘  └────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ HTTP/1.1 + Range Requests
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    HWDA Data Server (Rust)                   │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              HTTP Layer (Axum + Tower)                 │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐            │ │
│  │  │   CORS   │  │  Auth    │  │ Logging  │            │ │
│  │  └──────────┘  └──────────┘  └──────────┘            │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Handler Layer (路由处理器)                 │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │ │
│  │  │ KDB Handler  │  │ Wave Handler │  │ Stats Handler│ │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Service Layer (业务逻辑)                   │ │
│  │  ┌──────────────┐  ┌──────────────┐                   │ │
│  │  │ KdbService   │  │ WaveService  │                   │ │
│  │  └──────────────┘  └──────────────┘                   │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Data Layer (数据访问)                      │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │ │
│  │  │ LRU Cache    │  │ File System  │  │ wavefst Lib  │ │ │
│  │  │ (Moka)       │  │ (KDB/FST)    │  │ (待集成)      │ │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Persistent Storage                        │
│                                                              │
│  ┌──────────────────┐         ┌──────────────────┐         │
│  │  KDB Directory   │         │ Wave Directory   │         │
│  │  (*.kdb files)   │         │ (*.fst files)    │         │
│  └──────────────────┘         └──────────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

## 模块划分

### 1. HTTP 层 (HTTP Layer)

**职责**: 处理 HTTP 协议相关功能

- **CORS 中间件**: 跨域请求处理
- **认证中间件**: Bearer Token / API Key 验证
- **日志中间件**: 请求/响应日志记录
- **限流中间件**: 请求速率限制
- **请求体限制**: 防止过大请求

**文件**: `src/middleware/`

### 2. 处理器层 (Handler Layer)

**职责**: 处理 HTTP 请求，解析参数，构建响应

**主要处理器**:

- `kdb_handler.rs`: 知识库相关 API
  - `list_kdbs()`: 获取知识库列表
  - `get_kdb_info()`: 获取知识库元信息
  - `get_kdb_file()`: 下载知识库文件 (支持 Range)

- `wave_handler.rs`: 波形数据相关 API
  - `list_waves()`: 获取波形文件列表
  - `list_wave_signals()`: 获取信号列表
  - `get_signal_info()`: 获取信号元信息
  - `get_wave_data()`: 获取波形数据 (支持 Range + LoD)

- `stats_handler.rs`: 服务器状态相关 API
  - `health_check()`: 健康检查
  - `get_stats()`: 获取统计信息
  - `get_config()`: 获取配置信息

**文件**: `src/handlers/`

### 3. 服务层 (Service Layer)

**职责**: 实现核心业务逻辑

**主要服务**:

- **KdbService**: 知识库服务
  - 知识库文件管理
  - 元数据查询
  - HTTP Range 读取

- **WaveService**: 波形数据服务
  - FST 文件读取
  - LoD 层级选择
  - 信号元数据查询
  - 波形数据裁剪

**文件**: `src/services/`

### 4. 状态层 (State Layer)

**职责**: 管理服务器共享状态

**主要组件**:

- **ServerState**: 服务器状态容器
  - 配置信息 (ServerConfig)
  - 缓存系统 (KDB/Wave/Source Cache)
  - 统计信息 (ServerStats)

- **缓存系统**:
  - KDB 元数据缓存 (100 条目)
  - 波形元数据缓存 (1000 条目)
  - 波形数据块缓存 (256MB)
  - 源文件缓存 (128MB)

**文件**: `src/state.rs`

### 5. 数据层 (Data Layer)

**职责**: 数据持久化和访问

**存储介质**:

- **文件系统**: KDB 和 FST 文件存储
- **内存缓存**: Moka LRU 缓存
- **wavefst 库**: FST 格式解析 (待集成)

## 数据流

### 知识库下载流程

```
Client                              Server
  │                                   │
  │── GET /api/kdb/top ──────────────>│
  │                                   │
  │<── 200 OK + metadata ─────────────│
  │                                   │
  │── GET /api/kdb/top/file ─────────>│
  │   Range: bytes=0-65535            │
  │                                   │
  │<── 206 Partial Content ───────────│
  │   Content-Range: bytes 0-65535/...│
  │   [64KB data]                     │
  │                                   │
  │── GET /api/kdb/top/file ─────────>│
  │   Range: bytes=65536-131071       │
  │                                   │
  │<── 206 Partial Content ───────────│
  │   [next 64KB data]                │
  │                                   │
```

### 波形数据获取流程

```
Client                              Server
  │                                   │
  │── GET /api/wave/top/clk ─────────>│
  │   ?lod=2&start=0&end=1000000      │
  │                                   │
  │   [检查缓存]                      │
  │                                   │
  │   [Cache Miss]                    │
  │                                   │
  │   [读取 FST 文件]                   │
  │   [LoD 降采样]                     │
  │   [时间裁剪]                      │
  │                                   │
  │   [存入缓存]                      │
  │                                   │
  │<── 200 OK + waveform data ────────│
  │                                   │
```

## API 设计

### RESTful 规范

所有 API 遵循 RESTful 设计原则:

- **资源导向**: `/api/kdb`, `/api/wave`
- **HTTP 方法**: 主要使用 GET
- **状态码**: 
  - 200: 成功
  - 206: Partial Content (Range 请求)
  - 400: Bad Request (参数错误)
  - 404: Not Found (资源不存在)
  - 401: Unauthorized (认证失败)
  - 500: Internal Server Error

### 统一响应格式

**成功响应**:
```json
{
  "status": "success",
  "data": { ... },
  "error": null
}
```

**错误响应**:
```json
{
  "status": "error",
  "data": null,
  "error": {
    "code": "SIGNAL_NOT_FOUND",
    "message": "信号 'top.clk' 不存在"
  }
}
```

### 错误码定义

| 错误码 | 说明 | HTTP 状态码 |
|--------|------|------------|
| `KDB_NOT_FOUND` | 知识库不存在 | 404 |
| `KDB_CORRUPTED` | 知识库损坏 | 500 |
| `WAVEFORM_NOT_FOUND` | 波形文件不存在 | 404 |
| `SIGNAL_NOT_FOUND` | 信号不存在 | 404 |
| `INVALID_LOD` | 无效的 LoD 层级 | 400 |
| `INVALID_TIME_RANGE` | 无效的时间范围 | 400 |
| `RANGE_NOT_SUPPORTED` | 不支持 Range 请求 | 416 |
| `INTERNAL_ERROR` | 内部错误 | 500 |

## 缓存策略

### 三级缓存架构

```
┌─────────────────────────────────────┐
│  L1: Memory Cache (热数据)           │
│  - 容量：512MB                       │
│  - 淘汰策略：LRU                     │
│  - 访问延迟：<1ms                    │
│  - 存储：渲染就绪的波形数据          │
└─────────────────────────────────────┘
              │
              │ Cache Miss
              ▼
┌─────────────────────────────────────┐
│  L2: OPFS (温数据) [待实现]          │
│  - 容量：10-50GB                     │
│  - 淘汰策略：LRU + TTL               │
│  - 访问延迟：<10ms                   │
│  - 存储：波形数据块、FST chunks      │
└─────────────────────────────────────┘
              │
              │ Cache Miss
              ▼
┌─────────────────────────────────────┐
│  L3: Server Storage (冷数据)         │
│  - 容量：无限制                      │
│  - 访问延迟：>10ms                   │
│  - 存储：完整 FST 文件、源文件         │
└─────────────────────────────────────┘
```

### 缓存键设计

```rust
// 波形数据块缓存键
cache_key = format!(
    "{}:{}:{}:{}:{}",
    waveform_name, signal_name, lod, start_time, end_time
)

// 元数据缓存键
cache_key = waveform_name  // 或 kdb_name
```

## 性能优化

### 已实现

1. **异步 IO**: 使用 tokio 异步运行时
2. **零拷贝**: 使用 `bytes::Bytes` 减少内存复制
3. **LRU 缓存**: Moka 高性能并发缓存
4. **HTTP Range**: 支持断点续传和分块下载
5. **CORS 预检缓存**: 减少跨域请求开销

### 待实现

1. **wavefst 集成**: FST 文件高效解析
2. **LoD 预计算**: 构建时生成多分辨率数据
3. **OPFS 持久化**: 浏览器端持久缓存
4. **降采样算法**: min/max bucket 等
5. **性能监控**: Prometheus 指标收集

## 安全考虑

### 认证机制

支持两种认证方式:

1. **Bearer Token**: 
   ```
   Authorization: Bearer <token>
   ```

2. **API Key**:
   ```
   X-API-Key: <api_key>
   或
   ?api_key=<api_key>
   ```

### 速率限制

- 默认：100 请求/秒
- 可配置：`--rate-limit <requests_per_second>`

### 请求体限制

- 默认：缓存容量的 10%
- 防止大请求攻击

## 扩展点

### 添加新的 API

1. 在 `handlers/` 创建新的处理器
2. 在 `handlers/mod.rs` 导出
3. 在 `create_router()` 添加路由

### 添加新的数据源

1. 实现新的 Service
2. 添加对应的 Handler
3. 更新路由配置

### 添加中间件

1. 在 `middleware/` 创建新中间件
2. 在 `create_router()` 中应用

## 测试策略

### 单元测试

- 每个模块都有对应的测试
- 使用 `#[cfg(test)]` 标记
- 运行：`cargo test`

### 集成测试

- 测试完整的 HTTP 请求流程
- 使用 `tower::ServiceExt` 模拟请求

### 性能测试

- 待实现
- 计划使用 `wrk` 或 `ab` 工具

## 部署建议

### 开发环境

```bash
cargo run -- --kdb-dir ./kdb --wave-dir ./waves
```

### 生产环境

```bash
# 构建发布版本
cargo build --release

# 配置环境变量
export RUST_LOG=info
export HWDA_KDB_DIR=/data/kdb
export HWDA_WAVE_DIR=/data/waves

# 启动服务
./target/release/what-server \
  --kdb-dir /data/kdb \
  --wave-dir /data/waves \
  --port 8080 \
  --host 0.0.0.0 \
  --enable-auth true \
  --auth-token "secure-token" \
  --rate-limit 1000
```

### Docker 部署 (待实现)

```dockerfile
FROM rust:1.75 as builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/what-server /usr/local/bin/
CMD ["what-server"]
```

## 监控和日志

### 日志级别

- `trace`: 详细调试信息
- `debug`: 调试信息
- `info`: 一般信息
- `warn`: 警告
- `error`: 错误

### 日志格式

```
2024-01-01T12:00:00.000000Z  INFO what_server: 请求：GET /api/kdb
2024-01-01T12:00:00.001000Z  INFO what_server: 响应：GET /api/kdb 200 OK - 1ms
```

## 未来规划

### Phase 1 (当前)
- ✅ 基础架构搭建
- ✅ HTTP Range 支持
- ✅ 缓存系统
- ⏳ FST 解析集成

### Phase 2
- LoD 算法实现
- OPFS 持久化
- 性能优化

### Phase 3
- WebSocket 支持
- 实时数据推送
- 分布式缓存

## 参考资料

- [Axum 文档](https://docs.rs/axum/)
- [Tokio 文档](https://tokio.rs/)
- [wavefst 文档](https://docs.rs/wavefst/)
- [Moka 缓存](https://docs.rs/moka/)
