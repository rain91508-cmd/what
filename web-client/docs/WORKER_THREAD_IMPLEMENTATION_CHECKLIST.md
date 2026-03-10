# Worker Thread 架构实现 Checklist

本文档列出从当前架构迁移到 Worker Thread 架构的所有关键任务和检查点。

## 第一阶段：接口层（向后兼容）

### 1.1 创建核心接口

- [x] **创建 `core/waveformProviderInterface.ts`**
  - [x] 定义 `WaveformProviderInterface` 接口
  - [x] 定义 `RenderSegment` 类型
  - [x] 定义 `ValueInfo` 类型
  - [x] 定义 `WasmSignalInfo` 类型
  - [x] 定义 `ViewportConfig` 类型
  - [x] 定义 `CanvasConfig` 类型
  - [x] 定义 `ProviderConfig` 类型

**检查点**：
- [x] 接口包含所有当前 WASM 方法
- [x] 类型定义完整，无 `any`
- [x] 接口与现有 WASM 方法签名一致

**代码审核意见**：
- ✅ 接口定义完整，包含生命周期、配置设置、数据获取、渲染、缓存管理等方法
- ✅ 类型定义清晰，使用严格的 TypeScript 类型
- ✅ 额外添加了 `SignalInfo`, `SignalSegment`, `RenderResult`, `WaveformError` 等类型支持 Hook 和缓存
- ✅ 定义了 `WaveformProviderError` 错误类

### 1.2 创建直接模式包装器

- [x] **创建 `wasm/wasmWaveformProvider.ts`**
  - [x] 实现 `WasmWaveformProvider` 类
  - [x] 包装所有 WASM 方法
  - [x] 添加错误处理和日志
  - [x] 实现属性访问器

**检查点**：
- [x] 所有方法调用现有 WASM 实现
- [x] 错误处理完善
- [x] 类型安全，无编译错误

**代码审核意见**：
- ✅ 完整实现了 `WaveformProviderInterface` 接口
- ✅ 包装了现有的 `WaveformDataProvider` WASM 模块
- ✅ 使用 `WaveformProviderError` 进行错误处理
- ✅ 实现了所有属性访问器（viewportTimeStart, viewportTimeEnd, canvasWidth, canvasHeight 等）
- ✅ 添加了 `getSignals()` 和 `getSignalSegments()` 方法支持 Hook
- ✅ `renderWaveform` 方法在直接模式下使用 `fetchAndGetSegments` 获取数据并在主线程渲染

### 1.3 更新工厂函数

- [x] **更新 `wasm/waveformProviderFactory.ts`**
  - [x] 添加 `FactoryConfig` 接口
  - [x] 实现 `createWaveformProvider()` 函数
  - [x] 实现 `isWorkerSupported()` 检测
  - [x] 实现 `isOffscreenCanvasSupported()` 检测
  - [x] 实现 `isWorkerRenderSupported()` 检测

**检查点**：
- [x] 默认使用直接模式（`useWorker: false`）
- [x] 功能与之前完全一致
- [x] 浏览器不支持时自动降级到直接模式

**代码审核意见**：
- ✅ 实现了 `FactoryConfig` 接口继承 `ProviderConfig`
- ✅ `createWaveformProvider` 根据 `useWorker` 参数选择模式
- ✅ 浏览器不支持 Worker 或 OffscreenCanvas 时自动降级
- ✅ 提供了 `getEnvironmentSupport()` 和 `logEnvironmentSupport()` 用于调试
- ✅ 工厂函数返回 `Promise<WaveformProviderInterface>` 统一接口

### 1.4 更新 React 组件

- [x] **创建 `WaveformWindowWithProvider.tsx` 包装组件**
  - [x] 使用 `useWaveformProvider` Hook 创建 Provider
  - [x] 支持 `useWorker` 参数切换模式
  - [x] 提供错误处理和加载状态
  - [x] 向后兼容，可逐步迁移

