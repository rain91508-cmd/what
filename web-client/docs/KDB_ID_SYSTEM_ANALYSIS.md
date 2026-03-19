# KDB ID 系统分析文档

## 概述

本文档详细分析 KDB (Knowledge Database) 中的 ID 系统，包括 Module ID 和 Signal Global ID 的设计、查询方法以及与 OPFS 存储的 draw_sig_id 的关系。

---

## 一、Module ID 系统

### 1.1 Module ID 分配规则

- **ID 类型**: 1-based 整数 (从 1 开始)
- **存储方式**: Module 存储在数组中，ID = 数组索引 + 1
- **唯一性**: 每个 Module 在 KDB 中有唯一的 ID

```typescript
// 获取 Module 的代码示例
getModuleById(id: number): Module | null {
  if (id <= 0 || id > this.modules.length) return null;
  return this.modules[id - 1];  // ID 转数组索引
}
```

### 1.2 Module 结构

```typescript
interface Module {
  // ID 是隐式的：数组索引 + 1
  name: string;                    // Module 名称（短名称）
  parentModuleId: number;          // 父 Module ID，0 表示顶层模块
  definition: ModuleSourceLocation; // 定义位置信息
  signalDefs: SignalDef[];         // 信号定义（仅定义模块有）
  isInstance: boolean;             // 是否是实例
  childModuleIds: number[];        // 子模块 ID 列表
  defModuleId: number;             // 定义模块 ID，0 表示自己是定义
  signalInstsStartId: number;      // 在 allSignalInsts 中的起始索引
}
```

### 1.3 如何查找 Module Full Name

Full Name 是动态计算的，通过遍历 parent chain 构建：

```typescript
calculateModuleFullName(moduleIndex: number): string {
  const names: string[] = [];
  let currentId = moduleIndex;
  
  while (currentId > 0) {
    const module = this.getModuleById(currentId);
    if (!module) break;
    
    names.push(module.name);
    if (module.parentModuleId === 0) break;
    currentId = module.parentModuleId;
  }
  
  return names.reverse().join('.');
}
```

**示例**:
- Module ID: 5
- Parent Chain: 5 → 3 → 1 → 0
- Names: ["core", "picorv32", "work"]
- Full Name: `work.picorv32.core`

### 1.4 如何查找 Parent Module

```typescript
const module = getModuleById(moduleId);
if (module && module.parentModuleId > 0) {
  const parentModule = getModuleById(module.parentModuleId);
}
```

### 1.5 如何查找 Definition Module

```typescript
const module = getModuleById(moduleId);
if (module) {
  if (module.isInstance && module.defModuleId > 0) {
    // 这是一个实例，获取其定义模块
    const defModule = getModuleById(module.defModuleId);
  } else {
    // 这本身就是定义模块
    const defModule = module;
  }
}
```

### 1.6 如何查找 Sub-instances (子实例)

```typescript
const module = getModuleById(moduleId);
if (module) {
  for (const childId of module.childModuleIds) {
    const childModule = getModuleById(childId);
    // childModule 是子实例
  }
}
```

### 1.7 Source Location 信息

#### Definition Source Location (定义位置)
```typescript
interface ModuleSourceLocation {
  fileId: number;      // 源文件 ID
  startLine: number;   // 起始行号
  endLine: number;     // 结束行号
}
```

**获取方法**:
```typescript
const module = getModuleById(moduleId);
if (module && module.definition) {
  const { fileId, startLine, endLine } = module.definition;
}
```

#### Instance Source Location (实例位置)
- 每个 Module（包括实例）都有自己的 `definition` 字段，存储该模块在源代码中的位置
- 对于**实例模块**：
  - `definition` 字段存储的是**实例位置**（即实例化该模块的代码位置）
  - 要获取其**定义位置**，需要通过 `defModuleId` 查找定义模块，再获取定义模块的 `definition`

