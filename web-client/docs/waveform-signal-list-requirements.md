# Waveform 信号列表功能需求文档

## 1. 功能概述

Waveform 窗口的信号列表用于显示和管理波形查看器中的信号分组。支持多级 group 嵌套，每个 group 可以包含多个信号，信号可以跨 group 重复添加。

## 2. 数据结构

### 2.1 SignalGroup 接口
```typescript
interface SignalGroup {
  id: string;           // group 唯一标识
  name: string;         // group 显示名称
  parentId: string | null;  // 父 group ID，null 表示根节点
  signals: Array<Signal & { uniqueId: string }>;  // group 包含的信号列表
  expanded: boolean;    // 是否展开显示子 group
  children: string[];   // 子 group ID 列表
}
```

### 2.2 Groups 存储结构
```typescript
type Groups = Record<string, SignalGroup>;

// 示例结构
{
  'root': {
    id: 'root',
    name: 'root',
    parentId: null,
    signals: [],
    expanded: true,
    children: ['group_1']
  },
  'group_1': {
    id: 'group_1',
    name: 'Group_1',
    parentId: 'root',
    signals: [{...}, {...}],  // 只属于 group_1 的信号
    expanded: true,
    children: ['group_2']
  },
  'group_2': {
    id: 'group_2',
    name: 'Group_2',
    parentId: 'group_1',
    signals: [{...}],  // 只属于 group_2 的信号
    expanded: true,
    children: []
  }
}
```

## 3. 核心功能需求

### 3.1 Group 管理

#### 3.1.1 创建 Group
- **创建子 group**: 在指定 group 下创建子 group
  - 新 group 的 `parentId` 指向父 group
  - 父 group 的 `children` 数组添加新 group ID
  - 新 group 的 `signals` 初始为空数组
  - 自动选中新创建的 group

- **创建兄弟 group**: 在指定 group 的同一层级创建 group
  - 新 group 的 `parentId` 与指定 group 相同
  - 祖父 group 的 `children` 数组添加新 group ID

#### 3.1.2 删除 Group
- 如果该 group 是父 group 的最后一个子节点，则只清空 signals 和 children，保留 group 本身
- 否则完全删除 group，从父 group 的 children 中移除

#### 3.1.3 重命名 Group
- 双击 group 名称进入编辑模式
- 支持 Enter 确认、Escape 取消

#### 3.1.4 展开/折叠 Group
- 点击 group 左侧的 ▼/▶ 图标切换展开状态
- 展开时显示子 group 和信号
- 折叠时隐藏子 group 和信号

### 3.2 信号管理

#### 3.2.1 添加信号到 Group
- 信号只能添加到当前选中的 group
- 每个信号实例有唯一的 `uniqueId`（格式: `{handle}-{fullPath}-{index}`）
- 同一信号可以多次添加到同一个或不同的 group
- 添加信号时，只更新选中 group 的 signals 数组，不影响其他 group

#### 3.2.2 从 Group 移除信号
- 点击信号右侧的 × 按钮移除
- 只移除该 uniqueId 对应的信号实例
- 不影响其他 group 中的同名信号

#### 3.2.3 信号隔离原则
- **关键原则**: 每个 group 的 `signals` 数组只包含直接属于该 group 的信号
- 子 group 的信号不应该出现在父 group 的 signals 数组中
- 父 group 的信号不应该出现在子 group 的 signals 数组中

### 3.3 树形显示结构

#### 3.3.1 显示层级
```
root (隐藏，不显示)
├── Group_1 (level 0)
│   ├── Signal_A (属于 Group_1, level 1)
│   ├── Signal_B (属于 Group_1, level 1)
│   └── Group_2 (level 1)
│       ├── Signal_C (属于 Group_2, level 2)
│       └── Signal_D (属于 Group_2, level 2)
└── Group_3 (level 0)
    └── Signal_E (属于 Group_3, level 1)
```

#### 3.3.2 连接线显示
- 使用虚线显示树形层级关系
- 非最后一个子节点显示垂直连接线
- 所有子节点显示水平连接线

### 3.4 Group 选择

#### 3.4.1 选中 Group
- 点击 group 行选中该 group
- 选中的 group 高亮显示
- 新添加的信号会放入选中的 group

#### 3.4.2 取消选中
- 再次点击已选中的 group，取消选中（选中 root）
- 选中 root 时，新信号添加到任何root group(即当前被选中的 group）

## 4. 信号列表列定义

### 4.1 Scope 列 (Hierarchy)
- 显示信号所在的 hierarchy 路径
- 从 `signal.fullPath` 提取父实例名
- 支持列宽调整

### 4.2 Name 列
- 显示信号名称
- 总线信号显示为 `name[msb:lsb]` 格式
- 支持树形缩进和连接线
- 支持列宽调整

### 4.3 Value 列
- 显示信号当前值
- 支持列宽调整

## 5. 过滤功能

### 5.1 名称过滤
- 输入框支持按信号名称过滤
- 匹配 `signal.name` 或 `signal.fullPath`
- 不区分大小写

### 5.2 IO 类型过滤
- 下拉框选择: All / Input / Output / InOut / Internal
- 根据 `signal.direction` 过滤

## 6. 状态管理

### 6.1 Tab 级别隔离
- 每个 waveform tab 有独立的 groups 状态
- 切换 tab 时，groups 状态独立保存和恢复
- 不同 tab 的 group 结构互不影响

### 6.2 信号同步机制（新设计）

#### 6.2.1 全局唯一 ID
- 使用全局计数器 `nextWaveformSignalIdRef` 生成递增的唯一 ID
- 每个信号实例分配一个全局唯一的数字 ID (`unique_id`)
- ID 从 1 开始递增，永不重复

#### 6.2.2 信号处理流程
```
1. 用户在 SignalList 点击信号
   ↓
2. App.tsx 生成 unique_id，创建 WaveformSignal
   ↓
3. 将 WaveformSignal 添加到 tab.signals 队列
   ↓
4. WaveformWindow 检测到 signals 变化
   ↓
5. 直接将所有 signals 添加到选中的 group
   ↓
6. 调用 onSignalsProcessed 通知父组件
   ↓
7. App.tsx 从 tab.signals 中删除已处理的信号
```

#### 6.2.3 优势
- **简单清晰**: 无需 `processedSignalsRef` 跟踪状态
- **即时处理**: 信号添加到 group 后立即从队列删除
- **内存友好**: signals 队列不会无限增长
- **精确删除**: 使用 `unique_id` 精确删除指定实例

## 7. 渲染优化

### 7.1 虚拟滚动
- 大量信号时使用虚拟滚动优化性能

### 7.2 条件渲染
- 折叠的 group 不渲染其子节点
- 过滤时只渲染匹配的信号

## 8. 已知问题和注意事项

### 8.1 信号隔离
- **重要**: 确保 group.signals 只包含直接属于该 group 的信号
- 避免子 group 的信号泄漏到父 group 显示

### 8.2 唯一标识（新设计）
- 使用全局唯一的数字 `unique_id` 区分信号实例
- 删除时只删除指定 `unique_id` 的实例
- 同一信号多次添加会有不同的 `unique_id`

### 8.3 状态一致性
- `tab.signals` 只作为临时队列，处理完后立即清空
- `group.signals` 是实际的信号存储
- 两个数组通过 `unique_id` 关联
