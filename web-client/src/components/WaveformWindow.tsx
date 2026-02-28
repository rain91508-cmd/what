import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { waveformRenderer } from '../core/render/waveformRenderer';
import { cursorRenderer } from '../core/render/cursorRenderer';
import type { Viewport, Segment, Signal } from '../types';
import type { WaveformSignal, ColumnWidths, TimeConfig } from './TabPanel';
import { psToDisplayValue } from './TabPanel';
import { FilterInput } from './FilterInput';
import { wildcardMatch } from '../utils/wildcardMatch';
import { getOrCreateMockData, getValueAtTime } from '../utils/mockWaveformData';

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
  timeConfig?: TimeConfig;      // 时间配置
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

// 默认时间配置
// 默认 10ns/px = 10,000 ps/px
const DEFAULT_TIME_CONFIG: TimeConfig = {
  unitTimePs: 10000,  // 默认 10,000 ps/px (10 ns/px)
  unit: 'ns',
  pixelsPerUnit: 10,  // 固定 10 像素每单位
};

export function WaveformWindow({
  signals,
  groups,
  selectedGroup,
  columnWidths,
  timeConfig = DEFAULT_TIME_CONFIG,
  onSignalRemove,
  onGroupsUpdate,
  onSelectedGroupUpdate,
  onSignalsProcessed,
  onColumnWidthsChange,
}: WaveformWindowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const signalPanelRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  
  // 根据 canvas 宽度和时间配置计算 viewport
  const calculateViewport = useCallback((width: number): Viewport => {
    // 时间范围 = 宽度 / 每单位像素 * 单位时间(ps)
    const timeRange = (width / timeConfig.pixelsPerUnit) * timeConfig.unitTimePs;
    return {
      timeStart: 0,
      timeEnd: timeRange,
      signalStart: 0,
      signalEnd: 10,
      pixelsPerTime: 1,
      pixelsPerSignal: 24,
    };
  }, [timeConfig]);
  
  const [viewport, setViewport] = useState<Viewport>(() => calculateViewport(800));
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
  const [displayMouseX, setDisplayMouseX] = useState<number | null>(null); // Debounced for display
  const mouseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [nameFilter, setNameFilter] = useState('');
  const [ioFilters, setIoFilters] = useState<Set<string>>(new Set(['all']));
  const [showIoDropdown, setShowIoDropdown] = useState(false);
  const ioDropdownRef = useRef<HTMLDivElement>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // 使用 props 中的列宽，如果没有则使用默认值
  const widths = columnWidths || DEFAULT_COLUMN_WIDTHS;
  const hierarchyColumnWidth = widths.hierarchy;
  const nameColumnWidth = widths.name;
  const valueColumnWidth = widths.value;
  const signalPanelWidth = widths.panel;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ioDropdownRef.current && !ioDropdownRef.current.contains(event.target as Node)) {
        setShowIoDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Toggle IO filter
  const toggleIoFilter = (filter: string) => {
    const newFilters = new Set(ioFilters);
    if (filter === 'all') {
      setIoFilters(new Set(['all']));
    } else {
      newFilters.delete('all');
      if (newFilters.has(filter)) {
        newFilters.delete(filter);
        if (newFilters.size === 0) {
          setIoFilters(new Set(['all']));
        } else {
          setIoFilters(newFilters);
        }
      } else {
        newFilters.add(filter);
        setIoFilters(newFilters);
      }
    }
  };

  // Collect all display signals from all groups for rendering
  // Use useMemo to avoid creating new array reference on every render
  const displaySignals = useMemo(() => {
    return Object.values(groups).flatMap(g => g.signals);
  }, [groups]);

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
    const initRenderers = async () => {
      if (canvasRef.current && cursorCanvasRef.current) {
        await waveformRenderer.initialize(canvasRef.current);
        await cursorRenderer.initialize(cursorCanvasRef.current);
        renderWaveform();
      }
    };

    initRenderers();

    return () => {
      waveformRenderer.dispose();
      cursorRenderer.dispose();
    };
  }, []);

  // 监听窗口大小变化，更新 canvas 尺寸和 viewport
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && canvasRef.current && cursorCanvasRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        setCanvasWidth(width);
        canvasRef.current.width = width;
        canvasRef.current.height = height;
        cursorCanvasRef.current.width = width;
        cursorCanvasRef.current.height = height;
        waveformRenderer.resize(width, height);
        cursorRenderer.resize(width, height);
        // 根据新宽度重新计算 viewport
        setViewport(calculateViewport(width));
        renderWaveform();
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, selectedSignal, displaySignals]);

  // 监听时间配置变化，更新 viewport
  useEffect(() => {
    if (canvasWidth > 0) {
      setViewport(calculateViewport(canvasWidth));
      renderWaveform();
    }
  }, [timeConfig, canvasWidth, calculateViewport]);

  // Cleanup mouse timeout on unmount
  useEffect(() => {
    return () => {
      if (mouseTimeoutRef.current) {
        clearTimeout(mouseTimeoutRef.current);
      }
    };
  }, []);

  const renderWaveform = () => {
    if (!canvasRef.current) return;

    const { width, height } = canvasRef.current;

    // Generate segments from mock data - only for visible signals in treeNodes
    const segments: Segment[] = [];

    // Calculate row index for each signal, considering group rows
    let currentRow = 0;
    treeNodes.forEach((node) => {
      if (node.type === 'group') {
        // Group row - no waveform, just increment row counter
        currentRow++;
      } else if (node.type === 'signal' && node.signal) {
        // Signal row - render waveform from mock data
        const signalPath = node.signal.fullName || node.signal.name;
        const mockData = getOrCreateMockData(signalPath);
        
        // Get transitions within the viewport time range
        const visibleTransitions = mockData.transitions.filter(
          t => t.time >= viewport.timeStart && t.time <= viewport.timeEnd
        );
        
        if (visibleTransitions.length === 0) {
          // No transitions in viewport, show constant value
          const value = getValueAtTime(mockData, viewport.timeStart);
          segments.push({
            t0: viewport.timeStart,
            t1: viewport.timeEnd,
            row: currentRow,
            value,
          });
        } else {
          // Render transitions within viewport
          let lastTime = viewport.timeStart;
          let lastValue = getValueAtTime(mockData, viewport.timeStart);
          
          for (const transition of visibleTransitions) {
            // Add segment from lastTime to transition time
            if (lastTime < transition.time) {
              segments.push({
                t0: lastTime,
                t1: transition.time,
                row: currentRow,
                value: lastValue,
              });
            }
            lastTime = transition.time;
            lastValue = transition.value;
          }
          
          // Add final segment to timeEnd
          if (lastTime < viewport.timeEnd) {
            segments.push({
              t0: lastTime,
              t1: viewport.timeEnd,
              row: currentRow,
              value: lastValue,
            });
          }
        }
        currentRow++;
      }
    });

    // Reserve space for time ruler at top
    const rulerHeight = 20;

    // Set current time unit for renderer
    waveformRenderer.setTimeUnit(timeConfig.unit);

    waveformRenderer.render(segments, viewport, width, height, rulerHeight);

    // Note: cursorRenderer is updated separately in the rAF loop for smooth mouse following
  };

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = viewport.timeStart + (x / rect.width) * (viewport.timeEnd - viewport.timeStart);
    setCursor({ position: Math.round(time), visible: true });
  }, [viewport]);

  // Use refs for all cursor state to avoid dependency on React state in rAF loop
  const mousePosRef = useRef<number | null>(null);
  const cursorRef = useRef(cursor);
  const viewportRef = useRef(viewport);
  const timeConfigRef = useRef(timeConfig);
  const canvasWidthRef = useRef(canvasWidth);

  // Keep refs in sync with state
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    timeConfigRef.current = timeConfig;
  }, [timeConfig]);

  useEffect(() => {
    canvasWidthRef.current = canvasWidth;
  }, [canvasWidth]);

  // RequestAnimationFrame loop for smooth cursor updates
  // This loop directly updates cursorRenderer using refs (no React state dependency)
  useEffect(() => {
    let animationId: number;

    const updateCursor = () => {
      // Always update cursorRenderer with latest refs
      if (cursorRenderer.isInitialized()) {
        cursorRenderer.updateState({
          cursor: cursorRef.current,
          mouseX: mousePosRef.current,
          viewport: {
            timeStart: viewportRef.current.timeStart,
            timeEnd: viewportRef.current.timeEnd,
          },
          timeUnit: timeConfigRef.current.unit,
          containerWidth: canvasWidthRef.current,
          rulerHeight: 20,
        });
      }

      animationId = requestAnimationFrame(updateCursor);
    };

    animationId = requestAnimationFrame(updateCursor);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, []); // No dependencies - uses refs for all state

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const newMouseX = e.clientX - rect.left;

    // Update ref immediately (no re-render)
    mousePosRef.current = newMouseX;

    // Also update mouseX for other purposes (like click handling and info bar)
    setMouseX(newMouseX);
    setDisplayMouseX(newMouseX);
  }, []);

  const handleCanvasMouseLeave = useCallback(() => {
    mousePosRef.current = null;
    setMouseX(null);
    setDisplayMouseX(null);
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
    if (signal.msb !== signal.lsb) {
      return `${signal.name}[${signal.msb}:${signal.lsb}]`;
    }
    return signal.name;
  };

  const getSignalValue = (signal: Signal) => {
    return signalValues[signal.fullName] || '0x0';
  };

  const getHierarchyDisplay = (signal: Signal): string => {
    // 返回完整信号路径（去掉信号名本身）
    const parts = signal.fullName.split('.');
    if (parts.length <= 1) return '-';
    // 去掉最后一部分（信号名），保留前面的路径
    parts.pop();
    return parts.join('.') || '-';
  };

  const matchesIOFilter = (signal: Signal): boolean => {
    if (ioFilters.has('all')) return true;
    const dirName = signal.direction === 0 ? 'input' : signal.direction === 1 ? 'output' : signal.direction === 2 ? 'inout' : 'internal';
    return ioFilters.has(dirName);
  };

  const matchesNameFilter = (signal: Signal): boolean => {
    if (!nameFilter.trim()) return true;
    const pattern = nameFilter;
    return wildcardMatch(pattern, signal.name) ||
           wildcardMatch(pattern, signal.fullName);
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
          <FilterInput
            value={nameFilter}
            onChange={setNameFilter}
            placeholder="Filter..."
            storageKey="waveform_filter_history"
            style={{
              height: '22px',
              fontSize: '11px',
            }}
          />
          <div ref={ioDropdownRef} style={{ position: 'relative', flexShrink: 0 }}>
            <div
              onClick={() => setShowIoDropdown(!showIoDropdown)}
              style={{
                padding: '2px 4px',
                fontSize: '11px',
                border: '1px solid #c0c0c0',
                borderRadius: '2px',
                height: '22px',
                boxSizing: 'border-box',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                minWidth: '70px',
                justifyContent: 'space-between',
                backgroundColor: 'white',
              }}
            >
              <span>{ioFilters.has('all') ? 'All' : Array.from(ioFilters).map(f => f.charAt(0).toUpperCase() + f.slice(1, 3)).join(', ')}</span>
              <span style={{ fontSize: '8px' }}>▼</span>
            </div>
            {showIoDropdown && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: '2px',
                  backgroundColor: 'white',
                  border: '1px solid #c0c0c0',
                  borderRadius: '2px',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                  zIndex: 1000,
                  minWidth: '100px',
                }}
              >
                {['all', 'input', 'output', 'inout', 'internal'].map(filter => (
                  <div
                    key={filter}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleIoFilter(filter);
                    }}
                    style={{
                      padding: '4px 8px',
                      fontSize: '11px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      backgroundColor: ioFilters.has(filter) ? '#e3f2fd' : 'white',
                    }}
                  >
                    <span style={{ width: '12px', textAlign: 'center' }}>
                      {ioFilters.has(filter) ? '✓' : ''}
                    </span>
                    <span>{filter === 'all' ? 'All' : filter === 'inout' ? 'InOut' : filter.charAt(0).toUpperCase() + filter.slice(1)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
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
        <div
          className="waveform-signal-list"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Delete' && selectedSignal) {
              // Find the selected signal and remove it
              const signalToRemove = displaySignals.find(s => s.unique_id === selectedSignal);
              if (signalToRemove) {
                handleRemoveSignal(signalToRemove);
                setSelectedSignal(null);
              }
            }
          }}
          style={{ outline: 'none' }}
        >
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
                    {/* Scope column - 右对齐，显示完整路径，字体加大黑色 */}
                    <span
                      style={{
                        width: hierarchyColumnWidth,
                        fontSize: '12px',
                        color: '#000',
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        borderRight: '1px solid #e0e0e0',
                        height: '100%',
                        textAlign: 'right',
                        paddingRight: '4px',
                        direction: 'rtl',
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
                        cursor: signal.msb !== signal.lsb ? 'pointer' : 'default'
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (signal.msb !== signal.lsb) {
                          toggleSignalExpand(signal.unique_id);
                        }
                      }}
                      >
                        {signal.msb !== signal.lsb ? (expandedSignals.has(signal.unique_id) ? '▼' : '▶') : ''}
                      </span>
                      
                      <span className="waveform-signal-name">
                        {getSignalDisplayName(signal)}
                      </span>
                    </span>
                    
                    {/* Value column - 右对齐，字体加大黑色 */}
                    <span
                      className="waveform-signal-value"
                      style={{
                        flex: 1,
                        display: 'flex',
                        justifyContent: 'flex-end',
                        alignItems: 'center',
                        paddingRight: '8px',
                      }}
                    >
                      <span style={{
                        textAlign: 'right',
                        fontSize: '12px',
                        color: '#000',
                        fontWeight: 500,
                      }}>
                        {getSignalValue(signal)}
                      </span>
                    </span>
                  </div>
                  
                  {expandedSignals.has(signal.unique_id) && signal.msb !== signal.lsb && (
                    <div className="waveform-bus-bits">
                      {Array.from({ length: Math.min(signal.msb - signal.lsb + 1, 32) }, (_, i) => {
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
                              {renderTreeConnectors([...node.parentNodes, { level: node.level, isLast: i === Math.min(signal.msb - signal.lsb + 1, 32) - 1 }])}
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
              Cursor: {Math.round(psToDisplayValue(cursor.position, timeConfig.unit))} {timeConfig.unit}
            </span>
          )}
          
          {/* Mouse name and time - using debounced displayMouseX for value */}
          {displayMouseX !== null && mouseX !== null && (
            <span style={{
              position: 'absolute',
              left: `${(mouseX / (containerRef.current?.clientWidth || 1)) * 100}%`,
              transform: 'translateX(4px)',
              color: '#00ffff',
              fontWeight: 'bold',
              zIndex: 2,
            }}>
              Mouse: {Math.round(psToDisplayValue(viewport.timeStart + (displayMouseX / (containerRef.current?.clientWidth || 1)) * (viewport.timeEnd - viewport.timeStart), timeConfig.unit))} {timeConfig.unit}
            </span>
          )}
        </div>
        
        {/* Waveform canvas layers - double buffered for performance */}
        <div style={{ position: 'relative', flex: 1 }}>
          {/* Waveform layer (bottom) - heavy rendering */}
          <canvas
            ref={canvasRef}
            className="waveform-canvas"
            style={{ 
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              display: 'block',
              cursor: 'crosshair',
              background: selectedSignal ? '#f8f8ff' : '#fff',
            }}
            onClick={handleCanvasClick}
            onMouseMove={handleCanvasMouseMove}
            onMouseLeave={handleCanvasMouseLeave}
          />
          {/* Cursor layer (top) - lightweight overlay */}
          <canvas
            ref={cursorCanvasRef}
            className="cursor-canvas"
            style={{ 
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              display: 'block',
              pointerEvents: 'none', // Let events pass through to waveform canvas
            }}
          />
        </div>
      </div>
    </div>
  );
}