**获取方法**:
```typescript
const module = getModuleById(moduleId);
if (module) {
  if (module.isInstance) {
    // 实例模块
    // 1. 实例位置（实例化该模块的位置）
    const instanceLocation = module.definition;
    
    // 2. 定义位置（模块定义的位置）
    const defModule = getModuleById(module.defModuleId);
    if (defModule) {
      const definitionLocation = defModule.definition;
    }
  } else {
    // 定义模块：definition 就是其定义位置
    const definitionLocation = module.definition;
  }
}
```

---

## 二、Signal Global ID 系统

### 2.1 Signal 的两种表示

KDB 中 Signal 分为两部分存储：

1. **SignalDef (信号定义)**: 存储在**定义模块**中，包含静态信息
   - 每个信号的定义只存储一次，在其定义模块的 `signalDefs` 数组中
   - 所有实例共享同一个 SignalDef

2. **SignalInst (信号实例)**: 存储在全局数组 `allSignalInsts` 中，包含实例特定信息
   - 每个信号实例都有独立的 SignalInst
   - 通过 `parentModuleId` 关联到所属模块

### 2.2 Signal Global ID 分配规则

- **ID 类型**: 0-based 整数（数组索引）
- **存储位置**: `KnowledgeBase.allSignalInsts` 数组
- **唯一性**: 每个信号实例在全局数组中有唯一的索引

```typescript
interface KnowledgeBase {
  // ...
  allSignalInsts: SignalInst[];  // 全局信号实例数组
}
```

### 2.3 SignalInst 结构

```typescript
interface SignalInst {
  msb: number;                     // 最高位
  lsb: number;                     // 最低位
  parentModuleId: number;          // 所属模块 ID
  driverLocations: DriverLocation[]; // 驱动位置信息
}

interface DriverLocation {
  driverSignalGlobalId: number;    // 驱动信号的全局 ID
  line: number;                    // 源文件行号
}
```

### 2.4 SignalDef 结构

```typescript
interface SignalDef {
  name: string;                    // 信号名称
  type: SignalType;                // 信号类型
  declaration?: SourceLocation;    // 声明位置
  direction: PortDirection;        // 端口方向
}
```

### 2.5 如何计算 Signal Global ID

Signal Global ID 是通过 Module 的 `signalInstsStartId` 加上局部索引计算的：

```typescript
// 获取模块中第 localIndex 个信号的 global ID
const module = getModuleById(moduleId);
const globalId = module.signalInstsStartId + localIndex;
```

**示例**:
- Module ID: 3
- signalInstsStartId: 100
- 要获取第 5 个信号 (localIndex = 4)
- Global ID = 100 + 4 = 104

### 2.6 如何查找 Signal Full Name

```typescript
calculateSignalFullName(parentModuleId: number, signalName: string): string {
  const moduleFullName = calculateModuleFullName(parentModuleId);
  return moduleFullName ? `${moduleFullName}.${signalName}` : signalName;
}

// 构建完整的 Signal 对象（包含 bit width）
buildSignal(globalId: number): Signal | null {
  const inst = getSignalInstByGlobalId(globalId);
  if (!inst) return null;
  
  const module = getModuleById(inst.parentModuleId);
  if (!module) return null;
  
  // 计算局部索引
  const localIndex = globalId - module.signalInstsStartId;
  const signalDefs = getSignalDefs(inst.parentModuleId);
  const def = signalDefs[localIndex];
  
  // 构建 fullName
  const baseFullName = calculateSignalFullName(inst.parentModuleId, def.name);
  const fullNameWithBitWidth = (inst.msb !== inst.lsb)
    ? `${baseFullName}[${inst.msb}:${inst.lsb}]`
    : baseFullName;
  
  return {
    globalId,
    localIndex,
    name: def.name,
    fullName: fullNameWithBitWidth,
    // ...
  };
}
```

### 2.7 如何查找 Parent Module

```typescript
const inst = getSignalInstByGlobalId(globalId);
if (inst) {
  const parentModuleId = inst.parentModuleId;
  const parentModule = getModuleById(parentModuleId);
}
```

