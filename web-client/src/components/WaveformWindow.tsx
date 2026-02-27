import { useEffect, useRef, useState, useCallback } from 'react';
import { waveformRenderer } from '../core/render/waveformRenderer';
import type { Viewport, Segment, Signal } from '../types';
import type { WaveformSignal, ColumnWidths } from './TabPanel';

interface SignalGroup {
  id: string;
  name: string;
  parentId: string | null;
  signals: Array<Signal & { unique_id: number }>;  // 使用全局唯一的数字 ID
  expanded: boolean;
  children: string[];
}

interface WaveformWindowProps {
  signals: WaveformSignal[];  // 待添加到 group 的信号队列，每个信号已有 unique_id
  groups: Record<string, SignalGroup>;
  selectedGroup: string;
  columnWidths?: ColumnWidths;  // 列宽配置
  onSignalRemove: (signal: Signal & { unique_id: number }) => void;
  onGroupsUpdate: (groups: Record<string, SignalGroup>) => void;
  onSelectedGroupUpdate: (selectedGroup: string) => void;
  onSignalsProcessed: (processedIds: number[]) => void;  // 通知父组件已处理的信号 ID
  onColumnWidthsChange?: (widths: ColumnWidths) => void;  // 列宽变化回调
}

interface CursorState {
  position: number;
  visible: boolean;
}

interface TreeNode {
  type: 'group' | 'signal';
  group?: SignalGroup;
  signal?: Signal;
  level: number;
  isLast: boolean;
  parentNodes: { level: number; isLast: boolean }[];
}

// 默认列宽配置
const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  hierarchy: 60,
  name: 120,
  value: 80,
  panel: 200,
};

