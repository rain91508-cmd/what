# Source Tab Signal Value Expansion - Design Specification

## Overview

在 Monaco Editor 的 Source Tab 中实现点击左侧展开按钮，显示当前行中所有信号在当前 cursor time 的值。

## Time Synchronization Strategy

### Cursor Time 来源

**同步策略：同步到最后一个 active 的 waveform tab 的 cursor position**

```
┌─────────────────────────────────────────────────────────────────┐
│                          App.tsx                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  tabs: Tab[]                                            │   │
│  │  - type: 'source' | 'waveform' | 'tableview'           │   │
│  │  - cursorPosition?: number  (LoD0Unit)                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌───────────────────────────┼─────────────────────────────┐   │
│  │                           ▼                             │   │
│  │  getLastActiveWaveformCursorTime(): number | undefined │   │
│  │  - 遍历所有 tabs                                        │   │
│  │  - 找到最后一个 active 过的 waveform tab               │   │
│  │  - 返回其 cursorPosition                               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  MonacoSourceCodeWindow                                 │   │
│  │  - currentTime: number (来自 last active waveform)     │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 实现细节

```typescript
// App.tsx 中增加 helper 函数
const getLastActiveWaveformCursorTime = (): number | undefined => {
  // 找到当前 active 的 waveform tab
  const currentWaveformTab = tabs.find(t => 
    t.id === activeTab && t.type === 'waveform'
  );
  
  if (currentWaveformTab?.cursorPosition !== undefined) {
    return currentWaveformTab.cursorPosition;
  }
  
  // 如果没有当前 active 的 waveform，找最近访问过的
  // 可以通过记录 tab 切换历史来实现
  return lastWaveformCursorTime;
};

// 传递给 MonacoSourceCodeWindow
<MonacoSourceCodeWindow
  currentTime={getLastActiveWaveformCursorTime()}
  // ...
/>
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    MonacoSourceCodeWindow                             │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Monaco Editor                                                  │ │
│  │  ┌─────────┐  ┌────────────────────────────────────────────┐  │ │
│  │  │         │  │ line 8:  input clk;   ← grayed out         │  │ │
│  │  │         │  │ line 9:  input rst;   ← grayed out         │  │ │
│  │  │ ▶ Glyph │  │ line 10: assign data = addr + 1;           │  │ │  ← display module range
│  │  │ Margin  │  │ line 11:   data <= #5 addr + offset;       │  │ │  (only here show expand)
│  │  │ (Click) │  │ line 12: end                               │  │ │
│  │  └─────────┘  └────────────────────────────────────────────┘  │ │
│  │         │                                                       │ │
│  │         ▼ onMouseDown(GUTTER_GLYPH_MARGIN)                      │ │
│  │         + Check: line in [moduleStartLine, moduleEndLine]?      │ │
│  │  ┌─────────────────────────────────────────────────────────┐   │ │
│  │  │  1. Extract signal identifiers from line                │   │ │
│  │  │  2. Lookup signal globalId via KDB Manager              │   │ │
│  │  │  3. Build full signal names                             │   │ │
│  │  │  4. Call getSignalValueAtTime for each signal           │   │ │
│  │  └─────────────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  ViewZone (展开区域)                                            │ │
│  │  ┌──────────────────────────────────────────────────────────┐ │ │
│  │  │ ⏱ Cursor Time: 1,250 ns (from last active waveform)     │ │ │
│  │  │ ─────────────────────────────────────────────────────── │ │ │
│  │  │ Signal          Value        Width   Radix              │ │ │
│  │  │ ─────────────────────────────────────────────────────── │ │ │
│  │  │ data            0xABCD       [31:0]  hex                │ │ │
│  │  │ addr            1024         [15:0]  dec                │ │ │
│  │  │ offset          0b1010       [3:0]   bin                │ │ │
│  │  └──────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  WaveformProviderAdapter                                        │ │
│  │  - get_signal_value_at_time(signalName, time, format)          │ │
│  │  - Returns: ValueInfo { displayStr, valueType, width }         │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

**关键限制：只在 display module 范围内支持展开功能**
- 使用 `moduleStartLine` 和 `moduleEndLine` 确定范围
- 范围外的行不显示展开按钮
- 点击范围外的 glyph margin 无响应（类似寻找 driver 的逻辑）

## Signal Lookup via KDB Manager

### 通过标识符查找 Signal Global ID

参考 `handleWordClick` 的实现，使用 `kdbManager.findSignalByName`：

