import { useState, useEffect, useMemo } from 'react';
import type { Instance, Signal } from '../types';
import { FilterInput } from './FilterInput';
import { wildcardMatch } from '../utils/wildcardMatch';
import { kdbManager } from '../modules/knowledge';
import { waveManager } from '../modules/wSignal';

interface SignalListProps {
  instance: Instance | null;
  onSignalSelect: (signal: Signal) => void;
  onSignalAddToWaveform: (signal: Signal) => void;
}

const directionSymbols: Record<number, string> = {
  0: 'I',
  1: 'O',
  2: 'IO',
  3: '',
};

const isIOSignal = (signal: Signal): boolean => {
  return signal.direction === 0 || signal.direction === 1 || signal.direction === 2;
};

export function SignalList({ instance, onSignalSelect, onSignalAddToWaveform }: SignalListProps) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null);
  const [ioFilter, setIoFilter] = useState<'all' | 'input' | 'output' | 'inout' | 'internal'>('all');
  const [nameFilter, setNameFilter] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (instance && kdbManager.isLoaded()) {
      setLoading(true);
      // Get signals from KDB for this instance
      const instanceSignals = kdbManager.getSignalsForInstance(instance.fullPath);
      setSignals(instanceSignals);
      setLoading(false);
    } else {
      setSignals([]);
    }
  }, [instance]);

  const matchesIOFilter = (signal: Signal): boolean => {
    if (ioFilter === 'all') return true;
    if (ioFilter === 'input') return signal.direction === 0;
    if (ioFilter === 'output') return signal.direction === 1;
    if (ioFilter === 'inout') return signal.direction === 2;
    if (ioFilter === 'internal') return signal.direction === 3;
    return true;
  };

  const filteredSignals = useMemo(() => {
    let result = signals;

    // Filter by IO direction
    result = result.filter(matchesIOFilter);

    // Filter by name pattern (支持通配符 * 和 ?)
    if (nameFilter.trim()) {
      const pattern = nameFilter;
      result = result.filter(signal =>
        wildcardMatch(pattern, signal.name) ||
        wildcardMatch(pattern, signal.fullPath)
      );
    }

    return result;
  }, [signals, ioFilter, nameFilter]);

  const handleSignalClick = (signal: Signal) => {
    setSelectedSignal(signal);
    onSignalSelect(signal);
  };

  const handleDoubleClick = async (signal: Signal) => {
    // Check if signal exists in current waveform before adding
    const currentWaveform = waveManager.getCurrentWaveform();
    if (currentWaveform) {
      const exists = await waveManager.checkSignalExists(currentWaveform, signal.fullPath);
      if (!exists) {
        console.warn(`Signal ${signal.fullPath} not found in waveform ${currentWaveform}`);
        // Still add it - the waveform viewer will show it as unavailable
      }
    }
    onSignalAddToWaveform(signal);
  };

  const getSignalDisplayName = (signal: Signal) => {
    if (signal.bitWidth > 1) {
      return `${signal.name}[${signal.msb}:${signal.lsb}]`;
    }
    return signal.name;
  };

  if (!instance) {
    return (
      <div className="signal-panel">
        <div className="panel-header">Signals</div>
        <div style={{ 
          padding: '20px', 
          textAlign: 'center', 
          color: '#999',
          fontSize: '11px'
        }}>
          Select an instance to view signals
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="signal-panel">
        <div className="panel-header">Signals</div>
        <div style={{ 
          padding: '20px', 
          textAlign: 'center', 
          color: '#999',
          fontSize: '11px'
        }}>
          Loading signals...
        </div>
      </div>
    );
  }

  return (
    <div className="signal-panel">
      <div className="panel-header">Signals</div>
      
      {/* Filter bar - name filter and IO filter in one row */}
      <div style={{ 
        padding: '4px',
        borderBottom: '1px solid #e0e0e0',
        background: '#f8f8f8',
        display: 'flex',
        gap: '4px',
        alignItems: 'center',
      }}>
        <FilterInput
          value={nameFilter}
          onChange={setNameFilter}
          placeholder="Filter signals..."
          storageKey="signal_list_filter_history"
          style={{
            padding: '3px 6px',
            fontSize: '11px',
          }}
        />
        <select
          value={ioFilter}
          onChange={(e) => setIoFilter(e.target.value as any)}
          style={{
            padding: '3px 6px',
            fontSize: '11px',
            border: '1px solid #c0c0c0',
            borderRadius: '2px',
            width: '80px',
            background: '#fff',
          }}
        >
          <option value="all">All</option>
          <option value="input">Input</option>
          <option value="output">Output</option>
          <option value="inout">InOut</option>
          <option value="internal">Internal</option>
        </select>
      </div>

      {/* Signal list */}
      <div className="signal-list">
        {filteredSignals.length === 0 ? (
          <div style={{ 
            padding: '20px', 
            textAlign: 'center', 
            color: '#999',
            fontSize: '11px'
          }}>
            {signals.length === 0 ? 'No signals found for this instance' : 'No signals match filter'}
          </div>
        ) : (
          filteredSignals.map(signal => (
            <div
              key={signal.handle}
              className={`signal-item ${selectedSignal?.handle === signal.handle ? 'selected' : ''}`}
              onClick={() => handleSignalClick(signal)}
              onDoubleClick={() => handleDoubleClick(signal)}
              title={`Double-click to add to waveform\n${signal.fullPath}`}
            >
              <span className="signal-name">
                {getSignalDisplayName(signal)}
              </span>
              <span style={{ 
                fontSize: '9px', 
                color: isIOSignal(signal) ? '#0066cc' : '#666',
                marginLeft: '4px',
                minWidth: '20px',
                textAlign: 'right'
              }}>
                {directionSymbols[signal.direction]}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Status bar */}
      <div style={{ 
        padding: '4px 6px', 
        borderTop: '1px solid #e0e0e0',
        background: '#f5f5f5',
        fontSize: '10px',
        color: '#666'
      }}>
        {filteredSignals.length} / {signals.length} signals
      </div>
    </div>
  );
}
