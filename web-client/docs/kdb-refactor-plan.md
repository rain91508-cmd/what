# KDB 客户端重构计划

## 背景

当前 web-client 的 KDB 处理存在以下问题：
1. 数据转换层次过多（protobuf → WASM → JSON → IndexedDB → JS 对象 → KnowledgeBase）
2. 一次性加载所有模块和信号，大数据量时性能差
3. 数据结构与服务端 KDB 不匹配，转换容易出错

## 目标

1. **按需加载**：只加载需要显示的数据
2. **结构对齐**：客户端数据结构与服务端 KDB proto 保持一致
3. **简化转换**：减少不必要的数据转换层次
4. **利用新特性**：使用 proto 新增的 `child_module_ids` 构建树结构

---

## 服务端 KDB 结构（参考）

```protobuf
// kdb.proto
message Module {
  uint32 id = 1;                    // 模块唯一 ID
  string name = 2;                  // 模块名
  string full_name = 3;             // 完整路径
  uint32 parent_module_id = 4;      // 父模块 ID
  uint32 file_id = 5;               // 源文件 ID
  SourceLocation declaration = 6;   // 声明位置
  repeated Signal signals = 7;      // 信号列表（仅实例有）
  bool is_instance = 8;             // 是否是实例
  repeated uint32 child_module_ids = 9;  // 子模块 ID 列表
}

message Signal {
  uint64 id = 1;
  string name = 2;
  string full_name = 3;
  SignalType type = 4;
  uint32 msb = 5;
  uint32 lsb = 6;
  uint32 parent_module_id = 7;      // 所属模块 ID
  SourceLocation declaration = 8;
  repeated uint64 driver_signal_ids = 9;
  PortDirection direction = 10;
  repeated SourceLocation driver_lines = 11;
}

message DesignHierarchy {
  uint32 top_module_id = 1;         // 顶层模块 ID
  repeated uint32 module_ids = 2;   // 层次包含的所有模块 ID
}

message KnowledgeBase {
  KDBHeader header = 1;
  repeated SourceFile files = 2;
  repeated Module modules = 3;
  repeated DesignHierarchy hierarchies = 4;
}
```

---

## 客户端数据结构

### IndexedDB Schema

```typescript
// 1. knowledge-base store
interface KnowledgeBaseRecord {
  id: string;                       // KDB ID (key)
  header: {
    version: string;
    projectName: string;            // proto: project_name
    createdAt: string;              // proto: created_at
  };
  topModuleIds: number[];           // 从 hierarchies 提取的顶层模块 ID
  hierarchies: DesignHierarchy[];
}

// 2. modules store
interface ModuleRecord {
  id: number;                       // 模块 ID (key) - 与 proto 一致
  name: string;
  fullName: string;                 // proto: full_name
  parentModuleId: number;           // proto: parent_module_id
  fileId: number;                   // proto: file_id
  isInstance: boolean;              // proto: is_instance
  signals: Signal[];                // 完整信号列表
  childModuleIds: number[];         // proto: child_module_ids
  kdbId: string;                    // 所属 KDB
}

// 3. source-files store
interface SourceFileRecord {
  id: number;                       // 文件 ID (key)
  path: string;
  content: string;
  kdbId: string;
}

// Indexes:
// - modules: by-kdb (kdbId), by-full-name (fullName)
```

### 内存中的类型定义

