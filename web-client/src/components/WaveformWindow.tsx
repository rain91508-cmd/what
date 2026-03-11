import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { waveformRenderer } from '../core/render/waveformRenderer';
import { mockDataProvider } from '../core/data/mockDataProvider';
import type { Signal } from '../types';
import type { WaveformSignal, ColumnWidths, TimeConfig } from './TabPanel';
import { lod0ToDisplay, initTimeConfig } from './TabPanel';
import type { SignalInfo, DisplayFormat } from '../types/dataProvider';
import { FilterInput } from './FilterInput';
import { wildcardMatch } from '../utils/wildcardMatch';
import { zoomIn, zoomOut } from '../utils/zoomHelpers';
import { sanitizeTimeRange, type TimeRangeOnly } from '../utils/viewport';
import { buildWasmSignals, updateProviderSettings } from '../wasm/waveformProvider';

import { WaveformProviderAdapter } from '../wasm/waveformProviderAdapter';
import { useWaveformProvider } from '../contexts/WaveformProviderContext';

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
  viewport?: TimeRangeOnly;          // 外部控制的 viewport（可选）
  onViewportChange?: (viewport: TimeRangeOnly) => void;  // viewport 变化回调
  cursorPosition?: number;      // 外部控制的 cursor 位置（可选）
  onCursorPositionChange?: (position: number) => void;  // cursor 位置变化回调
  useMockData?: boolean;        // 是否使用 mock 数据
  // WASM Provider 配置（当 useMockData=false 时使用）
  serverUrl?: string;           // 服务器 URL
  waveformName?: string;        // 波形名称
  signalPrefix?: string;        // 信号前缀
  spaceBeforeBracket?: boolean; // 是否在 [ 前加空格
  // Waveform total range for sanity checks
  waveformRange?: {
    start: number;  // LoD0Unit - total start time of waveform
    end: number;    // LoD0Unit - total end time of waveform
  };
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
const DEFAULT_TIME_CONFIG: TimeConfig = initTimeConfig(1);

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
  useMockData = false,
  serverUrl: _serverUrl = 'http://localhost:8080',
  waveformName: _waveformName = '',
  signalPrefix: _signalPrefix = '',
  spaceBeforeBracket: _spaceBeforeBracket = false,
  waveformRange,
}: WaveformWindowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const signalPanelRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);

  // 使用共享 Provider
  const { provider: sharedProvider, isLoading: providerLoading } = useWaveformProvider();
  // WASM Provider reference - 使用适配器包装共享 Provider
  const wasmProviderRef = useRef<WaveformProviderAdapter | null>(null);
  // Canvas ID - 每个 Tab 唯一
  const canvasIdRef = useRef<string>(`canvas-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  // 用于跟踪 Provider 是否已准备好
  const providerReady = !providerLoading && sharedProvider !== null && wasmProviderRef.current !== null;

  // Initialize WASM Adapter when shared provider is ready
  useEffect(() => {
    console.log(`[WaveformWindow] Provider init check: useMockData=${useMockData}, providerLoading=${providerLoading}, sharedProvider=${sharedProvider ? 'yes' : 'no'}`);

    if (!useMockData && sharedProvider && !wasmProviderRef.current) {
      // 创建 Adapter 包装共享 Provider
      const adapter = new WaveformProviderAdapter(sharedProvider, canvasIdRef.current);
      wasmProviderRef.current = adapter;
      console.log(`[WaveformWindow] Created adapter for canvas: ${canvasIdRef.current}`);
    }
  }, [useMockData, sharedProvider, providerLoading]);

  // Register Canvas when adapter is ready
  // 使用 ref 来跟踪 Canvas 是否已 transfer，防止 StrictMode 下的重复 transfer
  const canvasTransferredRef = useRef(false);
  
  useEffect(() => {
    if (!wasmProviderRef.current || !canvasRef.current) return;
    
    // 如果已经 transfer 过，什么都不做
    // Canvas 已经在 Worker 中了，不需要再次 transfer 或 register
    if (canvasTransferredRef.current) {
      console.log(`[WaveformWindow] Canvas already transferred, skipping: ${canvasIdRef.current}`);
      return;
    }

    const registerCanvas = async () => {
      try {
        // 防止重复 transfer
        if (canvasTransferredRef.current) return;
        
        const canvas = canvasRef.current!;
        const containerRect = containerRef.current!.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height - 30; // Subtract ruler height
        
        // 保持 CSS 尺寸和 canvas 物理尺寸 1:1，禁用 devicePixelRatio 缩放
        // 这样不需要进行任何坐标转换
        canvas.width = width;
        canvas.height = height;
        
        const offscreenCanvas = canvas.transferControlToOffscreen();
        canvasTransferredRef.current = true;
        
        // 传递 dpr=1，禁用缩放
        await wasmProviderRef.current!.registerCanvas(offscreenCanvas, 1);
        console.log(`[WaveformWindow] Canvas registered: ${canvasIdRef.current}, dpr=1 (1:1 mapping)`);
      } catch (error) {
        console.error('[WaveformWindow] Failed to register canvas:', error);
        canvasTransferredRef.current = false;
      }
    };

    registerCanvas();

    // Cleanup: 不在这里 unregister Canvas
    // 在 StrictMode 下，这个 cleanup 会在组件重新挂载前执行
    // 但我们不 unregister，因为 Worker 中还需要这个 Canvas
    // 真正的清理会在组件完全卸载时由其他机制处理
    return () => {
      console.log(`[WaveformWindow] Component unmounting, but keeping canvas in Worker: ${canvasIdRef.current}`);
      // 不调用 unregisterCanvas，让 Canvas 在 Worker 中保留
      // 因为 StrictMode 下这不是真正的卸载
    };
  }, []);
  
  // 根据 canvas 宽度和时间配置计算 viewport
  // 所有时间值使用 LoD0Unit（整数）
  const calculateViewport = useCallback((): TimeRangeOnly => {
    return {
      timeStart: 0,     // LoD0Unit
      timeEnd: 100,     // LoD0Unit - 默认显示 100 个单位
    };
  }, []);
  
  // 使用外部 viewport 或内部 state
  const [internalViewport, setInternalViewport] = useState<TimeRangeOnly>(() => calculateViewport());
  const viewport = externalViewport ?? internalViewport;
  const setViewport = useCallback((newViewport: TimeRangeOnly | ((prev: TimeRangeOnly) => TimeRangeOnly)) => {
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
  // 防抖/节流相关 refs
  const renderThrottleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastRenderTimeRef = useRef<number>(0);
  const selectionUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // 使用 ref 跟踪 isPanning，避免函数重新创建
  const isPanningRef = useRef(false);

  // 拖动选择放大功能的状态
  const [isSelecting, setIsSelecting] = useState(false);
  const [isPanning, setIsPanning] = useState(false); // 标尺区域拖动平移
  const [selectionStartX, setSelectionStartX] = useState<number | null>(null);
  const [selectionStartY, setSelectionStartY] = useState<number | null>(null);
  const [selectionEndX, setSelectionEndX] = useState<number | null>(null);
  const [selectionEndY, setSelectionEndY] = useState<number | null>(null);
  const selectionStartRef = useRef<number | null>(null);
  const panStartXRef = useRef<number | null>(null); // 平移开始时的鼠标X位置
  const panStartTimeStartRef = useRef<number>(0); // 平移开始时的viewport timeStart
  const pendingViewportUpdateRef = useRef<TimeRangeOnly | null>(null); // 待更新的 viewport
  const panUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null); // 拖动更新的 throttle timeout

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
      // 如果不是 mock 模式，等待 Provider 准备好
      if (!useMockData && !providerReady) {
        console.log('[WaveformWindow] Waiting for provider to be ready...');
        return;
      }
      
      if (canvasRef.current) {
        // Worker 模式下不需要初始化 waveformRenderer（Canvas 已 transfer 到 Worker）
        // Mock 模式下需要初始化 waveformRenderer
        if (useMockData) {
          await waveformRenderer.initialize(canvasRef.current);
        }
        await renderWaveform();
      }
    };

    initRenderers();

    return () => {
      waveformRenderer.dispose();
    };
  }, [useMockData, providerReady]);  // 依赖 providerReady，当 Provider 准备好时重新执行

  // 使用 ref 存储上一次的 canvas 尺寸，避免循环依赖
  // @ts-ignore - 暂时未使用但保留以备将来
  const _lastCanvasSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  // 使用 ref 防止并发渲染
  const isRenderingRef = useRef(false);
  
  // 使用 ref 跟踪上一次渲染的参数，避免不必要的重复渲染
  const lastRenderParamsRef = useRef<{
    signalPrefix: string;
    spaceBeforeBracket: boolean;
    viewportTimeStart: number;
    viewportTimeEnd: number;
    canvasWidth: number;
    canvasHeight: number;
    signalListHash: string;
    timeConfigHash: string;
  }>({
    signalPrefix: '',
    spaceBeforeBracket: false,
    viewportTimeStart: 0,
    viewportTimeEnd: 0,
    canvasWidth: 0,
    canvasHeight: 0,
    signalListHash: '',
    timeConfigHash: '',
  });

  // 使用 ref 跟踪上一次的 WASM provider 设置
  const lastWasmSettingsRef = useRef<{
    signalPrefix: string;
    spaceBeforeBracket: boolean;
    signalListHash: string;
    viewportTimeStart: number;
    viewportTimeEnd: number;
    canvasWidth: number;
    canvasHeight: number;
  }>({
    signalPrefix: '',
    spaceBeforeBracket: false,
    signalListHash: '',
    viewportTimeStart: 0,
    viewportTimeEnd: 0,
    canvasWidth: 0,
    canvasHeight: 0,
  });

  // 添加 segments 缓存
  const cachedSegmentsRef = useRef<any[]>([]);
  const lastSegmentsParamsRef = useRef<{
    signalListHash: string;
    viewportTimeStart: number;
    viewportTimeEnd: number;
    canvasWidth: number;
    canvasHeight: number;
  }>({
    signalListHash: '',
    viewportTimeStart: 0,
    viewportTimeEnd: 0,
    canvasWidth: 0,
    canvasHeight: 0,
  });
  
  // 拖动时记录上一次计算 segments 时的 viewport
  const lastSegmentsViewportRef = useRef<{
    timeStart: number;
    timeEnd: number;
  }>({
    timeStart: 0,
    timeEnd: 0,
  });

  // 同步 isPanning 到 ref
  useEffect(() => {
    isPanningRef.current = isPanning;
  }, [isPanning]);

  // 节流渲染函数 - 拖动时使用更长的节流间隔
  const throttledRenderWaveform = useCallback(() => {
    // 如果不是 mock 模式，检查 Provider 是否准备好
    if (!useMockData && !providerReady) {
      console.log('[WaveformWindow] Provider not ready, skipping render');
      return;
    }
    
    const now = Date.now();
    const THROTTLE_INTERVAL = isPanningRef.current ? 250 : 80; // 拖动时250ms，正常80ms

    if (now - lastRenderTimeRef.current >= THROTTLE_INTERVAL) {
      lastRenderTimeRef.current = now;
      if (renderWaveformRef.current) {
        renderWaveformRef.current().catch(console.error);
      }
    } else {
      // 如果在节流间隔内，设置 pending 并等待
      if (renderThrottleTimeoutRef.current) {
        clearTimeout(renderThrottleTimeoutRef.current);
      }
      renderThrottleTimeoutRef.current = setTimeout(() => {
        lastRenderTimeRef.current = Date.now();
        if (renderWaveformRef.current) {
          renderWaveformRef.current().catch(console.error);
        }
      }, THROTTLE_INTERVAL - (now - lastRenderTimeRef.current));
    }
  }, [useMockData, providerReady]);

  // 清理所有定时器
  useEffect(() => {
    return () => {
      if (renderThrottleTimeoutRef.current) {
        clearTimeout(renderThrottleTimeoutRef.current);
      }
      if (panUpdateTimeoutRef.current) {
        clearTimeout(panUpdateTimeoutRef.current);
      }
      if (selectionUpdateTimeoutRef.current) {
        clearTimeout(selectionUpdateTimeoutRef.current);
      }
    };
  }, []);

  // renderWaveform 定义在 handleResize useEffect 之前，避免暂时性死区错误
  // 使用 ref 来存储函数，避免 useCallback 导致的依赖循环
  const renderWaveformRef = useRef<() => Promise<void>>();
  
  const renderWaveform = async () => {
    // 防止并发调用
    if (isRenderingRef.current) {
      return;
    }
    isRenderingRef.current = true;
    
    try {
      if (!canvasRef.current || !containerRef.current) return;

      // Update canvas dimensions from container
      const containerRect = containerRef.current.getBoundingClientRect();
      const width = containerRect.width;
      const height = containerRect.height - 30; // Subtract ruler height
      
      // 只在尺寸真的变化时才设置 canvas 的 width 和 height，避免触发 ResizeObserver
      // 注意：如果已经调用了 transferControlToOffscreen()，就不能再修改 canvas 尺寸了
      // 这种情况下，尺寸管理交给 Worker 处理
      if (!useMockData) {
        // Worker 模式：不修改 canvas 尺寸，只更新 Adapter 中的 canvasConfig
        // Worker 会在 render 时使用 canvasConfig 设置 WASM 的 canvas 尺寸
      } else {
        // Mock 模式：直接设置 canvas 尺寸
        if (Math.abs(canvasRef.current.width - width) > 0.5 || 
            Math.abs(canvasRef.current.height - height) > 0.5) {
          canvasRef.current.width = width;
          canvasRef.current.height = height;
        }
      }

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
            uniqueId: signal.unique_id,
            globalId: signal.globalId,
            name: signal.fullName || signal.name,
            row: currentRow,
            displayName: signal.name,
            width: signal.msb - signal.lsb + 1,  // 提供位宽
          });
          currentRow++;

          // 为每个bit创建单独的信号项
          // 使用 @[msb:lsb] 或 @[bit_index] 格式与 fullName 中的 [msb:lsb] 区分
          // WASM 检测到 @[...] 后，从父信号值中提取对应 bit
          // 例如: tb_top.u_dut.u_cluster0.mem_arid[7:0]@[0] 或 @[7:0]
          const bitCount = Math.min(signal.msb - signal.lsb + 1, 32);
          for (let i = 0; i < bitCount; i++) {
            const bitIndex = signal.msb - i;
            const baseName = signal.fullName || signal.name;
            signalList.push({
              uniqueId: signal.unique_id,  // bit信号使用相同的uniqueId
              globalId: signal.globalId,  // bit信号使用相同的globalId
              name: `${baseName}@[${bitIndex}]`,  // 特殊格式，WASM 从父信号提取 bit
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
            uniqueId: signal.unique_id,
            globalId: signal.globalId,
            name: signal.fullName || signal.name,
            row: currentRow,
            displayName: signal.name,
            width,  // 提供位宽
          });
          currentRow++;
        }
      }
    });

    // 生成 signalList 的哈希值用于检测变化
    const signalListHash = signalList.map(s => `${s.name}-${s.row}-${s.width}`).join('|');

    // 生成 timeConfig 的哈希值用于检测变化
    const timeConfigHash = `${timeConfig.DisplayUnitPerLoD0Unit}`;

    // 检查参数是否真的有变化，如果没有变化则直接返回，避免重复渲染
    const lastParams = lastRenderParamsRef.current;
    const hasParamsChanged =
      lastParams.signalPrefix !== _signalPrefix ||
      lastParams.spaceBeforeBracket !== _spaceBeforeBracket ||
      Math.abs(lastParams.viewportTimeStart - viewport.timeStart) > 0.1 ||
      Math.abs(lastParams.viewportTimeEnd - viewport.timeEnd) > 0.1 ||
      Math.abs(lastParams.canvasWidth - width) > 0.5 ||
      Math.abs(lastParams.canvasHeight - height) > 0.5 ||
      lastParams.signalListHash !== signalListHash ||
      lastParams.timeConfigHash !== timeConfigHash;

    if (!hasParamsChanged) {
      // 参数没有变化，直接返回
      return;
    }

    // 更新上一次渲染的参数
    lastRenderParamsRef.current = {
      signalPrefix: _signalPrefix,
      spaceBeforeBracket: _spaceBeforeBracket,
      viewportTimeStart: viewport.timeStart,
      viewportTimeEnd: viewport.timeEnd,
      canvasWidth: width,
      canvasHeight: height,
      signalListHash,
      timeConfigHash,
    };

    // Render with timeConfig for proper ruler display
    if (!useMockData && wasmProviderRef.current) {
      // Worker 模式下直接使用 Adapter，传递完整的参数
      
      // 构建旧格式的信号列表
      const uiSignals = signalList.map((s) => ({
        global_id: s.globalId,
        name: s.name,
        row: s.row,
        width: s.width || 1,
      }));

      // 构建带 draw_sig_id 的信号
      let wasmSignals: any[] = [];
      try {
        wasmSignals = await buildWasmSignals(uiSignals, _waveformName || 'unknown');
      } catch (error) {
        console.error('[WaveformWindow] Failed to build wasm signals:', error);
      }

      // 调用 Adapter 的 render_waveform 并传递完整参数
      console.log('[WaveformWindow] Calling render_waveform with viewport:', {
        timeStart: viewport.timeStart,
        timeEnd: viewport.timeEnd,
        width,
        height
      });
      await wasmProviderRef.current.render_waveform({
        signals: wasmSignals,
        viewport: {
          startTime: viewport.timeStart,
          endTime: viewport.timeEnd,
          width,
          height,
        },
        canvasConfig: {
          width,
          height,
          rowHeight: 24,
        },
        displayFormat: 'hex',
        timeConfig: {
          displayUnit: 'ps',
          lod0Unit: 1,
          displayUnitPerLoD0Unit: timeConfig.DisplayUnitPerLoD0Unit,
        },
      });
    } else {
      // Mock 模式：使用旧流程
      let segments;
      if (useMockData) {
        // Use mock data provider
        mockDataProvider.initialize(
          signalList,
          viewport,
          'hex' as DisplayFormat,
          width,
          24,
          20
        );
        segments = mockDataProvider.getSegments();
      }
      // 使用主线程渲染（Mock 数据模式）
      if (segments) {
        waveformRenderer.render(segments, viewport, width, height, 20, timeConfig);
      }
    }

    // 绘制选择区域高亮（只在水平拖动时显示）
    if (isSelecting && selectionStartX !== null && selectionEndX !== null && selectionStartY !== null && selectionEndY !== null) {
      const deltaX = Math.abs(selectionEndX - selectionStartX);
      const deltaY = Math.abs(selectionEndY - selectionStartY);

      // 只在水平拖动时显示选择框
      if (deltaX >= deltaY) {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const startX = Math.min(selectionStartX, selectionEndX);
          const endX = Math.max(selectionStartX, selectionEndX);
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
    }
  } finally {
    isRenderingRef.current = false;
  }
  };

  // 更新 ref
  renderWaveformRef.current = renderWaveform;

  // 使用 ResizeObserver 监听容器尺寸变化，触发重绘并调整 viewport
  useEffect(() => {
    if (!containerRef.current) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastWidth = 0;
    let isFirstCall = true;

    const resizeObserver = new ResizeObserver((entries) => {
      // 清除之前的定时器，重新开始计时
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      
      resizeTimeout = setTimeout(() => {
        for (const entry of entries) {
          const newWidth = entry.contentRect.width;
          const newHeight = entry.contentRect.height;
           
          // 初始化 lastWidth
          if (isFirstCall) {
            lastWidth = newWidth;
            isFirstCall = false;
          }
           
          // 如果宽度变化了，更新 viewport 的 timeEnd 保持 pixelsPerTime 不变
          if (newWidth !== lastWidth && !useMockData && wasmProviderRef.current) {
            // 使用 React state 中的 viewport，而不是 Adapter 中的 viewport
            const oldTimeStart = viewport.timeStart;
            const oldTimeEnd = viewport.timeEnd;
            const oldTimeSpan = oldTimeEnd - oldTimeStart;
            const newTimeEnd = oldTimeStart + (oldTimeSpan * newWidth / lastWidth);
            
            wasmProviderRef.current.set_viewport(oldTimeStart, newTimeEnd);
            wasmProviderRef.current.set_canvas_dimensions(newWidth, newHeight, 24);
            
            // 同步更新 React viewport state
            setViewport(prev => ({
              ...prev,
              timeStart: oldTimeStart,
              timeEnd: newTimeEnd,
            }));
          }
          
          lastWidth = newWidth;
        }
        
        // 如果不是 mock 模式，检查 Provider 是否准备好
        if (!useMockData && !providerReady) {
          console.log('[WaveformWindow] Provider not ready, skipping resize render');
          resizeTimeout = null;
          return;
        }
        
        if (renderWaveformRef.current) {
          renderWaveformRef.current().catch(console.error);
        }
        resizeTimeout = null;
      }, 50);
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
    };
  }, [useMockData, providerReady, viewport.timeStart, viewport.timeEnd]);

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
      throttledRenderWaveform();
    }
  }, [viewport.timeStart, viewport.timeEnd, canvasWidth, groups, expandedSignals, throttledRenderWaveform]);

  // 监听 timeConfig 变化，重新渲染波形（影响标尺显示）
  useEffect(() => {
    if (canvasWidth > 0) {
      throttledRenderWaveform();
    }
  }, [timeConfig, throttledRenderWaveform]);

  // 监听拖动状态变化，拖动结束后触发完整的数据获取
  useEffect(() => {
    if (!isPanning && canvasWidth > 0) {
      // 拖动结束，等待一小段时间后触发完整渲染（避免和节流冲突）
      const timeoutId = setTimeout(() => {
        if (renderWaveformRef.current) {
          renderWaveformRef.current().catch(console.error);
        }
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, [isPanning, canvasWidth]);

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
    const updateSignalValues = async () => {
      if (!cursor.visible) return;

      // 根据模式选择正确的 provider
      if (!useMockData && wasmProviderRef.current) {
        // WASM 模式：从 WASM provider 获取信号值
        const wasmProvider = wasmProviderRef.current;
        const values = new Map<string, string>();

        for (const signal of displaySignals) {
          try {
            const signalName = signal.fullName || signal.name;
            const valueInfo = await wasmProvider.get_signal_value_at_time(signalName, cursor.position);
            if (valueInfo && typeof valueInfo === 'object') {
              // ValueInfo object has displayStr field (camelCase from WASM serde)
              const displayStr = (valueInfo as any).displayStr || (valueInfo as any).display_str || '0x0';
              values.set(signalName, displayStr);

              // For expanded multi-bit signals, also get individual bit values
              if (signal.msb !== signal.lsb && expandedSignals.has(signal.unique_id)) {
                const bitCount = Math.min(signal.msb - signal.lsb + 1, 32);
                for (let i = 0; i < bitCount; i++) {
                  const bitIndex = signal.msb - i;
                  const bitSignalName = `${signal.fullName}@[${bitIndex}]`;
                  try {
                    const bitValueInfo = await wasmProvider.get_signal_value_at_time(bitSignalName, cursor.position);
                    if (bitValueInfo && typeof bitValueInfo === 'object') {
                      const bitDisplayStr = (bitValueInfo as any).displayStr || (bitValueInfo as any).display_str || '0';
                      values.set(bitSignalName, bitDisplayStr);
                    } else {
                      values.set(bitSignalName, '0');
                    }
                  } catch (error) {
                    values.set(bitSignalName, '0');
                  }
                }
              }
            } else {
              values.set(signal.fullName || signal.name, '0x0');
            }
          } catch (error) {
            console.error(`[WaveformWindow] Error getting value for signal ${signal.name}:`, error);
            values.set(signal.fullName || signal.name, '0x0');
          }
        }

        setSignalValues(values);
      } else {
        // Mock 模式：从 mock provider 获取信号值
        const values = mockDataProvider.getValuesAtTime(cursor.position);
        setSignalValues(values);
      }
    };

    updateSignalValues();
  }, [cursor.position, cursor.visible, displaySignals, expandedSignals, useMockData]);

  // 鼠标按下：立即设置 cursor 并开始选择
  const RULER_HEIGHT = 30; // 标尺区域高度
  const SIGNAL_ROW_HEIGHT = 24; // 信号行高度，与 CSS 中的 .waveform-signal-item 高度一致

  const handleCanvasMouseDown = useCallback(async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 判断是否在标尺区域（顶部30px）
    const isInRuler = y < RULER_HEIGHT;

    if (isInRuler) {
      // 标尺区域：开始平移拖动
      setIsPanning(true);
      panStartXRef.current = x;
      panStartTimeStartRef.current = viewport.timeStart;
      
      // 初始化上一次计算 segments 时的 viewport
      lastSegmentsViewportRef.current = {
        timeStart: viewport.timeStart,
        timeEnd: viewport.timeEnd,
      };
      
      // 同时设置 cursor 位置
      const canvasWidth = rect.width;
      const clickTime = viewport.timeStart + (x / canvasWidth) * (viewport.timeEnd - viewport.timeStart);
      setCursor({ position: Math.round(clickTime), visible: true });
    } else {
      // 波形区域：开始选择/缩放拖动
      // 立即设置 cursor 位置（在鼠标按下时刻）
      const canvasWidth = rect.width;
      const clickTime = viewport.timeStart + (x / canvasWidth) * (viewport.timeEnd - viewport.timeStart);

      // 获取可见信号列表进行吸附
      let finalTime = clickTime;
      const timeRange = viewport.timeEnd - viewport.timeStart;
      const snapThreshold = Math.max(timeRange * 0.04, 10);

      // 根据点击的 Y 坐标计算对应的 treeNode 索引（考虑 group 占位）
      const signalY = y - RULER_HEIGHT;
      const nodeIndex = Math.floor(signalY / SIGNAL_ROW_HEIGHT);

      // 找到对应的 treeNode
      const targetNode = treeNodes[nodeIndex];

      if (useMockData) {
        // Mock 数据模式：使用 mockDataProvider
        if (targetNode?.type === 'signal' && targetNode.signal) {
          const signalName = targetNode.signal.fullName || targetNode.signal.name;
          const { prev, next } = mockDataProvider.findTransitionsAround(signalName, clickTime);

          if (prev !== null && Math.abs(clickTime - prev) <= snapThreshold) {
            finalTime = prev;
          } else if (next !== null && Math.abs(next - clickTime) <= snapThreshold) {
            finalTime = next;
          }
        }
      } else if (wasmProviderRef.current && targetNode?.type === 'signal' && targetNode.signal) {
        // WASM 模式：从已获取数据的信号中找 transition
        const wasmProvider = wasmProviderRef.current;
        const signalName = targetNode.signal.fullName || targetNode.signal.name;

        console.log(`[WaveformWindow] Cursor snap: signal=${signalName}, clickTime=${clickTime}, threshold=${snapThreshold}, nodeIndex=${nodeIndex}`);

        try {
          const transitions = await wasmProvider.find_transitions_around(signalName, clickTime);
          console.log(`[WaveformWindow] Cursor snap: transitions=`, transitions);
          if (transitions && Array.isArray(transitions) && transitions.length >= 2) {
            const prev = transitions[0] as number | null;
            const next = transitions[1] as number | null;

            console.log(`[WaveformWindow] Cursor snap: prev=${prev}, next=${next}, clickTime=${clickTime}`);

            if (prev !== null && Math.abs(clickTime - prev) <= snapThreshold) {
              finalTime = prev;
              console.log(`[WaveformWindow] Cursor snap: snapped to prev=${prev}`);
            } else if (next !== null && Math.abs(next - clickTime) <= snapThreshold) {
              finalTime = next;
              console.log(`[WaveformWindow] Cursor snap: snapped to next=${next}`);
            } else {
              console.log(`[WaveformWindow] Cursor snap: no snap, distances: prev=${prev !== null ? Math.abs(clickTime - prev) : 'null'}, next=${next !== null ? Math.abs(next - clickTime) : 'null'}`);
            }
          }
        } catch (error) {
          console.error('[WaveformWindow] Failed to find transitions:', error);
        }
      } else if (targetNode?.type === 'group') {
        console.log(`[WaveformWindow] Cursor snap: clicked on group row, no snap`);
      }

      setCursor({ position: Math.round(finalTime), visible: true });
      
      // 开始拖动选择
      setIsSelecting(true);
      setSelectionStartX(x);
      setSelectionStartY(y);
      setSelectionEndX(x);
      setSelectionEndY(y);
      selectionStartRef.current = x;
    }
  }, [viewport, setCursor, useMockData, displaySignals, wasmProviderRef]);

  // 添加 refs 来避免频繁的 state 更新
  const selectionEndXRef = useRef<number | null>(null);
  const selectionEndYRef = useRef<number | null>(null);

  // 鼠标移动：更新选择区域
  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Update ref immediately (no re-render)
    mousePosRef.current = x;

    // Queue rAF-throttled update for rendering
    pendingMouseXRef.current = x;

    // 只在非拖动时更新 displayMouseX（用于 info bar）
    if (!isPanning && !isSelecting) {
      setDisplayMouseX(x);
    }
    setMouseX(x);

    // Update canvasWidth to ensure alignment (in case it changed)
    if (rect.width !== canvasWidth) {
      setCanvasWidth(rect.width);
    }

    // 如果在选择中，使用 ref 更新选择结束位置（避免频繁 re-render）
    if (isSelecting) {
      selectionEndXRef.current = x;
      selectionEndYRef.current = y;
      // 使用 rAF 来批量更新 state
      if (!selectionUpdateTimeoutRef.current) {
        selectionUpdateTimeoutRef.current = setTimeout(() => {
          setSelectionEndX(selectionEndXRef.current);
          setSelectionEndY(selectionEndYRef.current);
          selectionUpdateTimeoutRef.current = null;
        }, 16); // 约 60fps
      }
    }
    
    // 如果在平移中，计算新的 viewport 但使用 throttle 来避免频繁更新
    if (isPanning && panStartXRef.current !== null && onViewportChange) {
      const canvasWidth = rect.width;
      const deltaX = x - panStartXRef.current;
      const timeSpan = viewport.timeEnd - viewport.timeStart;
      const timeDelta = (deltaX / canvasWidth) * timeSpan;
      
      // 计算新的 viewport（向左拖动，时间减少；向右拖动，时间增加）
      const newTimeStart = panStartTimeStartRef.current - timeDelta;
      const newTimeEnd = newTimeStart + timeSpan;
      
      // 使用 sanity 函数验证
      const sanitized = sanitizeTimeRange(newTimeStart, newTimeEnd, waveformRange);
      
      // 保存待更新的 viewport
      pendingViewportUpdateRef.current = {
        timeStart: sanitized.timeStart,
        timeEnd: sanitized.timeEnd,
      };
      
      // 使用 throttle 更新 viewport，避免频繁触发 re-render
      if (!panUpdateTimeoutRef.current) {
        panUpdateTimeoutRef.current = setTimeout(() => {
          if (pendingViewportUpdateRef.current && onViewportChange) {
            onViewportChange(pendingViewportUpdateRef.current);
            pendingViewportUpdateRef.current = null;
          }
          panUpdateTimeoutRef.current = null;
        }, 100); // 100ms 更新一次
      }
    }
    
    // 注意：不在这里更新 cursor，只在单击时更新
  }, [viewport, isSelecting, isPanning, canvasWidth, onViewportChange, waveformRange]);

  // 清理拖动相关定时器
  const cleanupPanTimeout = useCallback(() => {
    if (panUpdateTimeoutRef.current) {
      clearTimeout(panUpdateTimeoutRef.current);
      panUpdateTimeoutRef.current = null;
    }
    // 如果有待更新的 viewport，在清理前最后更新一次
    if (pendingViewportUpdateRef.current && onViewportChange) {
      onViewportChange(pendingViewportUpdateRef.current);
      pendingViewportUpdateRef.current = null;
    }
  }, [onViewportChange]);

  // 清理选择区域更新定时器
  const cleanupSelectionTimeout = useCallback(() => {
    if (selectionUpdateTimeoutRef.current) {
      clearTimeout(selectionUpdateTimeoutRef.current);
      selectionUpdateTimeoutRef.current = null;
    }
    // 确保最终的选择区域状态更新
    if (selectionEndXRef.current !== null) {
      setSelectionEndX(selectionEndXRef.current);
    }
    if (selectionEndYRef.current !== null) {
      setSelectionEndY(selectionEndYRef.current);
    }
  }, []);

  // 鼠标释放：结束选择/平移并处理相应操作（cursor 已在 mousedown 时设置）
  const handleCanvasMouseUp = useCallback(() => {
    // 处理平移结束
    if (isPanning) {
      // 先清理定时器并确保最终 viewport 更新
      cleanupPanTimeout();
      setIsPanning(false);
      panStartXRef.current = null;
      return;
    }
    
    // 清理选择区域更新定时器
    cleanupSelectionTimeout();
    
    if (!isSelecting || !canvasRef.current) return;

    // 使用 getBoundingClientRect 获取实际显示宽度
    const rect = canvasRef.current.getBoundingClientRect();
    const canvasWidth = rect.width;

    // 计算拖动距离
    const deltaX = Math.abs((selectionEndX ?? 0) - (selectionStartX ?? 0));
    const deltaY = Math.abs((selectionEndY ?? 0) - (selectionStartY ?? 0));

    // 判断拖动方向：以距离较大的方向为准
    const isHorizontalDrag = deltaX >= deltaY;

    if (isHorizontalDrag) {
      // 水平拖动：放大到选择的时间范围
      const startX = Math.min(selectionStartX ?? 0, selectionEndX ?? 0);
      const endX = Math.max(selectionStartX ?? 0, selectionEndX ?? 0);

      // 如果选择区域足够大（大于等于10像素），则放大
      if (endX - startX >= 10) {
        const rawTimeStart = viewport.timeStart + (startX / canvasWidth) * (viewport.timeEnd - viewport.timeStart);
        const rawTimeEnd = viewport.timeStart + (endX / canvasWidth) * (viewport.timeEnd - viewport.timeStart);
        
        // Validate time range
        const sanitized = sanitizeTimeRange(rawTimeStart, rawTimeEnd, waveformRange);

        setViewport(prev => ({
          ...prev,
          timeStart: sanitized.timeStart,
          timeEnd: sanitized.timeEnd,
        }));
      }
    } else {
      // 垂直拖动：根据方向放大或缩小
      const dragY = (selectionEndY ?? 0) - (selectionStartY ?? 0);

      if (dragY < -20) {
        // 向上拖动超过20像素：放大（Zoom In）
        const newViewport = zoomIn(viewport, cursor.position);
        if (newViewport) {
          // Validate the zoom result
          const sanitized = sanitizeTimeRange(newViewport.timeStart, newViewport.timeEnd, waveformRange);
          setViewport({
            ...newViewport,
            timeStart: sanitized.timeStart,
            timeEnd: sanitized.timeEnd,
          });
        }
      } else if (dragY > 20) {
        // 向下拖动超过20像素：缩小（Zoom Out）
        const newViewport = zoomOut(viewport, cursor.position);
        if (newViewport) {
          // Validate the zoom result
          const sanitized = sanitizeTimeRange(newViewport.timeStart, newViewport.timeEnd, waveformRange);
          setViewport({
            ...newViewport,
            timeStart: sanitized.timeStart,
            timeEnd: sanitized.timeEnd,
          });
        }
      }
      // 如果垂直拖动距离小于20像素，视为单击，不执行缩放
    }
    // 注意：cursor 已在 mousedown 时设置，这里不再重复设置

    // 重置选择状态
    setIsSelecting(false);
    setSelectionStartX(null);
    setSelectionStartY(null);
    setSelectionEndX(null);
    setSelectionEndY(null);
    selectionStartRef.current = null;
  }, [isSelecting, isPanning, selectionStartX, selectionStartY, selectionEndX, selectionEndY, viewport, setViewport, cursor, waveformRange, cleanupPanTimeout, cleanupSelectionTimeout]);

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
    
    // 如果正在平移，取消平移状态
    if (isPanning) {
      cleanupPanTimeout();
      setIsPanning(false);
      panStartXRef.current = null;
    }
    
    // 清理选择区域更新定时器
    if (isSelecting) {
      cleanupSelectionTimeout();
    }
  }, [isPanning, isSelecting, cleanupPanTimeout, cleanupSelectionTimeout]);

  const handleColumnResize = (column: 'hierarchy' | 'name' | 'value', e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidths = { hierarchy: hierarchyColumnWidth, name: nameColumnWidth, value: valueColumnWidth };

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      let newWidths: ColumnWidths | null = null;

      if (column === 'hierarchy') {
        const newWidth = Math.max(20, startWidths.hierarchy + delta);  // 移除最大限制，只保留最小限制
        newWidths = { ...widths, hierarchy: newWidth };
      } else if (column === 'name') {
        const newWidth = Math.max(40, startWidths.name + delta);  // 移除最大限制，只保留最小限制
        newWidths = { ...widths, name: newWidth };
      } else if (column === 'value') {
        const newWidth = Math.max(30, startWidths.value + delta);  // 移除最大限制，只保留最小限制
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
                              {signalValues.get(`${signal.fullName}@[${bitIndex}]`) || '0'}
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
              transform: (() => {
                const cursorX = ((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * canvasWidth;
                const isClose = displayMouseX !== null && Math.abs(displayMouseX - cursorX) < 100;
                
                // If close to mouse, position on opposite side
                if (isClose && displayMouseX !== null) {
                  if (displayMouseX > cursorX) {
                    // Mouse on right, cursor label on left
                    return 'translateX(-100%) translateX(-4px)';
                  } else {
                    // Mouse on left, cursor label on right
                    return 'translateX(4px)';
                  }
                }
                
                // Default: check if too close to right edge
                if (cursorX > canvasWidth - 80) {
                  return 'translateX(-100%) translateX(-4px)';
                }
                return 'translateX(4px)';
              })(),
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
              transform: (() => {
                const cursorX = ((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * canvasWidth;
                const isClose = Math.abs(displayMouseX - cursorX) < 100;
                
                // If close to cursor, position on opposite side
                if (isClose) {
                  if (displayMouseX < cursorX) {
                    // Mouse on left, label on left
                    return 'translateX(-100%) translateX(-4px)';
                  } else {
                    // Mouse on right, label on right
                    return 'translateX(4px)';
                  }
                }
                
                // Default: check edges
                if (displayMouseX < 60) {
                  // Too close to left edge, show on right
                  return 'translateX(4px)';
                } else if (displayMouseX > canvasWidth - 80) {
                  // Too close to right edge, show on left
                  return 'translateX(-100%) translateX(-4px)';
                }
                // Default: show on left (opposite of cursor default)
                return 'translateX(-100%) translateX(-4px)';
              })(),
              color: '#00ffff',
              fontWeight: 'bold',
              zIndex: 2,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}>
              {(() => {
                const mouseTime = viewport.timeStart + (displayMouseX / (canvasWidth || 1)) * (viewport.timeEnd - viewport.timeStart);
                const mouseTimeDisplay = Math.round(lod0ToDisplay(mouseTime, timeConfig));
                const cursorTimeDisplay = Math.round(lod0ToDisplay(cursor.position, timeConfig));
                const delta = mouseTimeDisplay - cursorTimeDisplay;
                const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
                return `Mouse: ${mouseTimeDisplay} (${deltaStr})`;
              })()}
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
