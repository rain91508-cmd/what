import { useState, useEffect, useRef } from 'react';
import type { TimeConfig } from './TabPanel';
import { displayToLod0, lod0ToDisplay } from './TabPanel';

// 时间单位类型（用户可选择）
type TimeUnit = 'fs' | 'ps' | 'ns' | 'us' | 'ms' | 's';

// 时间单位到 fs 乘数的映射（以 fs 为基准）
const TIME_UNIT_MULTIPLIERS: Record<TimeUnit, number> = {
  fs: 1,
  ps: 1000,
  ns: 1000000,
  us: 1000000000,
  ms: 1000000000000,
  s: 1000000000000000,
};

// 数字枚举到单位字符串的映射
const TIME_UNIT_ENUM_TO_STR: Record<number, TimeUnit> = {
  0: 'fs',
  1: 'ps',
  2: 'ns',
  3: 'us',
  4: 'ms',
  5: 's',
};

interface ToolBarProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFull: () => void;
  onSearch: () => void;
  onAddSourceTab?: () => void;
  onAddWaveformTab?: () => void;
  // Source navigation history
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
  canNavigatePrevious?: boolean;
  canNavigateNext?: boolean;
  // Time configuration for waveform tabs
  timeConfig?: TimeConfig;
  onTimeConfigChange?: (config: TimeConfig) => void;
  // Waveform info for time unit conversion
  waveformTimeUnit?: number; // WaveformInfo.timeUnit (0=fs, 1=ps, 2=ns, 3=us, 4=ms, 5=s)
  // Maximum waveform time in LoD0Unit (for validation)
  maxWaveformTimeLod0?: number;
  // Connection and file actions
  onConnect?: () => void;
  onOpenKdb?: () => void;
  onOpenWaveform?: () => void;
  connected?: boolean;
  // File change detection
  onRefreshCheck?: () => void;
  onToggleAutoCheck?: () => void;
  autoCheckEnabled?: boolean;
  // Bookmark
  onAddBookmark?: () => void;
  // Current tab type for bookmark behavior
  currentTabType?: 'source' | 'waveform';
  // Viewport and cursor for time display
  viewportStart?: number;  // viewport timeStart in LoD0 units
  viewportEnd?: number;    // viewport timeEnd in LoD0 units
  cursorPosition?: number; // cursor position in LoD0 units
  onViewportStartChange?: (newStart: number) => void; // callback when user changes start time
  onCursorPositionChange?: (newPosition: number) => void; // callback when user changes cursor position
  // Search functionality
  searchPattern?: string;
  onSearchPatternChange?: (pattern: string) => void;
  onSearchExecute?: () => void;
  onSearchCancel?: () => void;
  isSearching?: boolean;
  searchHistory?: string[];
  // Hierarchy search mode (when no tab or source tab active)
  isHierarchySearchMode?: boolean;
  searchSignals?: boolean;
  onSearchSignalsChange?: (searchSignals: boolean) => void;
  // Waveform search mode (when waveform tab active)
  isWaveformSearchMode?: boolean;
  waveformSearchType?: 'value' | 'edge' | 'transition';
  onWaveformSearchTypeChange?: (type: 'value' | 'edge' | 'transition') => void;
  waveformEdgeType?: 'rising' | 'falling' | 'any';
  onWaveformEdgeTypeChange?: (type: 'rising' | 'falling' | 'any') => void;
  waveformFromValue?: string;
  onWaveformFromValueChange?: (value: string) => void;
  waveformToValue?: string;
  onWaveformToValueChange?: (value: string) => void;
  onWaveformSearchForward?: () => void;
  onWaveformSearchBackward?: () => void;
}