```typescript
// 在 App.tsx 的 handleWordClick 中
const signalGlobalId = await kdbManager.findSignalByName(lookupModuleIndex, word);
if (signalGlobalId) {
  const signal = kdbManager.buildSignal(signalGlobalId);
  // signal contains: globalId, name, fullName, width, msb, lsb, etc.
}
```

### 实现步骤

```typescript
// Step 1: Extract identifiers from line
const extractIdentifiers = (lineContent: string): string[] => {
  const identifierRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
  const matches = lineContent.match(identifierRegex) || [];
  
  // Verilog keywords to exclude
  const keywords = new Set([
    'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
    'integer', 'real', 'parameter', 'localparam', 'assign', 'always', 'initial',
    'begin', 'end', 'if', 'else', 'case', 'casex', 'casez', 'endcase', 'for',
    'while', 'repeat', 'forever', 'posedge', 'negedge', 'or', 'and', 'not',
    'function', 'endfunction', 'task', 'endtask', 'generate', 'endgenerate',
    'specify', 'endspecify', 'primitive', 'endprimitive', 'table', 'endtable',
    'defparam', 'disable', 'force', 'release', 'fork', 'join', 'wait',
    'event', 'typedef', 'enum', 'struct', 'union', 'packed', 'signed', 'unsigned'
  ]);
  
  return [...new Set(matches.filter(id => !keywords.has(id)))];
};

// Step 2: Lookup each identifier in KDB
const lookupSignals = async (
  identifiers: string[],
  moduleIndex: number
): Promise<SignalInfo[]> => {
  const signals: SignalInfo[] = [];
  
  for (const id of identifiers) {
    const globalId = await kdbManager.findSignalByName(moduleIndex, id);
    if (globalId !== null) {
      const signal = kdbManager.buildSignal(globalId);
      if (signal) {
        signals.push({
          globalId,
          shortName: signal.name,
          fullName: signal.fullName,
          width: signal.msb !== signal.lsb ? signal.msb - signal.lsb + 1 : 1,
          msb: signal.msb,
          lsb: signal.lsb,
        });
      }
    }
  }
  
  return signals;
};
```

## Radix (Display Format) Selection

### 策略：使用信号在 Waveform Tab 中的当前 radix 设置

```
问题：如何确定每个信号使用哪种 radix 显示？

方案：从当前 active 的 waveform tab 中获取信号的 radix 设置
```

### 实现

```typescript
// 在 App.tsx 中，从 active waveform tab 获取 radix map
const getSignalRadixMap = (): Map<string, DisplayFormat> => {
  const activeWaveformTab = tabs.find(t => 
    t.id === activeTab && t.type === 'waveform'
  );
  
  if (!activeWaveformTab?.signalDisplayFormats) {
    return new Map();
  }
  
  // signalDisplayFormats: Record<unique_id, DisplayFormat>
  // Need to map unique_id -> signal name -> format
  const radixMap = new Map<string, DisplayFormat>();
  
  // Get signal names from the waveform tab's signals
  const signals = activeWaveformTab.signals || [];
  for (const signal of signals) {
    const format = activeWaveformTab.signalDisplayFormats[signal.unique_id];
    if (format) {
      radixMap.set(signal.name, format);
    }
  }
  
  return radixMap;
};

// 传递给 MonacoSourceCodeWindow
<MonacoSourceCodeWindow
  signalRadixMap={getSignalRadixMap()}
  // ...
/>
```

### Fallback 策略

如果信号不在 waveform tab 中，使用默认 radix：

```typescript
const getDefaultRadix = (width: number): DisplayFormat => {
  // Multi-bit signals: default to hex
  // Single-bit signals: default to bin (but display as 0/1)
  return width > 1 ? 'hex' : 'bin';
};
```

### ViewZone 显示

显示该信号当前使用的 radix，不显示所有 radix 选项：

```typescript
// ViewZone 表格
<table class="signal-value-table">
  <thead>
    <tr>
      <th>Signal</th>
      <th>Value</th>
      <th>Width</th>
      <th>Radix</th>  <!-- 显示当前使用的 radix -->
    </tr>
  </thead>
  <tbody>
    {signalValues.map(sig => (
      <tr key={sig.shortName}>
        <td>{sig.shortName}</td>
        <td>{sig.value}</td>
        <td>[{sig.msb}:{sig.lsb}]</td>
        <td>{sig.radix}</td>  <!-- hex/bin/oct/dec -->
      </tr>
    ))}
  </tbody>
</table>
```

## Implementation Steps

