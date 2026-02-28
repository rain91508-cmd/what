import { useState, useEffect, useRef } from 'react';
import { kdbManager } from '../modules/knowledge/kdbManager';
import type { Signal, Module } from '../types/kdb';
import { SignalType } from '../types/kdb';
import { FilterInput } from './FilterInput';

interface SignalPanelProps {
  selectedModule: Module | null;
  onSignalAddToWaveform?: (signal: Signal) => void;
}

export function SignalPanel({ selectedModule, onSignalAddToWaveform }: SignalPanelProps) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [ioFilters, setIoFilters] = useState<Set<string>>(new Set(['all']));
  const [showIoDropdown, setShowIoDropdown] = useState(false);
  const [selectedSignalId, setSelectedSignalId] = useState<number | null>(null);
  const ioDropdownRef = useRef<HTMLDivElement>(null);

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

  // Load signals when selected module changes
  useEffect(() => {
    loadSignals();
  }, [selectedModule]);

  const loadSignals = async () => {
    console.log('[SignalPanel] loadSignals called, selectedModule:', selectedModule);
    if (!selectedModule) {
      setSignals([]);
      return;
    }

    try {
      setLoading(true);
      console.log('[SignalPanel] Fetching signals for module id:', selectedModule.id);
      const moduleSignals = await kdbManager.getModuleSignals(selectedModule.id);
      console.log('[SignalPanel] Got signals:', moduleSignals);
      setSignals(moduleSignals);
    } catch (err) {
      console.error('[SignalPanel] Failed to load signals:', err);
      setSignals([]);
    } finally {
      setLoading(false);
    }
  };

  // Convert wildcard pattern to regex
  const wildcardToRegex = (pattern: string): RegExp => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
  };

  // Toggle IO filter
  const toggleIoFilter = (filter: string) => {
    const newFilters = new Set(ioFilters);
    if (filter === 'all') {
      // If clicking 'all', clear other selections and select 'all'
      setIoFilters(new Set(['all']));
    } else {
      // Remove 'all' if selecting a specific filter
      newFilters.delete('all');
      if (newFilters.has(filter)) {
        newFilters.delete(filter);
        // If no filters selected, default to 'all'
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

  // Filter signals by search term and IO type
  const filterSignals = (signalList: Signal[]): Signal[] => {
    return signalList.filter(s => {
      // Name filter with wildcard support
      if (searchTerm) {
        const term = searchTerm.trim();
        if (term) {
          // Check if pattern contains wildcards
          if (term.includes('*') || term.includes('?')) {
            const regex = wildcardToRegex(term);
            if (!regex.test(s.name) && !regex.test(s.fullName)) {
              return false;
            }
          } else {
            // Simple substring match
            const lowerTerm = term.toLowerCase();
            if (!s.name.toLowerCase().includes(lowerTerm) && 
                !s.fullName.toLowerCase().includes(lowerTerm)) {
              return false;
            }
          }
        }
      }
      
      // IO filter (multi-select)
      if (!ioFilters.has('all')) {
        const dirNum = Number(s.direction);
        const dirName = dirNum === 1 ? 'input' : dirNum === 2 ? 'output' : dirNum === 3 ? 'inout' : 'internal';
        if (!ioFilters.has(dirName)) {
          return false;
        }
      }
      
      return true;
    });
  };

  const getSignalTypeLabel = (type: SignalType): string => {
    // Use numeric comparison to handle both enum and raw number values
    const typeNum = Number(type);
    switch (typeNum) {
      case 1: return 'wire';
      case 2: return 'reg';
      case 3: return 'logic';
      case 4: return 'bit';
      case 5: return 'integer';
      case 6: return 'real';
      case 7: return 'param';
      case 8: return 'localparam';
      default: return `unknown(${type})`;
    }
  };

  // Get display label: show direction for ports (input/output/inout), type for internal signals
  const getSignalDisplayLabel = (signal: Signal): string => {
    const dirNum = Number(signal.direction);
    if (dirNum === 1) return 'input';
    if (dirNum === 2) return 'output';
    if (dirNum === 3) return 'inout';
    // For internal signals, show signal type
    return getSignalTypeLabel(signal.signalType);
  };

  const formatSignalWidth = (signal: Signal): string => {
    if (signal.msb === signal.lsb) {
      return '';
    }
    return `[${signal.msb}:${signal.lsb}]`;
  };

  return (
    <div className="signal-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="panel-header" style={{ 
        padding: '8px 12px', 
        borderBottom: '1px solid #e0e0e0', 
        fontWeight: 'bold',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span>Signals</span>
        {selectedModule && (
          <span style={{ fontSize: '11px', color: '#666', fontWeight: 'normal' }}>
            {signals.length} signals
          </span>
        )}
      </div>

      {/* Filter bar */}
      <div style={{ 
        padding: '6px 8px', 
        borderBottom: '1px solid #e0e0e0', 
        display: 'flex', 
        gap: '6px',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <FilterInput
          value={searchTerm}
          onChange={setSearchTerm}
          placeholder="Search (* wildcard)..."
          storageKey="signal_panel_search_history"
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            height: '24px',
          }}
        />
        <div ref={ioDropdownRef} style={{ position: 'relative', flexShrink: 0 }}>
          <div
            onClick={() => setShowIoDropdown(!showIoDropdown)}
            style={{
              padding: '4px 6px',
              border: '1px solid #ddd',
              borderRadius: '3px',
              fontSize: '11px',
              backgroundColor: 'white',
              height: '24px',
              boxSizing: 'border-box',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              minWidth: '60px',
              justifyContent: 'space-between',
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
                border: '1px solid #ddd',
                borderRadius: '3px',
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



      {/* Signal list */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {!selectedModule ? (
          <div style={{ 
            padding: '40px 20px', 
            textAlign: 'center', 
            color: '#999',
            fontSize: '12px',
          }}>
            Select a module to view signals
          </div>
        ) : loading ? (
          <div style={{ 
            padding: '40px 20px', 
            textAlign: 'center', 
            color: '#999',
            fontSize: '12px',
          }}>
            Loading signals...
          </div>
        ) : signals.length === 0 ? (
          <div style={{ 
            padding: '40px 20px', 
            textAlign: 'center', 
            color: '#999',
            fontSize: '12px',
          }}>
            No signals in this module
          </div>
        ) : (
          <div>
            {filterSignals(signals).map((signal, index) => (
              <div
                key={`${signal.id}-${index}`}
                style={{
                  padding: '6px 12px',
                  borderBottom: '1px solid #f0f0f0',
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  userSelect: 'none',
                  backgroundColor: selectedSignalId === signal.id ? '#e3f2fd' : 'transparent',
                }}
                onClick={() => setSelectedSignalId(signal.id)}
                onDoubleClick={() => {
                  if (onSignalAddToWaveform) {
                    onSignalAddToWaveform(signal);
                  }
                }}
                title={onSignalAddToWaveform ? 'Double-click to add to waveform' : undefined}
              >
                {/* Signal name with bit range */}
                <span style={{ 
                  flex: 1,
                  color: '#333',
                  fontFamily: 'monospace',
                  pointerEvents: 'none',
                }}>
                  {signal.name}{formatSignalWidth(signal)}
                </span>

                {/* Type badge */}
                <span style={{
                  padding: '1px 6px',
                  backgroundColor: '#e3f2fd',
                  color: '#1976d2',
                  borderRadius: '3px',
                  fontSize: '10px',
                  pointerEvents: 'none',
                }}>
                  {getSignalDisplayLabel(signal)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
