# Feature Spec: Drag Signal from Waveform to Signal Panel

## 1. 概述

### 1.1 功能描述
支持从 Waveform 的 Signal List 中拖动一个信号到左侧的 Signal Panel，实现以下效果：
1. Hierarchy 自动展开到该信号的 parent module
2. Signal Panel 切换到该信号的 parent module
3. Signal Panel 中高亮选中该信号

### 1.2 复用策略
本功能将**复用 Session Manager 恢复 Hierarchy 状态的机制**，避免重复实现复杂的异步加载链。

## 2. 现有机制分析

### 2.1 Session Manager 如何恢复 Hierarchy 展开状态

Session 恢复时的关键代码（App.tsx）：

```typescript
// Step 9: Restore hierarchy panel state
if (session.hierarchy) {
  setExpandedModules(new Set(session.hierarchy.expandedModules))
  setSelectedModuleIndex(session.hierarchy.selectedModule)
}
```

**DesignBrowser 的响应机制**：

```typescript
// DesignBrowser.tsx - 当 expandedModules 改变时自动加载
useEffect(() => {
  if (isControlled && expandedNodes.size > 0 && treeNodes.size > 0) {
    const loadMissingChildren = async () => {
      let currentMap = treeNodes;
      const nodesToLoad = [...expandedNodes];
      
      while (nodesToLoad.length > 0) {
        const nodeId = nodesToLoad.shift()!;
        const node = currentMap.get(nodeId);
        if (node && !node.childrenLoaded && node.hasChildren) {
          currentMap = await loadChildren(nodeId, currentMap);
          // 递归加载已展开的子节点
          const childNodes = Array.from(currentMap.values()).filter(n => n.parentId === nodeId);
          for (const child of childNodes) {
            if (expandedNodes.has(child.id)) {
              nodesToLoad.push(child.id);
            }
          }
        }
      }
    };
    loadMissingChildren();
  }
}, [expandedNodes, isControlled, treeNodes.size]);
```

### 2.2 核心洞察

**关键发现**：DesignBrowser 已经实现了完整的异步加载链：
1. 只需要设置 `expandedModules`，DesignBrowser 会自动加载需要的节点
2. `loadMissingChildren` 会递归加载所有需要展开的节点
3. 不需要手动调用 `loadChildren`，状态驱动即可

## 3. 实现方案

### 3.1 架构设计

```
┌─────────────────┐     dragstart      ┌─────────────────┐
│  WaveformWindow │ ──────────────────> │  SignalPanel    │
│  (Source)       │   signal data       │  (Drop Target)  │
└─────────────────┘                     └────────┬────────┘
                                                  │
                                                  │ onDrop
                                                  ↓
                                         ┌─────────────────┐
                                         │  App.tsx        │
                                         │  (Controller)   │
                                         └────────┬────────┘
                                                  │
                    ┌─────────────────────────────┼─────────────────────────────┐
                    │                             │                             │
                    ↓                             ↓                             ↓
           ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
           │ expandedModules │          │ selectedModule  │          │ selectedSignal  │
           │ (Set<number>)   │          │ (number)        │          │ (number)        │
           └────────┬────────┘          └────────┬────────┘          └────────┬────────┘
                    │                             │                             │
                    ↓                             ↓                             ↓
           ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
           │ DesignBrowser     │          │ SignalPanel     │          │ SignalPanel     │
           │ (Auto-expand)   │          │ (Show module    │          │ (Highlight      │
           │                 │          │  signals)       │          │  signal)        │
           └─────────────────┘          └─────────────────┘          └─────────────────┘
```

### 3.2 数据流

```
1. 用户拖动 Waveform 信号
   ↓
2. WaveformWindow 在 dragstart 中设置信号数据
   dataTransfer.setData('application/json', JSON.stringify({
     globalId: signal.globalId,
     parentModuleId: signal.parentModuleId,
     name: signal.name,
     fullName: signal.fullName
   }))
   ↓
3. SignalPanel 作为 drop 区域，阻止默认行为
   ↓
4. App.tsx 处理 drop 事件
   a. 解析拖动的信号数据
   b. 计算 parent module chain
   c. 更新 expandedModules（复用 session manager 机制）
   d. 更新 selectedModuleIndex
   e. 设置 signalToSelect 状态
   ↓
5. DesignBrowser 自动展开到指定 module
   （通过 useEffect 监听 expandedModules 变化）
   ↓
6. SignalPanel 显示 parent module 的信号
   ↓
7. SignalPanel 高亮选中的信号
   （通过 selectedSignalGlobalId 状态）
```

## 4. 详细实现

### 4.1 计算 Parent Module Chain

