# HWDA Server - 硬件设计分析器数据服务器

这是一个基于 Rust + Axum 构建的高性能 HTTP 服务器，用于硬件设计分析工具提供数据服务。

## 项目结构

```
server/
├── Cargo.toml              # 项目依赖配置
├── README.md               # 本文件
└── src/
    ├── main.rs             # 程序入口
    ├── lib.rs              # 库导出
    ├── config.rs           # 服务器配置
    ├── error.rs            # 错误处理
    ├── state.rs            # 服务器状态管理
    ├── handlers/           # HTTP 请求处理器
    │   ├── mod.rs
    │   ├── kdb_handler.rs  # 知识库 API 处理
    │   ├── wave_handler.rs # 波形数据 API 处理
    │   └── stats_handler.rs# 统计信息处理
    ├── services/           # 业务逻辑层
    │   ├── mod.rs
    │   ├── kdb_service.rs  # 知识库服务
    │   └── wave_service.rs # 波形数据服务
    └── middleware/         # 中间件
        ├── mod.rs
        ├── auth.rs         # 认证中间件
        └── logging.rs      # 日志中间件
```

## 核心功能

### 1. 知识库服务 (KDB Service)
- 知识库文件管理
- 元数据查询
- HTTP Range 下载支持

### 2. 波形数据服务 (Wave Service)
- FST 波形文件读取
- LoD (Level of Detail) 层级支持
- 信号元数据查询
- HTTP Range 分块传输

### 3. 服务器特性
- 多级缓存 (内存 LRU)
- CORS 支持
- 认证中间件 (Bearer Token / API Key)
- 请求日志
- 速率限制
- 请求体大小限制

## API 接口

### 健康检查
```
GET /health
```

### 统计信息
```
GET /stats
GET /config
```

### 知识库 API
```
GET /api/kdb                    # 获取知识库列表
GET /api/kdb/:name              # 获取知识库元信息
GET /api/kdb/:name/file         # 下载知识库文件 (支持 Range)
```

### 波形数据 API
```
GET /api/wave/list              # 获取波形文件列表
GET /api/wave/:waveform_name/signals?name_regex=<pattern>&handle_from=<n>&handle_to=<n>&limit=<n>&offset=<n>  # 获取信号列表（支持过滤和分页）
GET /api/wave/:waveform_name/signals/:signal_name/data?lod=N&start=T1&end=T2&compress=<algo>  # 获取波形数据（支持LoD、压缩）
```

### 静态文件服务
```
GET /                           # 访问 Web 客户端（如果配置了 --web-dir）
GET /*                          # 静态文件（自动从 web-dir 提供）
```

## 启动参数

```bash
# 基本启动
cargo run -- --kdb-dir ./kdb --wave-dir ./waves --port 8080

# 同时提供 Web 客户端静态文件服务
hwda-server --kdb-dir ./kdb --wave-dir ./waves --web-dir ./web-client/dist --port 8080

# 完整参数
cargo run -- \
  --kdb-dir ./kdb \
  --wave-dir ./waves \
  --web-dir ./web-client/dist \
  --port 8080 \
  --host 0.0.0.0 \
  --log-level info \
  --enable-cors true \
  --cors-origin "*" \
  --max-connections 1000 \
  --cache-capacity-mb 512 \
  --chunk-size-kb 64 \
  --enable-auth false \
  --auth-token "your-token" \
  --rate-limit 100 \
  --fst-backend fstapi
```

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--kdb-dir` | 知识库文件目录 | `./kdb` |
| `--wave-dir` | 波形文件目录 | `./waves` |
| `--web-dir` | Web 客户端静态文件目录（可选） | - |
| `--port` | 服务端口 | `8080` |
| `--host` | 绑定地址 | `0.0.0.0` |
| `--log-level` | 日志级别 | `info` |
| `--enable-cors` | 启用 CORS | `true` |
| `--cors-origin` | CORS 来源 | `*` |
| `--max-connections` | 最大并发连接数 | `1000` |
| `--cache-capacity-mb` | LRU 缓存容量 (MB) | `512` |
| `--chunk-size-kb` | 数据块大小 (KB) | `64` |
| `--enable-auth` | 启用认证 | `false` |
| `--auth-token` | 认证令牌 | - |
| `--rate-limit` | 速率限制 (请求/秒) | `100` |
| `--fst-backend` | FST 读取后端 (`fstapi`/`wavefst`) | `fstapi` |

## 开发指南

### 添加新的 API 端点

1. 在 `handlers/` 目录下创建新的处理器文件
2. 在 `handlers/mod.rs` 中导出处理器
3. 在 `create_router()` 函数中添加路由

### 添加新的服务

1. 在 `services/` 目录下创建新的服务文件
2. 实现业务逻辑
3. 在 `services/mod.rs` 中导出服务

### 错误处理

使用统一的错误类型 `ServerError`:

```rust
use crate::error::{Result, ServerError};

async fn my_handler() -> Result<Json<Value>> {
    // 业务逻辑
    Ok(Json(success(data)))
}
```

### 缓存使用

```rust
// 存入缓存
state.wave_chunk_cache
    .insert(key, Arc::new(data))
    .await;

// 从缓存读取
if let Some(cached) = state.wave_chunk_cache.get(&key).await {
    // 缓存命中
}
```

## 性能优化

### 已实现
- ✅ 内存 LRU 缓存
- ✅ HTTP Range 分块传输
- ✅ 异步 IO (tokio)
- ✅ 零拷贝数据传输 (bytes)

### 待实现
- ⏳ LoD 数据预计算和缓存
- ⏳ OPFS 持久化缓存
- ⏳ 更高效的波形数据降采样算法

## 测试

```bash
# 运行所有测试
cargo test

# 运行特定测试
cargo test test_health_check

# 带输出运行
cargo test -- --nocapture
```

## 构建发布版本

```bash
cargo build --release
```

## 依赖说明

### 核心依赖
- `axum` - Web 框架
- `tokio` - 异步运行时
- `tower-http` - 中间件
- `serde` - 序列化
- `wavefst` - FST 波形解析

### 工具库
- `clap` - 命令行参数解析
- `tracing` - 日志
- `thiserror` - 错误处理
- `moka` - 缓存

## 后续开发计划

1. **波形解析集成** - 完成 wavefst 库的集成，实现 FST 文件读取
2. **LoD 算法** - 实现多分辨率降采样算法
3. **OPFS 缓存** - 实现本地持久化缓存层
4. **性能优化** - 性能分析和优化
5. **文档完善** - API 文档和使用指南

## 许可证

MIT License
