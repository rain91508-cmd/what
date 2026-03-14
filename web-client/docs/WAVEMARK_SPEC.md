# Wavemark 功能规格说明书

## 概述

Wavemark 是一个波形标记系统，允许用户在波形视图中标记特定时间点，保存该时刻的波形状态（包括展开的 signal groups），并能够快速跳转到这些标记点。

## 功能特性

### 1. 基本概念

**Wavemark** 包含以下信息：
- **ID**: 唯一标识符
- **名称**: 用户可编辑的标记名称（默认 "Wavemark N"）
- **时间**: 标记的时间点（LoD0Unit）
- **颜色**: 12种可选颜色，用于标记线和文字
- **展开的 Groups**: 标记创建时哪些 signal groups 是展开状态
- **创建时间**: 标记创建的时间戳

### 2. 创建 Wavemark

**触发条件**: 
- 当前 active tab 是 waveform tab
- 用户点击 toolbar 上的 bookmark 按钮（🔖）

**创建过程**:
1. 获取当前 cursor 位置的时间
2. 获取当前所有展开的 groups（排除 root）
3. 生成默认名称 "Wavemark N"（N 为序号）
4. 使用默认颜色（橙色 #ff6600）
5. 保存到当前 tab 的 wavemarks 列表中

**注意**: 如果当前是 source tab，则创建普通的 bookmark 而非 wavemark。

### 3. Wavemarks Tab

**位置**: MessageWindow 中，位于 Bookmarks 和 Drivers 之间

**显示内容**:
- 表头：Color | Name | Time | Groups | Action
- 列表：每个 wavemark 一行，显示其信息

#### 3.1 列宽调整

所有列（Color、Name、Time、Groups、Action）都支持拖拽调整宽度：
- 列之间有 4px 的 resize handle
- 最小宽度限制：Color 20px，其他列 50px
- 列宽状态保存在组件内部状态中

#### 3.2 颜色选择

- 点击颜色方块打开颜色选择器
- 12 种颜色可选：
  - #ff6600 (Orange, 默认)
  - #ff0000 (Red)
  - #00ff00 (Green)
  - #0000ff (Blue)
  - #ffff00 (Yellow)
  - #ff00ff (Magenta)
  - #00ffff (Cyan)
  - #800080 (Purple)
  - #008000 (Dark Green)
  - #ffa500 (Bright Orange)
  - #ff1493 (Deep Pink)
  - #00ced1 (Dark Turquoise)
- 点击颜色选择器外部自动关闭
- 当前选中颜色有边框高亮

#### 3.3 名称编辑

- 点击名称进入编辑模式
- 输入框自动聚焦
- 按 Enter 或失去焦点保存
- 按 Escape 取消编辑

#### 3.4 Groups 编辑

- 点击 groups 数量打开多选菜单
- 菜单显示所有非 root 的 groups
- 勾选/取消勾选来修改展开的 groups
- 点击菜单外部自动关闭
- 统计数量时排除 root group

#### 3.5 删除

- 点击 ✕ 按钮删除 wavemark
- 删除后立即从列表中移除

#### 3.6 双击跳转

- 双击 wavemark 行跳转到对应时间
- 恢复该 wavemark 记录的 groups 展开状态
- 将对应时间居中显示在 viewport 中

### 4. 波形视图中的显示

#### 4.1 Marker 线

- 在 canvas 上绘制垂直线
- 使用 wavemark 的颜色
- 只在 wavemark 时间在当前 viewport 范围内时显示
- z-index: 9（在 cursor 线之下）

#### 4.2 Info Bar 标签

