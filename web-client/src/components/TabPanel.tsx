import { ReactNode, useState, useRef, useEffect } from 'react';
import type { Signal } from '../types';

interface SignalGroup {
  id: string;
  name: string;
  parentId: string | null;
  signals: Array<Signal & { unique_id: number }>;
  expanded: boolean;
  children: string[];
}

// Signal with unique ID for waveform tabs
export interface WaveformSignal extends Signal {
  unique_id: number;  // 全局唯一 ID，用于标识信号实例
}

// Waveform info from server
export interface WaveformInfo {
  name: string;
  file: string;
  timeRange: { start: number; end: number };
  timeUnit: number;        // 数字枚举 (0=fs, 1=ps, 2=ns, 3=us, 4=ms, 5=s)
  timeUnitStr: string;     // 原始字符串如 "1ps", "3ns"
  signalCount: number;
}

// 列宽配置
export interface ColumnWidths {
  hierarchy: number;  // Scope 列宽
  name: number;       // Name 列宽
  value: number;      // Value 列宽
  panel: number;      // 信号面板宽度
}

// WaveformInfo.timeUnit 转换（服务器返回的是数字枚举）
// 0=fs, 1=ps, 2=ns, 3=us, 4=ms, 5=s
// 以 fs 为基准单位
export const WAVEFORM_TIME_UNIT_MULTIPLIERS = [
  1,           // fs
  1000,        // ps = 1000 fs
  1000000,     // ns = 1000000 fs
  1000000000,  // us = 1000000000 fs
  1000000000000,  // ms = 1000000000000 fs
  1000000000000000, // s = 1000000000000000 fs
];

// 时间单位字符串到数字枚举的映射
const TIME_UNIT_STR_TO_ENUM: Record<string, number> = {
  'fs': 0,
  'ps': 1,
  'ns': 2,
  'us': 3,
  'ms': 4,
  's': 5,
};

// 时间单位字符串到乘数的映射（转换为 fs）
// 以 fs 为基准单位
const TIME_UNIT_STR_TO_MULTIPLIER: Record<string, number> = {
  'fs': 1,
  'ps': 1000,
  'ns': 1000000,
  'us': 1000000000,
  'ms': 1000000000000,
  's': 1000000000000000,
};

/**
 * 解析服务器返回的 time_unit 字符串（如 "1ps", "3ns"）
 * @param timeUnitStr 时间单位字符串，如 "1ps", "3ns"
 * @returns { value: number, unit: string, fsMultiplier: number, unitEnum: number }
 */
export function parseTimeUnitStr(timeUnitStr: string): { 
  value: number; 
  unit: string; 
  fsMultiplier: number; 
  unitEnum: number;
} {
  // 匹配数字部分和单位部分
  const match = timeUnitStr.match(/^(\d+)\s*(fs|ps|ns|us|ms|s)$/i);
  if (!match) {
    // 默认返回 1ns
    return { value: 1, unit: 'ns', fsMultiplier: 1000000, unitEnum: 2 };
  }
  
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const fsMultiplier = TIME_UNIT_STR_TO_MULTIPLIER[unit] * value;
  const unitEnum = TIME_UNIT_STR_TO_ENUM[unit] ?? 2;
  
  return { value, unit, fsMultiplier, unitEnum };
}

/**
 * 将 WaveformInfo.timeUnit 转换为 ps 乘数
 * @deprecated 使用 parseTimeUnitStr 获取更精确的 psMultiplier
 */
export function timeUnitToPsMultiplier(timeUnit: number): number {
  return WAVEFORM_TIME_UNIT_MULTIPLIERS[timeUnit] || 1000;
}

// 时间配置
// 内部使用 LoD0Unit（整数），显示使用 DisplayUnit（纯数字）
export interface TimeConfig {
  DisplayUnitPerLoD0Unit: number;  // 每个 DisplayUnit 对应多少个 LoD0Unit
                                   // 默认 1，表示 1 DisplayUnit = 1 LoD0Unit
  // 内部预计算的倒数，用于快速乘法转换
  _displayPerLod0?: number;        // 1 / DisplayUnitPerLoD0Unit
}