```typescript
// types/kdb.ts
// 与 proto 结构一致，字段名转为 camelCase

export interface KDBHeader {
  version: string;
  projectName: string;
  createdAt: string;
}

export interface Module {
  id: number;
  name: string;
  fullName: string;
  parentModuleId: number;
  fileId: number;
  isInstance: boolean;
  signals: Signal[];
  childModuleIds: number[];
}

export interface Signal {
  id: number;
  name: string;
  fullName: string;
  signalType: SignalType;    // proto: type
  msb: number;
  lsb: number;
  parentModuleId: number;
  direction: PortDirection;
  driverSignalIds: number[];
}

export enum SignalType {
  UNKNOWN = 0,
  WIRE = 1,
  REG = 2,
  LOGIC = 3,
  BIT = 4,
  INTEGER = 5,
  REAL = 6,
  PARAMETER = 7,
  LOCALPARAM = 8,
}

export enum PortDirection {
  UNKNOWN = 0,
  INPUT = 1,
  OUTPUT = 2,
  INOUT = 3,
}

export interface DesignHierarchy {
  topModuleId: number;
  moduleIds: number[];
}

export interface KnowledgeBase {
  id: string;
  header: KDBHeader;
  topModuleIds: number[];
  hierarchies: DesignHierarchy[];
}
```

---

## 加载策略

| 场景 | 加载内容 | 时机 |
|------|---------|------|
| 打开 KDB | header + topModuleIds + hierarchies | 初始化 |
| 显示 Hierarchy | 顶层 Module 对象 | 初始渲染 |
| 展开模块 | 该模块的 childModuleIds 对应的 Module | 点击展开 |
| 选中模块 | 该模块的 signals | 点击选中 |
| 查看源码 | 对应的 SourceFile | 点击文件 |

---

## API 设计

### IndexedDBManager

```typescript
class IndexedDBManager {
  // 基础信息
  async getKnowledgeBase(id: string): Promise<KnowledgeBase | null>;
  async storeKnowledgeBase(kb: KnowledgeBase): Promise<void>;
  
  // 模块操作
  async getModule(id: number): Promise<Module | null>;
  async getModulesByKdb(kdbId: string): Promise<Module[]>;
  async getModuleByFullName(fullName: string): Promise<Module | null>;
  async storeModule(module: Module, kdbId: string): Promise<void>;
  
  // 批量获取（用于展开）
  async getModulesByIds(ids: number[]): Promise<Module[]>;
  
  // 源文件
  async getSourceFile(id: number): Promise<SourceFile | null>;
  async storeSourceFile(file: SourceFile, kdbId: string): Promise<void>;
  
  // 清理
  async clearKdbData(kdbId: string): Promise<void>;
}
```

### KdbManager

```typescript
class KdbManager {
  private currentKdbId: string | null = null;
  private kb: KnowledgeBase | null = null;
  
  // 加载 KDB（只加载基础信息）
  async loadKdb(kdbId: string): Promise<boolean>;
  
  // 获取顶层模块（用于初始显示）
  async getTopLevelModules(): Promise<Module[]>;
  
  // 获取子模块（展开时调用）
  async getChildModules(parentModule: Module): Promise<Module[]>;
  
  // 获取模块信号（选中时调用）
  async getModuleSignals(moduleId: number): Promise<Signal[]>;
  
  // 获取源文件内容
  async getSourceFile(fileId: number): Promise<string | null>;
  
  // 预加载（可选优化）
  async preloadModules(moduleIds: number[], depth?: number): Promise<Map<number, Module>>;
}
```

---

## 组件设计

### DesignBrowser（树形浏览器）

```typescript
interface TreeNodeProps {
  moduleId: number;
  depth?: number;
}

const TreeNode: React.FC<TreeNodeProps> = ({ moduleId, depth = 0 }) => {
  const [module, setModule] = useState<Module | null>(null);
  const [children, setChildren] = useState<Module[]>([]);
  const [expanded, setExpanded] = useState(false);
  
  // 加载当前模块
  useEffect(() => {
    kdbManager.getModule(moduleId).then(setModule);
  }, [moduleId]);
  
  // 展开时加载子模块
  const handleExpand = async () => {
    if (!expanded && module) {
      const childModules = await kdbManager.getChildModules(module);
      setChildren(childModules);
    }
    setExpanded(!expanded);
  };
  
  // 点击时触发选中回调
  const handleClick = () => {
    if (module) {
      onSelect(module);
    }
  };
  
  return (
    <div style={{ paddingLeft: depth * 16 }}>
      <div 
        onClick={handleClick}
        onDoubleClick={handleExpand}
        className={module?.isInstance ? 'instance' : 'module'}
      >
        {expanded ? '▼' : '▶'} {module?.name}
        {module?.isInstance && <span className="badge">instance</span>}
      </div>
      
      {expanded && children.map(child => (
        <TreeNode 
          key={child.id} 
          moduleId={child.id} 
          depth={depth + 1}
        />
      ))}
    </div>
  );
};

// 根组件
const DesignBrowser: React.FC = () => {
  const [topModules, setTopModules] = useState<Module[]>([]);
  
  useEffect(() => {
    kdbManager.getTopLevelModules().then(setTopModules);
  }, []);
  
  return (
    <div className="design-browser">
      {topModules.map(m => (
        <TreeNode key={m.id} moduleId={m.id} />
      ))}
    </div>
  );
};
```

