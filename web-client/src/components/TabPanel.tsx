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
  timeUnit: number;
  signalCount: number;
}

// 列宽配置
export interface ColumnWidths {
  hierarchy: number;  // Scope 列宽
  name: number;       // Name 列宽
  value: number;      // Value 列宽
  panel: number;      // 信号面板宽度
}

// 时间单位类型
export type TimeUnit = 'ps' | 'ns' | 'us' | 'ms' | 's';

// 时间单位转换乘数（转换为 ps）
export const TIME_UNIT_MULTIPLIERS: Record<TimeUnit, number> = {
  ps: 1,
  ns: 1000,
  us: 1000000,
  ms: 1000000000,
  s: 1000000000000,
};

// 时间配置
// 内部存储的单位时间始终是整数 ps
// 显示时根据 unit 进行转换
export interface TimeConfig {
  unitTimePs: number;    // 单位时间（整数 ps/px）
  unit: TimeUnit;        // 显示用的时间单位
  pixelsPerUnit: number; // 每个时间单位的像素宽度（固定为10）
}

/**
 * 将显示值转换为 ps
 * @param displayValue 显示的值（根据 unit）
 * @param unit 时间单位
 * @returns 对应的 ps 值（整数）
 */
export function displayValueToPs(displayValue: number, unit: TimeUnit): number {
  return Math.max(1, Math.floor(displayValue * TIME_UNIT_MULTIPLIERS[unit]));
}

/**
 * 将 ps 转换为显示值
 * @param psValue ps 值
 * @param unit 目标时间单位
 * @returns 显示值
 */
export function psToDisplayValue(psValue: number, unit: TimeUnit): number {
  return psValue / TIME_UNIT_MULTIPLIERS[unit];
}

export interface Tab {
  id: string;
  label: string;
  type: 'source' | 'waveform';
  // Tab-specific data
  moduleIndex?: number | null;  // For source tabs - 1-based module index
  startFromLine1?: boolean;     // For source tabs - open from line 1 instead of module start line
  signalDeclarationLine?: number; // For source tabs - jump to signal declaration line
  signals?: WaveformSignal[];  // For waveform tabs - 待添加到 group 的信号队列
  groups?: Record<string, SignalGroup>;  // For waveform tabs - group structure
  selectedGroup?: string;       // For waveform tabs - currently selected group
  columnWidths?: ColumnWidths;  // For waveform tabs - 列宽配置
  timeConfig?: TimeConfig;      // For waveform tabs - 时间配置
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
