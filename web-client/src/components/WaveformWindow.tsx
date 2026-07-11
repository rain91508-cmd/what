import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { waveformRenderer } from '../core/render/waveformRenderer';
import { mockDataProvider } from '../core/data/mockDataProvider';
import type { Signal } from '../types';
import type { WaveformSignal, ColumnWidths, TimeConfig } from './TabPanel';
import { lod0ToDisplay, initTimeConfig } from './TabPanel';
import type { SignalInfo, DisplayFormat } from '../types/dataProvider';
import type { Wavemark } from '../types/wavemark';
import { FilterInput } from './FilterInput';
import { wildcardMatch } from '../utils/wildcardMatch';
import { zoomIn, zoomOut } from '../utils/zoomHelpers';
import { sanitizeTimeRange, type TimeRangeOnly } from '../utils/viewport';
import { buildWasmSignals } from '../wasm/waveformProvider';
import { useT } from '../i18n';

import { WaveformProviderAdapter } from '../wasm/waveformProviderAdapter';
import { useWaveformProvider } from '../contexts/WaveformProviderContext';

/**
 * 统一的信号值管理器
 * 直接存储和管理 WASM 返回的格式化值
 */
class SignalValueManager {
  // 存储格式化后的值（用于显示）
  private values: Map<number, string> = new Map();
  
  // 回调：值变化
  private onValuesChange?: (values: Map<number, string>) => void;

  constructor(onValuesChange?: (values: Map<number, string>) => void) {
    this.onValuesChange = onValuesChange;
  }

  /**
   * 设置单个信号的值
   */
  setValue(signalId: number, value: string): void {
    this.values.set(signalId, value);
    this.triggerChange();
  }

  /**
   * 批量设置值
   */
  setValues(values: Map<number, string>): void {
    this.values = new Map(values);
    this.triggerChange();
  }

  /**
   * 获取单个信号的值
   */
  getValue(signalId: number): string {
    return this.values.get(signalId) || '0x0';
  }

  /**
   * 获取所有值
   */
  getValues(): Map<number, string> {
    return new Map(this.values);
  }

  /**
   * 清除所有值
   */
  clear(): void {
    this.values.clear();
    this.onValuesChange?.(new Map());
  }

  /**
   * 触发值变化回调
   */
  private triggerChange(): void {
    if (this.onValuesChange) {
      this.onValuesChange(new Map(this.values));
    }
  }
}

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
  activeTabId?: string;  // 当前激活的 tab ID，用于检测 tab 切换
  onColumnWidthsChange?: (widths: ColumnWidths) => void;  // 列宽变化回调
  viewport?: TimeRangeOnly;          // 外部控制的 viewport（可选）
  onViewportChange?: (viewport: TimeRangeOnly) => void;  // viewport 变化回调
  cursorPosition?: number;      // 外部控制的 cursor 位置（可选）
  onCursorPositionChange?: (position: number) => void;  // cursor 位置变化回调
  useMockData?: boolean;        // 是否使用 mock 数据
  // WASM Provider 配置（当 useMockData=false 时使用）
  serverUrl?: string;           // 服务器 URL
  waveformName?: string;        // 波形名称
  signalPrefix?: string;        // 本地信号前缀
  serverPrefix?: string;        // 服务器信号前缀
  spaceBeforeBracket?: boolean; // 是否在 [ 前加空格
  // Waveform total range for sanity checks
  waveformRange?: {
    start: number;  // LoD0Unit - total start time of waveform
    end: number;    // LoD0Unit - total end time of waveform
  };
  // Signal settings for session save/restore
  initialSignalDisplayFormats?: Record<number, 'hex' | 'bin' | 'oct' | 'dec'>;
  initialSignalHierarchySelections?: Record<number, number[]>;
  onSignalSettingsChange?: (settings: {
    signalDisplayFormats?: Record<number, 'hex' | 'bin' | 'oct' | 'dec'>;
    signalHierarchySelections?: Record<number, number[]>;
  }) => void;
  // Wavemarks to display
  wavemarks?: Wavemark[];
  // Signal selection callback
  onSignalSelect?: (signal: Signal & { unique_id: number }) => void;
  // Signal double click callback (jump to declaration)
  onSignalDoubleClick?: (signal: Signal & { unique_id: number }) => void;
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
  panel: 300,
};

// 默认时间配置
// DisplayUnitPerLoD0Unit = 1 表示 1 DisplayUnit = 1 LoD0Unit
const DEFAULT_TIME_CONFIG: TimeConfig = initTimeConfig(1);

/**
 * 格式化数字，每3位添加千位分隔符（逗号）
 * 例如：1234567 -> 1,234,567
 */