### SignalPanel（信号面板）

```typescript
interface SignalPanelProps {
  moduleId: number;
}

const SignalPanel: React.FC<SignalPanelProps> = ({ moduleId }) => {
  const [signals, setSignals] = useState<Signal[]>([]);
  
  useEffect(() => {
    kdbManager.getModuleSignals(moduleId).then(setSignals);
  }, [moduleId]);
  
  return (
    <div className="signal-panel">
      <h3>Signals ({signals.length})</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Width</th>
            <th>Direction</th>
          </tr>
        </thead>
        <tbody>
          {signals.map(sig => (
            <tr key={sig.id}>
              <td>{sig.name}</td>
              <td>{SignalType[sig.signalType]}</td>
              <td>{sig.msb}:{sig.lsb}</td>
              <td>{PortDirection[sig.direction]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
```

---

## 实施步骤

### Phase 1: 基础设施（1-2 天）

1. **更新 WASM proto 定义**
   - 文件: `src/kdb_proto.rs`
   - 添加 `child_module_ids` 字段到 Module
   - 确保所有字段与最新 proto 一致

2. **更新 IndexedDB Schema**
   - 文件: `src/core/storage/indexedDB.ts`
   - 修改 modules store: key 改为 `id` (number)
   - 添加/更新 indexes: `by-kdb`, `by-full-name`
   - 移除 `by-parent` index（不再需要）

3. **创建新的类型定义**
   - 文件: `src/types/kdb.ts`
   - 定义与 proto 对应的 TypeScript 类型
   - 添加 SignalType 和 PortDirection 枚举

### Phase 2: 存储层（2-3 天）

4. **修改 WASM 存储逻辑**
   - 文件: `src/lib.rs`
   - 分别存储到不同 store（knowledge-base, modules, source-files）
   - 保留 `child_module_ids` 字段
   - 模块使用 `id` 作为 key

5. **更新 kdbStorage.ts**
   - 文件: `src/core/storage/kdbStorage.ts`
   - 更新 `store_knowledge_base`: 存储 header 和 hierarchies
   - 更新 `store_module`: 使用 `id` 作为 key
   - 添加 `store_source_file`
   - 更新 `clear_kdb_data`

6. **更新 IndexedDBManager**
   - 文件: `src/core/storage/indexedDB.ts`
   - 添加 `getModule(id: number)`
   - 添加 `getModulesByIds(ids: number[])`
   - 添加 `getModuleByFullName(fullName: string)`
   - 更新 `getKnowledgeBase`: 返回新的结构

### Phase 3: 业务逻辑层（2-3 天）

7. **重构 kdbManager.ts**
   - 移除旧的转换逻辑（convertToKnowledgeBase 等）
   - 实现新的按需加载 API
   - 添加 `loadKdb`, `getTopLevelModules`, `getChildModules`, `getModuleSignals`
   - 可选: 添加预加载优化

8. **更新 kdbWasmParser.ts**
   - 简化 WASM 调用接口
   - 移除复杂的转换逻辑

### Phase 4: UI 层（2-3 天）

