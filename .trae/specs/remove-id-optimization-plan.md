# 移除 ID 字段优化计划

## 目标
通过移除 Module 和 Signal 的显式 ID 字段，使用数组索引作为隐式 ID，减少存储空间并简化数据结构。

## 背景

当前设计中，Module 和 Signal 都有显式的 ID 字段：
- `Module.id`: uint32，用于模块间引用（parent_module_id, child_module_ids, def_module_id）
- `Signal.id`: uint64，用于信号间引用（driver_signal_ids）

优化后，使用数组索引 + 1 作为隐式 ID：
- Module ID = modules 数组索引 + 1
- Signal ID = module.signals 数组索引 + 1（每个 module 内独立）

## 影响分析

### Module ID 使用场景
1. **parent_module_id**: Module 指向父模块
2. **child_module_ids**: Module 指向子模块列表
3. **def_module_id**: Instance 指向 Definition
4. **DesignHierarchy.module_ids**: 顶层模块列表
5. **查找模块**: `findModuleById(id)`

### Signal ID 使用场景
1. **driver_signal_ids**: 信号指向驱动信号列表
2. **查找信号**: `findSignalById(id)`
3. **跨模块信号引用**: 驱动分析中需要引用其他模块的信号

## 实施计划

### Phase 1: 准备工作（低风险）
**目标**: 建立辅助函数，为后续修改做准备

**任务**:
1. [ ] 在 `KdbBuilder` 中添加 `getModuleId(const ModuleInfo* module)` 方法
   - 实现: `return module ? (module - modules_.data()) + 1 : 0;`
   
2. [ ] 在 `KdbBuilder` 中添加 `getSignalId(const ModuleInfo* module, const SignalInfo* signal)` 方法
   - 实现: `return signal ? (signal - module->signals.data()) + 1 : 0;`

3. [ ] 更新 `findModuleById` 使用数组索引
   - 从 map 查找改为数组索引: `return &modules_[id - 1];`

4. [ ] 添加 `findSignalById(moduleId, signalId)` 重载
   - 先找到 module，再索引 signal

**验证**:
- 所有现有测试通过
- 功能无变化

### Phase 2: 更新 Proto 定义（中风险）
**目标**: 修改 proto 文件，移除 id 字段

**任务**:
1. [ ] 更新 `kdb.proto`
   ```protobuf
   message Module {
     // 移除: uint32 id = 1;
     string name = 1;  // 重新编号
     uint32 parent_module_id = 2;
     // ... 其他字段重新编号
   }
   
   message Signal {
     // 移除: uint64 id = 1;
     // 移除: uint32 parent_module_id = 7;
     string name = 1;  // 重新编号
     // ... 其他字段重新编号
   }
   ```

2. [ ] 更新 C++ 结构体 `ModuleInfo` 和 `SignalInfo`
   - 移除 `id` 和 `parentModuleId` 字段

**验证**:
- 编译通过（会有大量错误，但 proto 生成正确）

### Phase 3: 更新序列化/反序列化（高风险）
**目标**: 适配新的 proto 定义

**任务**:
1. [ ] 更新 `kdb_builder.cpp` - `toProtobuf()`
   - 移除 `set_id()` 调用
   - 移除 `set_parent_module_id()` 调用

2. [ ] 更新 `kdb_builder.cpp` - `fromProtobuf()`
   - 移除 `id()` 读取
   - 移除 `parent_module_id()` 读取
   - 重建索引时使用数组索引

3. [ ] 更新 `kdb_serializer.cpp`（如果使用）
   - 移除 id 和 parentModuleId 的序列化

**验证**:
- 序列化/反序列化测试通过
- KDB 文件读写正常

### Phase 4: 更新核心逻辑（高风险）
**目标**: 更新所有使用 id 的地方

**任务**:
1. [ ] 更新 `kdb_build_listener.cpp`
   - 使用 `getModuleId()` 获取模块 ID
   - 使用 `getSignalId()` 获取信号 ID
   - 更新 `currentModuleSignalMap_` 存储 (fullName -> signalIndex)

