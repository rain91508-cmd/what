# Server 信号波形数据获取实现 Checklist

基于 hint3.md 和 spec.md 的规范，检查 server 端实现情况。

## 一、OPFS 数据结构（Warm 层）

### 1.1 目录结构
- [x] **meta.json** - 波形元数据（<10KB）
  - 位置：`wave_data.rs` 中的 `ChunkHeader` 结构
  - 状态：✅ 已实现（32字节二进制头）
  
- [x] **signals.bin** - 信号表（紧凑二进制）
  - 位置：`wave_data.rs` 中的 `SignalBlockHeader` 结构
  - 状态：✅ 已实现

- [x] **level_X/chunk_*.bin** - 时间分块数据
  - 位置：`wave_data.rs` 中的 `ChunkSerializer`
  - 状态：✅ 已实现

### 1.2 Chunk 文件头（32字节）
- [x] 魔数 'WAVE' (0x57415645)
- [x] 版本号
- [x] LoD 层级
- [x] Chunk ID
- [x] 起始时间
- [x] 结束时间
- [x] 信号数量

**代码位置**: `server/src/services/wave_data.rs:210-284`

## 二、Chunk 内部数据布局

### 2.1 SoA (Structure of Arrays) 格式 ✅
- [x] 时间戳数组: `[t0, t1, t2, ...]`
- [x] 值数组: `[v0, v1, v2, ...]`
- [x] 不使用 AoS (Array of Structures)

**代码位置**: `server/src/services/wave_data.rs:332-413`

### 2.2 信号块头
- [x] 信号句柄 (u32)
- [x] 时间数组偏移 (u32)
- [x] 值数组偏移 (u32)
- [x] 转换点数量 (u32)
- [x] 压缩类型 (u8: 0=无压缩, 1=zstd, 2=lz4)

**代码位置**: `server/src/services/wave_data.rs:286-327`

## 三、LOD（金字塔）生成算法

### 3.1 min/max bucket 算法 ✅
- [x] 将时间轴分桶，每桶保留 min 和 max 值
- [x] 保留边沿信息
- [x] 不使用简单抽样（避免丢失窄脉冲）

**代码位置**: `server/src/services/wave_data.rs:125-186`

### 3.2 LoD 层级
- [x] 支持 0-11 层级
- [x] Level 0: 原始精度
- [x] Level N: 2^N 倍降采样

**代码位置**: `server/src/services/wave_data.rs:61-88`

## 四、数据压缩传输

### 4.1 压缩支持 ⚠️
- [ ] zstd 压缩
- [ ] lz4 压缩
- [x] 压缩类型字段预留（compression: u8）

**状态**: 框架已预留，实际压缩算法未实现

**代码位置**: `server/src/services/wave_data.rs:298`

### 4.2 传输格式
- [x] 二进制格式（非 JSON）
- [x] Content-Type: application/octet-stream

**代码位置**: `server/src/handlers/wave_handler.rs:170-173`

## 五、HTTP Range 支持

### 5.1 Range 请求处理 ✅
- [x] 解析 Range 请求头
- [x] 返回 206 Partial Content
- [x] 支持断点续传

**代码位置**: `server/src/services/wave_service.rs:476-490`

### 5.2 Range 响应头
- [x] Content-Range 头
- [x] Accept-Ranges: bytes

**代码位置**: `server/src/handlers/wave_handler.rs:175-196`

## 六、API 实现

### 6.1 波形数据获取 API ✅
```
GET /api/wave/:waveform_name/signals/:signal_name/data?lod=<level>&start=<time>&end=<time>
```

**代码位置**: `server/src/handlers/mod.rs:41-42`

### 6.2 参数支持
- [x] lod: LoD 层级 (0-11)
- [x] start: 起始时间（皮秒）
- [x] end: 结束时间（皮秒）

**代码位置**: `server/src/handlers/wave_handler.rs:129-148`

## 七、性能优化

### 7.1 时间分块 ✅
- [x] O(1) 时间定位
- [x] 无需索引
- [x] Cache friendly

**代码位置**: `server/src/services/wave_data.rs:469-507`

### 7.2 预生成 LOD ✅
- [x] Server 端预计算
- [x] 不在浏览器实时计算

**代码位置**: `server/src/services/wave_data.rs:188-207`

## 八、实战参数

### 8.1 推荐值 ✅
| 参数 | 推荐值 | 实现状态 |
|------|--------|----------|
| base window (L0) | 1-10 μs | ✅ 1ns (1000ps) |
| levels | 6-10 | ✅ 6 |
| chunk size | 64KB-512KB | ⚠️ 动态计算 |
| max points per screen | 50k | ❌ 未限制 |
| OPFS cache size | 1-5GB | ❌ 客户端实现 |

## 九、待实现功能

### 9.1 高优先级
- [ ] **实际波形数据读取** - 目前使用模拟数据
  - 需要从 fstapi 读取真实转换点
  - 代码位置: `wave_service.rs:551-560`

- [ ] **数据压缩** - zstd/lz4 压缩算法
  - 减小传输数据量
  - 代码位置: `wave_data.rs:298`

### 9.2 中优先级
- [ ] **多信号批量获取** - 一次请求多个信号
- [ ] **缓存机制** - Server 端 LRU 缓存
- [ ] **错误重试** - 网络错误处理

### 9.3 低优先级
- [ ] **WebSocket 支持** - 实时数据推送
- [ ] **增量更新** - 只传输变化的数据

## 十、代码质量

### 10.1 测试覆盖 ✅
- [x] LoD bucket 大小计算测试
- [x] 信号波形数据操作测试
- [x] Chunk 头序列化测试
- [x] Chunk 完整序列化测试

**代码位置**: `server/src/services/wave_data.rs:535-593`

### 10.2 文档
- [x] 模块级文档注释
- [x] 函数文档注释
- [x] 算法说明注释

## 总结

### 已实现 ✅
1. OPFS 数据结构规范
2. Chunk 二进制格式（SoA）
3. LOD 金字塔生成（min/max bucket）
4. HTTP Range 请求支持
5. 基础 API 实现
6. 单元测试

### 待完善 ⚠️
1. **真实波形数据读取** - 从 FST 文件读取转换点
2. **数据压缩** - zstd/lz4 压缩
3. **性能优化** - 单屏点数限制、缓存机制

### 总体评估
- **完成度**: ~70%
- **核心功能**: 已实现
- **生产就绪**: 需要完善真实数据读取和压缩