function formatNumberWithCommas(num: number): string {
  return num.toLocaleString('en-US');
}

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
  serverPrefix: _serverPrefix = '',
  spaceBeforeBracket: _spaceBeforeBracket = false,
  waveformRange,
  initialSignalDisplayFormats,
  initialSignalHierarchySelections,
  onSignalSettingsChange,
  wavemarks = [],
  onSignalSelect,
  onSignalDoubleClick,
  activeTabId,
}: WaveformWindowProps) {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const signalPanelRef = useRef<HTMLDivElement>(null);
  const signalListRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);

  // 可见信号范围状态（用于虚拟滚动）
  const [visibleRange, setVisibleRange] = useState<{ start: number; end: number }>({ start: 0, end: 100 });
  const visibleRangeRef = useRef(visibleRange);

  // 使用共享 Provider
  const { provider: sharedProvider, isLoading: providerLoading } = useWaveformProvider();
  // WASM Provider reference - 使用适配器包装共享 Provider
  const wasmProviderRef = useRef<WaveformProviderAdapter | null>(null);
  // Canvas ID - 每个 Tab 唯一
  const canvasIdRef = useRef<string>(`canvas-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  // 用于跟踪 Adapter 是否已创建，触发重新渲染
  const [adapterCreated, setAdapterCreated] = useState(false);
  // 用于跟踪 Provider 是否已准备好
  const providerReady = !providerLoading && sharedProvider !== null && wasmProviderRef.current !== null;

  // Initialize WASM Adapter and Register Canvas when shared provider is ready
  // 使用 ref 来跟踪 Canvas 是否已 transfer，防止 StrictMode 下的重复 transfer
  const canvasTransferredRef = useRef(false);
  
  // 添加一个 forceRender 状态，用于在 tab 切换时强制重新渲染
  const [forceRender, setForceRender] = useState(false);
  
  // 当组件从非激活状态切换到激活状态时，强制触发一次渲染
  useEffect(() => {
    console.log(`[WaveformWindow] Component activated, triggering force render`);
    setForceRender(true);
  }, []);
  
  // 当 tab 切换到波形 tab 时，强制触发重绘
  useEffect(() => {
    if (activeTabId) {
      console.log(`[WaveformWindow] Tab activated: ${activeTabId}, triggering force render`);
      setForceRender(prev => !prev);
      // 延迟触发一次渲染，确保 renderWaveformRef 已经赋值
      setTimeout(() => {
        if (renderWaveformRef.current) {
          console.log(`[WaveformWindow] Calling renderWaveform after tab switch`);
          renderWaveformRef.current().catch(console.error);
        } else {
          console.warn(`[WaveformWindow] renderWaveformRef not ready yet`);
        }
      }, 100);
    }
  }, [activeTabId]);
  
  useEffect(() => {
    console.log(`[WaveformWindow] Provider init check: useMockData=${useMockData}, providerLoading=${providerLoading}, sharedProvider=${sharedProvider ? 'yes' : 'no'}`);

    // 创建 Adapter（如果还没有创建）
    if (!useMockData && sharedProvider && !wasmProviderRef.current) {
      const adapter = new WaveformProviderAdapter(sharedProvider, canvasIdRef.current);
      wasmProviderRef.current = adapter;
      setAdapterCreated(true); // 触发重新渲染
      console.log(`[WaveformWindow] Created adapter for canvas: ${canvasIdRef.current}`);
    }

    // 注册 Canvas（如果adapter已创建且canvas未注册）
    if (!wasmProviderRef.current || !canvasRef.current) {
      console.log(`[WaveformWindow] Waiting for adapter or canvas: adapter=${wasmProviderRef.current ? 'yes' : 'no'}, canvas=${canvasRef.current ? 'yes' : 'no'}`);
      return;
    }
    
    // 如果已经 transfer 过，标记 adapter 中的 canvas 为已注册（StrictMode 场景）
    if (canvasTransferredRef.current) {
      console.log(`[WaveformWindow] Canvas already transferred, marking adapter as registered: ${canvasIdRef.current}`);
      wasmProviderRef.current.markCanvasRegistered();
      // 延迟触发一次渲染，确保 canvas 已准备好
      setTimeout(() => {
        renderWaveform();
      }, 50);
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
        
        // Canvas 注册完成后延迟触发渲染
        setTimeout(() => {
          renderWaveform();
        }, 50);
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
  }, [useMockData, sharedProvider, providerLoading, forceRender]);
  
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
  // 使用 unique_id 作为 key，支持同一个信号多次出现
  const [signalValues, setSignalValues] = useState<Map<number, string>>(new Map());
  const [selectedSignal, setSelectedSignal] = useState<number | null>(null);
  const [expandedSignals, setExpandedSignals] = useState<Set<number>>(new Set());
  const [displayFormat, setDisplayFormat] = useState<'hex' | 'bin' | 'oct' | 'dec'>('hex');

  // 多选信号状态（使用 unique_id 作为 key）
  const [selectedSignals, setSelectedSignals] = useState<Set<number>>(new Set());
  const [lastSelectedSignal, setLastSelectedSignal] = useState<number | null>(null);

  // 每个信号独立的显示格式（使用 unique_id 作为 key）
  // 使用 initialSignalDisplayFormats 初始化
  const [signalDisplayFormats, setSignalDisplayFormats] = useState<Map<number, 'hex' | 'bin' | 'oct' | 'dec'>>(() => {
    if (initialSignalDisplayFormats) {
      return new Map(Object.entries(initialSignalDisplayFormats).map(([k, v]) => [Number(k), v]));
    }
    return new Map();
  });
  const signalDisplayFormatsRef = useRef<Map<number, 'hex' | 'bin' | 'oct' | 'dec'>>(signalDisplayFormats);
  
  // 用于强制触发 updateSignalValues 的计数器
  const [signalFormatVersion, setSignalFormatVersion] = useState(0);
  
  // 同步 signalDisplayFormats 到 ref
  useEffect(() => {
    signalDisplayFormatsRef.current = signalDisplayFormats;
  }, [signalDisplayFormats]);

  // 同步 visibleRange 到 ref
  useEffect(() => {
    visibleRangeRef.current = visibleRange;
  }, [visibleRange]);

  // 当前显示进制选择下拉菜单的信号 unique_id
  const [showFormatDropdown, setShowFormatDropdown] = useState<number | null>(null);
  const formatDropdownRef = useRef<HTMLDivElement>(null);
  const dropdownPositionRef = useRef<{ x: number; y: number } | null>(null);
  
  // 每个信号的 hierarchy 显示选项（使用 unique_id 作为 key）
  // 存储用户选择的 hierarchy 部分索引
  // 使用 initialSignalHierarchySelections 初始化
  const [signalHierarchySelections, setSignalHierarchySelections] = useState<Map<number, Set<number>>>(() => {
    if (initialSignalHierarchySelections) {
      return new Map(Object.entries(initialSignalHierarchySelections).map(([k, v]) => [Number(k), new Set(v)]));
    }
    return new Map();
  });
  
  // 当前显示 hierarchy 选择下拉菜单的信号 unique_id
  const [showHierarchyDropdown, setShowHierarchyDropdown] = useState<number | null>(null);
  const hierarchyDropdownRef = useRef<HTMLDivElement>(null);
  
  // 当信号设置变化时通知父组件
  const prevFormatsRef = useRef<string>('');
  const prevHierarchyRef = useRef<string>('');
  
  useEffect(() => {
    if (onSignalSettingsChange) {
      // 序列化当前值用于比较
      const formatsObj: Record<number, 'hex' | 'bin' | 'oct' | 'dec'> = {};
      signalDisplayFormats.forEach((value, key) => {
        formatsObj[key] = value;
      });
      
      const hierarchyObj: Record<number, number[]> = {};
      signalHierarchySelections.forEach((value, key) => {
        hierarchyObj[key] = Array.from(value);
      });
      
      const formatsStr = JSON.stringify(formatsObj);
      const hierarchyStr = JSON.stringify(hierarchyObj);
      
      // 只有当值真正变化时才调用回调
      if (formatsStr !== prevFormatsRef.current || hierarchyStr !== prevHierarchyRef.current) {
        prevFormatsRef.current = formatsStr;
        prevHierarchyRef.current = hierarchyStr;
        
        onSignalSettingsChange({
          signalDisplayFormats: formatsObj,
          signalHierarchySelections: hierarchyObj,
        });
      }
    }
  }, [signalDisplayFormats, signalHierarchySelections, onSignalSettingsChange]);
  
  // 统一的信号值管理器
  const signalValueManagerRef = useRef<SignalValueManager | null>(null);
  
  // 初始化 SignalValueManager
  useEffect(() => {
    if (!signalValueManagerRef.current) {
      signalValueManagerRef.current = new SignalValueManager((newValues) => {
        setSignalValues(newValues);
      });
    }
  }, []);
  
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
      if (formatDropdownRef.current && !formatDropdownRef.current.contains(event.target as Node)) {
        setShowFormatDropdown(null);
        dropdownPositionRef.current = null;
      }
      if (hierarchyDropdownRef.current && !hierarchyDropdownRef.current.contains(event.target as Node)) {
        setShowHierarchyDropdown(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 定位进制选择下拉菜单
  useEffect(() => {
    if (showFormatDropdown !== null && formatDropdownRef.current && dropdownPositionRef.current) {
      const dropdown = formatDropdownRef.current;
      const { x, y } = dropdownPositionRef.current;
      
      // 计算下拉菜单的位置
      const dropdownWidth = dropdown.offsetWidth || 90;
      const dropdownHeight = dropdown.offsetHeight || 120;
      
      let left = x - dropdownWidth + 8; // 让下拉菜单左边缘对齐点击位置
      let top = y + 8;
      
      // 确保下拉菜单不会超出屏幕右边界
      if (left + dropdownWidth > window.innerWidth) {
        left = window.innerWidth - dropdownWidth - 8;
      }
      
      // 确保下拉菜单不会超出屏幕下边界
      if (top + dropdownHeight > window.innerHeight) {
        top = y - dropdownHeight - 8;
      }
      
      // 确保下拉菜单不会超出屏幕左边界
      if (left < 8) {
        left = 8;
      }
      
      // 确保下拉菜单不会超出屏幕上边界
      if (top < 8) {
        top = 8;
      }
      
      dropdown.style.left = `${left}px`;
      dropdown.style.top = `${top}px`;
    }
  }, [showFormatDropdown]);

  // 获取信号的显示格式（单bit默认binary，多bit默认hex）
  // 不使用 useCallback，确保每次都能获取最新的 signalDisplayFormatsRef 值
  const getSignalDisplayFormat = (signal: Signal & { unique_id: number }): 'hex' | 'bin' | 'oct' | 'dec' => {
    // 先检查是否有自定义格式（使用 ref 获取最新值）
    const customFormat = signalDisplayFormatsRef.current.get(signal.unique_id);
    if (customFormat) {
      console.log(`[getSignalDisplayFormat] Signal ${signal.name} (unique_id: ${signal.unique_id}) has custom format: ${customFormat}`);
      return customFormat;
    }
    // 没有自定义格式，根据位宽返回默认值
    const isSingleBit = signal.msb === signal.lsb;
    const defaultFormat = isSingleBit ? 'bin' : 'hex';
    return defaultFormat;
  };

  // 设置信号的显示格式
  const setSignalDisplayFormat = (uniqueId: number, format: 'hex' | 'bin' | 'oct' | 'dec') => {
    setSignalDisplayFormats(prev => {
      const newMap = new Map(prev);
      newMap.set(uniqueId, format);
      return newMap;
    });
    setShowFormatDropdown(null);

    // 增加计数器，强制触发 updateSignalValues
    setSignalFormatVersion(prev => prev + 1);
  };

  // 为多个信号设置统一的显示格式
  const setMultiSignalDisplayFormat = (uniqueIds: number[], format: 'hex' | 'bin' | 'oct' | 'dec') => {
    setSignalDisplayFormats(prev => {
      const newMap = new Map(prev);
      uniqueIds.forEach(id => {
        newMap.set(id, format);
      });
      return newMap;
    });
    setShowFormatDropdown(null);

    // 增加计数器，强制触发 updateSignalValues
    setSignalFormatVersion(prev => prev + 1);
  };

  // 处理信号多选点击
  const handleSignalMultiSelect = (
    signal: Signal & { unique_id: number },
    isCtrlClick: boolean,
    isShiftClick: boolean,
    allSignals: Array<Signal & { unique_id: number }>
  ) => {
    if (isShiftClick && lastSelectedSignal !== null) {
      // Shift + 点击：范围选择
      const currentIndex = allSignals.findIndex(s => s.unique_id === signal.unique_id);
      const lastIndex = allSignals.findIndex(s => s.unique_id === lastSelectedSignal);

      if (currentIndex !== -1 && lastIndex !== -1) {
        const startIndex = Math.min(currentIndex, lastIndex);
        const endIndex = Math.max(currentIndex, lastIndex);
        const rangeSignals = allSignals.slice(startIndex, endIndex + 1).map(s => s.unique_id);

        setSelectedSignals(new Set(rangeSignals));
        setLastSelectedSignal(signal.unique_id);
      }
    } else if (isCtrlClick) {
      // Ctrl/Cmd + 点击：切换选择状态
      setSelectedSignals(prev => {
        const newSet = new Set(prev);
        if (newSet.has(signal.unique_id)) {
          newSet.delete(signal.unique_id);
        } else {
          newSet.add(signal.unique_id);
        }
        return newSet;
      });
      setLastSelectedSignal(signal.unique_id);
    } else {
      // 普通点击：单选，清除多选
      setSelectedSignals(new Set());
      setSelectedSignal(signal.unique_id);
      setLastSelectedSignal(signal.unique_id);
      onSignalSelect?.(signal);
    }
  };

  // 检查是否处于多选模式
  const isMultiSelectMode = selectedSignals.size > 0;

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
  }, [useMockData, providerReady, adapterCreated, viewport.timeStart, viewport.timeEnd]);  // 依赖 providerReady 和 viewport，当任一个准备好时重新执行

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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _lastWasmSettingsRef = useRef<{
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _cachedSegmentsRef = useRef<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _lastSegmentsParamsRef = useRef<{
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
    console.log(`[WaveformWindow] renderWaveform called, canvas=${!!canvasRef.current}, container=${!!containerRef.current}`);
    // 防止并发调用
    if (isRenderingRef.current) {
      console.log(`[WaveformWindow] renderWaveform skipped, already rendering`);
      return;
    }
    isRenderingRef.current = true;
    
    try {
      if (!canvasRef.current || !containerRef.current) {
        console.log(`[WaveformWindow] renderWaveform aborted, missing canvas or container`);
        return;
      }

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

      // 获取当前可见范围（使用 ref 获取最新值）
      const range = visibleRangeRef.current;
      const visibleStartRow = range.start;
      const visibleEndRow = range.end;

      treeNodes.forEach((node) => {
      if (node.type === 'group') {
        // Group row - no waveform, just increment row counter
        currentRow++;
      } else if (node.type === 'signal' && node.signal) {
        const signal = node.signal as Signal & { unique_id: number };
        const signalDisplayFormat = getSignalDisplayFormat(signal);

        // 检查信号是否展开（多bit信号）
        const isExpanded = expandedSignals.has(signal.unique_id);
        const isBus = signal.msb !== signal.lsb;

        if (isBus && isExpanded) {
          // 展开状态：先绘制原始多bit信号（第一行），再绘制各个bit
          // 只添加可见范围内的信号
          if (currentRow >= visibleStartRow && currentRow <= visibleEndRow) {
            signalList.push({
              uniqueId: signal.unique_id,
              globalId: signal.globalId,
              name: signal.fullName || signal.name,
              row: currentRow,
              displayName: signal.name,
              width: signal.msb - signal.lsb + 1,  // 提供位宽
              displayFormat: signalDisplayFormat,
            });
          }
          currentRow++;

          // 为每个bit创建单独的信号项
          // 使用 @[msb:lsb] 或 @[bit_index] 格式与 fullName 中的 [msb:lsb] 区分
          // WASM 检测到 @[...] 后，从父信号值中提取对应 bit
          // 例如: tb_top.u_dut.u_cluster0.mem_arid[7:0]@[0] 或 @[7:0]
          const bitCount = Math.min(signal.msb - signal.lsb + 1, 32);
          for (let i = 0; i < bitCount; i++) {
            const bitIndex = signal.msb - i;
            const baseName = signal.fullName || signal.name;
            // 只添加可见范围内的 bit 信号
            if (currentRow >= visibleStartRow && currentRow <= visibleEndRow) {
              signalList.push({
                uniqueId: signal.unique_id,  // bit信号使用相同的uniqueId
                globalId: signal.globalId,  // bit信号使用相同的globalId
                name: `${baseName}@[${bitIndex}]`,  // 特殊格式，WASM 从父信号提取 bit
                row: currentRow,
                displayName: `${signal.name}[${bitIndex}]`,
                width: 1,  // 单个bit
                displayFormat: 'bin',  // bit信号始终用binary显示
              });
            }
            currentRow++;
          }
        } else {
          // 折叠状态或单bit信号：作为一个整体
          const width = signal.msb !== signal.lsb ? signal.msb - signal.lsb + 1 : 1;
          // 只添加可见范围内的信号
          if (currentRow >= visibleStartRow && currentRow <= visibleEndRow) {
            signalList.push({
              uniqueId: signal.unique_id,
              globalId: signal.globalId,
              name: signal.fullName || signal.name,
              row: currentRow,
              displayName: signal.name,
              width,  // 提供位宽
              displayFormat: signalDisplayFormat,
            });
          }
          currentRow++;
        }
      }
    });

    // 生成 signalList 的哈希值用于检测变化
    const signalListHash = signalList.map(s => `${s.name}-${s.row}-${s.width}-${s.displayFormat}`).join('|');

    // 生成 timeConfig 的哈希值用于检测变化
    const timeConfigHash = `${timeConfig.DisplayUnitPerLoD0Unit}`;

    // 检查参数是否真的有变化，如果没有变化则直接返回，避免重复渲染
    const lastParams = lastRenderParamsRef.current;
//    const hasParamsChanged =
//      lastParams.signalPrefix !== _signalPrefix ||
//      lastParams.spaceBeforeBracket !== _spaceBeforeBracket ||
//      Math.abs(lastParams.viewportTimeStart - viewport.timeStart) > 0.1 ||
//      Math.abs(lastParams.viewportTimeEnd - viewport.timeEnd) > 0.1 ||
//      Math.abs(lastParams.canvasWidth - width) > 0.5 ||
//      Math.abs(lastParams.canvasHeight - height) > 0.5 ||
//      lastParams.signalListHash !== signalListHash ||
//      lastParams.timeConfigHash !== timeConfigHash;

//    if (!hasParamsChanged) {
//      // 参数没有变化，直接返回
//      return;
//    }

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
      // Worker 模式下直接使用 Adapter ，传递完整的参数

      // 获取可见范围的起始行，用于调整 row 值
      const visibleStartRow = visibleRangeRef.current.start;

      // 构建旧格式的信号列表，调整 row 值使其相对于可见区域顶部
      const uiSignals = signalList.map((s) => ({
        global_id: s.globalId,
        name: s.name,
        row: s.row - visibleStartRow, // 调整 row 值，使可见区域从 0 开始
        width: s.width || 1,
        displayFormat: s.displayFormat as 'hex' | 'bin' | 'oct' | 'dec' | undefined,
      }));

      // 构建带 draw_sig_id 的信号
      let wasmSignals: any[] = [];
      try {
        wasmSignals = await buildWasmSignals(uiSignals, _waveformName || 'unknown');
      } catch (error) {
        console.error('[WaveformWindow] Failed to build wasm signals:', error);
      }

      // 调用 Adapter 的 render_waveform 并传递完整参数
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
        displayFormat: displayFormat,
        timeConfig: {
          displayUnit: 'ps',
          lod0Unit: 1,
          displayUnitPerLoD0Unit: timeConfig.DisplayUnitPerLoD0Unit,
        },
        signalPrefix: _signalPrefix,
        serverPrefix: _serverPrefix,
        spaceBeforeBracket: _spaceBeforeBracket,
      });
    } else {
      // Mock 模式：使用旧流程
      let segments;
      if (useMockData) {
        // Use mock data provider
        mockDataProvider.initialize(
          signalList,
          viewport,
          displayFormat as DisplayFormat,
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

    // 绘制选择区域高亮（只在水平拖动时显示，且只在 Mock 模式下）
    // Worker 模式下 canvas 已转移到 Worker，主线程无法访问
    if (useMockData && isSelecting && selectionStartX !== null && selectionEndX !== null && selectionStartY !== null && selectionEndY !== null) {
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
        
        // 如果不是 mock 模式，检查 Provider 和 Canvas 是否准备好
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

  // 监听信号显示格式变化，重新渲染波形
  useEffect(() => {
    if (canvasWidth > 0 && renderWaveformRef.current) {
      renderWaveformRef.current().catch(console.error);
    }
  }, [signalDisplayFormats, canvasWidth]);

  // Cleanup mouse timeout on unmount
  useEffect(() => {
    return () => {
      if (mouseTimeoutRef.current) {
        clearTimeout(mouseTimeoutRef.current);
      }
    };
  }, []);

  // 鼠标按下：立即设置 cursor 并开始选择
  // 注意：Canvas 坐标是相对于 canvas 元素的，canvas 从 Info Bar 下方开始
  // 所以 canvas 内的 y 坐标 0 对应的是 Ruler 的顶部
  const RULER_HEIGHT = 20; // 标尺区域高度（在 canvas 内）
  const SIGNAL_ROW_HEIGHT = 24; // 信号行高度，与 CSS 中的 .waveform-signal-item 高度一致

  const handleCanvasMouseDown = useCallback(async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 判断是否在标尺区域（canvas 顶部 20px）
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
      // 从 RULER_HEIGHT 开始计算信号位置（canvas 内坐标）
      const signalY = y - RULER_HEIGHT;
      const visibleRowIndex = Math.floor(signalY / SIGNAL_ROW_HEIGHT);
      // 加上可见范围的起始行，得到全局的 treeNode 索引
      const nodeIndex = visibleRowIndex + visibleRangeRef.current.start;

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

        // Debug: console.log(`[WaveformWindow] Cursor snap: signal=${signalName}, clickTime=${clickTime}, threshold=${snapThreshold}, nodeIndex=${nodeIndex}`);

        try {
          const transitions = await wasmProvider.find_transitions_around(signalName, clickTime);
          // Debug: console.log(`[WaveformWindow] Cursor snap: transitions=`, transitions);
          if (transitions && Array.isArray(transitions) && transitions.length >= 2) {
            const prev = transitions[0] as number | null;
            const next = transitions[1] as number | null;

            // Debug: console.log(`[WaveformWindow] Cursor snap: prev=${prev}, next=${next}, clickTime=${clickTime}`);

            if (prev !== null && Math.abs(clickTime - prev) <= snapThreshold) {
              finalTime = prev;
              // Debug: console.log(`[WaveformWindow] Cursor snap: snapped to prev=${prev}`);
            } else if (next !== null && Math.abs(next - clickTime) <= snapThreshold) {
              finalTime = next;
              // Debug: console.log(`[WaveformWindow] Cursor snap: snapped to next=${next}`);
            } else {
              // Debug: console.log(`[WaveformWindow] Cursor snap: no snap, distances: prev=${prev !== null ? Math.abs(clickTime - prev) : 'null'}, next=${next !== null ? Math.abs(next - clickTime) : 'null'}`);
            }
          }
        } catch (error) {
          console.error('[WaveformWindow] Failed to find transitions:', error);
        }
      } else if (targetNode?.type === 'group') {
        // Debug: console.log(`[WaveformWindow] Cursor snap: clicked on group row, no snap`);
      }

      setCursor({ position: Math.round(finalTime), visible: true });
      
      // 开始拖动选择
      setIsSelecting(true);
      setSelectionStartX(x);
      setSelectionStartY(y);
      setSelectionEndX(x);
      setSelectionEndY(y);
      selectionStartRef.current = x;

      // 添加全局鼠标事件监听，支持鼠标移出canvas后继续拖动
      const handleGlobalMouseMove = (e: MouseEvent) => {
        if (!canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        
        // 计算相对于canvas的坐标，限制在canvas边界内
        let relativeX = e.clientX - rect.left;
        let relativeY = e.clientY - rect.top;
        
        // 限制X坐标在canvas边界内
        relativeX = Math.max(0, Math.min(rect.width, relativeX));
        // 限制Y坐标在canvas边界内（考虑Ruler高度）
        relativeY = Math.max(RULER_HEIGHT, Math.min(rect.height, relativeY));
        
        // 更新选择结束位置
        selectionEndXRef.current = relativeX;
        selectionEndYRef.current = relativeY;
        
        // 更新state用于渲染
        if (!selectionUpdateTimeoutRef.current) {
          selectionUpdateTimeoutRef.current = setTimeout(() => {
            setSelectionEndX(selectionEndXRef.current);
            setSelectionEndY(selectionEndYRef.current);
            selectionUpdateTimeoutRef.current = null;
          }, 16);
        }
      };

      const handleGlobalMouseUp = (e: MouseEvent) => {
        // 移除全局事件监听
        document.removeEventListener('mousemove', handleGlobalMouseMove);
        document.removeEventListener('mouseup', handleGlobalMouseUp);
        
        // 检查鼠标是否在canvas内释放
        if (!canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const isInsideCanvas = 
          e.clientX >= rect.left && 
          e.clientX <= rect.right && 
          e.clientY >= rect.top && 
          e.clientY <= rect.bottom;
        
        // 如果鼠标在canvas内释放，让handleCanvasMouseUp处理缩放
        // 如果鼠标在canvas外释放，在这里处理缩放
        if (isInsideCanvas) {
          // 重置选择状态，让handleCanvasMouseUp处理缩放
          setIsSelecting(false);
          setSelectionStartX(null);
          setSelectionStartY(null);
          setSelectionEndX(null);
          setSelectionEndY(null);
          selectionStartRef.current = null;
          return;
        }
        
        // 鼠标在canvas外释放，执行缩放操作
        const canvasWidth = rect.width;
        
        // 获取最终的选择结束位置
        const finalEndX = selectionEndXRef.current ?? x;
        const finalEndY = selectionEndYRef.current ?? y;
        
        // 计算拖动距离
        const deltaX = Math.abs(finalEndX - x);
        const deltaY = Math.abs(finalEndY - y);
        
        // 判断拖动方向
        const isHorizontalDrag = deltaX >= deltaY;
        
        if (isHorizontalDrag) {
          // 水平拖动：放大到选择的时间范围
          const startXPos = Math.min(x, finalEndX);
          const endXPos = Math.max(x, finalEndX);
          
          // 如果选择区域足够大（大于等于10像素），则放大
          if (endXPos - startXPos >= 10) {
            const rawTimeStart = viewport.timeStart + (startXPos / canvasWidth) * (viewport.timeEnd - viewport.timeStart);
            const rawTimeEnd = viewport.timeStart + (endXPos / canvasWidth) * (viewport.timeEnd - viewport.timeStart);
            
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
          const dragY = finalEndY - y;
          
          if (dragY < -20) {
            // 向上拖动超过20像素：放大（Zoom In）
            const newViewport = zoomIn(viewport, cursor.position);
            if (newViewport) {
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
              const sanitized = sanitizeTimeRange(newViewport.timeStart, newViewport.timeEnd, waveformRange);
              setViewport({
                ...newViewport,
                timeStart: sanitized.timeStart,
                timeEnd: sanitized.timeEnd,
              });
            }
          }
        }
        
        // 重置选择状态
        setIsSelecting(false);
        setSelectionStartX(null);
        setSelectionStartY(null);
        setSelectionEndX(null);
        setSelectionEndY(null);
        selectionStartRef.current = null;
      };

      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);
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
      const newWidth = Math.max(100, startWidth + delta);  // 只保留最小宽度限制100px，移除最大限制

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
    
    // Delete the group completely (including all signals and children)
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

  // ===== Drag and Drop State =====
  const [draggedItem, setDraggedItem] = useState<{ type: 'signal' | 'group'; id: string | number } | null>(null);
  const [dragOverItem, setDragOverItem] = useState<{ type: 'signal' | 'group'; id: string | number; position: 'before' | 'after' | 'inside' } | null>(null);

  // ===== Drag and Drop Handlers =====
  const handleDragStart = (e: React.DragEvent, type: 'signal' | 'group', id: string | number) => {
    setDraggedItem({ type, id });
    e.dataTransfer.effectAllowed = 'move';
    // Set drag image (optional)
    e.dataTransfer.setData('text/plain', `${type}:${id}`);
  };

  const handleDragOver = (e: React.DragEvent, type: 'signal' | 'group', id: string | number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!draggedItem) return;

    // Calculate drop position based on mouse Y position relative to target
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const isBelow = e.clientY > midY;

    // For groups, also support dropping inside (when dragging over group header)
    let position: 'before' | 'after' | 'inside' = isBelow ? 'after' : 'before';
    if (type === 'group' && draggedItem.type === 'signal') {
      // When dragging signal over group header, prefer dropping inside
      const isOverGroupHeader = e.clientY < rect.top + 20; // Top 20px is header
      if (isOverGroupHeader) {
        position = 'inside';
      }
    }

    setDragOverItem({ type, id, position });
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear if leaving the entire item (not entering a child)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setDragOverItem(null);
    }
  };

  const handleDrop = (e: React.DragEvent, targetType: 'signal' | 'group', targetId: string | number) => {
    e.preventDefault();
    e.stopPropagation();

    if (!draggedItem || !dragOverItem) {
      setDragOverItem(null);
      setDraggedItem(null);
      return;
    }

    const { type: sourceType, id: sourceId } = draggedItem;
    const { position } = dragOverItem;

    if (sourceType === 'signal') {
      handleSignalDrop(sourceId as number, targetType, targetId, position);
    } else if (sourceType === 'group') {
      handleGroupDrop(sourceId as string, targetType, targetId, position);
    }

    setDragOverItem(null);
    setDraggedItem(null);
  };

  const handleSignalDrop = (signalUniqueId: number, targetType: 'signal' | 'group', targetId: string | number, position: 'before' | 'after' | 'inside') => {
    // Find the signal and its current group
    let sourceGroupId: string | null = null;
    let signal: (Signal & { unique_id: number }) | null = null;

    for (const [gid, group] of Object.entries(groups)) {
      const found = group.signals.find(s => s.unique_id === signalUniqueId);
      if (found) {
        sourceGroupId = gid;
        signal = found;
        break;
      }
    }

    if (!sourceGroupId || !signal) return;

    // Determine target group and position
    let targetGroupId: string | null = null;
    let insertIndex: number = 0;

    if (targetType === 'group') {
      targetGroupId = targetId as string;
      const targetGroup = groups[targetGroupId];

      if (position === 'inside') {
        // Drop inside group at the beginning
        insertIndex = 0;
      } else {
        // Drop before/after the group - need to find position in parent's children list
        const parentId = targetGroup.parentId || 'root';
        const parentGroup = groups[parentId];
        const groupIndex = parentGroup.children.indexOf(targetGroupId);

        if (position === 'before') {
          // Insert at the position of this group
          insertIndex = groupIndex;
        } else {
          // Insert after this group
          insertIndex = groupIndex + 1;
        }
        targetGroupId = parentId;
      }
    } else {
      // Target is a signal
      const targetSignalId = targetId as number;

      // Find target signal's group
      for (const [gid, group] of Object.entries(groups)) {
        const targetIndex = group.signals.findIndex(s => s.unique_id === targetSignalId);
        if (targetIndex !== -1) {
          targetGroupId = gid;
          if (position === 'before') {
            insertIndex = targetIndex;
          } else {
            insertIndex = targetIndex + 1;
          }
          break;
        }
      }
    }

    if (!targetGroupId) return;

    // Don't do anything if dropping in the same position
    if (sourceGroupId === targetGroupId) {
      const sourceIndex = groups[sourceGroupId].signals.findIndex(s => s.unique_id === signalUniqueId);
      if (sourceIndex === insertIndex || sourceIndex === insertIndex - 1) {
        return;
      }
    }

    // Perform the move
    const newGroups = { ...groups };

    // Remove from source
    newGroups[sourceGroupId] = {
      ...newGroups[sourceGroupId],
      signals: newGroups[sourceGroupId].signals.filter(s => s.unique_id !== signalUniqueId),
    };

    // Adjust insert index if moving within the same group and source is before target
    if (sourceGroupId === targetGroupId) {
      const sourceIndex = groups[sourceGroupId].signals.findIndex(s => s.unique_id === signalUniqueId);
      if (sourceIndex < insertIndex) {
        insertIndex--;
      }
    }

    // Insert into target
    newGroups[targetGroupId] = {
      ...newGroups[targetGroupId],
      signals: [
        ...newGroups[targetGroupId].signals.slice(0, insertIndex),
        signal,
        ...newGroups[targetGroupId].signals.slice(insertIndex),
      ],
    };

    onGroupsUpdate(newGroups);
  };

  const handleGroupDrop = (sourceGroupId: string, targetType: 'signal' | 'group', targetId: string | number, position: 'before' | 'after' | 'inside') => {
    // Find source group's parent
    const sourceGroup = groups[sourceGroupId];
    if (!sourceGroup) return;

    const sourceParentId = sourceGroup.parentId || 'root';

    // Determine target parent and position
    let targetParentId: string;
    let insertIndex: number;

    if (targetType === 'group') {
      const targetGroupId = targetId as string;
      const targetGroup = groups[targetGroupId];

      if (position === 'inside') {
        // Move group inside target group
        targetParentId = targetGroupId;
        insertIndex = 0; // Insert at beginning
      } else {
        // Move group before/after target group
        targetParentId = targetGroup.parentId || 'root';
        const targetIndex = groups[targetParentId].children.indexOf(targetGroupId);

        if (position === 'before') {
          insertIndex = targetIndex;
        } else {
          insertIndex = targetIndex + 1;
        }
      }
    } else {
      // Cannot drop group on a signal
      return;
    }

    // Don't do anything if dropping in the same position
    if (sourceParentId === targetParentId) {
      const sourceIndex = groups[sourceParentId].children.indexOf(sourceGroupId);
      if (sourceIndex === insertIndex || sourceIndex === insertIndex - 1) {
        return;
      }
    }

    // Perform the move
    const newGroups = { ...groups };

    // Remove from source parent
    newGroups[sourceParentId] = {
      ...newGroups[sourceParentId],
      children: newGroups[sourceParentId].children.filter(id => id !== sourceGroupId),
    };

    // Adjust insert index if moving within the same parent and source is before target
    if (sourceParentId === targetParentId) {
      const sourceIndex = groups[sourceParentId].children.indexOf(sourceGroupId);
      if (sourceIndex < insertIndex) {
        insertIndex--;
      }
    }

    // Update source group's parent
    newGroups[sourceGroupId] = {
      ...newGroups[sourceGroupId],
      parentId: targetParentId === 'root' ? null : targetParentId,
    };

    // Insert into target parent
    newGroups[targetParentId] = {
      ...newGroups[targetParentId],
      children: [
        ...newGroups[targetParentId].children.slice(0, insertIndex),
        sourceGroupId,
        ...newGroups[targetParentId].children.slice(insertIndex),
      ],
    };

    onGroupsUpdate(newGroups);
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

  const getSignalValue = (signal: Signal & { unique_id: number }) => {
    // 从 SignalValueManager 获取格式化后的信号值，使用 unique_id 作为 key
    // 支持同一个信号多次出现
    if (signalValueManagerRef.current) {
      return signalValueManagerRef.current.getValue(signal.unique_id);
    }
    return signalValues.get(signal.unique_id) || '0x0';
  };

  const getHierarchyDisplay = (signal: Signal & { unique_id: number }): string => {
    // 返回信号路径（根据用户选择显示部分hierarchy）
    // 按 @ 和 . 分割hierarchy路径
    const fullPath = signal.fullName;
    const parts = fullPath.split(/[@.]/);
    if (parts.length <= 1) return '-';
    
    // 去掉最后一部分（信号名）
    parts.pop();
    
    // 获取用户选择的索引
    const selectedIndices = signalHierarchySelections.get(signal.unique_id);
    
    if (!selectedIndices || selectedIndices.size === 0) {
      // 没有选择，显示完整路径
      return parts.join('.');
    }
    
    // 根据用户选择的部分显示
    const selectedParts = parts.filter((_, index) => selectedIndices.has(index));
    
    if (selectedParts.length === 0) {
      return '-';
    }
    
    return selectedParts.join('.');
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

  // Memoize treeNodes to prevent infinite useEffect loops
  // The dependency array should include all values that affect the tree structure
  const treeNodes = useMemo(() => buildTreeNodes('root', 0, []), [
    groups,
    expandedSignals,
    ioFilters,
    nameFilter,
  ]);

  // 当 treeNodes 变化时，重新计算可见范围并触发重绘
  useEffect(() => {
    if (signalListRef.current) {
      const scrollTop = signalListRef.current.scrollTop;
      const clientHeight = signalListRef.current.clientHeight;
      const SIGNAL_ROW_HEIGHT = 24;

      const startRow = Math.floor(scrollTop / SIGNAL_ROW_HEIGHT);
      const visibleRows = Math.ceil(clientHeight / SIGNAL_ROW_HEIGHT);
      const endRow = startRow + visibleRows + 1;

      setVisibleRange({ start: Math.max(0, startRow), end: endRow });

      // 触发重绘
      if (renderWaveformRef.current) {
        renderWaveformRef.current().catch(console.error);
      }
    }
  }, [treeNodes]);

  // 监听 scrollend 事件（scroll-snap 动画结束后触发）
  useEffect(() => {
    const signalList = signalListRef.current;
    if (!signalList) return;

    const handleScrollEnd = () => {
      // scroll-snap 结束后再次计算可见范围并触发重绘
      const scrollTop = signalList.scrollTop;
      const clientHeight = signalList.clientHeight;
      const SIGNAL_ROW_HEIGHT = 24;

      const startRow = Math.floor(scrollTop / SIGNAL_ROW_HEIGHT);
      const visibleRows = Math.ceil(clientHeight / SIGNAL_ROW_HEIGHT);
      const endRow = startRow + visibleRows + 1;

      setVisibleRange({ start: Math.max(0, startRow), end: endRow });

      if (renderWaveformRef.current) {
        renderWaveformRef.current().catch(console.error);
      }
    };

    // 使用 scrollend 事件（现代浏览器支持）
    signalList.addEventListener('scrollend', handleScrollEnd);

    return () => {
      signalList.removeEventListener('scrollend', handleScrollEnd);
    };
  }, []);

  // 监听 cursor 或 displayFormat 变化，更新信号值
  // Note: This must be after treeNodes is defined
  useEffect(() => {
    const updateSignalValues = async () => {
      if (!cursor.visible || !signalValueManagerRef.current) {
        return;
      }

      // 根据模式选择正确的 provider
      if (!useMockData && wasmProviderRef.current) {
        // WASM 模式：从 WASM provider 获取信号值
        const wasmProvider = wasmProviderRef.current;
        if (!wasmProvider) return;
        // 使用 unique_id 作为 key，支持同一个信号多次出现
        const rawValues = new Map<number, string>();

        // Use treeNodes to get signals in the same order as rendering
        // This ensures cursor values match the displayed signals (including expanded bits)
        for (const node of treeNodes) {
          if (node.type !== 'signal' || !node.signal) continue;
          
          const signal = node.signal as Signal & { unique_id: number };
          // 获取信号的显示格式
          const signalDisplayFormat = getSignalDisplayFormat(signal);

          try {
            const signalName = signal.fullName || signal.name;
            // 传递 displayFormat 参数
            const valueInfo = await wasmProvider.get_signal_value_at_time(signalName, cursor.position, signalDisplayFormat);
            if (valueInfo && typeof valueInfo === 'object') {
              // ValueInfo object has displayStr field (camelCase from WASM serde)
              const displayStr = (valueInfo as any).displayStr || (valueInfo as any).display_str || '0x0';
              // Use unique_id as key to support duplicate signals
              rawValues.set(signal.unique_id, displayStr);

              // For expanded multi-bit signals, also get individual bit values
              // Use negative indices for bit values to avoid conflicts with signal unique_ids
              if (signal.msb !== signal.lsb && expandedSignals.has(signal.unique_id)) {
                const bitCount = Math.min(signal.msb - signal.lsb + 1, 32);
                for (let i = 0; i < bitCount; i++) {
                  const bitIndex = signal.msb - i;
                  const bitSignalName = `${signal.fullName}@[${bitIndex}]`;
                  try {
                    // bit信号使用bin格式
                    const bitValueInfo = await wasmProvider.get_signal_value_at_time(bitSignalName, cursor.position, 'bin');
                    // Use a unique key for each bit: -(unique_id * 100 + bit_index)
                    const bitKey = -(signal.unique_id * 100 + i);
                    if (bitValueInfo && typeof bitValueInfo === 'object') {
                      const bitDisplayStr = (bitValueInfo as any).displayStr || (bitValueInfo as any).display_str || '0';
                      rawValues.set(bitKey, bitDisplayStr);
                    } else {
                      rawValues.set(bitKey, '0');
                    }
                  } catch (error) {
                    const bitKey = -(signal.unique_id * 100 + i);
                    rawValues.set(bitKey, '0');
                  }
                }
              }
            } else {
              rawValues.set(signal.unique_id, '0x0');
            }
          } catch (error) {
            console.error(`[WaveformWindow] Error getting value for signal ${signal.name}:`, error);
            rawValues.set(signal.unique_id, '0x0');
          }
        }

        // 使用 SignalValueManager 批量设置值
        signalValueManagerRef.current.setValues(rawValues);
      } else {
        // Mock 模式：从 mock provider 获取信号值
        // Convert string keys to number keys for consistency
        const mockValues = mockDataProvider.getValuesAtTime(cursor.position);
        const rawValues = new Map<number, string>();
        // Mock data uses signal names as keys, we need to map them to unique_ids
        // For now, just use a simple hash of the name as the key
        mockValues.forEach((value, key) => {
          // Create a simple hash from the string key
          let hash = 0;
          for (let i = 0; i < key.length; i++) {
            const char = key.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
          }
          rawValues.set(Math.abs(hash), value);
        });
        // 使用 SignalValueManager 批量设置值
        signalValueManagerRef.current.setValues(rawValues);
      }
    };

    updateSignalValues();
  }, [cursor.position, cursor.visible, treeNodes, expandedSignals, useMockData, displayFormat, signalDisplayFormats, signalFormatVersion]);

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
    <div className="waveform-container" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Main content area - signal panel + canvas */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div
          className="waveform-signal-panel"
          ref={signalPanelRef}
          style={{ width: signalPanelWidth, minWidth: 100 }}
          onClick={(e) => {
            // 点击空白处取消多选（如果不是点击在信号行上）
            const target = e.target as HTMLElement;
            const isSignalRow = target.closest('.waveform-signal-item');
            const isValueColumn = target.closest('.waveform-signal-value');
            const isScopeColumn = target.closest('[title]'); // Scope column has title attribute

            if (!isSignalRow && !isValueColumn && selectedSignals.size > 0) {
              setSelectedSignals(new Set());
              setLastSelectedSignal(null);
            }
          }}
        >
        {/* Filter bar - 增加高度到40px */}
        <div style={{
          height: '40px',
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
            placeholder={t('panel.hierarchy.searchPlaceholder')}
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

        {/* Header with 3 columns and visible dividers - 增加高度到20px */}
        <div className="waveform-header" style={{ display: 'flex', position: 'relative', borderBottom: '1px solid #c0c0c0', height: '20px', boxSizing: 'border-box' }}>
          <span style={{ width: hierarchyColumnWidth, paddingLeft: '4px', fontSize: '10px', borderRight: '1px solid #c0c0c0' }}>{t('panel.waveform.scope')}</span>
          <span style={{ width: nameColumnWidth, paddingLeft: '4px', borderRight: '1px solid #c0c0c0' }}>{t('panel.waveform.name')}</span>
          <span style={{ 
            flex: 1,
            textAlign: 'right',
            paddingRight: '4px',
          }}>{t('panel.waveform.value')}</span>
          
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
          ref={signalListRef}
          className="waveform-signal-list"
          tabIndex={0}
          onScroll={(e) => {
            // 计算可见范围并触发重绘
            const target = e.target as HTMLDivElement;
            const scrollTop = target.scrollTop;
            const clientHeight = target.clientHeight;
            const SIGNAL_ROW_HEIGHT = 24; // 与 CSS 中的行高一致

            const startRow = Math.floor(scrollTop / SIGNAL_ROW_HEIGHT);
            const visibleRows = Math.ceil(clientHeight / SIGNAL_ROW_HEIGHT);
            const endRow = startRow + visibleRows + 1; // +1 确保部分可见的行也被包含

            // 更新可见范围（使用函数式更新避免依赖循环）
            setVisibleRange({ start: Math.max(0, startRow), end: endRow });

            // 触发重绘
            if (renderWaveformRef.current) {
              renderWaveformRef.current().catch(console.error);
            }
          }}
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
              
              const isDragOver = dragOverItem?.type === 'group' && dragOverItem?.id === group.id;
              const dropIndicatorStyle = isDragOver ? {
                borderTop: dragOverItem?.position === 'before' ? '2px solid #4080c0' : undefined,
                borderBottom: dragOverItem?.position === 'after' ? '2px solid #4080c0' : undefined,
                backgroundColor: dragOverItem?.position === 'inside' ? '#e8f0fe' : undefined,
              } : {};

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
                    draggable
                    onDragStart={(e) => handleDragStart(e, 'group', group.id)}
                    onDragOver={(e) => handleDragOver(e, 'group', group.id)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, 'group', group.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      paddingLeft: '4px',
                      cursor: 'move',
                      ...dropIndicatorStyle,
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
              const isSingleSelected = selectedSignal === signal.unique_id;
              const isMultiSelected = selectedSignals.has(signal.unique_id);
              const isSelected = isSingleSelected || isMultiSelected;

              const isDragOver = dragOverItem?.type === 'signal' && dragOverItem?.id === signal.unique_id;
              const dropIndicatorStyle = isDragOver ? {
                borderTop: dragOverItem?.position === 'before' ? '2px solid #4080c0' : undefined,
                borderBottom: dragOverItem?.position === 'after' ? '2px solid #4080c0' : undefined,
              } : {};

              // 获取所有信号节点用于 shift 选择
              const allSignalNodes = treeNodes.filter(n => n.type === 'signal' && n.signal) as Array<TreeNode & { signal: Signal & { unique_id: number } }>;
              const allSignals = allSignalNodes.map(n => n.signal);

              return (
                <div key={signal.unique_id}>
                  <div
                    className={`waveform-signal-item ${isSelected ? 'selected' : ''}`}
                    onClick={(e) => {
                      const isCtrlClick = e.ctrlKey || e.metaKey;
                      const isShiftClick = e.shiftKey;
                      handleSignalMultiSelect(signal, isCtrlClick, isShiftClick, allSignals);
                    }}
                    draggable={!isMultiSelectMode}
                    onDragStart={(e) => {
                      if (!isMultiSelectMode) {
                        handleDragStart(e, 'signal', signal.unique_id);
                      }
                    }}
                    onDragOver={(e) => handleDragOver(e, 'signal', signal.unique_id)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, 'signal', signal.unique_id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      paddingLeft: '4px',
                      cursor: isMultiSelectMode ? 'default' : 'move',
                      backgroundColor: isSelected ? '#e3f2fd' : undefined,
                      ...dropIndicatorStyle,
                    }}
                  >
                    {/* Scope column - 右对齐，显示完整路径，字体加大黑色，点击弹出选择菜单 */}
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
                        cursor: 'pointer',
                      }}
                      title={getHierarchyDisplay(signal)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isMultiSelectMode && selectedSignals.size > 0) {
                          // 多选模式：显示共有部分选择菜单
                          setShowHierarchyDropdown(signal.unique_id);
                        } else {
                          // 单选模式：显示该信号的 hierarchy 选择菜单
                          setShowHierarchyDropdown(signal.unique_id);
                        }
                      }}
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
                        onClick={() => {
                          onSignalSelect?.(signal);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          onSignalDoubleClick?.(signal);
                        }}
                        style={{ cursor: 'pointer' }}
                        title="Double-click to jump to declaration, drag to Signal Panel"
                      >
                        {getSignalDisplayName(signal)}
                      </span>
                    </span>
                    
                    {/* Value column - 右对齐，字体加大黑色，点击可选择进制 */}
                    <span
                      className="waveform-signal-value"
                      style={{
                        flex: 1,
                        display: 'flex',
                        justifyContent: 'flex-end',
                        alignItems: 'center',
                        paddingRight: '8px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        position: 'relative',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isMultiSelectMode && selectedSignals.size > 0) {
                          // 多选模式下：为所有选中的信号设置统一的格式
                          if (showFormatDropdown === signal.unique_id) {
                            setShowFormatDropdown(null);
                            dropdownPositionRef.current = null;
                          } else {
                            dropdownPositionRef.current = { x: e.clientX, y: e.clientY };
                            setShowFormatDropdown(signal.unique_id);
                          }
                        } else {
                          // 单选模式：保持原有行为
                          if (showFormatDropdown === signal.unique_id) {
                            setShowFormatDropdown(null);
                            dropdownPositionRef.current = null;
                          } else {
                            dropdownPositionRef.current = { x: e.clientX, y: e.clientY };
                            setShowFormatDropdown(signal.unique_id);
                          }
                        }
                      }}
                      title={isMultiSelectMode ? `Click to set format for ${selectedSignals.size} selected signals` : getSignalValue(signal)}
                    >
                      <span style={{
                        textAlign: 'right',
                        fontSize: '12px',
                        color: '#000',
                        fontWeight: 500,
                        cursor: 'pointer',
                      }}>
                        {getSignalValue(signal)}
                      </span>

                      {/* 进制选择下拉菜单 */}
                      {showFormatDropdown === signal.unique_id && (
                        <div
                          ref={formatDropdownRef}
                          style={{
                            position: 'fixed',
                            backgroundColor: 'white',
                            border: '1px solid #c0c0c0',
                            borderRadius: '2px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                            zIndex: 9999,
                            minWidth: '90px',
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          {['bin', 'oct', 'dec', 'hex'].map((format) => (
                            <div
                              key={format}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isMultiSelectMode && selectedSignals.size > 0) {
                                  // 多选模式：为所有选中的信号设置格式
                                  setMultiSignalDisplayFormat(Array.from(selectedSignals), format as any);
                                } else {
                                  // 单选模式：只为当前信号设置格式
                                  setSignalDisplayFormat(signal.unique_id, format as any);
                                }
                              }}
                              style={{
                                padding: '4px 8px',
                                fontSize: '11px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                backgroundColor: getSignalDisplayFormat(signal) === format ? '#e3f2fd' : 'white',
                              }}
                            >
                              <span style={{ width: '12px', textAlign: 'center' }}>
                                {getSignalDisplayFormat(signal) === format ? '✓' : ''}
                              </span>
                              <span>{format.toUpperCase()}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      
                      {/* Hierarchy 选择下拉菜单 */}
                      {showHierarchyDropdown === signal.unique_id && (
                        <div
                          ref={hierarchyDropdownRef}
                          style={{
                            position: 'fixed',
                            backgroundColor: 'white',
                            border: '1px solid #c0c0c0',
                            borderRadius: '2px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                            zIndex: 9999,
                            minWidth: '150px',
                            maxHeight: '200px',
                            overflow: 'auto',
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          {(() => {
                            // 判断是否为多选模式
                            const isMultiMode = isMultiSelectMode && selectedSignals.size > 0;

                            if (isMultiMode) {
                              // 多选模式：计算共有部分
                              const selectedSignalList = allSignals.filter(s => selectedSignals.has(s.unique_id));
                              if (selectedSignalList.length === 0) return null;

                              // 获取所有信号的 hierarchy 部分
                              const allPartsList = selectedSignalList.map(s => {
                                const parts = s.fullName.split(/[@.]/);
                                parts.pop(); // 去掉信号名
                                return parts;
                              });

                              // 找出最短的 hierarchy 长度（共有部分的最大长度）
                              const minLength = Math.min(...allPartsList.map(parts => parts.length));

                              // 计算共有部分：所有信号在该位置都相同的部分
                              const commonParts: { index: number; name: string }[] = [];
                              for (let i = 0; i < minLength; i++) {
                                const firstValue = allPartsList[0][i];
                                const isCommon = allPartsList.every(parts => parts[i] === firstValue);
                                if (isCommon) {
                                  commonParts.push({ index: i, name: firstValue });
                                }
                              }

                              if (commonParts.length === 0) {
                                return (
                                  <div style={{ padding: '8px', fontSize: '11px', color: '#666' }}>
                                    No common parts
                                  </div>
                                );
                              }

                              // 计算每个共有部分的选中状态（所有信号都选中才算选中）
                              const getCommonPartSelected = (index: number): boolean => {
                                return selectedSignalList.every(s => {
                                  const selection = signalHierarchySelections.get(s.unique_id);
                                  // 如果没有设置，默认为全选
                                  if (!selection) return true;
                                  return selection.has(index);
                                });
                              };

                              return (
                                <>
                                  <div style={{
                                    padding: '6px 8px',
                                    fontSize: '11px',
                                    fontWeight: 'bold',
                                    borderBottom: '1px solid #e0e0e0',
                                    backgroundColor: '#f5f5f5',
                                  }}>
                                    Common Parts ({selectedSignalList.length} signals)
                                  </div>
                                  {commonParts.map(({ index, name }) => {
                                    const isSelected = getCommonPartSelected(index);
                                    return (
                                      <div
                                        key={index}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          // 为所有选中的信号统一设置该部分
                                          setSignalHierarchySelections(prev => {
                                            const newMap = new Map(prev);
                                            selectedSignalList.forEach(s => {
                                              const parts = s.fullName.split(/[@.]/);
                                              parts.pop();
                                              const currentSet = new Set(prev.get(s.unique_id) ?? parts.map((_, i) => i));
                                              if (isSelected) {
                                                currentSet.delete(index);
                                              } else {
                                                currentSet.add(index);
                                              }
                                              newMap.set(s.unique_id, currentSet);
                                            });
                                            return newMap;
                                          });
                                        }}
                                        style={{
                                          padding: '4px 8px',
                                          fontSize: '11px',
                                          cursor: 'pointer',
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: '6px',
                                          backgroundColor: isSelected ? '#e3f2fd' : 'white',
                                        }}
                                      >
                                        <span style={{ width: '12px', textAlign: 'center' }}>
                                          {isSelected ? '✓' : ''}
                                        </span>
                                        <span>{name}</span>
                                      </div>
                                    );
                                  })}
                                </>
                              );
                            } else {
                              // 单选模式：原有逻辑
                              // 分割 hierarchy 路径
                              const fullPath = signal.fullName;
                              const parts = fullPath.split(/[@.]/);
                              parts.pop(); // 去掉信号名

                              if (parts.length === 0) return null;

                              // 获取当前选择
                              const currentSelection = signalHierarchySelections.get(signal.unique_id);
                              const allIndices = new Set(parts.map((_, i) => i));
                              const isAllSelected = !currentSelection || currentSelection.size === parts.length;

                              return (
                                <>
                                  {/* Select All / Select None */}
                                  <div
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSignalHierarchySelections(prev => {
                                        const newMap = new Map(prev);
                                        if (isAllSelected) {
                                          // Select none
                                          newMap.set(signal.unique_id, new Set());
                                        } else {
                                          // Select all
                                          newMap.set(signal.unique_id, new Set(parts.map((_, i) => i)));
                                        }
                                        return newMap;
                                      });
                                    }}
                                    style={{
                                      padding: '6px 8px',
                                      fontSize: '11px',
                                      cursor: 'pointer',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '6px',
                                      borderBottom: '1px solid #e0e0e0',
                                      fontWeight: 'bold',
                                    }}
                                  >
                                    <span style={{ width: '12px', textAlign: 'center' }}>
                                      {isAllSelected ? '✓' : '○'}
                                    </span>
                                    <span>{isAllSelected ? 'Select None' : 'Select All'}</span>
                                  </div>

                                  {/* 每个 hierarchy 部分 */}
                                  {parts.map((part, index) => {
                                    const isSelected = currentSelection?.has(index) ?? true;
                                    return (
                                      <div
                                        key={index}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSignalHierarchySelections(prev => {
                                            const newMap = new Map(prev);
                                            const currentSet = new Set(prev.get(signal.unique_id) ?? parts.map((_, i) => i));
                                            if (currentSet.has(index)) {
                                              currentSet.delete(index);
                                            } else {
                                              currentSet.add(index);
                                            }
                                            newMap.set(signal.unique_id, currentSet);
                                            return newMap;
                                          });
                                        }}
                                        style={{
                                          padding: '4px 8px',
                                          fontSize: '11px',
                                          cursor: 'pointer',
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: '6px',
                                          backgroundColor: isSelected ? '#e3f2fd' : 'white',
                                        }}
                                      >
                                        <span style={{ width: '12px', textAlign: 'center' }}>
                                          {isSelected ? '✓' : ''}
                                        </span>
                                        <span>{part}</span>
                                      </div>
                                    );
                                  })}
                                </>
                              );
                            }
                          })()}
                        </div>
                      )}
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
                              <span
                                className="waveform-signal-name"
                                onClick={() => {
                                  console.log('[WaveformWindow] Hierarchy signal name clicked:', signal.name);
                                  onSignalSelect?.(signal);
                                }}
                                style={{ cursor: 'pointer' }}
                              >
                                {signal.name}[{bitIndex}]
                              </span>
                            </span>
                            
                            {/* Value column */}
                            <span className="waveform-signal-value" style={{ flex: 1 }}>
                              {/* Use unique key for bit value: -(unique_id * 100 + bit_index) */}
                              {signalValueManagerRef.current?.getValue(-(signal.unique_id * 100 + i)) || '0'}
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
              {t('panel.waveform.noSignalsAdded')}
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

        <div className="waveform-canvas-container" ref={containerRef} style={{ display: 'flex', flexDirection: 'column', pointerEvents: 'auto', flex: 1 }}>
        {/* Cursor/Marker info bar - 40px，与左侧Filter Bar对齐 */}
        <div
          style={{
            height: '40px',
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
            pointerEvents: 'auto',
          }}
          onMouseMove={(e) => {
            // 当鼠标在info bar上移动时，更新mouseX以保持鼠标线显示
            const containerRect = containerRef.current?.getBoundingClientRect();
            if (containerRect) {
              const x = e.clientX - containerRect.left;
              setMouseX(x);
              setDisplayMouseX(x);
              pendingMouseXRef.current = x;
            }
          }}
          onMouseEnter={(e) => {
            // 当鼠标进入info bar时，恢复鼠标线显示
            const containerRect = containerRef.current?.getBoundingClientRect();
            if (containerRect) {
              const x = e.clientX - containerRect.left;
              setMouseX(x);
              setDisplayMouseX(x);
              pendingMouseXRef.current = x;
            }
          }}
          onMouseLeave={() => {
            // 当鼠标离开info bar时，如果不在canvas上，则清除鼠标线
            // 这里不需要处理，因为canvas的onMouseLeave会处理
          }}
        >
          {/* Cursor vertical line in info bar */}
          {cursor.visible && (
            <div style={{
              position: 'absolute',
              left: `${((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * 100}%`,
              top: 0,
              bottom: 0,
              width: '2px',
              background: '#ff00ff',
              zIndex: 100,
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

          {/* Cursor info - 两行显示：第一行Cursor，第二行时间 */}
          {cursor.visible && (() => {
            const cursorTimeStr = formatNumberWithCommas(Math.round(lod0ToDisplay(cursor.position, timeConfig)));
            const line1 = t('panel.waveform.cursor');
            const line2 = cursorTimeStr;
            // 估计每个字符8px宽度，取两行中较长的一行
            const charWidth = 8;
            const cursorTextWidth = Math.max(line1.length, line2.length) * charWidth + 8; // +8px padding
            
            return (
              <div style={{
                position: 'absolute',
                left: `${((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * 100}%`,
                transform: (() => {
                  const cursorX = ((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * canvasWidth;
                  
                  // Check if mouse is on the right side and too close
                  if (displayMouseX !== null && displayMouseX > cursorX && (displayMouseX - cursorX) < cursorTextWidth) {
                    // Mouse on right and too close, cursor label on left
                    return 'translateX(-100%) translateX(-4px)';
                  }
                  
                  // Check if too close to right edge
                  if (cursorX > canvasWidth - cursorTextWidth) {
                    return 'translateX(-100%) translateX(-4px)';
                  }
                  
                  // Default: show on right
                  return 'translateX(4px)';
                })(),
                color: '#ffffff',
                fontWeight: 'bold',
                zIndex: 2,
                pointerEvents: 'none',
                display: 'flex',
                flexDirection: 'column',
                lineHeight: '1.2',
              }}>
                <span>{line1}</span>
                <span>{line2}</span>
              </div>
            );
          })()}

          {/* Wavemark info labels */}
          {wavemarks.map((wavemark) => {
            // Only show wavemark label if it's within the current viewport
            if (wavemark.time < viewport.timeStart || wavemark.time > viewport.timeEnd) {
              return null;
            }
            
            const wavemarkTimeStr = formatNumberWithCommas(Math.round(lod0ToDisplay(wavemark.time, timeConfig)));
            const line1 = wavemark.name;
            const line2 = wavemarkTimeStr;
            const charWidth = 8;
            const textWidth = Math.max(line1.length, line2.length) * charWidth + 8;
            
            return (
              <div
                key={`wavemark-label-${wavemark.id}`}
                style={{
                  position: 'absolute',
                  left: `${((wavemark.time - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * 100}%`,
                  transform: (() => {
                    const wavemarkX = ((wavemark.time - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * canvasWidth;
                    const cursorX = cursor.visible 
                      ? ((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * canvasWidth 
                      : null;
                    
                    // Check if too close to right edge
                    if (wavemarkX > canvasWidth - textWidth) {
                      return 'translateX(-100%) translateX(-4px)';
                    }
                    
                    // Check if cursor is visible and wavemark is close to cursor
                    if (cursor.visible && cursorX !== null) {
                      const distance = Math.abs(wavemarkX - cursorX);
                      if (distance < textWidth + 10) { // 10px buffer
                        // Wavemark is close to cursor, show on opposite side
                        if (wavemarkX <= cursorX) {
                          // Wavemark is on left of cursor (or exactly at cursor), show label on left
                          return 'translateX(-100%) translateX(-4px)';
                        } else {
                          // Wavemark is on right of cursor, show label on right
                          return 'translateX(4px)';
                        }
                      }
                    }
                    
                    // Default: show on right
                    return 'translateX(4px)';
                  })(),
                  color: '#cccccc', // Light gray for text
                  fontWeight: 'bold',
                  zIndex: 1,
                  pointerEvents: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  lineHeight: '1.2',
                  fontSize: '12px',
                }}
              >
                <span>{line1}</span>
                <span>{line2}</span>
              </div>
            );
          })}

          {/* Mouse info - 两行显示：第一行差值，第二行时间 */}
          {displayMouseX !== null && mouseX !== null && (() => {
            const mouseTime = viewport.timeStart + (displayMouseX / (canvasWidth || 1)) * (viewport.timeEnd - viewport.timeStart);
            const mouseTimeDisplay = Math.round(lod0ToDisplay(mouseTime, timeConfig));
            const cursorTimeDisplay = Math.round(lod0ToDisplay(cursor.position, timeConfig));
            const delta = mouseTimeDisplay - cursorTimeDisplay;
            const deltaStr = `(${delta >= 0 ? '+' : ''}${formatNumberWithCommas(delta)})`;

            const line1 = deltaStr;
            const line2 = formatNumberWithCommas(mouseTimeDisplay);
            // 估计每个字符8px宽度，取两行中较长的一行
            const charWidth = 8;
            const mouseTextWidth = Math.max(line1.length, line2.length) * charWidth + 8; // +8px padding
            
            return (
              <div style={{
                position: 'absolute',
                left: mouseX,
                transform: (() => {
                  const cursorX = ((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * canvasWidth;
                  
                  // Check if too close to right edge
                  if (displayMouseX > canvasWidth - mouseTextWidth) {
                    // Too close to right edge, show on left
                    return 'translateX(-100%) translateX(-4px)';
                  }
                  
                  // Check if mouse is on the left of cursor and too close
                  if (cursor.visible && displayMouseX < cursorX && (cursorX - displayMouseX) < mouseTextWidth) {
                    // Mouse on left of cursor and too close, show on left
                    return 'translateX(-100%) translateX(-4px)';
                  }
                  
                  // Default: show on right
                  return 'translateX(4px)';
                })(),
                color: '#00ffff',
                fontWeight: 'bold',
                zIndex: 2,
                pointerEvents: 'none',
                display: 'flex',
                flexDirection: 'column',
                lineHeight: '1.2',
              }}>
                <span>{line1}</span>
                <span>{line2}</span>
              </div>
            );
          })()}
        </div>
        
        {/* Waveform canvas layers */}
        <div style={{ position: 'relative', flex: 1, pointerEvents: 'auto' }}>
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
              pointerEvents: 'auto',
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
              width: '2px',
              background: '#ff00ff',
              zIndex: 100,
              pointerEvents: 'none',
            }} />
          )}
          {/* Wavemark vertical lines - HTML overlay */}
          {wavemarks.map((wavemark) => {
            // Only show wavemark if it's within the current viewport
            if (wavemark.time < viewport.timeStart || wavemark.time > viewport.timeEnd) {
              return null;
            }
            return (
              <div
                key={wavemark.id}
                style={{
                  position: 'absolute',
                  left: `${((wavemark.time - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: '1px',
                  background: wavemark.color,
                  zIndex: 9,
                  pointerEvents: 'none',
                }}
                title={`${wavemark.name} @ ${wavemark.time}`}
              />
            );
          })}
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
      
      {/* Waveform Scrollbar - 显示当前view在整个波形中的位置和比例 */}
      {waveformRange && (
        <div
          className="waveform-scrollbar"
          style={{
            height: '14px',
            background: '#f0f0f0',
            borderTop: '1px solid #d0d0d0',
            position: 'relative',
            cursor: 'pointer',
            flexShrink: 0,
            overflow: 'hidden',
          }}
          onMouseDown={(e) => {
            // 计算点击位置对应的波形时间
            const rect = e.currentTarget.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const ratio = clickX / rect.width;
            const totalTime = waveformRange.end - waveformRange.start;
            const viewTimeRange = viewport.timeEnd - viewport.timeStart;
            
            // 点击位置作为view的中心
            const newCenterTime = waveformRange.start + ratio * totalTime;
            const newTimeStart = Math.max(waveformRange.start, newCenterTime - viewTimeRange / 2);
            const newTimeEnd = Math.min(waveformRange.end, newCenterTime + viewTimeRange / 2);
            
            setViewport({
              timeStart: newTimeStart,
              timeEnd: newTimeEnd,
            });
          }}
        >
          {/* 滑块 - 表示当前view的范围 */}
          {(() => {
            const totalTime = waveformRange.end - waveformRange.start;
            const viewStartRatio = (viewport.timeStart - waveformRange.start) / totalTime;
            const viewEndRatio = (viewport.timeEnd - waveformRange.start) / totalTime;
            const leftPercent = Math.max(0, viewStartRatio * 100);
            const widthPercent = Math.min(100, (viewEndRatio - viewStartRatio) * 100);
            
            return (
              <div
                style={{
                  position: 'absolute',
                  left: `${leftPercent}%`,
                  width: `${widthPercent}%`,
                  top: 0,
                  bottom: 0,
                  background: '#c0c0c0',
                  borderLeft: '1px solid #a0a0a0',
                  borderRight: '1px solid #a0a0a0',
                  cursor: 'grab',
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  const startX = e.clientX;
                  const startTimeStart = viewport.timeStart;
                  const startTimeEnd = viewport.timeEnd;
                  const viewTimeRange = startTimeEnd - startTimeStart;
                  const rect = e.currentTarget.parentElement?.getBoundingClientRect();
                  if (!rect) return;
                  
                  const handleMouseMove = (moveEvent: MouseEvent) => {
                    const deltaX = moveEvent.clientX - startX;
                    const deltaRatio = deltaX / rect.width;
                    const totalTime = waveformRange.end - waveformRange.start;
                    const deltaTime = deltaRatio * totalTime;
                    
                    let newTimeStart = startTimeStart + deltaTime;
                    let newTimeEnd = startTimeEnd + deltaTime;
                    
                    // 限制在波形范围内
                    if (newTimeStart < waveformRange.start) {
                      newTimeStart = waveformRange.start;
                      newTimeEnd = newTimeStart + viewTimeRange;
                    }
                    if (newTimeEnd > waveformRange.end) {
                      newTimeEnd = waveformRange.end;
                      newTimeStart = newTimeEnd - viewTimeRange;
                    }
                    
                    setViewport({
                      timeStart: newTimeStart,
                      timeEnd: newTimeEnd,
                    });
                  };
                  
                  const handleMouseUp = () => {
                    document.removeEventListener('mousemove', handleMouseMove);
                    document.removeEventListener('mouseup', handleMouseUp);
                  };
                  
                  document.addEventListener('mousemove', handleMouseMove);
                  document.addEventListener('mouseup', handleMouseUp);
                }}
              />
            );
          })()}
        </div>
      )}
    </div>
  );
}