2. [ ] 更新 `driver_analyzer.cpp`
   - 修改驱动关系存储方式
   - 从存储 signal ID 改为存储 (moduleId, signalIndex)

3. [ ] 更新 `kdb_builder.cpp` - `addModule()`
   - 移除 `mod->id = nextModuleId_++`
   - 使用数组索引作为 ID

4. [ ] 更新 `kdb_builder.cpp` - `addSignal()`
   - 移除 `sig.id = nextSignalId_++`
   - 移除 `sig.parentModuleId = moduleId`
   - 使用数组索引作为 ID

5. [ ] 更新 `kdb_builder.cpp` - `buildIndices()`
   - 重建索引时使用数组索引
   - 更新 `signalFullNameToId_` 存储 signalIndex 而不是 signalId

**验证**:
- 所有测试通过
- 功能正常

### Phase 5: 更新 Viewer 和工具（中风险）
**目标**: 更新显示和查询工具

**任务**:
1. [ ] 更新 `kdb_viewer.cpp`
   - 更新信号查找逻辑
   - 更新显示格式

2. [ ] 更新 `kdb_serializer.cpp`（完整更新）
   - 适配新的 ID 方案

**验证**:
- 查看器功能正常
- 所有工具工作正常

### Phase 6: 清理和优化（低风险）
**目标**: 清理不再使用的代码

**任务**:
1. [ ] 移除 `nextModuleId_` 和 `nextSignalId_` 计数器
2. [ ] 移除 `moduleIdToIndex_` 和 `signalIdToIndex_` map
3. [ ] 清理调试代码
4. [ ] 更新文档和注释

**验证**:
- 代码整洁
- 无冗余代码

## 风险评估

| 风险项 | 等级 | 缓解措施 |
|--------|------|----------|
| 驱动分析逻辑错误 | 高 | 详细测试，保留备份 |
| 序列化格式不兼容 | 高 | 版本控制，增量测试 |
| 性能下降 | 中 | 基准测试，必要时回退 |
| 代码复杂度增加 | 中 | 完善文档，添加辅助函数 |

## 回退方案

如果优化导致问题：
1. 保留原始 proto 定义备份
2. 保留原始 C++ 结构体备份
3. 使用 git 分支管理
4. 每个 phase 完成后提交，可单独回退

## 预期收益

### 存储空间节省
- Module: 每个节省 4 字节 (id) + 4 字节 (file_id 已移除) = 8 字节
- Signal: 每个节省 8 字节 (id) + 4 字节 (parent_module_id) = 12 字节
- 以 1000 模块、10000 信号为例：节省约 128KB

### 性能提升
- 查找 Module: O(1) map -> O(1) 数组索引（更快）
- 查找 Signal: O(1) map -> O(1) 数组索引（更快）
- 缓存友好性：数组访问比 map 更好

## 时间估算

| Phase | 预计时间 | 复杂度 |
|-------|---------|--------|
| Phase 1 | 2-3 小时 | 低 |
| Phase 2 | 1-2 小时 | 中 |
| Phase 3 | 3-4 小时 | 高 |
| Phase 4 | 4-6 小时 | 高 |
| Phase 5 | 2-3 小时 | 中 |
| Phase 6 | 1-2 小时 | 低 |
| **总计** | **13-20 小时** | - |

## 建议

考虑到：
1. 改动范围大，风险较高
2. 收益相对有限（对于小型设计）
3. 当前系统工作稳定

**建议**：
- 如果 KDB 文件大小是瓶颈，实施此优化
- 如果需要支持超大型设计（百万级信号），实施此优化
- 否则，优先完成其他功能，后续再考虑

## 下一步行动

等待决策：
1. **实施优化** - 按 Phase 逐步执行
2. **暂停优化** - 回退 proto 和结构体修改，保持当前设计
3. **部分优化** - 只移除 Module id，保留 Signal id（降低风险）