- 在 info bar 中显示 wavemark 名称和时间
- 文字颜色统一使用亮灰色 (#cccccc)
- 标签位置智能调整：
  - 默认显示在 marker 线右侧
  - 太靠近右边缘时显示在左侧
  - 太靠近 cursor 时显示在 cursor 另一侧

### 5. Session 管理

#### 5.1 保存 Session

- 每个 waveform tab 的 wavemarks 都会被保存
- 包含完整的 wavemark 信息（id、name、time、color、expandedGroups、createdAt）

#### 5.2 恢复 Session

- 恢复时重建所有 wavemarks
- 保持原有的颜色和 groups 设置

### 6. Group 同步

当 signal groups 发生变化时：
- 检测哪些 groups 被删除
- 自动从所有 wavemarks 的 expandedGroups 中移除被删除的 group
- 保持数据一致性

## 技术实现

### 数据类型

```typescript
// types/wavemark.ts
export const WAVEMARK_COLORS = [
  '#ff6600', '#ff0000', '#00ff00', '#0000ff', '#ffff00',
  '#ff00ff', '#00ffff', '#800080', '#008000', '#ffa500',
  '#ff1493', '#00ced1',
] as const;

export type WavemarkColor = typeof WAVEMARK_COLORS[number];

export interface Wavemark {
  id: string;
  name: string;
  time: number;
  createdAt: number;
  color: WavemarkColor;
  expandedGroups: string[];
}
```

### Tab 类型扩展

```typescript
// TabPanel.tsx
interface Tab {
  // ... 其他字段
  wavemarks?: Wavemark[];
}
```

### Session 类型扩展

```typescript
// types/session.ts
interface Session {
  // ... 其他字段
  waveformTabs: Array<{
    // ... 其他字段
    wavemarks?: Array<{
      id: string;
      name: string;
      time: number;
      createdAt: number;
      expandedGroups: string[];
    }>;
  }>;
}
```

### 主要组件

#### MessageWindow

Props:
```typescript
interface MessageWindowProps {
  // ... 其他 props
  wavemarks?: Wavemark[];
  onWavemarkClick?: (wavemark: Wavemark) => void;
  onWavemarkDelete?: (wavemarkId: string) => void;
  onWavemarkRename?: (wavemarkId: string, newName: string) => void;
  onWavemarkColorChange?: (wavemarkId: string, newColor: string) => void;
  onWavemarkGroupsChange?: (wavemarkId: string, newGroups: string[]) => void;
  availableGroups?: Array<{ id: string; name: string }>;
}
```

#### WaveformWindow

Props:
```typescript
interface WaveformWindowProps {
  // ... 其他 props
  wavemarks?: Wavemark[];
}
```

### 回调函数

#### App.tsx

```typescript
// 创建 wavemark
const handleAddBookmark = useCallback(async () => {
  // 如果是 waveform tab，创建 wavemark
  // 如果是 source tab，创建 bookmark
}, [activeTab, tabs, addMessage]);

// 双击跳转
const handleWavemarkClick = useCallback((wavemark: Wavemark) => {
  // 居中显示 wavemark 时间
  // 恢复 groups 展开状态
}, [activeTab, tabs, addMessage]);

// 删除
const handleWavemarkDelete = useCallback((wavemarkId: string) => {
  // 从当前 tab 的 wavemarks 中移除
}, [activeTab, addMessage]);

// 重命名
const handleWavemarkRename = useCallback((wavemarkId: string, newName: string) => {
  // 更新 wavemark 名称
}, [activeTab]);

// 颜色变更
const handleWavemarkColorChange = useCallback((wavemarkId: string, newColor: string) => {
  // 更新 wavemark 颜色
}, [activeTab]);

// Groups 变更
const handleWavemarkGroupsChange = useCallback((wavemarkId: string, newGroups: string[]) => {
  // 更新 wavemark 的 expandedGroups
}, [activeTab]);

// Group 更新时同步
const handleGroupsUpdate = (tabId: string, groups: any) => {
  // 检测被删除的 groups
  // 从 wavemarks 中移除被删除的 group 引用
};
```

## 用户交互流程

### 创建 Wavemark

1. 用户切换到 waveform tab
2. 移动 cursor 到想要标记的时间点
3. 展开需要的 signal groups
4. 点击 toolbar 上的 🔖 按钮
5. 在 MessageWindow 的 Wavemarks tab 中看到新创建的标记

### 查看和编辑 Wavemark

1. 打开 MessageWindow 的 Wavemarks tab
2. 查看所有 wavemarks 列表
3. 点击颜色方块更改颜色
4. 点击名称进行编辑
5. 点击 groups 数量编辑展开的 groups
6. 拖拽列边界调整列宽

### 跳转到 Wavemark

1. 在 Wavemarks tab 中双击某个 wavemark
2. 波形视图跳转到该时间点并居中显示
3. 自动恢复该 wavemark 记录的 groups 展开状态

### 删除 Wavemark

1. 在 Wavemarks tab 中找到要删除的标记
2. 点击右侧的 ✕ 按钮
3. 标记立即从列表中移除

## 注意事项

1. **Root Group**: 在创建 wavemark 和编辑 groups 时，root group 被排除在外
2. **Cursor 重合**: 当 wavemark 和 cursor 完全重合时，info bar 标签显示在 cursor 标签的左侧
3. **Viewport 范围**: 只有时间在当前 viewport 范围内的 wavemarks 才会显示 marker 线
4. **每个 Tab 独立**: 每个 waveform tab 有自己的 wavemarks 列表，互不干扰
