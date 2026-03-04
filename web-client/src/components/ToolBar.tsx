import { useState, useEffect, useRef } from 'react';
import type { TimeConfig } from './TabPanel';
import { displayToLod0, parseTimeUnitStr } from './TabPanel';

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
  onZoomFit: () => void;
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
  waveformTimeUnitStr?: string; // WaveformInfo.timeUnitStr 如 "1ps", "3ns"
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
}

export function ToolBar({ 
  onZoomIn, 
  onZoomOut, 
  onZoomFit, 
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
  waveformTimeUnitStr, // 如 "1ps", "3ns"
  maxWaveformTimeLod0 = 1000000, // Default 1,000,000 LoD0Units
  onConnect,
  onOpenKdb,
  onOpenWaveform,
  connected = false,
  onRefreshCheck,
  onToggleAutoCheck,
  autoCheckEnabled = false,
  onAddBookmark,
}: ToolBarProps) {
  // Local state for input value (only committed on Enter)
  // 用户输入的是绝对时间数值，单位由 selectedUnit 决定
  const [inputValue, setInputValue] = useState<string>('');
  const [selectedUnit, setSelectedUnit] = useState<TimeUnit>('ns');
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 获取 fs 乘数（根据 waveformTimeUnitStr 或 waveformTimeUnit）
  const getFsPerLod0Unit = (): number => {
    if (waveformTimeUnitStr) {
      // 使用服务器返回的原始字符串（如 "3ns"）
      const parsed = parseTimeUnitStr(waveformTimeUnitStr);
      return parsed.fsMultiplier;
    }
    // 使用数字枚举（如 2 = ns）
    return TIME_UNIT_MULTIPLIERS[TIME_UNIT_ENUM_TO_STR[waveformTimeUnit] ?? 'ns'];
  };

  // 根据 waveformTimeUnitStr 更新选中单位（如果提供了）
  useEffect(() => {
    if (waveformTimeUnitStr) {
      const parsed = parseTimeUnitStr(waveformTimeUnitStr);
      const unit = parsed.unit as TimeUnit;
      // 只更新为有效的单位选项
      if (TIME_UNIT_MULTIPLIERS[unit]) {
        setSelectedUnit(unit);
      }
    }
  }, [waveformTimeUnitStr]);

  // Update input value when timeConfig changes (from external sources like zoom buttons)
  // 将 DisplayUnitPerLoD0Unit 转换为当前单位的显示值
  useEffect(() => {
    if (!isEditing && timeConfig) {
      // DisplayUnitPerLoD0Unit 表示每个 DisplayUnit 对应多少个 LoD0Unit
      // 我们需要将其转换为绝对时间的显示值
      // 1 LoD0Unit = getFsPerLod0Unit() fs
      // DisplayUnit 的绝对时间 = DisplayUnitPerLoD0Unit * getFsPerLod0Unit() fs
      // 然后转换为 selectedUnit 单位的数值
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerLod0Unit = getFsPerLod0Unit();
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
    }
  }, [timeConfig, isEditing, waveformTimeUnit, waveformTimeUnitStr, selectedUnit]);

  // Initialize input value
  useEffect(() => {
    if (timeConfig && inputValue === '') {
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerLod0Unit = getFsPerLod0Unit();
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
    }
  }, [timeConfig, waveformTimeUnit, waveformTimeUnitStr, selectedUnit]);

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
    // 1. 转换为 fs: inputValue * TIME_UNIT_MULTIPLIERS[selectedUnit]
    const inputFs = numValue * TIME_UNIT_MULTIPLIERS[selectedUnit];

    // 2. 转换为 LoD0Unit: fs / fsPerLod0Unit
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
      <button className="tool-bar-button" title="Zoom Fit" onClick={onZoomFit}>
        ⬛
      </button>
      
      {/* Time configuration - always visible */}
      <div className="tool-bar-separator"></div>
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: '4px',
        padding: '0 4px',
      }}>
        <input
          ref={inputRef}
          type="number"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
          style={{
            width: '60px',
            padding: '2px 4px',
            fontSize: '11px',
            border: '1px solid #c0c0c0',
            borderRadius: '2px',
          }}
          min="0.000001"
          step={getStepSize()}
          title={timeConfig ? `Time per division (${selectedUnit}, press Enter to confirm)` : 'Time scale'}
        />
        <select
          value={selectedUnit}
          onChange={(e) => handleUnitChange(e.target.value as TimeUnit)}
          style={{
            padding: '2px 4px',
            fontSize: '11px',
            border: '1px solid #c0c0c0',
            borderRadius: '2px',
            width: '50px',
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
      
      <div className="tool-bar-separator"></div>
      <button className="tool-bar-button" title="Search" onClick={onSearch}>
        🔍
      </button>
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