### 2.8 如何查找 Definition Source Location

```typescript
const inst = getSignalInstByGlobalId(globalId);
if (inst) {
  const module = getModuleById(inst.parentModuleId);
  const localIndex = globalId - module.signalInstsStartId;
  const signalDefs = getSignalDefs(inst.parentModuleId);
  const def = signalDefs[localIndex];
  
  // 获取声明位置
  if (def.declaration) {
    const { fileId, line } = def.declaration;
  }
}
```

### 2.9 如何查找 Driver 信息

```typescript
const inst = getSignalInstByGlobalId(globalId);
if (inst) {
  for (const driver of inst.driverLocations) {
    const driverSignalGlobalId = driver.driverSignalGlobalId;
    const driverLine = driver.line;
    const driverSignal = buildSignal(driverSignalGlobalId);
  }
}
```

---

## 三、KDB Manager 帮助函数

KDB Manager 提供了一系列帮助函数来简化 ID 查询操作：

### 3.1 Module 相关函数

```typescript
// 获取模块
getModuleById(id: number): Module | null

// 计算模块的完整层次名称
calculateModuleFullName(moduleIndex: number): string

// 获取模块的显示范围（用于源代码查看）
// 对于实例，返回定义模块的范围
getDisplayRange(moduleId: number): { fileId: number; startLine: number; endLine: number } | null
```

### 3.2 Signal 相关函数

```typescript
// 获取信号实例
getSignalInstByGlobalId(globalId: number): SignalInst | null

// 获取模块的信号定义列表
// 对于实例，从定义模块获取
getSignalDefs(moduleId: number): SignalDef[]

// 构建完整的 Signal 对象（合并 SignalDef + SignalInst）
buildSignal(globalId: number): Signal | null

// 计算信号的完整层次名称
calculateSignalFullName(parentModuleId: number, signalName: string): string

// 获取信号的驱动信息
getDriverBySignalId(signalGlobalId: number): DriverLocation[]
```

### 3.3 使用示例

```typescript
// 获取信号的所有信息
const signal = kdbManager.buildSignal(globalId);
if (signal) {
  console.log(`Name: ${signal.name}`);
  console.log(`Full Name: ${signal.fullName}`);
  console.log(`Parent Module: ${signal.parentModuleId}`);
  console.log(`Declaration: ${signal.declaration?.fileId}:${signal.declaration?.line}`);
  console.log(`Drivers: ${signal.driverLocations.length}`);
}

// 获取模块的显示范围（用于源代码高亮）
const range = kdbManager.getDisplayRange(moduleId);
if (range) {
  console.log(`File: ${range.fileId}`);
  console.log(`Lines: ${range.startLine}-${range.endLine}`);
}
```

---

## 四、与 OPFS 存储的 draw_sig_id 的关系

### 4.1 为什么需要 draw_sig_id

- **global_id**: KDB 中的信号全局 ID，范围可能很大且不连续
- **draw_sig_id**: 用于波形绘制的连续整数 ID，范围 0 ~ N-1

**原因**: WASM 和渲染系统需要连续的 ID 来优化存储和查找性能。

### 4.2 draw_sig_id 分配规则

- **ID 类型**: 0-based 连续整数
- **分配方式**: 单调递增，首次使用时分配
- **存储位置**: OPFS 中的 `signals.json` 文件
- **分组**: 每 256 个信号为一组 (GROUP_SIZE = 256)

```typescript
interface SignalMetadata {
  version: number;
  next_draw_sig_id: number;        // 下一个可用的 ID
  signal_map: Record<string, number>;  // global_id (string) -> draw_sig_id
}
```

### 4.3 映射关系

```
KDB Global ID (e.g., 1042)  →  SignalIdManager  →  draw_sig_id (e.g., 5)
                                    ↓
                              OPFS signals.json
                              {
                                "signal_map": {
                                  "1042": 5,
                                  "2056": 6,
                                  ...
                                }
                              }
```