### Step 1: Extend MonacoSourceCodeWindow Props

```typescript
interface MonacoSourceCodeWindowProps {
  // ... existing props ...
  
  /**
   * Current cursor time from last active waveform tab (LoD0Unit)
   */
  currentTime?: number;
  
  /**
   * Waveform provider adapter for fetching signal values
   */
  providerAdapter?: WaveformProviderAdapter;
  
  /**
   * Signal radix map from active waveform tab
   * Key: signal full name, Value: display format
   */
  signalRadixMap?: Map<string, DisplayFormat>;
  
  /**
   * Current module index for signal lookup
   */
  lookupModuleIndex?: number;
}

interface SignalValueInfo {
  globalId: number;
  shortName: string;
  fullName: string;
  value: string;
  width: number;
  msb: number;
  lsb: number;
  radix: DisplayFormat;
  valueType: string;
}
```

### Step 2: State Management

```typescript
// 展开状态管理
const expandedLines = useRef<Set<number>>(new Set());
const viewZones = useRef<Record<number, string>>({});
const loadingLines = useRef<Set<number>>(new Set());
```

### Step 3: Glyph Margin Decoration (Only in Module Range)

只在 display module 范围内显示展开按钮：

```typescript
const EXPAND_ICON_CLASS = 'signal-expand-icon';
const COLLAPSE_ICON_CLASS = 'signal-collapse-icon';
const LOADING_ICON_CLASS = 'signal-loading-icon';

const updateExpandDecorations = useCallback(() => {
  if (!editorRef.current) return;
  
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  const model = editorRef.current.getModel();
  if (!model) return;
  
  const lineCount = model.getLineCount();
  
  // Determine the range to show expand icons
  // Only show within display module range (similar to driver lookup logic)
  const startLine = moduleStartLine || 1;
  const endLine = moduleEndLine || lineCount;
  
  for (let line = 1; line <= lineCount; line++) {
    // Only add decoration if within module range
    const isInModuleRange = line >= startLine && line <= endLine;
    
    if (!isInModuleRange) {
      // Outside module range: no decoration (or could add a disabled style)
      continue;
    }
    
    let className = EXPAND_ICON_CLASS;
    
    if (loadingLines.current.has(line)) {
      className = LOADING_ICON_CLASS;
    } else if (expandedLines.current.has(line)) {
      className = COLLAPSE_ICON_CLASS;
    }
    
    decorations.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        glyphMarginClassName: className,
      }
    });
  }
  
  decorationsRef.current = editorRef.current.deltaDecorations(
    decorationsRef.current,
    decorations
  );
}, [moduleStartLine, moduleEndLine]);
```

### Step 4: Handle Click Event (with Module Range Check)

类似寻找 driver 的逻辑，只在 display module 范围内支持展开功能：

```typescript
const handleEditorDidMount = useCallback((editor: editor.IStandaloneCodeEditor) => {
  editorRef.current = editor;
  
  const disposable = editor.onMouseDown((e: monaco.editor.IEditorMouseEvent) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      return;
    }
    
    const lineNumber = e.target.position?.lineNumber;
    if (!lineNumber) return;
    
    // Check if line is within display module range (same logic as driver lookup)
    if (moduleStartLine && moduleEndLine) {
      if (lineNumber < moduleStartLine || lineNumber > moduleEndLine) {
        console.log('[MonacoSourceCodeWindow] Click outside display module range:', lineNumber);
        return; // Silently ignore clicks outside module range
      }
    }
    
    toggleLineExpansion(lineNumber);
  });
  
  return () => {
    disposable.dispose();
  };
}, [moduleStartLine, moduleEndLine]);
```

### Step 5: Toggle Expansion

```typescript
const toggleLineExpansion = async (lineNumber: number) => {
  const isExpanded = expandedLines.current.has(lineNumber);
  
  if (isExpanded) {
    // Collapse
    removeViewZone(lineNumber);
    expandedLines.current.delete(lineNumber);
    updateExpandDecorations();
  } else {
    // Expand
    if (currentTime === undefined) {
      showNotification('No active waveform cursor time available');
      return;
    }
    
    if (!lookupModuleIndex) {
      showNotification('No module context available');
      return;
    }
    
    loadingLines.current.add(lineNumber);
    updateExpandDecorations();
    
    try {
      await expandLine(lineNumber);
      expandedLines.current.add(lineNumber);
    } finally {
      loadingLines.current.delete(lineNumber);
      updateExpandDecorations();
    }
  }
};
```

