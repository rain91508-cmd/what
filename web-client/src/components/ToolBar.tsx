import { useState, useEffect, useRef } from 'react';
import type { TimeConfig, TimeUnit } from './TabPanel';
import { psToDisplayValue, displayValueToPs, TIME_UNIT_MULTIPLIERS } from './TabPanel';

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
  // Maximum waveform time in ps (for validation)
  maxWaveformTimePs?: number;
  // Connection and file actions
  onConnect?: () => void;
  onOpenKdb?: () => void;
  onOpenWaveform?: () => void;
  connected?: boolean;
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
  maxWaveformTimePs = 1000000, // Default 1,000,000 ps = 1000 ns
  onConnect,
  onOpenKdb,
  onOpenWaveform,
  connected = false,
}: ToolBarProps) {
  // Local state for input value (only committed on Enter)
  const [inputValue, setInputValue] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Update input value when timeConfig changes (from external sources like zoom buttons)
  useEffect(() => {
    if (!isEditing && timeConfig) {
      const displayValue = psToDisplayValue(timeConfig.unitTimePs, timeConfig.unit);
      setInputValue(displayValue.toString());
    }
  }, [timeConfig, isEditing]);

  // Initialize input value
  useEffect(() => {
    if (timeConfig && inputValue === '') {
      const displayValue = psToDisplayValue(timeConfig.unitTimePs, timeConfig.unit);
      setInputValue(displayValue.toString());
    }
  }, [timeConfig]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setIsEditing(true);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitInputValue();
    } else if (e.key === 'Escape') {
      // Restore original value
      if (timeConfig) {
        const displayValue = psToDisplayValue(timeConfig.unitTimePs, timeConfig.unit);
        setInputValue(displayValue.toString());
      }
      setIsEditing(false);
      inputRef.current?.blur();
    }
  };

  const handleInputBlur = () => {
    // Restore original value on blur (cancel edit)
    if (timeConfig) {
      const displayValue = psToDisplayValue(timeConfig.unitTimePs, timeConfig.unit);
      setInputValue(displayValue.toString());
    }
    setIsEditing(false);
  };

  const commitInputValue = () => {
    if (!timeConfig || !onTimeConfigChange) return;

    const numValue = parseFloat(inputValue);
    if (isNaN(numValue) || numValue <= 0) {
      // Invalid input, restore original value
      const displayValue = psToDisplayValue(timeConfig.unitTimePs, timeConfig.unit);
      setInputValue(displayValue.toString());
      setIsEditing(false);
      return;
    }

    // Convert display value to ps
    const newUnitTimePs = displayValueToPs(numValue, timeConfig.unit);
    
    // Validate: unit time cannot exceed max waveform time
    if (newUnitTimePs > maxWaveformTimePs) {
      // Exceeds limit, restore original value
      const displayValue = psToDisplayValue(timeConfig.unitTimePs, timeConfig.unit);
      setInputValue(displayValue.toString());
      setIsEditing(false);
      // Optionally show a message or tooltip
      return;
    }

    // Commit the change
    onTimeConfigChange({
      ...timeConfig,
      unitTimePs: newUnitTimePs,
    });
    setIsEditing(false);
  };

  const handleUnitChange = (newUnit: TimeUnit) => {
    if (timeConfig && onTimeConfigChange) {
      // Keep the same ps value, just change the display unit
      onTimeConfigChange({
        ...timeConfig,
        unit: newUnit,
      });
    }
  };

  // Calculate step size based on current unit
  const getStepSize = (): string => {
    if (!timeConfig) return '0.1';
    const multiplier = TIME_UNIT_MULTIPLIERS[timeConfig.unit];
    // Step should be meaningful in the current unit
    if (multiplier >= 1000000000) return '0.001'; // s
    if (multiplier >= 1000000) return '0.001'; // ms
    if (multiplier >= 1000) return '0.001'; // us
    if (multiplier >= 1) return '0.001'; // ns
    return '1'; // ps
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
          title={timeConfig ? `Time per pixel (${timeConfig.unit}, press Enter to confirm)` : 'Time per pixel'}
        />
        <select
          value={timeConfig?.unit || 'ns'}
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