### 4.4 如何获取 draw_sig_id

```typescript
// 获取或创建 draw_sig_id
const draw_sig_id = signalIdManager.getOrCreateDrawSigId(global_id);

// 批量获取已存在的映射
const drawSigIdMap = signalIdManager.getDrawSigIds([1042, 2056, 3078]);
// 返回: Map { 1042 => 5, 2056 => 6, ... }
```

### 4.5 Group ID 计算

```typescript
// 计算信号所属的 group
getGroupId(draw_sig_id: number): number {
  return Math.floor(draw_sig_id / 256);
}

// 示例:
// draw_sig_id = 5   → group_id = 0
// draw_sig_id = 255 → group_id = 0
// draw_sig_id = 256 → group_id = 1
// draw_sig_id = 300 → group_id = 1
```

### 4.6 OPFS 存储结构

OPFS 中波形数据按 group 存储：

```
/wave_cache/
  /<waveform_name>/
    signals.json          # global_id → draw_sig_id 映射
    group_0.bin           # group 0 的数据 (draw_sig_id 0-255)
    group_1.bin           # group 1 的数据 (draw_sig_id 256-511)
    ...
```

### 4.7 使用流程

1. **添加信号到波形**:
   ```typescript
   const global_id = signal.globalId;  // 从 KDB 获取
   const draw_sig_id = signalIdManager.getOrCreateDrawSigId(global_id);
   ```

2. **获取信号数据**:
   ```typescript
   const group_id = signalIdManager.getGroupId(draw_sig_id);
   const data = await opfsCache.readGroup(group_id);
   ```

3. **WASM 绘制**:
   ```typescript
   // WASM 内部通过 draw_sig_id 查找信号数据
   const signal_data = get_signal_data(draw_sig_id);
   ```

---

## 五、ID 系统总结

| ID 类型 | 范围 | 存储位置 | 用途 | 计算方式 |
|---------|------|----------|------|----------|
| Module ID | 1-based | modules[] 数组 | 模块标识 | 数组索引 + 1 |
| Signal Global ID | 0-based | allSignalInsts[] 数组 | 信号全局标识 | 数组索引 |
| draw_sig_id | 0-based (连续) | OPFS signals.json | 波形绘制 | 动态分配 |
| Group ID | 0-based | OPFS group_*.bin | 数据分块 | draw_sig_id / 256 |

### 关键转换关系

```
Module ID (1-based) ←→ modules[index - 1]
                        ↓
Signal Global ID = module.signalInstsStartId + localIndex
                        ↓
draw_sig_id = signal_map[global_id]  (通过 SignalIdManager)
                        ↓
Group ID = floor(draw_sig_id / 256)
```

---

## 六、常见问题

### Q1: 为什么 Module ID 是 1-based，而 Signal Global ID 是 0-based？

**A**: 这是历史原因。Module ID 使用 1-based 因为 0 表示 "无父模块" (top-level)。Signal Global ID 使用 0-based 因为它是数组索引。

### Q2: 如何根据 full name 查找 signal？

**A**: 需要遍历所有信号，计算每个信号的 full name 进行匹配。或者使用搜索服务建立的索引。

### Q3: draw_sig_id 在会话之间保持一致吗？

**A**: 是的，draw_sig_id 存储在 OPFS 的 signals.json 中，会话之间保持一致。但不同的 waveform 有独立的映射。

### Q4: 如何清除 draw_sig_id 映射？

**A**: 删除 OPFS 中的 `signals.json` 文件，下次启动时会重新分配。

---

## 七、相关文件

- `src/types/kdb.ts` - KDB 类型定义
- `src/modules/knowledge/kdbManager.ts` - KDB 管理器
- `src/core/cache/signalIdManager.ts` - Signal ID 管理器
- `src/opfs_cache.rs` - OPFS 缓存 (Rust/WASM)
- `src/waveform_provider.rs` - 波形数据提供器 (Rust/WASM)