/**
 * 初始化 TimeConfig，预计算倒数
 */
export function initTimeConfig(
  displayUnitPerLoD0Unit: number
): TimeConfig {
  return {
    DisplayUnitPerLoD0Unit: displayUnitPerLoD0Unit,
    _displayPerLod0: 1 / displayUnitPerLoD0Unit,
  };
}

/**
 * LoD0Unit → DisplayUnit（使用预计算的倒数，乘法比除法快）
 * @param lod0Units LoD0Unit 值（整数）
 * @param timeConfig 时间配置
 * @returns DisplayUnit 值（纯数字，不带单位）
 */
export function lod0ToDisplay(lod0Units: number, timeConfig: TimeConfig): number {
  const multiplier = timeConfig._displayPerLod0 ?? (1 / timeConfig.DisplayUnitPerLoD0Unit);
  return lod0Units * multiplier;
}

/**
 * DisplayUnit → LoD0Unit（取整）
 * @param displayUnits DisplayUnit 值
 * @param timeConfig 时间配置
 * @returns LoD0Unit 值（整数）
 */
export function displayToLod0(displayUnits: number, timeConfig: TimeConfig): number {
  return Math.floor(displayUnits * timeConfig.DisplayUnitPerLoD0Unit);
}

/**
 * LoD0Unit → Real Time fs（绝对时间，以 fs 为单位）
 * LoD0Unit = time_unit (服务器返回的时间单位)
 * @param lod0Units LoD0Unit 值（整数）
 * @param waveformTimeUnit WaveformInfo.timeUnit（服务器返回的数字枚举）
 * @returns 绝对时间（fs）
 */
export function lod0ToFs(lod0Units: number, waveformTimeUnit: number): number {
  return lod0Units * WAVEFORM_TIME_UNIT_MULTIPLIERS[waveformTimeUnit];
}

/**
 * LoD0Unit → Real Time fs（绝对时间）- 支持 timeUnitStr
 * LoD0Unit = time_unit (服务器返回的时间单位)
 * @param lod0Units LoD0Unit 值（整数）
 * @param waveformTimeUnit WaveformInfo.timeUnit（服务器返回的数字枚举）
 * @param waveformTimeUnitStr WaveformInfo.timeUnitStr（如 "1ps", "3ns"）
 * @returns 绝对时间（fs）
 */
export function lod0ToFsWithStr(
  lod0Units: number,
  waveformTimeUnit: number,
  waveformTimeUnitStr?: string
): number {
  if (waveformTimeUnitStr) {
    const parsed = parseTimeUnitStr(waveformTimeUnitStr);
    return lod0Units * parsed.fsMultiplier;
  }
  return lod0ToFs(lod0Units, waveformTimeUnit);
}

/**
 * Real Time fs → LoD0Unit（取整）
 * LoD0Unit = time_unit (服务器返回的时间单位)
 * @param fs 绝对时间（fs）
 * @param waveformTimeUnit WaveformInfo.timeUnit（服务器返回的数字枚举）
 * @returns LoD0Unit 值（整数）
 */
export function fsToLod0(fs: number, waveformTimeUnit: number): number {
  return Math.floor(fs / WAVEFORM_TIME_UNIT_MULTIPLIERS[waveformTimeUnit]);
}

/**
 * Real Time fs → LoD0Unit（取整）- 支持 timeUnitStr
 * @param fs 绝对时间（fs）
 * @param waveformTimeUnit WaveformInfo.timeUnit（服务器返回的数字枚举）
 * @param waveformTimeUnitStr WaveformInfo.timeUnitStr（如 "1ps", "3ns"）
 * @returns LoD0Unit 值（整数）
 */