```typescript
// App.tsx - 计算从 root 到 target module 的 chain
const getModuleChain = (targetModuleId: number): number[] => {
  const chain: number[] = [];
  let currentId = targetModuleId;
  
  while (currentId > 0) {
    chain.unshift(currentId); // 添加到开头，保持 root -> child 顺序
    const module = kdbManager.getModuleById(currentId);
    currentId = module?.parentModuleId || 0;
  }
  
  return chain; // [rootModule, childModule, ..., targetModule]
};
```

### 4.2 展开 Hierarchy 到指定 Module

```typescript
// App.tsx - 复用 session manager 的展开机制
const expandHierarchyToModule = useCallback((targetModuleId: number) => {
  // 1. 计算需要展开的所有模块（从 root 到 target）
  const chain = getModuleChain(targetModuleId);
  
  // 2. 更新 expandedModules（这会触发 DesignBrowser 的 useEffect）
  setExpandedModules(prev => {
    const newExpanded = new Set(prev);
    chain.forEach(id => newExpanded.add(id));
    return newExpanded;
  });
  
  // 3. 设置选中的 module
  setSelectedModuleIndex(targetModuleId);
}, []);
```

### 4.3 处理 Drop 事件

```typescript
// App.tsx - 处理从 Waveform 拖放的信号
const handleSignalDropFromWaveform = useCallback((signalData: {
  globalId: number;
  parentModuleId: number;
  name: string;
  fullName: string;
}) => {
  console.log('[App] Signal dropped from waveform:', signalData);
  
  // 1. 展开 hierarchy 到信号的 parent module
  if (signalData.parentModuleId > 0) {
    expandHierarchyToModule(signalData.parentModuleId);
  }
  
  // 2. 设置要选择的信号（用于 SignalPanel 高亮）
  setPendingSelectedSignal(signalData.globalId);
}, [expandHierarchyToModule]);
```

### 4.4 SignalPanel 选中信号

```typescript
// App.tsx - 新增状态用于控制 SignalPanel 选中
const [pendingSelectedSignal, setPendingSelectedSignal] = useState<number | null>(null);

// 当 selectedModuleIndex 改变且有待选信号时，通知 SignalPanel
useEffect(() => {
  if (pendingSelectedSignal && selectedModuleIndex) {
    // 检查信号是否属于当前选中的 module
    const signal = kdbManager.buildSignal(pendingSelectedSignal);
    if (signal && signal.parentModuleId === selectedModuleIndex) {
      // 信号属于当前 module，可以选中
      // 通过 ref 或 callback 通知 SignalPanel
      signalPanelRef.current?.selectSignal(pendingSelectedSignal);
    }
    setPendingSelectedSignal(null);
  }
}, [pendingSelectedSignal, selectedModuleIndex]);
```

## 5. 代码修改清单

### 5.1 WaveformWindow.tsx

**修改位置**：信号名称的渲染部分

```typescript
// 在 signal name span 上添加 draggable 属性
<span
  className="waveform-signal-name"
  draggable
  onDragStart={(e) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      globalId: signal.globalId,
      parentModuleId: signal.parentModuleId,
      name: signal.name,
      fullName: signal.fullName
    }));
    e.dataTransfer.effectAllowed = 'move';
  }}
  // ... 其他属性
>
  {getSignalDisplayName(signal)}
</span>
```

### 5.2 SignalPanel.tsx

**修改位置**：组件根元素

```typescript
interface SignalPanelProps {
  // ... 现有 props
  onSignalDrop?: (signalData: {
    globalId: number;
    parentModuleId: number;
    name: string;
    fullName: string;
  }) => void;
  pendingSelectedSignal?: number | null;
}

// 在组件根元素添加 drop 支持
<div
  className="signal-panel"
  onDragOver={(e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }}
  onDrop={(e) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('application/json');
    if (data) {
      const signalData = JSON.parse(data);
      onSignalDrop?.(signalData);
    }
  }}
>
  {/* ... 现有内容 */}
</div>

// 添加 useEffect 监听 pendingSelectedSignal
useEffect(() => {
  if (pendingSelectedSignal) {
    setSelectedSignalGlobalId(pendingSelectedSignal);
  }
}, [pendingSelectedSignal]);
```

### 5.3 App.tsx

**新增状态**：
```typescript
const [pendingSelectedSignal, setPendingSelectedSignal] = useState<number | null>(null);
```

