import { useState, useEffect, useRef } from 'react';
import type { TimeConfig } from './TabPanel';
import { displayToLod0, lod0ToDisplay, initTimeConfig } from './TabPanel';
import { useT } from '../i18n';

type TimeUnit = 'fs' | 'ps' | 'ns' | 'us' | 'ms' | 's';

const TIME_UNIT_MULTIPLIERS: Record<TimeUnit, number> = {
  fs: 1,
  ps: 1000,
  ns: 1000000,
  us: 1000000000,
  ms: 1000000000000,
  s: 1000000000000000,
};

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
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
  canNavigatePrevious?: boolean;
  canNavigateNext?: boolean;
  timeConfig?: TimeConfig;
  onTimeConfigChange?: (config: TimeConfig) => void;
  waveformTimeUnit?: number;
  selectedDisplayUnit?: TimeUnit;
  onDisplayUnitChange?: (unit: TimeUnit) => void;
  maxWaveformTimeLod0?: number;
  onConnect?: () => void;
  onOpenKdb?: () => void;
  onOpenCachedKdb?: () => void;
  onOpenWaveform?: () => void;
  connected?: boolean;
  onRefreshCheck?: () => void;
  onToggleAutoCheck?: () => void;
  autoCheckEnabled?: boolean;
  onAddBookmark?: () => void;
  viewportStart?: number;
  viewportEnd?: number;
  cursorPosition?: number;
  onViewportStartChange?: (newStart: number) => void;
  onCursorPositionChange?: (newPosition: number) => void;
  searchPattern?: string;
  onSearchPatternChange?: (pattern: string) => void;
  onSearchExecute?: () => void;
  onSearchCancel?: () => void;
  isSearching?: boolean;
  searchHistory?: string[];
  isHierarchySearchMode?: boolean;
  searchSignals?: boolean;
  onSearchSignalsChange?: (searchSignals: boolean) => void;
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
  waveformSearchHistory?: string[];
  waveformFromValueHistory?: string[];
  waveformToValueHistory?: string[];
  onAddTableViewTab?: () => void;
  tableStartTime?: number;
  tableEndTime?: number;
  onTableStartTimeChange?: (time: number) => void;
  onTableEndTimeChange?: (time: number) => void;
  onTableStartTimeChangeWithSpan?: (start: number, end: number) => void;
  onTableTimeApply?: () => void;
  currentTabType?: 'source' | 'waveform' | 'tableview';
  currentWaveDisplayUnitPerLoD0?: number;
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
  waveformTimeUnit = 2,
  maxWaveformTimeLod0 = 1000000,
  onConnect,
  onOpenKdb,
  onOpenCachedKdb,
  onOpenWaveform,
  connected = false,
  onRefreshCheck,
  onToggleAutoCheck,
  autoCheckEnabled = false,
  onAddBookmark,
  viewportStart,
  viewportEnd,
  cursorPosition,
  onViewportStartChange,
  onCursorPositionChange,
  searchPattern = '',
  onSearchPatternChange,
  onSearchExecute,
  onSearchCancel,
  isSearching = false,
  searchHistory = [],
  isHierarchySearchMode = false,
  searchSignals = false,
  onSearchSignalsChange,
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
  waveformSearchHistory = [],
  waveformFromValueHistory = [],
  waveformToValueHistory = [],
  onAddTableViewTab,
  tableStartTime,
  tableEndTime,
  onTableStartTimeChange,
  onTableEndTimeChange,
  onTableStartTimeChangeWithSpan,
  onTableTimeApply,
  currentTabType = 'source',
  currentWaveDisplayUnitPerLoD0 = 1.0,
  selectedDisplayUnit,
  onDisplayUnitChange,
}: ToolBarProps) {
  const { t } = useT();
  const [inputValue, setInputValue] = useState<string>('');
  const [localSelectedUnit, setLocalSelectedUnit] = useState<TimeUnit>('ns');
  const selectedUnit = selectedDisplayUnit ?? localSelectedUnit;
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [startInputValue, setStartInputValue] = useState<string>('');
  const [isStartEditing, setIsStartEditing] = useState(false);
  const startInputRef = useRef<HTMLInputElement>(null);

  const [cursorInputValue, setCursorInputValue] = useState<string>('');
  const [isCursorEditing, setIsCursorEditing] = useState(false);
  const cursorInputRef = useRef<HTMLInputElement>(null);

  const [tableStartInputValue, setTableStartInputValue] = useState<string>('0');
  const [tableSpanInputValue, setTableSpanInputValue] = useState<string>('0');
  const tableStartInputRef = useRef<HTMLInputElement>(null);
  const tableSpanInputRef = useRef<HTMLInputElement>(null);

  const [showSearchHistory, setShowSearchHistory] = useState(false);
  const [localSearchPattern, setLocalSearchPattern] = useState(searchPattern);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  const [showWaveformSearchHistory, setShowWaveformSearchHistory] = useState(false);
  const [showFromValueHistory, setShowFromValueHistory] = useState(false);
  const [showToValueHistory, setShowToValueHistory] = useState(false);
  const waveformSearchInputRef = useRef<HTMLInputElement>(null);
  const fromValueInputRef = useRef<HTMLInputElement>(null);
  const toValueInputRef = useRef<HTMLInputElement>(null);
  const waveformSearchContainerRef = useRef<HTMLDivElement>(null);
  const fromValueContainerRef = useRef<HTMLDivElement>(null);
  const toValueContainerRef = useRef<HTMLDivElement>(null);

  const getFsPerLod0Unit = (): number => {
    return TIME_UNIT_MULTIPLIERS[TIME_UNIT_ENUM_TO_STR[waveformTimeUnit] ?? 'ns'];
  };

  useEffect(() => {
    if (selectedDisplayUnit !== undefined) {
      return;
    }
    const unit = TIME_UNIT_ENUM_TO_STR[waveformTimeUnit ?? 2] ?? 'ns';
    if (unit in TIME_UNIT_MULTIPLIERS) {
      setLocalSelectedUnit(unit);
    }
  }, [waveformTimeUnit, selectedDisplayUnit]);

  useEffect(() => {
    if (!isEditing && timeConfig) {
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerLod0Unit = getFsPerLod0Unit();
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
    }
  }, [timeConfig, isEditing, waveformTimeUnit, selectedUnit]);

  useEffect(() => {
    if (!isStartEditing && viewportStart !== undefined && timeConfig) {
      const displayValue = lod0ToDisplay(viewportStart, timeConfig);
      setStartInputValue(displayValue.toString());
    }
  }, [viewportStart, timeConfig, isStartEditing]);

  useEffect(() => {
    if (!isCursorEditing && cursorPosition !== undefined && timeConfig) {
      const displayValue = lod0ToDisplay(cursorPosition, timeConfig);
      setCursorInputValue(displayValue.toFixed(1));
    }
  }, [cursorPosition, timeConfig, isCursorEditing]);

  useEffect(() => {
    if (timeConfig && inputValue === '') {
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerLod0Unit = getFsPerLod0Unit();
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
    }
  }, [timeConfig, waveformTimeUnit, selectedUnit]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowSearchHistory(false);
      }
      if (waveformSearchContainerRef.current && !waveformSearchContainerRef.current.contains(e.target as Node)) {
        setShowWaveformSearchHistory(false);
      }
      if (fromValueContainerRef.current && !fromValueContainerRef.current.contains(e.target as Node)) {
        setShowFromValueHistory(false);
      }
      if (toValueContainerRef.current && !toValueContainerRef.current.contains(e.target as Node)) {
        setShowToValueHistory(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const effectiveTimeConfig = timeConfig || initTimeConfig(currentWaveDisplayUnitPerLoD0);
    if (tableStartTime !== undefined) {
      const displayValue = lod0ToDisplay(tableStartTime, effectiveTimeConfig);
      setTableStartInputValue(displayValue.toString());
    }
  }, [tableStartTime, timeConfig, currentWaveDisplayUnitPerLoD0]);

  useEffect(() => {
    const effectiveTimeConfig = timeConfig || initTimeConfig(currentWaveDisplayUnitPerLoD0);
    if (tableStartTime !== undefined && tableEndTime !== undefined) {
      const spanLod0 = tableEndTime - tableStartTime;
      const displaySpan = lod0ToDisplay(spanLod0, effectiveTimeConfig);
      setTableSpanInputValue(displaySpan.toString());
    }
  }, [tableStartTime, tableEndTime, timeConfig, currentWaveDisplayUnitPerLoD0]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setIsEditing(true);
  };

  const handleUnitChange = (newUnit: TimeUnit) => {
    setLocalSelectedUnit(newUnit);
    if (onDisplayUnitChange) {
      onDisplayUnitChange(newUnit);
    }
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
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerLod0Unit = getFsPerLod0Unit();
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
      setIsEditing(false);
      return;
    }

    const inputFs = numValue * TIME_UNIT_MULTIPLIERS[selectedUnit];
    const fsPerLod0Unit = getFsPerLod0Unit();
    const lod0Units = Math.floor(inputFs / fsPerLod0Unit);
    const newDisplayUnitPerLoD0Unit = Math.max(1, lod0Units);

    if (newDisplayUnitPerLoD0Unit > maxWaveformTimeLod0) {
      const lod0PerDisplayUnit = timeConfig.DisplayUnitPerLoD0Unit;
      const fsPerDisplayUnit = lod0PerDisplayUnit * fsPerLod0Unit;
      const displayValue = fsPerDisplayUnit / TIME_UNIT_MULTIPLIERS[selectedUnit];
      setInputValue(displayValue.toString());
      setIsEditing(false);
      return;
    }

    onTimeConfigChange({
      ...timeConfig,
      DisplayUnitPerLoD0Unit: newDisplayUnitPerLoD0Unit,
      _displayPerLod0: 1 / newDisplayUnitPerLoD0Unit,
    });
    setIsEditing(false);
  };

  const handleStartInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setStartInputValue(e.target.value);
    setIsStartEditing(true);
  };

  const handleStartInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitStartValue();
    } else if (e.key === 'Escape') {
      if (viewportStart !== undefined && timeConfig) {
        const displayValue = lod0ToDisplay(viewportStart, timeConfig);
        setStartInputValue(displayValue.toString());
      }
      setIsStartEditing(false);
      startInputRef.current?.blur();
    }
  };

  const handleStartInputBlur = () => {
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
      const displayValue = lod0ToDisplay(viewportStart, timeConfig);
      setStartInputValue(displayValue.toString());
      setIsStartEditing(false);
      return;
    }

    const newStartLod0 = displayToLod0(numValue, timeConfig);
    const timeSpan = viewportEnd - viewportStart;
    const maxStart = maxWaveformTimeLod0 - timeSpan;

    if (newStartLod0 < 0 || newStartLod0 > maxStart) {
      const displayValue = lod0ToDisplay(viewportStart, timeConfig);
      setStartInputValue(displayValue.toString());
      setIsStartEditing(false);
      return;
    }

    onViewportStartChange(newStartLod0);
    setIsStartEditing(false);
  };

  const handleCursorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCursorInputValue(e.target.value);
    setIsCursorEditing(true);
  };

  const handleCursorInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitCursorValue();
    } else if (e.key === 'Escape') {
      if (cursorPosition !== undefined && timeConfig) {
        const displayValue = lod0ToDisplay(cursorPosition, timeConfig);
        setCursorInputValue(displayValue.toString());
      }
      setIsCursorEditing(false);
      cursorInputRef.current?.blur();
    }
  };

  const handleCursorInputBlur = () => {
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
      const displayValue = lod0ToDisplay(cursorPosition, timeConfig);
      setCursorInputValue(displayValue.toString());
      setIsCursorEditing(false);
      return;
    }

    const newCursorLod0 = displayToLod0(numValue, timeConfig);

    if (newCursorLod0 < 0 || newCursorLod0 > maxWaveformTimeLod0) {
      const displayValue = lod0ToDisplay(cursorPosition, timeConfig);
      setCursorInputValue(displayValue.toString());
      setIsCursorEditing(false);
      return;
    }

    onCursorPositionChange(newCursorLod0);
    setIsCursorEditing(false);
  };

  const handleTableStartInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTableStartInputValue(e.target.value);
  };

  const handleTableSpanInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTableSpanInputValue(e.target.value);
  };

  const handleTableStartInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitTableStartValue();
    } else if (e.key === 'Escape') {
      if (tableStartTime !== undefined) {
        const effectiveTimeConfig = timeConfig || initTimeConfig(currentWaveDisplayUnitPerLoD0);
        const displayValue = lod0ToDisplay(tableStartTime, effectiveTimeConfig);
        setTableStartInputValue(displayValue.toString());
      }
    }
  };

  const handleTableSpanInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitTableSpanValue();
    } else if (e.key === 'Escape') {
      if (tableStartTime !== undefined && tableEndTime !== undefined) {
        const effectiveTimeConfig = timeConfig || initTimeConfig(currentWaveDisplayUnitPerLoD0);
        const spanLod0 = tableEndTime - tableStartTime;
        const displaySpan = lod0ToDisplay(spanLod0, effectiveTimeConfig);
        setTableSpanInputValue(displaySpan.toString());
      }
    }
  };

  const commitTableStartValue = () => {
    const effectiveTimeConfig = timeConfig || initTimeConfig(currentWaveDisplayUnitPerLoD0);
    if (!onTableStartTimeChange || !onTableEndTimeChange) return;

    const numValue = parseFloat(tableStartInputValue);
    if (isNaN(numValue) || numValue < 0) {
      if (tableStartTime !== undefined) {
        const displayValue = lod0ToDisplay(tableStartTime, effectiveTimeConfig);
        setTableStartInputValue(displayValue.toString());
      }
      return;
    }

    const newStartLod0 = displayToLod0(numValue, effectiveTimeConfig);
    const spanValue = parseFloat(tableSpanInputValue);
    let newEndLod0 = newStartLod0;
    if (!isNaN(spanValue)) {
      const spanLod0 = displayToLod0(spanValue, effectiveTimeConfig);
      newEndLod0 = newStartLod0 + spanLod0;
    }

    if (onTableStartTimeChangeWithSpan) {
      onTableStartTimeChangeWithSpan(newStartLod0, newEndLod0);
    } else {
      onTableStartTimeChange(newStartLod0);
      onTableEndTimeChange(newEndLod0);
    }
  };

  const commitTableSpanValue = (currentStartLod0?: number, effectiveTimeConfig?: TimeConfig) => {
    const config = effectiveTimeConfig || timeConfig || initTimeConfig(currentWaveDisplayUnitPerLoD0);

    if (!onTableEndTimeChange) return;

    const baseStartLod0 = currentStartLod0 !== undefined ? currentStartLod0 : tableStartTime;
    if (baseStartLod0 === undefined) return;

    const numValue = parseFloat(tableSpanInputValue);
    if (isNaN(numValue) || numValue < 0) {
      if (tableEndTime !== undefined && tableStartTime !== undefined) {
        const spanLod0 = tableEndTime - tableStartTime;
        const displaySpan = lod0ToDisplay(spanLod0, config);
        setTableSpanInputValue(displaySpan.toString());
      }
      return;
    }

    const spanLod0 = displayToLod0(numValue, config);
    const newEndLod0 = baseStartLod0 + spanLod0;
    onTableEndTimeChange(newEndLod0);
  };

  const handleTableTimeApply = () => {
    const effectiveTimeConfig = timeConfig || initTimeConfig(currentWaveDisplayUnitPerLoD0);

    const numStartValue = parseFloat(tableStartInputValue);
    let newStartLod0: number | undefined;
    if (!isNaN(numStartValue) && numStartValue >= 0 && effectiveTimeConfig && onTableStartTimeChange) {
      newStartLod0 = displayToLod0(numStartValue, effectiveTimeConfig);
      onTableStartTimeChange(newStartLod0);
    }

    commitTableSpanValue(newStartLod0, effectiveTimeConfig);

    onTableTimeApply?.();
  };

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
      <button
        className="tool-bar-button"
        title={connected ? t('toolbar.connected') : t('toolbar.connect')}
        onClick={onConnect}
        style={{ color: connected ? '#4caf50' : '#666' }}
      >
        {connected ? '🟢' : '🔌'}
      </button>
      <button
        className="tool-bar-button"
        title={t('toolbar.openKdb')}
        onClick={onOpenKdb}
      >
        📂
      </button>
      <button
        className="tool-bar-button"
        title={t('toolbar.openCachedKdb')}
        onClick={onOpenCachedKdb}
      >
        💾
      </button>
      <button
        className="tool-bar-button"
        title={t('toolbar.openWaveform')}
        onClick={onOpenWaveform}
      >
        📊
      </button>

      <div className="tool-bar-separator"></div>
      <button className="tool-bar-button" title={t('toolbar.zoomIn')} onClick={onZoomIn}>
        🔍+
      </button>
      <button className="tool-bar-button" title={t('toolbar.zoomOut')} onClick={onZoomOut}>
        🔍-
      </button>
      <button className="tool-bar-button" title={t('toolbar.zoomFull')} onClick={onZoomFull}>
        ⬛
      </button>

      <div className="tool-bar-separator"></div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 4px',
      }}>
        <span style={{ fontSize: '11px', color: '#666' }}>{t('toolbar.display')}</span>
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
          title={timeConfig ? `${t('toolbar.display')} (${selectedUnit}, press Enter to confirm)` : t('toolbar.display')}
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

      {viewportStart !== undefined && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '0 4px',
        }}>
          <span style={{ fontSize: '11px', color: '#666' }}>{t('toolbar.start')}</span>
          <input
            ref={startInputRef}
            type="number"
            value={startInputValue}
            onChange={handleStartInputChange}
            onKeyDown={handleStartInputKeyDown}
            onBlur={handleStartInputBlur}
            style={{
              width: '105px',
              padding: '4px 6px',
              fontSize: '12px',
              border: '1px solid #c0c0c0',
              borderRadius: '3px',
              height: '24px',
            }}
            min="0"
            step="1"
            title={`Viewport start time (${selectedUnit}, press Enter to confirm)`}
          />
        </div>
      )}

      {cursorPosition !== undefined && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '0 4px',
        }}>
          <span style={{ fontSize: '11px', color: '#666' }}>{t('toolbar.cursor')}</span>
          <input
            ref={cursorInputRef}
            type="number"
            value={cursorInputValue}
            onChange={handleCursorInputChange}
            onKeyDown={handleCursorInputKeyDown}
            onBlur={handleCursorInputBlur}
            style={{
              width: '105px',
              padding: '4px 6px',
              fontSize: '12px',
              border: '1px solid #c0c0c0',
              borderRadius: '3px',
              height: '24px',
            }}
            min="0"
            step="1"
            title={`Cursor position (${selectedUnit}, press Enter to confirm)`}
          />
        </div>
      )}

      {currentTabType === 'tableview' && (
        <>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '0 4px',
          }}>
            <span style={{ fontSize: '11px', color: '#666' }}>{t('toolbar.start')}</span>
            <input
              ref={tableStartInputRef}
              type="number"
              value={tableStartInputValue}
              onChange={handleTableStartInputChange}
              onKeyDown={handleTableStartInputKeyDown}
              style={{
                width: '105px',
                padding: '4px 6px',
                fontSize: '12px',
                border: '1px solid #c0c0c0',
                borderRadius: '3px',
                height: '24px',
              }}
              min="0"
              step="1"
              title={`Table start time (${selectedUnit}, press Enter to confirm)`}
            />
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '0 4px',
          }}>
            <span style={{ fontSize: '11px', color: '#666' }}>{t('toolbar.span')}</span>
            <input
              ref={tableSpanInputRef}
              type="number"
              value={tableSpanInputValue}
              onChange={handleTableSpanInputChange}
              onKeyDown={handleTableSpanInputKeyDown}
              style={{
                width: '105px',
                padding: '4px 6px',
                fontSize: '12px',
                border: '1px solid #c0c0c0',
                borderRadius: '3px',
                height: '24px',
              }}
              min="0"
              step="1"
              title={`Table time span (${selectedUnit}, press Enter to confirm)`}
            />
          </div>
          <button
            className="tool-bar-button"
            title={t('toolbar.apply')}
            onClick={handleTableTimeApply}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
            }}
          >
            {t('toolbar.apply')}
          </button>
        </>
      )}

      <div className="tool-bar-separator"></div>

      <div ref={searchContainerRef} style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
        {isWaveformSearchMode ? (
          <>
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
              <option value="value">{t('toolbar.value')}</option>
              <option value="edge">{t('toolbar.edge')}</option>
              <option value="transition">{t('toolbar.transition')}</option>
            </select>

            {waveformSearchType === 'value' && (
              <div ref={waveformSearchContainerRef} style={{ position: 'relative' }}>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={localSearchPattern}
                  onChange={(e) => {
                    setLocalSearchPattern(e.target.value);
                    onSearchPatternChange?.(e.target.value);
                  }}
                  onFocus={() => setShowWaveformSearchHistory(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setShowWaveformSearchHistory(false);
                      onWaveformSearchForward?.();
                    }
                  }}
                  placeholder={t('toolbar.pattern')}
                  style={{
                    width: '80px',
                    padding: '4px 6px',
                    fontSize: '12px',
                    border: '1px solid #c0c0c0',
                    borderRadius: '3px',
                    height: '24px',
                  }}
                />
                {showWaveformSearchHistory && searchHistory.length > 0 && (
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
                          setShowWaveformSearchHistory(false);
                        }}
                        style={{
                          padding: '4px 8px',
                          cursor: 'pointer',
                          fontSize: '12px',
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
            )}

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
                <option value="rising">{t('toolbar.rising')}</option>
                <option value="falling">{t('toolbar.falling')}</option>
                <option value="any">{t('toolbar.any')}</option>
              </select>
            )}

            {waveformSearchType === 'transition' && (
              <>
                <div ref={fromValueContainerRef} style={{ position: 'relative' }}>
                  <input
                    ref={fromValueInputRef}
                    type="text"
                    value={waveformFromValue}
                    onChange={(e) => onWaveformFromValueChange?.(e.target.value)}
                    onFocus={() => setShowFromValueHistory(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setShowFromValueHistory(false);
                      }
                    }}
                    placeholder={t('toolbar.from')}
                    style={{
                      width: '60px',
                      padding: '4px 6px',
                      fontSize: '12px',
                      border: '1px solid #c0c0c0',
                      borderRadius: '3px',
                      height: '24px',
                    }}
                  />
                  {showFromValueHistory && waveformFromValueHistory.length > 0 && (
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
                        minWidth: '120px',
                        maxHeight: '200px',
                        overflow: 'auto',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                      }}
                    >
                      {waveformFromValueHistory.map((value, index) => (
                        <div
                          key={index}
                          onClick={() => {
                            onWaveformFromValueChange?.(value);
                            setShowFromValueHistory(false);
                          }}
                          style={{
                            padding: '4px 8px',
                            cursor: 'pointer',
                            fontSize: '12px',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f0f0')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          {value}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: '11px', color: '#666' }}>→</span>
                <div ref={toValueContainerRef} style={{ position: 'relative' }}>
                  <input
                    ref={toValueInputRef}
                    type="text"
                    value={waveformToValue}
                    onChange={(e) => onWaveformToValueChange?.(e.target.value)}
                    onFocus={() => setShowToValueHistory(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setShowToValueHistory(false);
                      }
                    }}
                    placeholder={t('toolbar.to')}
                    style={{
                      width: '60px',
                      padding: '4px 6px',
                      fontSize: '12px',
                      border: '1px solid #c0c0c0',
                      borderRadius: '3px',
                      height: '24px',
                    }}
                  />
                  {showToValueHistory && waveformToValueHistory.length > 0 && (
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
                        minWidth: '120px',
                        maxHeight: '200px',
                        overflow: 'auto',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                      }}
                    >
                      {waveformToValueHistory.map((value, index) => (
                        <div
                          key={index}
                          onClick={() => {
                            onWaveformToValueChange?.(value);
                            setShowToValueHistory(false);
                          }}
                          style={{
                            padding: '4px 8px',
                            cursor: 'pointer',
                            fontSize: '12px',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f0f0')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          {value}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            <button
              className="tool-bar-button"
              title={t('toolbar.searchBackward')}
              onClick={() => onWaveformSearchBackward?.()}
              style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '1px' }}
            >
              <span>🔍</span><span>◀</span>
            </button>

            <button
              className="tool-bar-button"
              title={t('toolbar.searchForward')}
              onClick={() => onWaveformSearchForward?.()}
              style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '1px' }}
            >
              <span>▶</span><span>🔍</span>
            </button>
          </>
        ) : (
          <>
            {isHierarchySearchMode && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '2px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input
                  type="checkbox"
                  checked={searchSignals}
                  onChange={(e) => onSearchSignalsChange?.(e.target.checked)}
                  style={{ margin: 0 }}
                />
                <span>{t('toolbar.signals')}</span>
              </label>
            )}

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
                placeholder={t('toolbar.search')}
                style={{
                  width: '120px',
                  padding: '4px 6px',
                  fontSize: '12px',
                  border: '1px solid #c0c0c0',
                  borderRadius: '3px',
                  height: '24px',
                }}
              />

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

            <button
              className="tool-bar-button"
              title={isSearching ? t('toolbar.cancelSearch') : t('toolbar.search')}
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
      <button className="tool-bar-button" title={t('toolbar.addSourceTab')} onClick={onAddSourceTab}>
        📄+
      </button>
      <button className="tool-bar-button" title={t('toolbar.addWaveformTab')} onClick={onAddWaveformTab}>
        <span style={{ fontSize: '12px', fontFamily: 'monospace' }}>⌇+</span>
      </button>
      <button className="tool-bar-button" title={t('toolbar.addTableViewTab')} onClick={onAddTableViewTab}>
        <span style={{ fontSize: '12px', fontFamily: 'monospace' }}>📊+</span>
      </button>
      <button className="tool-bar-button" title={t('toolbar.addBookmark')} onClick={onAddBookmark}>
        🔖
      </button>

      <div className="tool-bar-separator"></div>
      <button
        className="tool-bar-button"
        title={t('toolbar.refreshCheck')}
        onClick={onRefreshCheck}
      >
        🔄
      </button>
      <button
        className="tool-bar-button"
        title={autoCheckEnabled ? t('toolbar.autoCheckOn') : t('toolbar.autoCheckOff')}
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
        title={t('toolbar.previousLocation')}
        onClick={onNavigatePrevious}
        disabled={!canNavigatePrevious}
        style={{ opacity: canNavigatePrevious ? 1 : 0.3 }}
      >
        ◀
      </button>
      <button
        className="tool-bar-button"
        title={t('toolbar.nextLocation')}
        onClick={onNavigateNext}
        disabled={!canNavigateNext}
        style={{ opacity: canNavigateNext ? 1 : 0.3 }}
      >
        ▶
      </button>
    </div>
  );
}
