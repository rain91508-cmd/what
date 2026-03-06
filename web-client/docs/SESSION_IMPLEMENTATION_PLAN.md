# Session Save/Restore 实现计划

## 已完成

1. ✅ Session 类型定义 (`src/types/session.ts`)
2. ✅ SessionManager (`src/modules/session/sessionManager.ts`)
3. ✅ SessionDialog 组件 (`src/components/SessionDialog.tsx`)
4. ✅ SessionLoadingOverlay 组件 (`src/components/SessionLoadingOverlay.tsx`)

## 待实现

### 1. 修改 MenuBar.tsx
- 在 File 菜单下添加 "Save Session" 和 "Restore Session" 选项
- 添加点击事件处理

### 2. 修改 App.tsx
- 添加 session dialog 状态管理
- 实现 `handleSaveSession` 函数：
  - 收集当前所有状态
  - 创建 Session 对象
  - 调用 sessionManager.saveSession()
  - 显示等待遮罩
- 实现 `handleRestoreSession` 函数：
  - 显示等待遮罩
  - 关闭当前所有 tab、KDB、波形
  - 连接服务器（如果失败提示重新输入）
  - 下载 KDB 和波形（如果找不到提示重新选择）
  - 恢复 source tabs
  - 恢复 waveform tabs
  - 恢复 bookmarks
  - 隐藏等待遮罩

### 3. 需要收集的状态

#### Source Tabs
- tabs 数组中 type === 'source' 的 tab
- 每个 tab 的：id, moduleIndex, displayModuleIndex, signalDeclarationLine
- activeSourceTabId

#### Waveform Tabs
- tabs 数组中 type === 'waveform' 的 tab
- 每个 tab 的：id, label, groups, selectedGroup
- nextWaveformSignalIdRef.current
- activeWaveformTabId

#### Bookmarks
- bookmarkManager.getBookmarks()

#### Server/KDB/Waveform
- serverHost, serverPort
- currentKdbName
- currentWaveName, useMockData

### 4. 恢复时的处理

#### Source Tab
- 使用 displayModuleIndex 获取 module
- 从 module.definition 获取 fileId, startLine, endLine
- 如果有 signalDeclarationLine，跳转到该行

#### Waveform Tab
- 通过 globalId 使用 kdbManager.buildSignal() 查找信号
- columnWidths, timeConfig 使用默认值
- waveformTimeUnit 从打开的波形获取

### 5. 错误处理
- KDB/波形找不到：弹窗要求重新选择
- 服务器连接失败：弹窗要求重新输入地址
- 信号找不到：跳过该信号

## 文件修改清单

1. `src/components/MenuBar.tsx` - 添加菜单项
2. `src/App.tsx` - 实现保存/恢复逻辑
3. `src/types/session.ts` - ✅ 已完成
4. `src/modules/session/sessionManager.ts` - ✅ 已完成
5. `src/components/SessionDialog.tsx` - ✅ 已完成
6. `src/components/SessionLoadingOverlay.tsx` - ✅ 已完成
