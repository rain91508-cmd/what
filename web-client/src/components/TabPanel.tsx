import { ReactNode, useState, useRef, useEffect } from 'react';
import type { Instance, Signal } from '../types';

interface SignalGroup {
  id: string;
  name: string;
  parentId: string | null;
  signals: Array<Signal & { uniqueId: string }>;
  expanded: boolean;
  children: string[];
}

// Signal with unique ID for waveform tabs
export interface WaveformSignal extends Signal {
  unique_id: number;  // 全局唯一 ID，用于标识信号实例
}

// 列宽配置
export interface ColumnWidths {
  hierarchy: number;  // Scope 列宽
  name: number;       // Name 列宽
  value: number;      // Value 列宽
  panel: number;      // 信号面板宽度
}

export interface Tab {
  id: string;
  label: string;
  type: 'source' | 'waveform';
  // Tab-specific data
  instance?: Instance | null;  // For source tabs
  signals?: WaveformSignal[];  // For waveform tabs - 待添加到 group 的信号队列
  groups?: Record<string, SignalGroup>;  // For waveform tabs - group structure
  selectedGroup?: string;       // For waveform tabs - currently selected group
  columnWidths?: ColumnWidths;  // For waveform tabs - 列宽配置
}

interface TabPanelProps {
  activeTab: string;
  onTabChange: (tabId: string) => void;
  tabs: Tab[];
  onTabClose: (tabId: string) => void;
  onTabRename: (tabId: string, newLabel: string) => void;
  children: ReactNode;
}

export function TabPanel({ 
  activeTab, 
  onTabChange, 
  tabs, 
  onTabClose,
  onTabRename,
  children 
}: TabPanelProps) {
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingTab && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTab]);

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

  return (
    <div className="tab-panel">
      <div className="tab-header">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
            onDoubleClick={() => handleDoubleClick(tab)}
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
      <div className="tab-content">
        {children}
      </div>
    </div>
  );
}