9. **重构 DesignBrowser**
   - 重写为按需加载的树形组件
   - 使用 `childModuleIds` 展开子节点
   - 移除旧的 buildHierarchy 逻辑

10. **创建 SignalPanel 组件**
    - 显示选中模块的信号
    - 按需加载信号数据

11. **更新 App.tsx**
    - 集成新的组件
    - 处理模块选中事件

### Phase 5: 测试与优化（2-3 天）

12. **单元测试**
    - IndexedDB 操作测试
    - KdbManager API 测试

13. **集成测试**
    - 端到端加载流程测试
    - 大数据量性能测试

14. **性能优化**
    - 添加预加载策略
    - 优化渲染性能

---

## 数据结构转换对照

### Module（proto → IndexedDB）

| Proto Field | IndexedDB Field | Type | Note |
|-------------|-----------------|------|------|
| `id` | `id` (key) | number | 主键 |
| `name` | `name` | string | - |
| `full_name` | `fullName` | string | camelCase |
| `parent_module_id` | `parentModuleId` | number | camelCase |
| `file_id` | `fileId` | number | camelCase |
| `is_instance` | `isInstance` | boolean | camelCase |
| `signals` | `signals` | Signal[] | 直接存储 |
| `child_module_ids` | `childModuleIds` | number[] | camelCase |

### Signal（proto → IndexedDB）

| Proto Field | IndexedDB Field | Type | Note |
|-------------|-----------------|------|------|
| `id` | `id` | number | - |
| `name` | `name` | string | - |
| `full_name` | `fullName` | string | camelCase |
| `type` | `signalType` | number | 避免与 JS 关键字冲突 |
| `msb` | `msb` | number | - |
| `lsb` | `lsb` | number | - |
| `parent_module_id` | `parentModuleId` | number | camelCase |
| `direction` | `direction` | number | - |
| `driver_signal_ids` | `driverSignalIds` | number[] | camelCase |

---

## 预期收益

1. **性能提升**
   - 初始加载时间减少 80%+（只加载顶层）
   - 内存占用与模块数量无关
   - 大数据量设计也能流畅操作

2. **代码简化**
   - 减少 50%+ 的数据转换代码
   - 类型定义与 proto 一致，易于维护
   - 树形构建逻辑更简单

3. **用户体验**
   - 打开 KDB 更快
   - 展开层次无卡顿
   - 信号查看按需加载

4. **可扩展性**
   - 支持更大的设计（百万级模块）
   - 易于添加新的按需加载功能
   - 缓存策略更灵活

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 重构工作量大 | 高 | 分阶段实施，每阶段可独立测试 |
| 兼容性问题 | 中 | 保留旧代码作为 fallback，逐步迁移 |
| 性能不达预期 | 低 | 添加预加载和缓存优化 |
| 数据丢失 | 低 | 充分测试存储和加载逻辑 |

---

## 附录

### A. 旧架构 vs 新架构对比

```
旧架构:
KDB → WASM解析 → 全部转换 → IndexedDB(扁平) → JS加载全部 → 构建Map → UI

新架构:
KDB → WASM解析 → 分别存储 → IndexedDB(分层) → JS按需加载 → 直接显示
```

### B. 关键设计决策

1. **为什么用 `id` 而不是 `full_name` 做 key？**
   - KDB 中所有引用都是数字 ID
   - 查询更快（数字比较 vs 字符串比较）
   - 节省存储空间

2. **为什么保留 `full_name`？**
   - 用于显示路径
   - 用于路径查找（通过 index）
   - 与服务器调试时对应

3. **为什么不存储 `parent_module_id` index？**
   - 有 `child_module_ids` 就不需要反向查询
   - 减少索引维护成本
   - `parent_module_id` 仅用于验证

4. **为什么 signals 存储在 module 中？**
   - 与 KDB 结构一致
   - 加载模块时自然获得 signals
   - 避免额外的 store 和查询

---

*文档版本: 1.0*
*更新日期: 2024-01-01*