- [ ] **更新 `WaveformWindow.tsx`**
  - [ ] 使用 `WaveformProviderInterface` 类型
  - [ ] 通过工厂函数创建 provider
  - [ ] 移除直接 WASM 调用

**检查点**：
- [x] 包装组件正常渲染
- [x] 无 TypeScript 错误
- [ ] 所有功能正常工作（需测试验证）

**代码审核意见**：
- ✅ 创建了 `WaveformWindowWithProvider` 包装组件
- ✅ 使用 `useWaveformProvider` Hook 管理 Provider 生命周期
- ✅ 支持 Worker 模式和直接模式切换
- ✅ 提供错误处理和重试机制
- ⚠️ `WaveformWindow.tsx` 仍使用旧的 `getProvider` 直接调用（第 12 行：`import { getProvider, WaveformDataProvider, ... } from '../wasm/waveformProvider'`）
- ⚠️ `WaveformWindow.tsx` 第 105 行仍直接使用 `WaveformDataProvider` 类型
- ⚠️ `WaveformWindow.tsx` 第 111 行仍调用 `getProvider()` 而非工厂函数
- 💡 可以逐步迁移，不影响现有功能
- 💡 建议在第三阶段或第四阶段完成 `WaveformWindow.tsx` 的迁移

**阶段一验收**：
- [x] 接口层实现完成
- [x] 直接模式包装器实现完成
- [x] 工厂函数实现完成
- [x] React 组件包装器完成
- [x] 类型检查通过
- [x] 向后兼容

**第一阶段完成总结**：
- ✅ 核心接口定义完成
- ✅ 直接模式包装器实现完成
- ✅ 工厂函数实现完成，支持自动降级
- ✅ React 组件包装器完成，可逐步迁移
- ⚠️ `WaveformWindow.tsx` 完整迁移待后续阶段完成
- ✅ 当前代码保持向后兼容，不影响现有功能

---

## 第二阶段：Worker 实现

### 2.1 创建 Worker 文件

- [x] **创建 `workers/waveformWorker.ts`**
  - [x] 实现消息处理主循环
  - [x] 实现 `INITIALIZE` 处理
  - [x] 实现 `RENDER_WAVEFORM` 处理
  - [x] 实现 `SET_VIEWPORT` 处理
  - [x] 实现 `SET_CANVAS_DIMENSIONS` 处理
  - [x] 实现 `SET_SIGNAL_LIST` 处理
  - [x] 实现 `GET_SIGNAL_VALUE_AT_TIME` 处理
  - [x] 实现 `FIND_TRANSITIONS_AROUND` 处理
  - [x] 实现 `CLEAR_CACHE` 处理
  - [x] 实现 `DISPOSE` 处理

**检查点**：
- [x] Worker 能正确加载 WASM
- [x] 所有消息类型处理正确
- [x] 错误处理完善

**代码审核意见**：
- ✅ Worker 使用 `self.onmessage` 处理消息
- ✅ 实现了完整的命令类型处理
- ✅ 使用 `currentRenderId` 机制取消过期任务
- ⚠️ 渲染逻辑使用简单实现，需要后续完善

### 2.2 实现 Worker 渲染器

- [x] **提取通用渲染代码**
  - [x] 创建 `core/render/waveformDrawing.ts` 通用渲染模块
  - [x] 提取 `renderWaveform` 主渲染函数
  - [x] 提取 `drawSingleBitWaveform`、`drawMultiBitWaveform`、`drawMinMaxWaveform` 等绘制函数
  - [x] 提取 `drawTimeRuler` 时间标尺绘制函数
  - [x] 支持 `CanvasRenderingContext2D` 和 `OffscreenCanvasRenderingContext2D`

- [x] **在 Worker 中使用通用渲染代码**
  - [x] Worker 导入 `waveformDrawing` 模块
  - [x] 使用 `renderWaveform` 进行渲染
  - [x] 确保渲染结果与主线程一致

**检查点**：
- [x] 渲染结果与主线程一致
- [x] 支持所有信号类型（XZ、总线、min/max 等）
- [ ] 性能可接受（需测试验证）