### Step 6: Expand Line - Full Implementation

```typescript
const expandLine = async (lineNumber: number) => {
  const editor = editorRef.current;
  if (!editor) return;
  
  // Get line content
  const model = editor.getModel();
  if (!model) return;
  
  const lineContent = model.getLineContent(lineNumber);
  
  // Extract identifiers
  const identifiers = extractIdentifiers(lineContent);
  if (identifiers.length === 0) {
    showNotification('No signals found in this line');
    return;
  }
  
  // Lookup signals in KDB
  const signals = await lookupSignals(identifiers, lookupModuleIndex!);
  if (signals.length === 0) {
    showNotification('No matching signals found in current module');
    return;
  }
  
  // Fetch values for each signal
  const signalValues: SignalValueInfo[] = [];
  
  for (const sig of signals) {
    // Get radix from waveform tab, or use default
    const radix = signalRadixMap?.get(sig.fullName) || 
                  (sig.width > 1 ? 'hex' : 'bin');
    
    try {
      const valueInfo = await providerAdapter?.get_signal_value_at_time(
        sig.fullName,
        currentTime!,
        radix
      );
      
      if (valueInfo) {
        signalValues.push({
          ...sig,
          value: valueInfo.displayStr,
          radix,
          valueType: valueInfo.valueType,
        });
      }
    } catch (err) {
      console.warn(`Failed to get value for ${sig.fullName}:`, err);
    }
  }
  
  if (signalValues.length === 0) {
    showNotification('No signal values available at current time');
    return;
  }
  
  // Create ViewZone
  createSignalValueViewZone(lineNumber, signalValues);
};
```

### Step 7: Create ViewZone

```typescript
const createSignalValueViewZone = (
  lineNumber: number,
  signalValues: SignalValueInfo[]
) => {
  const editor = editorRef.current;
  if (!editor) return;
  
  const domNode = document.createElement('div');
  domNode.className = 'signal-value-zone';
  
  // Format time display
  const timeDisplay = formatTimeDisplay(currentTime);
  
  let html = `
    <div class="signal-zone-header">
      <span class="time-icon">⏱</span>
      <span class="time-label">Cursor Time:</span>
      <span class="time-value">${timeDisplay}</span>
    </div>
    <table class="signal-value-table">
      <thead>
        <tr>
          <th>Signal</th>
          <th>Value</th>
          <th>Width</th>
          <th>Radix</th>
        </tr>
      </thead>
      <tbody>
  `;
  
  for (const sig of signalValues) {
    const valueClass = sig.valueType === 'has_x' ? 'value-x' : 
                       sig.valueType === 'has_z' ? 'value-z' : 'value-normal';
    const widthStr = sig.width > 1 ? `[${sig.msb}:${sig.lsb}]` : '[0]';
    
    html += `
      <tr>
        <td class="signal-name" title="${sig.fullName}">${sig.shortName}</td>
        <td class="signal-value ${valueClass}">${sig.value}</td>
        <td class="signal-width">${widthStr}</td>
        <td class="signal-radix">${sig.radix}</td>
      </tr>
    `;
  }
  
  html += '</tbody></table>';
  domNode.innerHTML = html;
  
  // Calculate height
  const rowHeight = 22;
  const headerHeight = 28;
  const heightInPx = headerHeight + signalValues.length * rowHeight + 16;
  
  editor.changeViewZones(accessor => {
    if (viewZones.current[lineNumber]) {
      accessor.removeZone(viewZones.current[lineNumber]);
    }
    
    const zoneId = accessor.addZone({
      afterLineNumber: lineNumber,
      heightInPx,
      domNode,
    });
    
    viewZones.current[lineNumber] = zoneId;
  });
};

const removeViewZone = (lineNumber: number) => {
  const editor = editorRef.current;
  if (!editor || !viewZones.current[lineNumber]) return;
  
  editor.changeViewZones(accessor => {
    accessor.removeZone(viewZones.current[lineNumber]);
    delete viewZones.current[lineNumber];
  });
};
```

### Step 8: CSS Styles