export function fsToLod0WithStr(
  fs: number,
  waveformTimeUnit: number,
  waveformTimeUnitStr?: string
): number {
  if (waveformTimeUnitStr) {
    const parsed = parseTimeUnitStr(waveformTimeUnitStr);
    return Math.floor(fs / parsed.fsMultiplier);
  }
  return fsToLod0(fs, waveformTimeUnit);
}

/**
 * LoD0Unit → Real Time PS（绝对时间）
 * @param lod0Units LoD0Unit 值（整数）
 * @param waveformTimeUnit WaveformInfo.timeUnit（服务器返回的数字枚举）
 * @returns 绝对时间（ps）
 * @deprecated 使用 lod0ToFs 或 lod0ToFsWithStr
 */
export function lod0ToPs(lod0Units: number, waveformTimeUnit: number): number {
  return Math.floor(lod0ToFs(lod0Units, waveformTimeUnit) / 1000);
}

/**
 * Real Time PS → LoD0Unit（取整）
 * @param ps 绝对时间（ps）
 * @param waveformTimeUnit WaveformInfo.timeUnit（服务器返回的数字枚举）
 * @returns LoD0Unit 值（整数）
 * @deprecated 使用 fsToLod0 或 fsToLod0WithStr
 */
export function psToLod0(ps: number, waveformTimeUnit: number): number {
  return fsToLod0(ps * 1000, waveformTimeUnit);
}

// 保留旧函数用于兼容（标记为废弃）
/** @deprecated 使用新的 lod0ToDisplay 或 displayToLod0 */
export type TimeUnit = 'ps' | 'ns' | 'us' | 'ms' | 's';

/** @deprecated 使用新的时间单位体系 */
export const TIME_UNIT_MULTIPLIERS: Record<TimeUnit, number> = {
  ps: 1,
  ns: 1000,
  us: 1000000,
  ms: 1000000000,
  s: 1000000000000,
};

/** @deprecated 使用 lod0ToDisplay */
export function psToDisplayValue(psValue: number, _unit: TimeUnit): number {
  // 临时兼容，实际应该使用 lod0ToDisplay
  return psValue;
}

/** @deprecated 使用 displayToLod0 */
export function displayValueToPs(displayValue: number, _unit: TimeUnit): number {
  // 临时兼容，实际应该使用 displayToLod0
  return Math.floor(displayValue);
}

// Navigation history entry for source tabs
export interface NavigationHistoryEntry {
  fileId: number;
  line: number;
  timestamp: number;
  displayModuleIndex?: number;  // Displayed module for source context
}

export interface Tab {
  id: string;
  label: string;
  type: 'source' | 'waveform';
  // Tab-specific data
  moduleIndex?: number | null;  // For source tabs - 1-based module index (selected instance)
  displayModuleIndex?: number | null; // For source tabs - 1-based module index (displayed instance, e.g., def_module)
  fileId?: number | null;       // For source tabs - file ID (for loading file directly when displayModuleIndex is 0)
  startFromLine1?: boolean;     // For source tabs - open from line 1 instead of module start line
  signalDeclarationLine?: number; // For source tabs - jump to signal declaration line
  moduleStartLine?: number;     // For source tabs - module definition start line (display range)
  moduleEndLine?: number;       // For source tabs - module definition end line (display range)
  // Source navigation history
  navigationHistory?: NavigationHistoryEntry[];
  navigationPointer?: number;   // Points to next insertion position
  signals?: WaveformSignal[];  // For waveform tabs - 待添加到 group 的信号队列
  groups?: Record<string, SignalGroup>;  // For waveform tabs - group structure
  selectedGroup?: string;       // For waveform tabs - currently selected group
  columnWidths?: ColumnWidths;  // For waveform tabs - 列宽配置
  timeConfig?: TimeConfig;      // For waveform tabs - 时间配置
  waveformTimeUnit?: number;    // For waveform tabs - WaveformInfo.timeUnit (0=fs, 1=ps, 2=ns, 3=us, 4=ms, 5=s), default 2 (ns)
  // Viewport state for waveform tabs (time in LoD0Unit)
  viewport?: {
    timeStart: number;  // LoD0Unit
    timeEnd: number;    // LoD0Unit
  };
  cursorPosition?: number;  // LoD0Unit, cursor position for zoom operations
  // Waveform total range (for sanity check and boundary validation)
  // If user sets custom range, use that; otherwise use server returned range
  waveformRange?: {
    start: number;  // LoD0Unit - total start time of waveform
    end: number;    // LoD0Unit - total end time of waveform
  };
}