**代码审核意见**：
- ✅ 创建了通用的 `waveformDrawing.ts` 渲染模块
- ✅ 提取了与 Canvas 类型无关的绘制函数
- ✅ Worker 和主线程使用相同的渲染代码
- ✅ 支持所有信号类型：单 bit、多 bit、XZ、Z、min/max、toggling 等
- ✅ 支持时间标尺绘制

### 2.3 创建 Worker 包装器

- [x] **创建 `wasm/workerWaveformProvider.ts`**
  - [x] 实现 `WorkerWaveformProvider` 类
  - [x] 实现 Worker 生命周期管理
  - [x] 实现消息发送/接收
  - [x] 实现 Promise 封装
  - [x] 实现超时处理

**检查点**：
- [x] 与 `WaveformProviderInterface` 完全兼容
- [x] 消息传递正确
- [x] 错误处理完善

**代码审核意见**：
- ✅ 完整实现了 `WaveformProviderInterface` 接口
- ✅ 使用 `postMessage` 与 Worker 通信
- ✅ 实现了 Promise 包装和 30 秒超时机制
- ✅ 实现了 `Transferable` 支持（OffscreenCanvas）
- ✅ 实现了 `getSignals()` 和 `getSignalSegments()` 方法

### 2.4 实现 RenderScheduler

- [x] **创建 `core/renderScheduler.ts`**
  - [x] 实现 `RenderScheduler` 类
  - [x] 实现防抖机制（50ms）
  - [x] 实现命令去重
  - [x] 实现任务队列
  - [x] 实现 `sendDirectCommand` 辅助函数

**检查点**：
- [x] 快速拖动时只渲染最后一次
- [x] 不阻塞其他命令
- [x] 任务 ID 机制正确

**代码审核意见**：
- ✅ 实现了 50ms 防抖延迟
- ✅ 使用 `currentTaskId` 实现命令去重
- ✅ 实现了 `requestRender`（防抖）和 `requestRenderImmediate`（立即）两种模式
- ✅ 其他命令通过 `sendDirectCommand` 直接发送，不经过调度器
- ✅ 实现了渲染完成和错误回调

### 2.5 实现参数缓存

- [x] **创建 `core/renderCache.ts`**
  - [x] 实现 `RenderCache` 类
  - [x] 实现缓存键生成
  - [x] 实现 LRU 淘汰策略
  - [x] 实现内存限制检查
  - [x] 实现缓存清理

**检查点**：
- [x] 参数不变时直接使用缓存
- [x] LRU 自动淘汰旧缓存
- [x] 内存限制管理（默认 100MB）

**代码审核意见**：
- ✅ 基于信号列表和视口参数生成缓存键
- ✅ 实现了 LRU（最近最少使用）淘汰策略
- ✅ 支持内存使用量估算和限制
- ✅ 提供命中率统计
- ✅ 支持清除特定信号的缓存

**阶段二验收**：
- [ ] Worker 模式基本功能正常（需测试验证）
- [x] 渲染结果正确（代码层面与主线程一致）
- [ ] 性能有提升（需测试验证）

**代码审核意见**：
- ✅ Worker 文件 (`waveformWorker.ts`) 实现了所有消息类型处理
- ✅ Worker 使用通用渲染模块 (`waveformDrawing.ts`)，与主线程代码一致
- ✅ Worker 包装器 (`workerWaveformProvider.ts`) 完整实现接口
- ✅ RenderScheduler 实现 50ms 防抖和命令去重
- ✅ RenderCache 实现 LRU 淘汰和内存限制
- ⚠️ 实际功能需要在第三阶段/第四阶段通过测试验证
- ⚠️ 性能数据需要在第四阶段通过性能测试获取

**第二阶段完成总结**：
- ✅ 所有 TypeScript 文件已创建并通过类型检查
- ✅ 没有修改 Rust 代码
- ✅ Worker 和主线程使用相同的渲染代码（`waveformDrawing.ts`）
- ✅ 渲染逻辑已对齐，无需额外修改
- ⚠️ 需要在第三阶段/第四阶段进行测试验证
- ⚠️ 需要在第四阶段进行性能测试获取性能数据