```css
/* Expand/Collapse Icons */
.monaco-editor .signal-expand-icon {
  background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="%23666" d="M6 4l4 4-4 4V4z"/></svg>') center no-repeat;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.2s;
}

.monaco-editor .signal-expand-icon:hover {
  opacity: 1;
}

.monaco-editor .signal-collapse-icon {
  background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="%231976d2" d="M4 6l4 4 4-4H4z"/></svg>') center no-repeat;
  cursor: pointer;
}

.monaco-editor .signal-loading-icon {
  background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" stroke="%23999" stroke-width="2" fill="none" stroke-dasharray="20" stroke-dashoffset="0"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></circle></svg>') center no-repeat;
}

/* ViewZone Styles */
.monaco-editor .signal-value-zone {
  background: linear-gradient(to right, #f8f9fa, #ffffff);
  border-left: 3px solid #1976d2;
  border-radius: 0 4px 4px 0;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  margin: 4px 0 4px 20px;
  padding: 8px 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
}

.signal-zone-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #e0e0e0;
  color: #666;
  font-size: 11px;
}

.signal-zone-header .time-value {
  color: #1976d2;
  font-weight: 600;
}

.signal-value-table {
  width: 100%;
  border-collapse: collapse;
}

.signal-value-table th {
  text-align: left;
  padding: 4px 8px;
  color: #999;
  font-size: 10px;
  font-weight: normal;
  text-transform: uppercase;
}

.signal-value-table td {
  padding: 4px 8px;
}

.signal-name {
  color: #1976d2;
  font-weight: 500;
}

.signal-value {
  font-weight: 600;
  font-family: 'Consolas', monospace;
}

.signal-value.value-x {
  color: #ff5722;
}

.signal-value.value-z {
  color: #ff9800;
}

.signal-value.value-normal {
  color: #333;
}

.signal-width, .signal-radix {
  color: #666;
  font-size: 10px;
}
```

## Integration with App.tsx

```typescript
// App.tsx modifications

// 1. Track last active waveform cursor time
const [lastWaveformCursorTime, setLastWaveformCursorTime] = useState<number | undefined>();

// 2. Update when waveform tab cursor changes
const handleCursorPositionChange = (position: number) => {
  setLastWaveformCursorTime(position);
  // ... existing logic
};

// 3. Build signal radix map from active waveform tab
const getSignalRadixMap = useCallback((): Map<string, DisplayFormat> => {
  const activeWaveformTab = tabs.find(t => 
    t.id === activeTab && t.type === 'waveform'
  );
  
  const radixMap = new Map<string, DisplayFormat>();
  
  if (activeWaveformTab?.signals && activeWaveformTab?.signalDisplayFormats) {
    for (const signal of activeWaveformTab.signals) {
      const format = activeWaveformTab.signalDisplayFormats[signal.unique_id];
      if (format) {
        radixMap.set(signal.name, format);
      }
    }
  }
  
  return radixMap;
}, [tabs, activeTab]);

// 4. Pass to MonacoSourceCodeWindow
<MonacoSourceCodeWindow
  currentTime={lastWaveformCursorTime}
  providerAdapter={providerAdapter}
  signalRadixMap={getSignalRadixMap()}
  lookupModuleIndex={activeTabData.displayModuleIndex || activeTabData.moduleIndex}
  // ...
/>
```

## Performance Considerations

### No Frontend Cache Needed

```
WASM 后端已经有完善的缓存机制：
- OPFS Cache (持久化缓存)
- Memory Cache (内存缓存)

因此前端不需要额外的 LRU Cache，直接调用 providerAdapter 即可。
```

### Debounced Time Updates

```typescript
// 当 cursor time 变化时，防抖刷新所有展开的 ViewZone
useEffect(() => {
  const timer = setTimeout(() => {
    refreshAllExpandedZones();
  }, 100);
  return () => clearTimeout(timer);
}, [currentTime]);

const refreshAllExpandedZones = async () => {
  for (const lineNumber of expandedLines.current) {
    await expandLine(lineNumber);
  }
};
```

## Error Handling

```typescript
const expandLine = async (lineNumber: number) => {
  try {
    // ... implementation
  } catch (err) {
    console.error('Failed to expand line:', err);
    showNotification('Failed to load signal values');
    
    // Remove from expanded lines on error
    expandedLines.current.delete(lineNumber);
  }
};
```

## Files to Modify

1. **MonacoSourceCodeWindow.tsx** - Main implementation
2. **App.tsx** - Pass cursor time, adapter, radix map, and lookup module index
3. **index.css** - Add styles for ViewZone and icons

## Testing Checklist

- [ ] Click expand icon shows signal values
- [ ] Click collapse icon hides ViewZone
- [ ] Values update when cursor time changes
- [ ] Correct radix is used from waveform tab
- [ ] Fallback radix works for signals not in waveform
- [ ] Handles X/Z values correctly
- [ ] Works correctly when switching between waveform tabs
- [ ] Loading state shown while fetching values
