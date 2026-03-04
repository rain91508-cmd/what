import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { waveformRenderer } from '../core/render/waveformRenderer';
import { mockDataProvider } from '../core/data/mockDataProvider';
import type { Viewport, Signal } from '../types';
import type { WaveformSignal, ColumnWidths, TimeConfig } from './TabPanel';
import { lod0ToDisplay, initTimeConfig } from './TabPanel';
import type { SignalInfo, DisplayFormat } from '../types/dataProvider';
import { FilterInput } from './FilterInput';
import { wildcardMatch } from '../utils/wildcardMatch';

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
  viewport?: Viewport;          // 外部控制的 viewport（可选）
  onViewportChange?: (viewport: Viewport) => void;  // viewport 变化回调
  cursorPosition?: number;      // 外部控制的 cursor 位置（可选）
  onCursorPositionChange?: (position: number) => void;  // cursor 位置变化回调
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
// DisplayUnitPerLoD0Unit = 1 表示 1 DisplayUnit = 1 LoD0Unit
const DEFAULT_TIME_CONFIG: TimeConfig = initTimeConfig(1, 3);

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
  viewport: externalViewport,
  onViewportChange,
  cursorPosition: externalCursorPosition,
  onCursorPositionChange,
}: WaveformWindowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const signalPanelRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  
  // 根据 canvas 宽度和时间配置计算 viewport
  // 所有时间值使用 LoD0Unit（整数）
  const calculateViewport = useCallback((width: number): Viewport => {
    // viewport 能显示的 LoD0Unit 数量 = 宽度 >> pixels2LoD0UnitShift
    const lod0UnitCount = width >> timeConfig.pixels2LoD0UnitShift;
    return {
      timeStart: 0,           // LoD0Unit
      timeEnd: lod0UnitCount, // LoD0Unit
      signalStart: 0,
      signalEnd: 10,
      pixelsPerTime: 1,
      pixelsPerSignal: 24,
    };
  }, [timeConfig]);
  
  // 使用外部 viewport 或内部 state
  const [internalViewport, setInternalViewport] = useState<Viewport>(() => calculateViewport(800));
  const viewport = externalViewport ?? internalViewport;
  const setViewport = useCallback((newViewport: Viewport | ((prev: Viewport) => Viewport)) => {
    if (externalViewport === undefined) {
      setInternalViewport(newViewport);
    }
    if (onViewportChange) {
      const resolvedViewport = typeof newViewport === 'function' 
        ? newViewport(viewport) 
        : newViewport;
      onViewportChange(resolvedViewport);
    }
  }, [externalViewport, onViewportChange, viewport]);
  
  // 使用外部 cursorPosition 或内部 state
  const [internalCursor, setInternalCursor] = useState<CursorState>({ position: 500, visible: true });
  const cursor = externalCursorPosition !== undefined 
    ? { position: externalCursorPosition, visible: true }
    : internalCursor;
  const setCursor = useCallback((newCursor: CursorState | ((prev: CursorState) => CursorState)) => {
    if (externalCursorPosition === undefined) {
      setInternalCursor(newCursor);
    }
    if (onCursorPositionChange) {
      const resolvedCursor = typeof newCursor === 'function'
        ? newCursor(cursor)
        : newCursor;
      onCursorPositionChange(resolvedCursor.position);
    }
  }, [externalCursorPosition, onCursorPositionChange, cursor]);
  
  // 信号值（由 DataProvider 根据 cursor 位置提供）
  const [signalValues, setSignalValues] = useState<Map<string, string>>(new Map());
  const [selectedSignal, setSelectedSignal] = useState<number | null>(null);
  const [expandedSignals, setExpandedSignals] = useState<Set<number>>(new Set());
  // cursor state is now managed above with external support
  const [mouseX, setMouseX] = useState<number | null>(null);
  const [displayMouseX, setDisplayMouseX] = useState<number | null>(null); // Debounced for display
  // rAF-throttled mouse position for rendering (separate from state for performance)
  const [renderMouseX, setRenderMouseX] = useState<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingMouseXRef = useRef<number | null>(null);
  const mouseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [nameFilter, setNameFilter] = useState('');
  const [ioFilters, setIoFilters] = useState<Set<string>>(new Set(['all']));
  const [showIoDropdown, setShowIoDropdown] = useState(false);
  const ioDropdownRef = useRef<HTMLDivElement>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // 拖动选择放大功能的状态
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<number | null>(null);
  const selectionStartRef = useRef<number | null>(null);

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

  // rAF-throttled mouse position update for smooth rendering
  useEffect(() => {
    const updateRenderMouseX = () => {
      if (pendingMouseXRef.current !== null) {
        setRenderMouseX(pendingMouseXRef.current);
        pendingMouseXRef.current = null;
      }
      rafIdRef.current = requestAnimationFrame(updateRenderMouseX);
    };
    
    rafIdRef.current = requestAnimationFrame(updateRenderMouseX);
    
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
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
      if (canvasRef.current) {
        await waveformRenderer.initialize(canvasRef.current);
        renderWaveform();
      }
    };

    initRenderers();

    return () => {
      waveformRenderer.dispose();
    };
  }, []);

  // 监听窗口大小变化，更新 canvas 尺寸
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && canvasRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        setCanvasWidth(width);
        canvasRef.current.width = width;
        canvasRef.current.height = height;
        waveformRenderer.resize(width, height);
        // 只更新 canvas 尺寸，不重置 viewport
        renderWaveform();
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
    // 注意：不依赖 groups/selectedSignal/displaySignals，避免加入信号时重置 view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听时间配置变化，更新 viewport（保留当前时间范围）
  useEffect(() => {
    if (canvasWidth > 0 && externalViewport === undefined) {
      // 保留当前的 timeStart/timeEnd，只更新其他属性
      setViewport(prev => ({
        ...prev,
        signalStart: 0,
        signalEnd: 10,
        pixelsPerTime: 1,
        pixelsPerSignal: 24,
      }));
    }
    // 注意：不监听 timeConfig，避免重置时间范围
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasWidth, externalViewport, setViewport]);

  // 监听 viewport 变化，重新渲染波形
  useEffect(() => {
    if (canvasWidth > 0) {
      renderWaveform();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, groups, selectedSignal, displaySignals, expandedSignals]);

  // Cleanup mouse timeout on unmount
  useEffect(() => {
    return () => {
      if (mouseTimeoutRef.current) {
        clearTimeout(mouseTimeoutRef.current);
      }
    };
  }, []);

  // 监听 cursor 变化，更新信号值
  useEffect(() => {
    if (!cursor.visible) return;
    
    // 从 DataProvider 获取当前可见信号在 cursor 位置的值
    const values = mockDataProvider.getValuesAtTime(cursor.position);
    setSignalValues(values);
  }, [cursor.position, cursor.visible, displaySignals, expandedSignals]);

  const renderWaveform = () => {
    if (!canvasRef.current) return;

    const { width, height } = canvasRef.current;
    
    console.log(`[WaveformWindow] renderWaveform: width=${width}, height=${height}, viewport=${viewport.timeStart}-${viewport.timeEnd}`);

    // Build visible signal list from treeNodes
    // UI 决定哪些信号可见，以及它们的 row 顺序
    const signalList: SignalInfo[] = [];
    let currentRow = 0;
    
    treeNodes.forEach((node) => {
      if (node.type === 'group') {
        // Group row - no waveform, just increment row counter
        currentRow++;
      } else if (node.type === 'signal' && node.signal) {
        const signal = node.signal as Signal & { unique_id: number };
        
        // 检查信号是否展开（多bit信号）
        const isExpanded = expandedSignals.has(signal.unique_id);
        const isBus = signal.msb !== signal.lsb;
        
        if (isBus && isExpanded) {
          // 展开状态：先绘制原始多bit信号（第一行），再绘制各个bit
          signalList.push({
            name: signal.fullName || signal.name,
            row: currentRow,
            displayName: signal.name,
            width: signal.msb - signal.lsb + 1,  // 提供位宽
          });
          currentRow++;
          
          // 为每个bit创建单独的信号项
          const bitCount = Math.min(signal.msb - signal.lsb + 1, 32);
          for (let i = 0; i < bitCount; i++) {
            const bitIndex = signal.msb - i;
            signalList.push({
              name: `${signal.fullName || signal.name}[${bitIndex}]`,
              row: currentRow,
              displayName: `${signal.name}[${bitIndex}]`,
              width: 1,  // 单个bit
            });
            currentRow++;
          }
        } else {
          // 折叠状态或单bit信号：作为一个整体
          const width = signal.msb !== signal.lsb ? signal.msb - signal.lsb + 1 : 1;
          signalList.push({
            name: signal.fullName || signal.name,
            row: currentRow,
            displayName: signal.name,
            width,  // 提供位宽
          });
          currentRow++;
        }
      }
    });

    // Initialize DataProvider with visible signals
    // rowHeight = 25 (24px + 1px border)
    mockDataProvider.initialize(
      signalList,
      viewport,
      'hex' as DisplayFormat,  // TODO: make this configurable
      width,
      25,  // rowHeight (24px height + 1px border)
      20   // rulerHeight
    );

    // Get segments from DataProvider (already formatted and coordinate-converted)
    const segments = mockDataProvider.getSegments();

    // Render
    waveformRenderer.render(segments, viewport, width, height, 20);

    // 绘制选择区域高亮
    if (isSelecting && selectionStart !== null && selectionEnd !== null) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const startX = Math.min(selectionStart, selectionEnd);
        const endX = Math.max(selectionStart, selectionEnd);
        const selectionWidth = endX - startX;

        // 绘制半透明蓝色选择区域
        ctx.fillStyle = 'rgba(100, 150, 255, 0.3)';
        ctx.fillRect(startX, 20, selectionWidth, height - 20);

        // 绘制边框
        ctx.strokeStyle = 'rgba(100, 150, 255, 0.8)';
        ctx.lineWidth = 1;
        ctx.strokeRect(startX, 20, selectionWidth, height - 20);
      }
    }
  };

  // 鼠标按下：开始选择或设置 cursor
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    
    // 开始拖动选择
    setIsSelecting(true);
    setSelectionStart(x);
    setSelectionEnd(x);
    selectionStartRef.current = x;
  }, []);

  // 鼠标移动：更新选择区域
  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;

    // Update ref immediately (no re-render)
    mousePosRef.current = x;

    // Queue rAF-throttled update for rendering
    pendingMouseXRef.current = x;

    // Also update mouseX for other purposes (like click handling and info bar)
    setMouseX(x);
    setDisplayMouseX(x);

    // Update canvasWidth to ensure alignment (in case it changed)
    if (rect.width !== canvasWidth) {
      setCanvasWidth(rect.width);
    }

    // 如果在选择中，只更新选择结束位置
    if (isSelecting) {
      setSelectionEnd(x);
    }
    // 注意：不在这里更新 cursor，只在单击时更新
  }, [viewport, isSelecting, canvasWidth]);

  // 鼠标释放：结束选择并放大
  const handleCanvasMouseUp = useCallback(() => {
    if (!isSelecting || !canvasRef.current) return;

    // 使用 getBoundingClientRect 获取实际显示宽度
    const rect = canvasRef.current.getBoundingClientRect();
    const canvasWidth = rect.width;
    const startX = Math.min(selectionStart ?? 0, selectionEnd ?? 0);
    const endX = Math.max(selectionStart ?? 0, selectionEnd ?? 0);

    // 如果选择区域太小（小于10像素），则不放大，只设置 cursor
    if (endX - startX < 10) {
      // 使用鼠标释放时的位置（endX），而不是 selectionStart
      const clickTime = viewport.timeStart + (endX / canvasWidth) * (viewport.timeEnd - viewport.timeStart);

      // 获取可见信号列表
      const visibleSignals = mockDataProvider.getSignalNames();

      if (visibleSignals.length > 0) {
        // 使用第一个可见信号进行吸附（简化处理）
        const signalName = visibleSignals[0];
        const { prev, next } = mockDataProvider.findTransitionsAround(signalName, clickTime);

        // 基于时间距离进行吸附（而非像素距离）
        // 吸附阈值：时间范围的 2% 或至少 10 个时间单位
        const timeRange = viewport.timeEnd - viewport.timeStart;
        const snapThreshold = Math.max(timeRange * 0.02, 10);

        let finalTime = clickTime;

        if (prev !== null && Math.abs(clickTime - prev) <= snapThreshold) {
          finalTime = prev;
        } else if (next !== null && Math.abs(next - clickTime) <= snapThreshold) {
          finalTime = next;
        }

        setCursor({ position: Math.round(finalTime), visible: true });
      } else {
        setCursor({ position: Math.round(clickTime), visible: true });
      }
    } else {
      // 计算新的 viewport 时间范围
      const newTimeStart = viewport.timeStart + (startX / canvasWidth) * (viewport.timeEnd - viewport.timeStart);
      const newTimeEnd = viewport.timeStart + (endX / canvasWidth) * (viewport.timeEnd - viewport.timeStart);

      setViewport(prev => ({
        ...prev,
        timeStart: newTimeStart,
        timeEnd: newTimeEnd,
      }));
    }

    // 重置选择状态
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
    selectionStartRef.current = null;
  }, [isSelecting, selectionStart, selectionEnd, viewport, setViewport, setCursor]);

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

  const handleCanvasMouseLeave = useCallback(() => {
    mousePosRef.current = null;
    pendingMouseXRef.current = null;
    setMouseX(null);
    setDisplayMouseX(null);
    setRenderMouseX(null);
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
    // 从 Map 获取信号值，如果没有则返回默认值
    return signalValues.get(signal.fullName) || '0x0';
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
                              {signalValues.get(`${signal.fullName}[${bitIndex}]`) || '0'}
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
          {/* Cursor vertical line in info bar */}
          {cursor.visible && (
            <div style={{
              position: 'absolute',
              left: `${((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * 100}%`,
              top: 0,
              bottom: 0,
              width: '1px',
              background: '#ff00ff',
              zIndex: 1,
              pointerEvents: 'none',
            }} />
          )}
          
          {/* Mouse vertical line in info bar */}
          {renderMouseX !== null && (
            <div style={{
              position: 'absolute',
              left: renderMouseX,
              top: 0,
              bottom: 0,
              width: '2px',
              background: '#00aa00',
              zIndex: 1,
              pointerEvents: 'none',
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
              Cursor: {Math.round(lod0ToDisplay(cursor.position, timeConfig))}
            </span>
          )}

          {/* Mouse name and time - using debounced displayMouseX for value */}
          {displayMouseX !== null && mouseX !== null && (
            <span style={{
              position: 'absolute',
              left: mouseX,
              transform: 'translateX(4px)',
              color: '#00ffff',
              fontWeight: 'bold',
              zIndex: 2,
              pointerEvents: 'none',
            }}>
              Mouse: {Math.round(lod0ToDisplay(viewport.timeStart + (displayMouseX / (canvasWidth || 1)) * (viewport.timeEnd - viewport.timeStart), timeConfig))}
            </span>
          )}
        </div>
        
        {/* Waveform canvas layers */}
        <div style={{ position: 'relative', flex: 1 }}>
          {/* Waveform layer - heavy rendering */}
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
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseLeave}
          />
          {/* Cursor vertical line - HTML overlay */}
          {cursor.visible && (
            <div style={{
              position: 'absolute',
              left: `${((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * 100}%`,
              top: 0,
              bottom: 0,
              width: '1px',
              background: '#ff00ff',
              zIndex: 10,
              pointerEvents: 'none',
            }} />
          )}
          {/* Mouse vertical line - HTML overlay for smooth rendering */}
          {renderMouseX !== null && (
            <div style={{
              position: 'absolute',
              left: renderMouseX,
              top: 0,
              bottom: 0,
              width: '2px',
              background: '#00aa00',
              zIndex: 10,
              pointerEvents: 'none',
              willChange: 'left',
            }} />
          )}
        </div>
      </div>
    </div>
  );
}