---

## 第三阶段：错误处理与优化

### 3.1 Worker 生命周期管理

- [ ] **创建 `core/workerLifecycleManager.ts`**
  - [ ] 实现 `WorkerLifecycleManager` 类
  - [ ] 实现自动重启机制
  - [ ] 实现错误计数
  - [ ] 实现健康检查

**检查点**：
- [ ] Worker 崩溃后自动重启
- [ ] 重启后状态恢复
- [ ] 错误次数过多时停止重启

### 3.2 内存管理

- [ ] **创建 `core/memoryManager.ts`**
  - [ ] 实现 `MemoryManager` 类
  - [ ] 实现内存监控
  - [ ] 实现内存清理
  - [ ] 实现内存限制检查

**检查点**：
- [ ] 内存使用可监控
- [ ] 超出限制时触发清理
- [ ] 无内存泄漏

### 3.3 降级策略

- [ ] **更新工厂函数**
  - [ ] 实现初始化降级
  - [ ] 实现运行时降级
  - [ ] 实现 `AdaptiveProvider` 类

**检查点**：
- [ ] Worker 失败时自动降级
- [ ] 降级过程用户无感知
- [ ] 降级后功能正常

### 3.4 浏览器兼容性

- [ ] **检测浏览器支持**
  - [ ] 检测 `Worker` 支持
  - [ ] 检测 `OffscreenCanvas` 支持
  - [ ] 检测 `ImageBitmap` 支持

**检查点**：
- [ ] Safari 自动使用直接模式
- [ ] 旧版浏览器自动降级
- [ ] 功能检测准确

**阶段三验收**：
- [ ] 错误处理完善
- [ ] 降级策略有效
- [ ] 内存无泄漏

---

## 第四阶段：测试与优化

### 4.1 单元测试

- [ ] **测试接口层**
  - [ ] 测试 `WaveformProviderInterface` 实现
  - [ ] 测试 `RenderScheduler`
  - [ ] 测试 `RenderCache`

- [ ] **测试 Worker 通信**
  - [ ] 测试消息发送/接收
  - [ ] 测试超时处理
  - [ ] 测试错误处理

- [ ] **测试降级策略**
  - [ ] 测试初始化降级
  - [ ] 测试运行时降级

### 4.2 集成测试

- [ ] **测试完整流程**
  - [ ] 测试初始化流程
  - [ ] 测试渲染流程
  - [ ] 测试清理流程

- [ ] **测试边界情况**
  - [ ] 测试大量信号（>1000）
  - [ ] 测试快速拖动
  - [ ] 测试 Worker 崩溃

### 4.3 性能测试

- [ ] **测试指标**
  - [ ] 初始加载时间
  - [ ] 拖动响应时间
  - [ ] 缩放响应时间
  - [ ] 内存使用情况

- [ ] **对比测试**
  - [ ] 与直接模式对比
  - [ ] 记录性能提升数据

### 4.4 用户体验测试

- [ ] **测试场景**
  - [ ] 正常浏览波形
  - [ ] 快速拖动
  - [ ] 缩放操作
  - [ ] 切换波形文件

**检查点**：
- [ ] UI 无卡顿
- [ ] 响应流畅
- [ ] 无闪烁

**阶段四验收**：
- [ ] 所有测试通过
- [ ] 性能提升明显
- [ ] 用户体验良好

---

## 第五阶段：部署与监控

### 5.1 灰度发布

- [ ] **配置开关**
  - [ ] 添加 `preferWorker` 配置
  - [ ] 支持运行时切换
  - [ ] 添加用户白名单

- [ ] **分阶段启用**
  - [ ] 10% 用户启用 Worker
  - [ ] 50% 用户启用 Worker
  - [ ] 100% 用户启用 Worker

### 5.2 监控与告警

- [ ] **性能监控**
  - [ ] 监控渲染时间
  - [ ] 监控内存使用
  - [ ] 监控 Worker 错误率