export function WaveformWindow({
  signals,
  groups,
  selectedGroup,
  columnWidths,
  onSignalRemove,
  onGroupsUpdate,
  onSelectedGroupUpdate,
  onSignalsProcessed,
  onColumnWidthsChange,
}: WaveformWindowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const signalPanelRef = useRef<HTMLDivElement>(null);
  const [viewport] = useState<Viewport>({
    timeStart: 0,
    timeEnd: 1000,
    signalStart: 0,
    signalEnd: 10,
    pixelsPerTime: 1,
    pixelsPerSignal: 24,
  });
  const [signalValues] = useState<Record<string, string>>({
    'top.clk': '1',
    'top.rst_n': '0',
    'top.data_in': '0x1234',
    'top.data_out': '0xABCD',
    'top.state': '0x3',
    'top.counter': '0x00FF',
  });
  const [selectedSignal, setSelectedSignal] = useState<number | null>(null);
  const [expandedSignals, setExpandedSignals] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<CursorState>({ position: 500, visible: true });
  const [mouseX, setMouseX] = useState<number | null>(null);
  const [nameFilter, setNameFilter] = useState('');
  const [ioFilter, setIoFilter] = useState<'all' | 'input' | 'output' | 'inout' | 'internal'>('all');
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // 使用 props 中的列宽，如果没有则使用默认值
  const widths = columnWidths || DEFAULT_COLUMN_WIDTHS;
  const hierarchyColumnWidth = widths.hierarchy;
  const nameColumnWidth = widths.name;
  const valueColumnWidth = widths.value;
  const signalPanelWidth = widths.panel;

  // Collect all display signals from all groups for rendering
  const displaySignals = Object.values(groups).flatMap(g => g.signals);

  // 处理待添加的信号队列 - 直接添加到选中的 group，然后通知父组件删除
  useEffect(() => {
    if (signals.length === 0) return;

    // 所有待处理的信号都有 unique_id，直接添加到选中的 group
    const newSignals = signals.map(s => ({
      ...s,
      unique_id: s.unique_id,
    }));

    // 添加到选中的 group
    onGroupsUpdate({
      ...groups,
      [selectedGroup]: {
        ...groups[selectedGroup],
        signals: [...groups[selectedGroup].signals, ...newSignals],
      },
    });

    // 通知父组件这些信号已处理，可以从 signals 队列中删除
    const processedIds = signals.map(s => s.unique_id);
    onSignalsProcessed(processedIds);
  }, [signals, selectedGroup, onGroupsUpdate, onSignalsProcessed]);

  useEffect(() => {
    const initRenderer = async () => {
      if (canvasRef.current) {
        await waveformRenderer.initialize(canvasRef.current);
        renderWaveform();
      }
    };

    initRenderer();

    return () => {
      waveformRenderer.dispose();
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && canvasRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        canvasRef.current.width = width;
        canvasRef.current.height = height;
        waveformRenderer.resize(width, height);
        renderWaveform();
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [groups, cursor, mouseX, selectedSignal, displaySignals]);

  const renderWaveform = () => {
    if (!canvasRef.current) return;

    const { width, height } = canvasRef.current;

    // Generate mock segments - only for visible signals in treeNodes
    const segments: Segment[] = [];
    const timeStep = (viewport.timeEnd - viewport.timeStart) / 20;

    // Calculate row index for each signal, considering group rows
    let currentRow = 0;
    treeNodes.forEach((node) => {
      if (node.type === 'group') {
        // Group row - no waveform, just increment row counter
        currentRow++;
      } else if (node.type === 'signal' && node.signal) {
        // Signal row - render waveform
        let currentTime = viewport.timeStart;
        let currentValue = 0;

        while (currentTime < viewport.timeEnd) {
          const nextTime = currentTime + timeStep;
          segments.push({
            t0: currentTime,
            t1: nextTime,
            row: currentRow,
            value: currentValue,
          });

          currentTime = nextTime;
          currentValue = currentValue === 0 ? 1 : 0;
        }
        currentRow++;
      }
    });

    // Reserve space for time ruler at top
    const rulerHeight = 20;
    waveformRenderer.render(segments, viewport, width, height, rulerHeight);

    const ctx = canvasRef.current.getContext('2d');
    if (ctx && cursor.visible) {
      const cursorX = ((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * width;
      ctx.strokeStyle = '#ff00ff';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(cursorX, rulerHeight);
      ctx.lineTo(cursorX, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (mouseX !== null && ctx) {
      ctx.strokeStyle = '#00aa00';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mouseX, rulerHeight);
      ctx.lineTo(mouseX, height);
      ctx.stroke();
    }
  };

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = viewport.timeStart + (x / rect.width) * (viewport.timeEnd - viewport.timeStart);
    setCursor({ position: Math.round(time), visible: true });
  }, [viewport]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    setMouseX(e.clientX - rect.left);
  }, []);

  const handleCanvasMouseLeave = useCallback(() => {
    setMouseX(null);
  }, []);

  const handleColumnResize = (column: 'hierarchy' | 'name' | 'value', e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidths = { hierarchy: hierarchyColumnWidth, name: nameColumnWidth, value: valueColumnWidth };

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      let newWidths: ColumnWidths | null = null;

      if (column === 'hierarchy') {
        const newWidth = Math.max(40, Math.min(150, startWidths.hierarchy + delta));
        newWidths = { ...widths, hierarchy: newWidth };
      } else if (column === 'name') {
        const newWidth = Math.max(80, Math.min(250, startWidths.name + delta));
        newWidths = { ...widths, name: newWidth };
      } else if (column === 'value') {
        const newWidth = Math.max(50, Math.min(200, startWidths.value + delta));
        newWidths = { ...widths, value: newWidth };
      }

      if (newWidths && onColumnWidthsChange) {
        onColumnWidthsChange(newWidths);
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleSignalPanelResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = signalPanelWidth;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(150, Math.min(400, startWidth + delta));

      if (onColumnWidthsChange) {
        onColumnWidthsChange({ ...widths, panel: newWidth });
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  // Handle signal removal - remove only the specific instance by unique_id
  const handleRemoveSignal = (signal: Signal & { unique_id: number }) => {
    // Remove from groups
    const newGroups = { ...groups };
    Object.keys(newGroups).forEach(groupId => {
      newGroups[groupId] = {
        ...newGroups[groupId],
        signals: newGroups[groupId].signals.filter(s => s.unique_id !== signal.unique_id),
      };
    });
    onGroupsUpdate(newGroups);

    // Notify parent
    onSignalRemove(signal);
  };

  const toggleGroupExpand = (groupId: string) => {
    onGroupsUpdate({
      ...groups,
      [groupId]: {
        ...groups[groupId],
        expanded: !groups[groupId].expanded,
      },
    });
  };

  const addGroup = (parentId: string, asSibling: boolean = false) => {
    const newId = `group_${Date.now()}`;
    const targetParentId = asSibling ? (groups[parentId]?.parentId || 'root') : parentId;
    const groupCount = Object.keys(groups).filter(id => id !== 'root').length;
    
    const newGroup: SignalGroup = {
      id: newId,
      name: `Group_${groupCount + 1}`,
      parentId: targetParentId,
      signals: [],
      expanded: true,
      children: [],
    };

    onGroupsUpdate({
      ...groups,
      [newId]: newGroup,
      [targetParentId]: {
        ...groups[targetParentId],
        children: [...groups[targetParentId].children, newId],
      },
    });

    onSelectedGroupUpdate(newId);
  };

  const deleteGroup = (groupId: string) => {
    if (groupId === 'root') return;
    
    const group = groups[groupId];
    if (!group) return;

    const parentId = group.parentId || 'root';
    const parentGroup = groups[parentId];
    
    // Check if this is the last child of its parent
    const isLastChild = parentGroup && parentGroup.children.length === 1 && parentGroup.children[0] === groupId;
    
    if (isLastChild) {
      // If this is the last child, only clear signals but keep the group
      onGroupsUpdate({
        ...groups,
        [groupId]: {
          ...groups[groupId],
          signals: [],
          children: [],
        },
      });
    } else {
      // Otherwise, delete the group completely
      const newGroups = { ...groups };
      
      // Remove from parent's children
      newGroups[parentId] = {
        ...newGroups[parentId],
        children: newGroups[parentId].children.filter(id => id !== groupId),
      };
      
      // Remove the group
      delete newGroups[groupId];
      
      onGroupsUpdate(newGroups);
      onSelectedGroupUpdate(parentId);
    }
  };

  const startRenameGroup = (groupId: string) => {
    setEditingGroup(groupId);
    setEditName(groups[groupId].name);
  };

  const finishRenameGroup = () => {
    if (editingGroup && editName.trim()) {
      onGroupsUpdate({
        ...groups,
        [editingGroup]: {
          ...groups[editingGroup],
          name: editName.trim(),
        },
      });
    }
    setEditingGroup(null);
    setEditName('');
  };

  const toggleSignalExpand = (unique_id: number) => {
    const newExpanded = new Set(expandedSignals);
    if (newExpanded.has(unique_id)) {
      newExpanded.delete(unique_id);
    } else {
      newExpanded.add(unique_id);
    }
    setExpandedSignals(newExpanded);
  };

  const getSignalDisplayName = (signal: Signal) => {
    if (signal.bitWidth > 1) {
      return `${signal.name}[${signal.msb}:${signal.lsb}]`;
    }
    return signal.name;
  };

  const getSignalValue = (signal: Signal) => {
    return signalValues[signal.fullPath] || '0x0';
  };

  const getHierarchyDisplay = (signal: Signal): string => {
    // Extract hierarchy from fullPath
    const parts = signal.fullPath.split('.');
    if (parts.length <= 1) return '-';
    // Return the second to last part (parent instance)
    return parts[parts.length - 2] || '-';
  };

  const matchesIOFilter = (signal: Signal): boolean => {
    if (ioFilter === 'all') return true;
    if (ioFilter === 'input') return signal.direction === 0;
    if (ioFilter === 'output') return signal.direction === 1;
    if (ioFilter === 'inout') return signal.direction === 2;
    if (ioFilter === 'internal') return signal.direction === 3;
    return true;
  };

  const matchesNameFilter = (signal: Signal): boolean => {
    if (!nameFilter.trim()) return true;
    const pattern = nameFilter.toLowerCase();
    return signal.name.toLowerCase().includes(pattern) ||
           signal.fullPath.toLowerCase().includes(pattern);
  };

  // Build tree structure - hide root, but show its direct children (top-level groups)
  const buildTreeNodes = (groupId: string, level: number, parentNodes: { level: number; isLast: boolean }[]): TreeNode[] => {
    const group = groups[groupId];
    if (!group) return [];

    const nodes: TreeNode[] = [];
    const isRoot = groupId === 'root';
    
    // Only hide root, show all other groups including top-level groups
    if (!isRoot) {
      nodes.push({
        type: 'group',
        group: group,
        level,
        isLast: false,
        parentNodes: [...parentNodes],
      });
    }

    // Process children if expanded
    // For root, always process children (to show top-level groups)
    const shouldProcessChildren = isRoot || group.expanded;
    
    if (shouldProcessChildren) {
      const childGroups = group.children.map(childId => groups[childId]).filter(Boolean);
      const filteredSignals = group.signals.filter(s => matchesIOFilter(s) && matchesNameFilter(s));
      const allItems = [...childGroups, ...filteredSignals];

      allItems.forEach((item, index) => {
        const isLast = index === allItems.length - 1;
        // For root, don't increase level (top-level groups start at level 0)
        const newLevel = isRoot ? level : level + 1;
        const newParentNodes = isRoot
          ? [...parentNodes] 
          : [...parentNodes, { level, isLast: index === allItems.length - 1 }];

        if ('children' in item) {
          nodes.push(...buildTreeNodes(item.id, newLevel, newParentNodes));
        } else {
          nodes.push({
            type: 'signal',
            signal: item as Signal,
            level: newLevel,
            isLast,
            parentNodes: newParentNodes,
          });
        }
      });
    }

    return nodes;
  };

  const treeNodes = buildTreeNodes('root', 0, []);

  const renderTreeConnectors = (parentNodes: { level: number; isLast: boolean }[]) => {
    return parentNodes.map((node, index) => (
      <span
        key={index}
        style={{
          display: 'inline-block',
          width: '12px',
          height: '20px',
          position: 'relative',
        }}
      >
        {!node.isLast && (
          <span
            style={{
              position: 'absolute',
              left: '5px',
              top: '0',
              width: '1px',
              height: '100%',
              borderLeft: '1px dashed #c0c0c0',
            }}
          />
        )}
        <span
          style={{
            position: 'absolute',
            left: '5px',
            top: '10px',
            width: '7px',
            height: '1px',
            borderTop: '1px dashed #c0c0c0',
          }}
        />
      </span>
    ));
  };

  return (
    <div className="waveform-container">
      <div 
        className="waveform-signal-panel" 
        ref={signalPanelRef}
        style={{ width: signalPanelWidth }}
      >
        {/* Filter bar */}
        <div style={{
          height: '30px',
          padding: '4px',
          borderBottom: '1px solid #d0d0d0',
          background: '#f0f0f0',
          display: 'flex',
          gap: '4px',
          alignItems: 'center',
          boxSizing: 'border-box',
        }}>
          <input
            type="text"
            placeholder="Filter..."
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            style={{
              flex: 1,
              padding: '2px 4px',
              fontSize: '10px',
              border: '1px solid #c0c0c0',
              borderRadius: '2px',
            }}
          />
          <select
            value={ioFilter}
            onChange={(e) => setIoFilter(e.target.value as any)}
            style={{
              padding: '2px 4px',
              fontSize: '10px',
              border: '1px solid #c0c0c0',
              borderRadius: '2px',
              width: '70px',
            }}
          >
            <option value="all">All</option>
            <option value="input">Input</option>
            <option value="output">Output</option>
            <option value="inout">InOut</option>
            <option value="internal">Internal</option>
          </select>
        </div>

        {/* Header with 3 columns and visible dividers */}
        <div className="waveform-header" style={{ display: 'flex', position: 'relative', borderBottom: '1px solid #c0c0c0', height: '22px', boxSizing: 'border-box' }}>
          <span style={{ width: hierarchyColumnWidth, paddingLeft: '4px', fontSize: '10px', borderRight: '1px solid #c0c0c0' }}>Scope</span>
          <span style={{ width: nameColumnWidth, paddingLeft: '4px', borderRight: '1px solid #c0c0c0' }}>Name</span>
          <span style={{ 
            flex: 1,
            textAlign: 'right',
            paddingRight: '4px',
          }}>Value</span>
          
          {/* Resizers - positioned on the right edge of each column */}
          <div
            style={{
              position: 'absolute',
              left: hierarchyColumnWidth,
              top: 0,
              width: '4px',
              height: '100%',
              cursor: 'col-resize',
              backgroundColor: 'transparent',
              zIndex: 10,
              marginLeft: '-2px',
            }}
            onMouseDown={(e) => handleColumnResize('hierarchy', e)}
          />
          <div
            style={{
              position: 'absolute',
              left: hierarchyColumnWidth + nameColumnWidth,
              top: 0,
              width: '4px',
              height: '100%',
              cursor: 'col-resize',
              backgroundColor: 'transparent',
              zIndex: 10,
              marginLeft: '-2px',
            }}
            onMouseDown={(e) => handleColumnResize('name', e)}
          />
        </div>
        
        {/* Group and signal list */}
        <div className="waveform-signal-list">
          {treeNodes.map((node) => {
            if (node.type === 'group' && node.group) {
              const group = node.group;
              const isSelected = selectedGroup === group.id;
              
              return (
                <div key={group.id}>
                  <div 
                    className={`waveform-group-header ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      // Toggle selection: if already selected, deselect (set to root)
                      if (selectedGroup === group.id) {
                        onSelectedGroupUpdate('root');
                      } else {
                        onSelectedGroupUpdate(group.id);
                      }
                    }}
                    style={{ 
                      display: 'flex',
                      alignItems: 'center',
                      paddingLeft: '4px',
                    }}
                  >
                    {/* Scope column - empty for groups */}
                    <span style={{ 
                      width: hierarchyColumnWidth,
                      borderRight: '1px solid #e0e0e0',
                      height: '100%',
                    }}></span>
                    
                    {/* Name column with tree structure */}
                    <span style={{ 
                      width: nameColumnWidth,
                      display: 'flex',
                      alignItems: 'center',
                      paddingLeft: `${node.level * 12}px`,
                      borderRight: '1px solid #e0e0e0',
                      height: '100%',
                    }}>
                      {renderTreeConnectors(node.parentNodes)}
                      <span 
                        style={{ cursor: 'pointer', marginRight: '2px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroupExpand(group.id);
                        }}
                      >
                        {group.expanded ? '▼' : '▶'}
                      </span>
                      
                      {editingGroup === group.id ? (
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={finishRenameGroup}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') finishRenameGroup();
                            if (e.key === 'Escape') {
                              setEditingGroup(null);
                              setEditName('');
                            }
                          }}
                          autoFocus
                          style={{
                            width: '80px',
                            fontSize: '11px',
                            padding: '1px 2px',
                            border: '1px solid #4080c0',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span 
                          style={{ fontWeight: 600 }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            startRenameGroup(group.id);
                          }}
                          title="Double-click to rename"
                        >
                          {group.name}
                        </span>
                      )}
                      
                      <span style={{ marginLeft: '8px', fontSize: '9px', color: '#666' }}>
                        ({group.signals.length + group.children.length})
                      </span>
                    </span>
                    
                    {/* Value column - empty for groups */}
                    <span style={{ flex: 1 }}></span>
                    
                    {/* Action buttons */}
                    <span style={{ display: 'flex', gap: '2px', marginLeft: '4px' }}>
                      <button
                        style={{
                          fontSize: '9px',
                          padding: '1px 3px',
                          border: '1px solid #c0c0c0',
                          background: isSelected ? '#d0e0f0' : '#f0f0f0',
                          cursor: 'pointer',
                          borderRadius: '2px',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          addGroup(group.id, false);
                        }}
                        title="Add child group"
                      >
                        +↓
                      </button>
                      <button
                        style={{
                          fontSize: '9px',
                          padding: '1px 3px',
                          border: '1px solid #c0c0c0',
                          background: isSelected ? '#d0e0f0' : '#f0f0f0',
                          cursor: 'pointer',
                          borderRadius: '2px',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          addGroup(group.id, true);
                        }}
                        title="Add sibling group"
                      >
                        +→
                      </button>
                      <button
                        style={{
                          fontSize: '9px',
                          padding: '1px 3px',
                          border: '1px solid #c0c0c0',
                          background: '#f0f0f0',
                          cursor: 'pointer',
                          borderRadius: '2px',
                          color: '#cc0000',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteGroup(group.id);
                        }}
                        title="Delete group"
                      >
                        ×
                      </button>
                    </span>
                  </div>
                </div>
              );
            } else if (node.type === 'signal' && node.signal) {
              const signal = node.signal as Signal & { unique_id: number };
              const isSelected = selectedSignal === signal.unique_id;

              return (
                <div key={signal.unique_id}>
                  <div
                    className={`waveform-signal-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedSignal(signal.unique_id)}
                    style={{ 
                      display: 'flex',
                      alignItems: 'center',
                      paddingLeft: '4px',
                    }}
                  >
                    {/* Scope column */}
                    <span 
                      style={{ 
                        width: hierarchyColumnWidth,
                        fontSize: '10px',
                        color: '#666',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        borderRight: '1px solid #e0e0e0',
                        height: '100%',
                      }}
                      title={getHierarchyDisplay(signal)}
                    >
                      {getHierarchyDisplay(signal)}
                    </span>
                    
                    {/* Name column with tree structure */}
                    <span style={{ 
                      width: nameColumnWidth,
                      display: 'flex',
                      alignItems: 'center',
                      paddingLeft: `${node.level * 12}px`,
                      borderRight: '1px solid #e0e0e0',
                      height: '100%',
                    }}>
                      {renderTreeConnectors(node.parentNodes)}
                      
                      <span style={{ 
                        width: '14px',
                        cursor: signal.bitWidth > 1 ? 'pointer' : 'default'
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (signal.bitWidth > 1) {
                          toggleSignalExpand(signal.unique_id);
                        }
                      }}
                      >
                        {signal.bitWidth > 1 ? (expandedSignals.has(signal.unique_id) ? '▼' : '▶') : ''}
                      </span>
                      
                      <span className="waveform-signal-name">
                        {getSignalDisplayName(signal)}
                      </span>
                    </span>
                    
                    {/* Value column */}
                    <span 
                      className="waveform-signal-value"
                      style={{ 
                        flex: 1,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span></span>
                      <span>{getSignalValue(signal)}</span>
                      <span
                        className="waveform-signal-remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveSignal(signal);
                        }}
                        title="Remove signal"
                      >
                        ×
                      </span>
                    </span>
                  </div>
                  
                  {expandedSignals.has(signal.unique_id) && signal.bitWidth > 1 && (
                    <div className="waveform-bus-bits">
                      {Array.from({ length: Math.min(signal.bitWidth, 32) }, (_, i) => {
                        const bitIndex = signal.msb - i;
                        return (
                          <div
                            key={i}
                            className="waveform-bus-bit"
                            style={{ 
                              display: 'flex',
                              alignItems: 'center',
                              paddingLeft: '4px',
                            }}
                          >
                            {/* Scope column - empty for bus bits */}
                            <span style={{ 
                              width: hierarchyColumnWidth,
                              borderRight: '1px solid #e0e0e0',
                              height: '100%',
                            }}></span>
                            
                            {/* Name column with tree structure */}
                            <span style={{ 
                              width: nameColumnWidth,
                              display: 'flex',
                              alignItems: 'center',
                              paddingLeft: `${(node.level + 1) * 12}px`,
                              borderRight: '1px solid #e0e0e0',
                              height: '100%',
                            }}>
                              {renderTreeConnectors([...node.parentNodes, { level: node.level, isLast: i === Math.min(signal.bitWidth, 32) - 1 }])}
                              <span style={{ width: '14px' }}></span>
                              <span className="waveform-signal-name">
                                {signal.name}[{bitIndex}]
                              </span>
                            </span>
                            
                            {/* Value column */}
                            <span className="waveform-signal-value" style={{ flex: 1 }}>
                              {Math.random() > 0.5 ? '1' : '0'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }
            return null;
          })}
          
          {displaySignals.length === 0 && (
            <div style={{
              padding: '20px',
              textAlign: 'center',
              color: '#999',
              fontSize: '11px',
            }}>
              No signals added
            </div>
          )}
        </div>
      </div>

      {/* Resizer between signal panel and canvas */}
      <div
        className="panel-resizer"
        onMouseDown={handleSignalPanelResize}
        title="Drag to resize"
      >
        <div className="panel-resizer-handle" />
      </div>

      <div className="waveform-canvas-container" ref={containerRef} style={{ display: 'flex', flexDirection: 'column' }}>
        {/* Cursor/Marker info bar - corresponds to left filter bar (30px) */}
        <div style={{
          height: '30px',
          background: '#1a1a1a',
          borderBottom: '1px solid #404040',
          flexShrink: 0,
          position: 'relative',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          fontSize: '13px',
          fontFamily: 'Consolas, Monaco, monospace',
        }}>
          {/* Cursor vertical line */}
          {cursor.visible && (
            <div style={{
              position: 'absolute',
              left: `${((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * 100}%`,
              top: 0,
              bottom: 0,
              width: '1px',
              background: '#ff00ff',
              zIndex: 1,
            }} />
          )}
          
          {/* Mouse vertical line */}
          {mouseX !== null && (
            <div style={{
              position: 'absolute',
              left: `${(mouseX / (containerRef.current?.clientWidth || 1)) * 100}%`,
              top: 0,
              bottom: 0,
              width: '1px',
              background: '#00ffff',
              zIndex: 1,
            }} />
          )}
          
          {/* Cursor name and time */}
          {cursor.visible && (
            <span style={{
              position: 'absolute',
              left: `${((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * 100}%`,
              transform: 'translateX(4px)',
              color: '#ffffff',
              fontWeight: 'bold',
              zIndex: 2,
            }}>
              Cursor: {cursor.position}
            </span>
          )}
          
          {/* Mouse name and time */}
          {mouseX !== null && (
            <span style={{
              position: 'absolute',
              left: `${(mouseX / (containerRef.current?.clientWidth || 1)) * 100}%`,
              transform: 'translateX(4px)',
              color: '#00ffff',
              fontWeight: 'bold',
              zIndex: 2,
            }}>
              Mouse: {Math.round(viewport.timeStart + (mouseX / (containerRef.current?.clientWidth || 1)) * (viewport.timeEnd - viewport.timeStart))}
            </span>
          )}
        </div>
        
        {/* Waveform canvas */}
        <canvas
          ref={canvasRef}
          className="waveform-canvas"
          style={{ 
            display: 'block',
            cursor: 'crosshair',
            background: selectedSignal ? '#f8f8ff' : '#fff',
            flex: 1,
          }}
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={handleCanvasMouseLeave}
        />
      </div>
    </div>
  );
}