**新增函数**：
```typescript
// 计算 module chain
const getModuleChain = (targetModuleId: number): number[] => {
  const chain: number[] = [];
  let currentId = targetModuleId;
  
  while (currentId > 0) {
    chain.unshift(currentId);
    const module = kdbManager.getModuleById(currentId);
    currentId = module?.parentModuleId || 0;
  }
  
  return chain;
};

// 展开 hierarchy 到指定 module（复用 session manager 机制）
const expandHierarchyToModule = useCallback((targetModuleId: number) => {
  const chain = getModuleChain(targetModuleId);
  
  setExpandedModules(prev => {
    const newExpanded = new Set(prev);
    chain.forEach(id => newExpanded.add(id));
    return newExpanded;
  });
  
  setSelectedModuleIndex(targetModuleId);
}, []);

// 处理 drop 事件
const handleSignalDropFromWaveform = useCallback((signalData: {
  globalId: number;
  parentModuleId: number;
  name: string;
  fullName: string;
}) => {
  if (signalData.parentModuleId > 0) {
    expandHierarchyToModule(signalData.parentModuleId);
    setPendingSelectedSignal(signalData.globalId);
  }
}, [expandHierarchyToModule]);
```

**修改 SignalPanel 组件调用**：
```typescript
<SignalPanel
  selectedModuleIndex={selectedModuleIndex}
  onSignalAddToWaveform={handleSignalAddToWaveform}
  onSignalAddToTableView={handleSignalAddToTableView}
  onSignalDoubleClick={handleSignalDoubleClick}
  onSignalSelect={handleSignalSelect}
  activeTabType={tabs.find(t => t.id === activeTab)?.type}
  onSignalDrop={handleSignalDropFromWaveform}
  pendingSelectedSignal={pendingSelectedSignal}
/>
```

## 6. 时序图

```
User          WaveformWindow    SignalPanel    App.tsx        DesignBrowser
 |                |                  |             |                |
 |--drag signal--> |                  |             |                |
 |                |--dragstart------> |             |                |
 |                |  set dataTransfer |             |                |
 |                |                  |             |                |
 |--drop---------> |                  |             |                |
 |                |                  |--onDrop----> |                |
 |                |                  |  parse data |                |
 |                |                  |             |                |
 |                |                  |             |--expandHierarchyToModule()
 |                |                  |             |  - getModuleChain()
 |                |                  |             |  - setExpandedModules()
 |                |                  |             |  - setSelectedModuleIndex()
 |                |                  |             |                |
 |                |                  |             |--useEffect------>
 |                |                  |             |  expandedModules|
 |                |                  |             |                |
 |                |                  |             |                |--loadMissingChildren()
 |                |                  |             |                |  - loadChildren() (async)
 |                |                  |             |                |  - recursive load
 |                |                  |             |                |
 |                |                  |             |                |--treeNodes updated
 |                |                  |             |                |
 |                |                  |<--render---- |                |
 |                |                  |  show module|                |
 |                |                  |  signals    |                |
 |                |                  |             |                |
 |                |                  |<--useEffect--|                |
 |                |                  |  pendingSelectedSignal        |
 |                |                  |             |                |
 |                |                  |--highlight--> |                |
 |                |                  |  signal     |                |
```

## 7. 边界情况处理

### 7.1 KDB 未加载
- 如果 KDB 未加载，拖放操作应该被忽略或显示提示

### 7.2 Module 不存在
- 如果信号的 parent module 不存在，应该显示错误信息

### 7.3 信号已在当前 Module
- 如果 Signal Panel 已经显示该信号的 parent module，只需要高亮信号即可

### 7.4 异步加载延迟
- 用户可能在 hierarchy 还在展开时进行其他操作
- 需要确保 `pendingSelectedSignal` 在 module 切换后才清除

## 8. 测试用例

### 8.1 基本功能
1. 拖动 Waveform 中的信号到 Signal Panel
2. 验证 Hierarchy 展开到信号的 parent module
3. 验证 Signal Panel 显示该 module 的信号
4. 验证信号被高亮选中

### 8.2 边界情况
1. 拖动时 KDB 未加载
2. 拖动到 Signal Panel 外部
3. 快速连续拖动多个信号
4. 拖动 hierarchy 中未加载的 module 的信号

### 8.3 性能测试
1. 拖动深层嵌套的信号（10+ 层）
2. 拖动包含大量子节点的 module 中的信号

## 9. 相关文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `App.tsx` | 修改 | 添加展开逻辑和 drop 处理 |
| `WaveformWindow.tsx` | 修改 | 添加 drag 支持 |
| `SignalPanel.tsx` | 修改 | 添加 drop 支持和选中信号 |
| `DesignBrowser.tsx` | 无需修改 | 复用现有机制 |

## 10. 总结

本方案的核心是**复用 Session Manager 恢复 Hierarchy 的机制**：

1. **不重新实现**异步加载链，而是利用 DesignBrowser 已有的 `useEffect` 监听
2. **只需要设置状态**（`expandedModules` 和 `selectedModuleIndex`），DesignBrowser 会自动处理加载
3. **保持架构一致**，与 Session 恢复使用相同的代码路径

这种设计避免了代码重复，利用了经过测试的现有机制，同时也更容易维护。