- [ ] **错误监控**
  - [ ] 记录 Worker 崩溃
  - [ ] 记录降级事件
  - [ ] 记录超时事件

### 5.3 文档更新

- [ ] **更新用户文档**
  - [ ] 添加 Worker 模式说明
  - [ ] 添加故障排查指南
  - [ ] 添加性能优化建议

- [ ] **更新开发文档**
  - [ ] 更新架构文档
  - [ ] 更新 API 文档
  - [ ] 添加开发指南

**阶段五验收**：
- [ ] 生产环境稳定运行
- [ ] 监控数据正常
- [ ] 用户反馈良好

---

## 关键检查点汇总

### 架构设计
- [x] 接口层设计完成
- [x] Worker 通信机制设计完成
- [x] 错误处理策略设计完成
- [x] 降级策略设计完成
- [x] 缓存机制设计完成

### 代码实现
- [x] 接口层实现
- [x] Worker 实现
- [x] 包装器实现
- [x] 调度器实现
- [x] 缓存实现

### 测试覆盖
- [ ] 单元测试
- [ ] 集成测试
- [ ] 性能测试
- [ ] 兼容性测试

### 部署准备
- [ ] 灰度发布方案
- [ ] 监控方案
- [ ] 回滚方案
- [ ] 文档更新

---

## 文档中提到的关键点

### 核心概念
1. **接口隔离**：`WaveformProviderInterface` 解耦实现
2. **参数复制**：消息传递时复制参数，确保一致性
3. **防抖机制**：50ms 防抖，减少重复渲染
4. **命令去重**：只执行最新的 render 命令
5. **Worker 直接绘制**：使用 `transferControlToOffscreen()`

### 错误处理
6. **Worker 自动重启**：崩溃后自动恢复
7. **内存监控**：防止内存泄漏
8. **降级策略**：Worker 失败时自动降级
9. **超时处理**：30 秒渲染超时
10. **参数缓存**：参数不变时直接使用缓存

### 性能优化
11. **防抖延迟**：50ms 平衡响应和性能
12. **缓存有效期**：60 秒自动过期
13. **零数据传输**：Worker 直接绘制无需传输
14. **任务队列**：顺序执行避免并发冲突
15. **内存限制**：512MB 内存上限

### 兼容性
16. **Safari 降级**：不支持 OffscreenCanvas 时降级
17. **Worker 检测**：运行时检测浏览器支持
18. **自适应 Provider**：运行时动态切换模式

### 代码组织
19. **文件结构**：`core/`, `wasm/`, `workers/` 分离
20. **工厂模式**：`createWaveformProvider()` 统一创建
21. **生命周期管理**：`WorkerLifecycleManager` 管理 Worker
22. **内存管理**：`MemoryManager` 监控内存使用

---

## 快速参考

### 文件清单
```
web-client/src/
├── core/
│   ├── waveformProviderInterface.ts  (接口定义)
│   ├── renderScheduler.ts            (渲染调度)
│   ├── renderCache.ts                (渲染缓存)
│   ├── workerLifecycleManager.ts     (Worker 生命周期)
│   └── memoryManager.ts              (内存管理)
├── wasm/
│   ├── waveformProviderFactory.ts    (工厂函数)
│   ├── wasmWaveformProvider.ts       (直接模式包装器)
│   └── workerWaveformProvider.ts     (Worker 模式包装器)
├── workers/
│   └── waveformWorker.ts             (Worker 线程)
└── hooks/
    └── useWaveformProvider.ts        (React Hook)
```

### 关键配置
- **防抖延迟**：50ms
- **渲染超时**：30s
- **缓存有效期**：60s
- **内存限制**：512MB
- **Worker 重启延迟**：1s
- **最大错误次数**：3

### 浏览器支持
- **Chrome**：69+ ✓
- **Firefox**：105+ ✓
- **Safari**：✗ (降级到直接模式)
- **Edge**：79+ ✓

---

**最后更新**：2024年
**文档版本**：v1.0