export function ToolBar({ 
  onZoomIn, 
  onZoomOut, 
  onZoomFull, 
  onSearch,
  onAddSourceTab,
  onAddWaveformTab,
  onNavigatePrevious,
  onNavigateNext,
  canNavigatePrevious = false,
  canNavigateNext = false,
  timeConfig,
  onTimeConfigChange,
  waveformTimeUnit = 2, // Default to ns (2)
  maxWaveformTimeLod0 = 1000000, // Default 1,000,000 LoD0Units
  onConnect,
  onOpenKdb,
  onOpenWaveform,
  connected = false,
  onRefreshCheck,
  onToggleAutoCheck,
  autoCheckEnabled = false,
  onAddBookmark,
  // Viewport and cursor
  viewportStart,
  viewportEnd,
  cursorPosition,
  onViewportStartChange,
  onCursorPositionChange,
  // Search functionality
  searchPattern = '',
  onSearchPatternChange,
  onSearchExecute,
  onSearchCancel,
  isSearching = false,
  searchHistory = [],
  isHierarchySearchMode = false,
  searchSignals = false,
  onSearchSignalsChange,
  // Waveform search mode
  isWaveformSearchMode = false,
  waveformSearchType = 'value',
  onWaveformSearchTypeChange,
  waveformEdgeType = 'any',
  onWaveformEdgeTypeChange,
  waveformFromValue = '',
  onWaveformFromValueChange,
  waveformToValue = '',
  onWaveformToValueChange,
  onWaveformSearchForward,
  onWaveformSearchBackward,
}: ToolBarProps) {
  // Local state for display unit input value (only committed on Enter)
  const [inputValue, setInputValue] = useState<string>('');
  const [selectedUnit, setSelectedUnit] = useState<TimeUnit>('ns');
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Local state for start time input
  const [startInputValue, setStartInputValue] = useState<string>('');
  const [isStartEditing, setIsStartEditing] = useState(false);
  const startInputRef = useRef<HTMLInputElement>(null);

  // Local state for cursor position input
  const [cursorInputValue, setCursorInputValue] = useState<string>('');
  const [isCursorEditing, setIsCursorEditing] = useState(false);
  const cursorInputRef = useRef<HTMLInputElement>(null);

  // Search state
  const [showSearchHistory, setShowSearchHistory] = useState(false);
  const [localSearchPattern, setLocalSearchPattern] = useState(searchPattern);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // 获取 fs 乘数（根据 waveformTimeUnit）
  const getFsPerLod0Unit = (): number => {
    // 使用数字枚举（如 2 = ns）
    return TIME_UNIT_MULTIPLIERS[TIME_UNIT_ENUM_TO_STR[waveformTimeUnit] ?? 'ns'];
  };

  // 根据 waveformTimeUnit 更新选中单位
  useEffect(() => {
    const unit = TIME_UNIT_ENUM_TO_STR[waveformTimeUnit] ?? 'ns';
    // 只更新为有效的单位选项
    if (TIME_UNIT_MULTIPLIERS[unit]) {
      setSelectedUnit(unit as TimeUnit);
    }
  }, [waveformTimeUnit]);

  // Update display unit input value when timeConfig changes
  useEffect(() => {
    if (!isEditing && timeConfig) {
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerLod0Unit = getFsPerLod0Unit();
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
    }
  }, [timeConfig, isEditing, waveformTimeUnit, selectedUnit]);

  // Update start time input when viewport changes
  useEffect(() => {
    if (!isStartEditing && viewportStart !== undefined && timeConfig) {
      const displayValue = lod0ToDisplay(viewportStart, timeConfig);
      setStartInputValue(displayValue.toString());
    }
  }, [viewportStart, timeConfig, isStartEditing]);

  // Update cursor position input when cursor changes
  useEffect(() => {
    if (!isCursorEditing && cursorPosition !== undefined && timeConfig) {
      const displayValue = lod0ToDisplay(cursorPosition, timeConfig);
      setCursorInputValue(displayValue.toFixed(1)); // Show 1 decimal place
    }
  }, [cursorPosition, timeConfig, isCursorEditing]);

  // Initialize input values
  useEffect(() => {
    if (timeConfig && inputValue === '') {
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerLod0Unit = getFsPerLod0Unit();
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
    }
  }, [timeConfig, waveformTimeUnit, selectedUnit]);

  // Close search history when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowSearchHistory(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ==================== Display Unit Handlers ====================
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setIsEditing(true);
  };

  const handleUnitChange = (newUnit: TimeUnit) => {
    setSelectedUnit(newUnit);
    // 单位改变时，重新计算输入值
    if (timeConfig && !isEditing) {
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerLod0Unit = getFsPerLod0Unit();
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[newUnit];
      setInputValue(displayValue.toString());
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitInputValue();
    } else if (e.key === 'Escape') {
      // Restore original value
      if (timeConfig) {
        const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
        const fsPerLod0Unit = getFsPerLod0Unit();
        const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
        const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
        setInputValue(displayValue.toString());
      }
      setIsEditing(false);
      inputRef.current?.blur();
    }
  };

  const handleInputBlur = () => {
    // Restore original value on blur (cancel edit)
    if (timeConfig) {
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerLod0Unit = getFsPerLod0Unit();
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
    }
    setIsEditing(false);
  };

  const commitInputValue = () => {
    if (!timeConfig || !onTimeConfigChange) return;

    const numValue = parseFloat(inputValue);
    if (isNaN(numValue) || numValue <= 0) {
      // Invalid input, restore original value
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerLod0Unit = getFsPerLod0Unit();
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
      setIsEditing(false);
      return;
    }

    // 用户输入的是绝对时间数值（带单位）
    // LoD0Unit = time_unit (服务器的时间单位)
    // 1. 转换为 fs: inputValue * TIME_UNIT_MULTIPLIERS[selectedUnit]
    const inputFs = numValue * TIME_UNIT_MULTIPLIERS[selectedUnit];

    // 2. 转换为 LoD0Unit: fs / fsPerLod0Unit
    // fsPerLod0Unit 是通过 time_unit 计算得到的
    const fsPerLod0Unit = getFsPerLod0Unit();
    const lod0Units = Math.floor(inputFs / fsPerLod0Unit);

    // 3. 这就是新的 DisplayUnitPerLoD0Unit（必须是整数）
    const newDisplayUnitPerLoD0Unit = Math.max(1, lod0Units);

    // Validate: cannot be too large
    if (newDisplayUnitPerLoD0Unit > maxWaveformTimeLod0) {
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
      setIsEditing(false);
      return;
    }

    // Commit the change
    onTimeConfigChange({
      ...timeConfig,
      DisplayUnitPerLoD0Unit: newDisplayUnitPerLoD0Unit,
      _displayPerLod0: 1 / newDisplayUnitPerLoD0Unit,
    });
    setIsEditing(false);
  };

  // ==================== Start Time Handlers ====================
  const handleStartInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setStartInputValue(e.target.value);
    setIsStartEditing(true);
  };

  const handleStartInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitStartValue();
    } else if (e.key === 'Escape') {
      // Restore original value
      if (viewportStart !== undefined && timeConfig) {
        const displayValue = lod0ToDisplay(viewportStart, timeConfig);
        setStartInputValue(displayValue.toString());
      }
      setIsStartEditing(false);
      startInputRef.current?.blur();
    }
  };

  const handleStartInputBlur = () => {
    // Restore original value on blur (cancel edit)
    if (viewportStart !== undefined && timeConfig) {
      const displayValue = lod0ToDisplay(viewportStart, timeConfig);
      setStartInputValue(displayValue.toString());
    }
    setIsStartEditing(false);
  };

  const commitStartValue = () => {
    if (!timeConfig || !onViewportStartChange || viewportStart === undefined || viewportEnd === undefined) {
      setIsStartEditing(false);
      return;
    }

    const numValue = parseFloat(startInputValue);
    if (isNaN(numValue) || numValue < 0) {
      // Invalid input, restore original value
      const displayValue = lod0ToDisplay(viewportStart, timeConfig);
      setStartInputValue(displayValue.toString());
      setIsStartEditing(false);
      return;
    }

    // Convert display unit value to LoD0 units
    const newStartLod0 = displayToLod0(numValue, timeConfig);

    // Sanity check: ensure start is within valid range
    const timeSpan = viewportEnd - viewportStart;
    const maxStart = maxWaveformTimeLod0 - timeSpan;
    
    if (newStartLod0 < 0 || newStartLod0 > maxStart) {
      // Invalid range, restore original value
      const displayValue = lod0ToDisplay(viewportStart, timeConfig);
      setStartInputValue(displayValue.toString());
      setIsStartEditing(false);
      return;
    }

    // Commit the change - keep the same time span, just move the window
    onViewportStartChange(newStartLod0);
    setIsStartEditing(false);
  };

  // ==================== Cursor Position Handlers ====================
  const handleCursorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCursorInputValue(e.target.value);
    setIsCursorEditing(true);
  };

  const handleCursorInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitCursorValue();
    } else if (e.key === 'Escape') {
      // Restore original value
      if (cursorPosition !== undefined && timeConfig) {
        const displayValue = lod0ToDisplay(cursorPosition, timeConfig);
        setCursorInputValue(displayValue.toString());
      }
      setIsCursorEditing(false);
      cursorInputRef.current?.blur();
    }
  };

  const handleCursorInputBlur = () => {
    // Restore original value on blur (cancel edit)
    if (cursorPosition !== undefined && timeConfig) {
      const displayValue = lod0ToDisplay(cursorPosition, timeConfig);
      setCursorInputValue(displayValue.toString());
    }
    setIsCursorEditing(false);
  };

  const commitCursorValue = () => {
    if (!timeConfig || !onCursorPositionChange || cursorPosition === undefined) {
      setIsCursorEditing(false);
      return;
    }

    const numValue = parseFloat(cursorInputValue);
    if (isNaN(numValue) || numValue < 0) {
      // Invalid input, restore original value
      const displayValue = lod0ToDisplay(cursorPosition, timeConfig);
      setCursorInputValue(displayValue.toString());
      setIsCursorEditing(false);
      return;
    }

    // Convert display unit value to LoD0 units
    const newCursorLod0 = displayToLod0(numValue, timeConfig);

    // Sanity check: ensure cursor is within valid range
    if (newCursorLod0 < 0 || newCursorLod0 > maxWaveformTimeLod0) {
      // Invalid range, restore original value
      const displayValue = lod0ToDisplay(cursorPosition, timeConfig);
      setCursorInputValue(displayValue.toString());
      setIsCursorEditing(false);
      return;
    }

    // Commit the change
    onCursorPositionChange(newCursorLod0);
    setIsCursorEditing(false);
  };

  // Calculate step size based on current unit
  const getStepSize = (): string => {
    switch (selectedUnit) {
      case 's': return '0.001';
      case 'ms': return '0.001';
      case 'us': return '0.001';
      case 'ns': return '0.001';
      case 'ps': return '1';
      default: return '0.001';
    }
  };

  return (
    <div className="tool-bar">
      {/* Connection and file actions */}
      <button 
        className="tool-bar-button" 
        title={connected ? "Connected" : "Connect to Server"}
        onClick={onConnect}
        style={{ color: connected ? '#4caf50' : '#666' }}
      >
        {connected ? '🟢' : '🔌'}
      </button>
      <button 
        className="tool-bar-button" 
        title="Open KDB"
        onClick={onOpenKdb}
      >
        📂
      </button>
      <button 
        className="tool-bar-button" 
        title="Open Waveform"
        onClick={onOpenWaveform}
      >
        📊
      </button>
      
      <div className="tool-bar-separator"></div>
      <button className="tool-bar-button" title="Zoom In" onClick={onZoomIn}>
        🔍+
      </button>
      <button className="tool-bar-button" title="Zoom Out" onClick={onZoomOut}>
        🔍-
      </button>
      <button className="tool-bar-button" title="Zoom Full" onClick={onZoomFull}>
        ⬛
      </button>
      
      {/* Time configuration - always visible */}
      <div className="tool-bar-separator"></div>
      
      {/* Display Unit Input */}
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: '4px',
        padding: '0 4px',
      }}>
        <span style={{ fontSize: '11px', color: '#666' }}>Grid:</span>
        <input
          ref={inputRef}
          type="number"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
          style={{
            width: '60px',
            padding: '4px 6px',
            fontSize: '12px',
            border: '1px solid #c0c0c0',
            borderRadius: '3px',
            height: '24px',
          }}
          min="0.000001"
          step={getStepSize()}
          title={timeConfig ? `Time per division (${selectedUnit}, press Enter to confirm)` : 'Time scale'}
        />
        <select
          value={selectedUnit}
          onChange={(e) => handleUnitChange(e.target.value as TimeUnit)}
          style={{
            padding: '4px 6px',
            fontSize: '12px',
            border: '1px solid #c0c0c0',
            borderRadius: '3px',
            width: '50px',
            height: '24px',
          }}
          title="Time unit"
        >
          <option value="fs">fs</option>
          <option value="ps">ps</option>
          <option value="ns">ns</option>
          <option value="us">us</option>
          <option value="ms">ms</option>
          <option value="s">s</option>
        </select>
      </div>

      {/* Start Time Input */}
      {viewportStart !== undefined && (
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '4px',
          padding: '0 4px',
        }}>
          <span style={{ fontSize: '11px', color: '#666' }}>Start:</span>
          <input
            ref={startInputRef}
            type="number"
            value={startInputValue}
            onChange={handleStartInputChange}
            onKeyDown={handleStartInputKeyDown}
            onBlur={handleStartInputBlur}
            style={{
              width: '70px',
              padding: '4px 6px',
              fontSize: '12px',
              border: '1px solid #c0c0c0',
              borderRadius: '3px',
              height: '24px',
            }}
            min="0"
            step={getStepSize()}
            title={`Viewport start time (${selectedUnit}, press Enter to confirm)`}
          />
        </div>
      )}

      {/* Cursor Position Input */}
      {cursorPosition !== undefined && (
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '4px',
          padding: '0 4px',
        }}>
          <span style={{ fontSize: '11px', color: '#666' }}>Cursor:</span>
          <input
            ref={cursorInputRef}
            type="number"
            value={cursorInputValue}
            onChange={handleCursorInputChange}
            onKeyDown={handleCursorInputKeyDown}
            onBlur={handleCursorInputBlur}
            style={{
              width: '70px',
              padding: '4px 6px',
              fontSize: '12px',
              border: '1px solid #c0c0c0',
              borderRadius: '3px',
              height: '24px',
            }}
            min="0"
            step={getStepSize()}
            title={`Cursor position (${selectedUnit}, press Enter to confirm)`}
          />
        </div>
      )}
      
      <div className="tool-bar-separator"></div>
      
      {/* Search Section */}
      <div ref={searchContainerRef} style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
        {/* Waveform Search Mode */}
        {isWaveformSearchMode ? (
          <>
            {/* Search Type Dropdown */}
            <select
              value={waveformSearchType}
              onChange={(e) => onWaveformSearchTypeChange?.(e.target.value as 'value' | 'edge' | 'transition')}
              style={{
                padding: '4px 6px',
                fontSize: '11px',
                border: '1px solid #c0c0c0',
                borderRadius: '3px',
                height: '24px',
                width: '90px',
              }}
            >
              <option value="value">Value</option>
              <option value="edge">Edge</option>
              <option value="transition">Transition</option>
            </select>
            
            {/* Value Mode: Single input */}
            {waveformSearchType === 'value' && (
              <input
                ref={searchInputRef}
                type="text"
                value={localSearchPattern}
                onChange={(e) => {
                  setLocalSearchPattern(e.target.value);
                  onSearchPatternChange?.(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onWaveformSearchForward?.();
                  }
                }}
                placeholder="Pattern..."
                style={{
                  width: '80px',
                  padding: '4px 6px',
                  fontSize: '12px',
                  border: '1px solid #c0c0c0',
                  borderRadius: '3px',
                  height: '24px',
                }}
              />
            )}
            
            {/* Edge Mode: Edge type dropdown */}
            {waveformSearchType === 'edge' && (
              <select
                value={waveformEdgeType}
                onChange={(e) => onWaveformEdgeTypeChange?.(e.target.value as 'rising' | 'falling' | 'any')}
                style={{
                  padding: '4px 6px',
                  fontSize: '11px',
                  border: '1px solid #c0c0c0',
                  borderRadius: '3px',
                  height: '24px',
                  width: '70px',
                }}
              >
                <option value="rising">Rising</option>
                <option value="falling">Falling</option>
                <option value="any">Any</option>
              </select>
            )}
            
            {/* Transition Mode: From and To inputs */}
            {waveformSearchType === 'transition' && (
              <>
                <input
                  type="text"
                  value={waveformFromValue}
                  onChange={(e) => onWaveformFromValueChange?.(e.target.value)}
                  placeholder="From..."
                  style={{
                    width: '60px',
                    padding: '4px 6px',
                    fontSize: '12px',
                    border: '1px solid #c0c0c0',
                    borderRadius: '3px',
                    height: '24px',
                  }}
                />
                <span style={{ fontSize: '11px', color: '#666' }}>→</span>
                <input
                  type="text"
                  value={waveformToValue}
                  onChange={(e) => onWaveformToValueChange?.(e.target.value)}
                  placeholder="To..."
                  style={{
                    width: '60px',
                    padding: '4px 6px',
                    fontSize: '12px',
                    border: '1px solid #c0c0c0',
                    borderRadius: '3px',
                    height: '24px',
                  }}
                />
              </>
            )}
            
            {/* Search Backward Button */}
            <button
              className="tool-bar-button"
              title="Search Backward"
              onClick={() => onWaveformSearchBackward?.()}
              style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '1px' }}
            >
              <span>🔍</span><span>◀</span>
            </button>
            
            {/* Search Forward Button */}
            <button
              className="tool-bar-button"
              title="Search Forward"
              onClick={() => onWaveformSearchForward?.()}
              style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '1px' }}
            >
              <span>▶</span><span>🔍</span>
            </button>
          </>
        ) : (
          <>
            {/* Signal/Instance Checkbox (only in hierarchy search mode) */}
            {isHierarchySearchMode && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '2px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input
                  type="checkbox"
                  checked={searchSignals}
                  onChange={(e) => onSearchSignalsChange?.(e.target.checked)}
                  style={{ margin: 0 }}
                />
                <span>Signals</span>
              </label>
            )}
            
            {/* Search Input */}
            <div style={{ position: 'relative' }}>
              <input
                ref={searchInputRef}
                type="text"
                value={localSearchPattern}
                onChange={(e) => {
                  setLocalSearchPattern(e.target.value);
                  onSearchPatternChange?.(e.target.value);
                }}
                onFocus={() => setShowSearchHistory(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setShowSearchHistory(false);
                    if (isSearching) {
                      onSearchCancel?.();
                    } else {
                      onSearchExecute?.();
                    }
                  }
                }}
                placeholder="Search..."
                style={{
                  width: '120px',
                  padding: '4px 6px',
                  fontSize: '12px',
                  border: '1px solid #c0c0c0',
                  borderRadius: '3px',
                  height: '24px',
                }}
              />
              
              {/* Search History Dropdown */}
              {showSearchHistory && searchHistory.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: '2px',
                    background: '#fff',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    padding: '4px 0',
                    zIndex: 1000,
                    minWidth: '150px',
                    maxHeight: '200px',
                    overflow: 'auto',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                  }}
                >
                  {searchHistory.map((pattern, index) => (
                    <div
                      key={index}
                      onClick={() => {
                        setLocalSearchPattern(pattern);
                        onSearchPatternChange?.(pattern);
                        setShowSearchHistory(false);
                      }}
                      style={{
                        padding: '4px 8px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        hover: { background: '#f0f0f0' },
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f0f0')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {pattern}
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            {/* Search/Cancel Button */}
            <button
              className="tool-bar-button"
              title={isSearching ? 'Cancel Search' : 'Search'}
              onClick={() => {
                if (isSearching) {
                  onSearchCancel?.();
                } else {
                  onSearchExecute?.();
                }
              }}
              style={{
                background: isSearching ? '#ffebee' : undefined,
                color: isSearching ? '#d32f2f' : undefined,
              }}
            >
              {isSearching ? '✕' : '🔍'}
            </button>
          </>
        )}
      </div>
      
      <div className="tool-bar-separator"></div>
      <button className="tool-bar-button" title="Add Source Tab" onClick={onAddSourceTab}>
        📄+
      </button>
      <button className="tool-bar-button" title="Add Waveform Tab" onClick={onAddWaveformTab}>
        <span style={{ fontSize: '12px', fontFamily: 'monospace' }}>⌇+</span>
      </button>
      <button className="tool-bar-button" title="Add Bookmark" onClick={onAddBookmark}>
        🔖
      </button>
      
      {/* File change detection buttons */}
      <div className="tool-bar-separator"></div>
      <button 
        className="tool-bar-button" 
        title="Refresh Check - Check if KDB/Waveform has changed"
        onClick={onRefreshCheck}
      >
        🔄
      </button>
      <button 
        className="tool-bar-button" 
        title={autoCheckEnabled ? "Auto Check: ON" : "Auto Check: OFF"}
        onClick={onToggleAutoCheck}
        style={{ 
          color: autoCheckEnabled ? '#4caf50' : '#666',
          fontWeight: autoCheckEnabled ? 'bold' : 'normal'
        }}
      >
        {autoCheckEnabled ? '⏱️' : '⏸️'}
      </button>
      
      <div className="tool-bar-separator"></div>
      <button 
        className="tool-bar-button" 
        title="Previous Location"
        onClick={onNavigatePrevious}
        disabled={!canNavigatePrevious}
        style={{ opacity: canNavigatePrevious ? 1 : 0.3 }}
      >
        ◀
      </button>
      <button 
        className="tool-bar-button" 
        title="Next Location"
        onClick={onNavigateNext}
        disabled={!canNavigateNext}
        style={{ opacity: canNavigateNext ? 1 : 0.3 }}
      >
        ▶
      </button>
    </div>
  );
}