interface TabPanelProps {
  activeTab: string;
  onTabChange: (tabId: string) => void;
  tabs: Tab[];
  onTabClose: (tabId: string) => void;
  onTabRename: (tabId: string, newLabel: string) => void;
  onTabsReorder?: (newTabs: Tab[]) => void;  // 新增：Tab 重新排序回调
  children: ReactNode;
}

export function TabPanel({ 
  activeTab, 
  onTabChange, 
  tabs, 
  onTabClose,
  onTabRename,
  onTabsReorder,
  children 
}: TabPanelProps) {
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);
  const [showTabList, setShowTabList] = useState(false);
  const [visibleTabCount, setVisibleTabCount] = useState(tabs.length);
  const inputRef = useRef<HTMLInputElement>(null);
  const tabHeaderRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingTab && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTab]);

  // 计算可见的 Tab 数量
  useEffect(() => {
    const calculateVisibleTabs = () => {
      if (!tabHeaderRef.current) return;
      
      const headerWidth = tabHeaderRef.current.clientWidth;
      const tabListButtonWidth = 30; // Tab 列表按钮宽度
      const availableWidth = headerWidth - tabListButtonWidth;
      
      // 估算每个 tab 的平均宽度
      const avgTabWidth = 100;
      const count = Math.floor(availableWidth / avgTabWidth);
      
      setVisibleTabCount(Math.max(1, Math.min(count, tabs.length)));
    };

    calculateVisibleTabs();
    window.addEventListener('resize', calculateVisibleTabs);
    return () => window.removeEventListener('resize', calculateVisibleTabs);
  }, [tabs.length]);

  // 点击外部关闭 Tab 列表
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (tabListRef.current && !tabListRef.current.contains(event.target as Node)) {
        setShowTabList(false);
      }
    };

    if (showTabList) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showTabList]);

  const handleDoubleClick = (tab: Tab) => {
    setEditingTab(tab.id);
    setEditValue(tab.label);
  };

  const handleRenameSubmit = () => {
    if (editingTab && editValue.trim()) {
      onTabRename(editingTab, editValue.trim());
    }
    setEditingTab(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setEditingTab(null);
    }
  };

  // 拖拽开始
  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    setDraggedTab(tabId);
    e.dataTransfer.effectAllowed = 'move';
    // 设置拖拽时的透明图像
    const dragImage = document.createElement('div');
    dragImage.style.background = 'transparent';
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);
  };

  // 拖拽经过
  const handleDragOver = (e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    if (draggedTab && draggedTab !== tabId) {
      setDragOverTab(tabId);
    }
  };

  // 拖拽离开
  const handleDragLeave = () => {
    setDragOverTab(null);
  };

  // 拖拽放下
  const handleDrop = (e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    setDragOverTab(null);
    
    if (draggedTab && draggedTab !== targetTabId && onTabsReorder) {
      const newTabs = [...tabs];
      const dragIndex = newTabs.findIndex(t => t.id === draggedTab);
      const dropIndex = newTabs.findIndex(t => t.id === targetTabId);
      
      if (dragIndex !== -1 && dropIndex !== -1) {
        const [removed] = newTabs.splice(dragIndex, 1);
        newTabs.splice(dropIndex, 0, removed);
        onTabsReorder(newTabs);
      }
    }
    setDraggedTab(null);
  };

  // 拖拽结束
  const handleDragEnd = () => {
    setDraggedTab(null);
    setDragOverTab(null);
  };

  // 处理 Tab 列表选择
  const handleTabListSelect = (tabId: string) => {
    // 将选中的 Tab 移到第一个位置
    if (onTabsReorder) {
      const newTabs = [...tabs];
      const selectedIndex = newTabs.findIndex(t => t.id === tabId);
      if (selectedIndex > 0) {
        const [selected] = newTabs.splice(selectedIndex, 1);
        newTabs.unshift(selected);
        onTabsReorder(newTabs);
      }
    }
    onTabChange(tabId);
    setShowTabList(false);
  };

  // 获取可见的 Tabs（前 N 个）
  const visibleTabs = tabs.slice(0, visibleTabCount);
  const hiddenTabs = tabs.slice(visibleTabCount);

  return (
    <div className="tab-panel">
      <div className="tab-header" ref={tabHeaderRef} style={{ display: 'flex', alignItems: 'center' }}>
        {/* Tab 列表按钮 */}
        <div 
          ref={tabListRef}
          style={{ position: 'relative' }}
        >
          <button
            className="tab-list-button"
            onClick={() => setShowTabList(!showTabList)}
            style={{
              padding: '4px 8px',
              border: '1px solid #c0c0c0',
              borderRadius: '2px',
              background: '#f0f0f0',
              cursor: 'pointer',
              fontSize: '11px',
              marginRight: '4px',
            }}
            title="Tab List"
          >
            ☰
          </button>
          
          {/* Tab 列表下拉菜单 */}
          {showTabList && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                backgroundColor: '#fff',
                border: '1px solid #c0c0c0',
                borderRadius: '2px',
                zIndex: 1000,
                minWidth: '150px',
                maxHeight: '200px',
                overflowY: 'auto',
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
              }}
            >
              {tabs.map((tab, index) => (
                <div
                  key={tab.id}
                  onClick={() => handleTabListSelect(tab.id)}
                  style={{
                    padding: '6px 12px',
                    fontSize: '11px',
                    cursor: 'pointer',
                    borderBottom: index < tabs.length - 1 ? '1px solid #f0f0f0' : 'none',
                    backgroundColor: activeTab === tab.id ? '#4080c0' : '#fff',
                    color: activeTab === tab.id ? '#fff' : '#000',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  onMouseEnter={(e) => {
                    if (activeTab !== tab.id) {
                      (e.target as HTMLDivElement).style.backgroundColor = '#f0f0f0';
                      (e.target as HTMLDivElement).style.color = '#000';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (activeTab !== tab.id) {
                      (e.target as HTMLDivElement).style.backgroundColor = '#fff';
                    }
                  }}
                >
                  {tab.label}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 可见的 Tabs */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {visibleTabs.map(tab => (
            <div
              key={tab.id}
              className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => onTabChange(tab.id)}
              onDoubleClick={() => handleDoubleClick(tab)}
              draggable
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={(e) => handleDragOver(e, tab.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, tab.id)}
              onDragEnd={handleDragEnd}
              style={{
                opacity: draggedTab === tab.id ? 0.5 : 1,
                borderTop: dragOverTab === tab.id ? '2px solid #4080c0' : undefined,
              }}
            >
              {editingTab === tab.id ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={handleRenameSubmit}
                  onKeyDown={handleKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  className="tab-rename-input"
                />
              ) : (
                <>
                  <span className="tab-label">{tab.label}</span>
                  <span 
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTabClose(tab.id);
                    }}
                  >
                    ×
                  </span>
                </>
              )}
            </div>
          ))}
        </div>

        {/* 隐藏的 Tab 数量指示器 */}
        {hiddenTabs.length > 0 && (
          <div
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              color: '#666',
              background: '#f0f0f0',
              borderRadius: '2px',
              marginLeft: '4px',
            }}
            title={`${hiddenTabs.length} more tabs`}
          >
            +{hiddenTabs.length}
          </div>
        )}
      </div>
      <div className="tab-content">
        {children}
      </div>
    </div>
  );
}
