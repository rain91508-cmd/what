import { useState, useEffect } from 'react';
import { kdbManager } from '../modules/knowledge/kdbManager';
import type { Signal, Module } from '../types/kdb';
import { SignalType, PortDirection } from '../types/kdb';
import { FilterInput } from './FilterInput';

interface SignalPanelProps {
  selectedModule: Module | null;
}

interface SignalGroup {
  name: string;
  signals: Signal[];
  expanded: boolean;
}

export function SignalPanel({ selectedModule }: SignalPanelProps) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [ioFilter, setIoFilter] = useState<'all' | 'input' | 'output' | 'inout' | 'internal'>('all');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['ports', 'internal']));

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

  // Group signals by type
  const getGroupedSignals = (): SignalGroup[] => {
    const ports = signals.filter(s => s.direction !== PortDirection.Internal);
    const internal = signals.filter(s => s.direction === PortDirection.Internal);

    const groups: SignalGroup[] = [];

    if (ports.length > 0) {
      groups.push({
        name: 'ports',
        signals: ports,
        expanded: expandedGroups.has('ports'),
      });
    }

    if (internal.length > 0) {
      groups.push({
        name: 'internal',
        signals: internal,
        expanded: expandedGroups.has('internal'),
      });
    }

    return groups;
  };

  // Convert wildcard pattern to regex
  const wildcardToRegex = (pattern: string): RegExp => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
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
      
      // IO filter
      if (ioFilter !== 'all') {
        const dirNum = Number(s.direction);
        switch (ioFilter) {
          case 'input':
            if (dirNum !== 1) return false;
            break;
          case 'output':
            if (dirNum !== 2) return false;
            break;
          case 'inout':
            if (dirNum !== 3) return false;
            break;
          case 'internal':
            if (dirNum !== 0) return false;
            break;
        }
      }
      
      return true;
    });
  };

  const toggleGroup = (groupName: string) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(groupName)) {
      newExpanded.delete(groupName);
    } else {
      newExpanded.add(groupName);
    }
    setExpandedGroups(newExpanded);
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

  const getDirectionLabel = (direction: PortDirection): string => {
    const dirNum = Number(direction);
    switch (dirNum) {
      case 1: return 'input';
      case 2: return 'output';
      case 3: return 'inout';
      case 0: return 'internal';
      default: return '';
    }
  };

  const getDirectionIcon = (direction: PortDirection): string => {
    const dirNum = Number(direction);
    switch (dirNum) {
      case 1: return '➡️';
      case 2: return '⬅️';
      case 3: return '↔️';
      default: return '•';
    }
  };

  const formatSignalWidth = (signal: Signal): string => {
    if (signal.msb === signal.lsb) {
      return '';
    }
    return `[${signal.msb}:${signal.lsb}]`;
  };

  const groupedSignals = getGroupedSignals();

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
        <select
          value={ioFilter}
          onChange={(e) => setIoFilter(e.target.value as any)}
          style={{
            padding: '4px 6px',
            border: '1px solid #ddd',
            borderRadius: '3px',
            fontSize: '11px',
            outline: 'none',
            backgroundColor: 'white',
            height: '24px',
            boxSizing: 'border-box',
            flexShrink: 0,
          }}
        >
          <option value="all">All</option>
          <option value="input">In</option>
          <option value="output">Out</option>
          <option value="inout">IO</option>
          <option value="internal">Int</option>
        </select>
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
            {groupedSignals.map(group => {
              const filteredSignals = filterSignals(group.signals);
              if (filteredSignals.length === 0) return null;

              const isExpanded = expandedGroups.has(group.name);

              return (
                <div key={group.name}>
                  {/* Group header */}
                  <div
                    onClick={() => toggleGroup(group.name)}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: '#f0f0f0',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      color: '#555',
                      textTransform: 'uppercase',
                    }}
                  >
                    <span style={{ marginRight: '6px', fontSize: '10px' }}>
                      {isExpanded ? '▼' : '▶'}
                    </span>
                    <span>{group.name}</span>
                    <span style={{ 
                      marginLeft: 'auto', 
                      fontWeight: 'normal',
                      color: '#888',
                    }}>
                      {filteredSignals.length}
                    </span>
                  </div>

                  {/* Signal items */}
                  {isExpanded && (
                    <div>
                      {filteredSignals.map((signal, index) => (
                        <div
                          key={`${group.name}-${signal.id}-${index}`}
                          style={{
                            padding: '6px 12px 6px 24px',
                            borderBottom: '1px solid #f0f0f0',
                            fontSize: '12px',
                            display: 'flex',
                            alignItems: 'center',
                          }}
                        >
                          {/* Direction icon */}
                          <span style={{ marginRight: '6px', fontSize: '10px' }}>
                            {getDirectionIcon(signal.direction)}
                          </span>

                          {/* Signal name */}
                          <span style={{ 
                            flex: 1,
                            color: '#333',
                            fontFamily: 'monospace',
                          }}>
                            {signal.name}
                          </span>

                          {/* Width */}
                          {formatSignalWidth(signal) && (
                            <span style={{ 
                              marginRight: '8px',
                              color: '#666',
                              fontFamily: 'monospace',
                              fontSize: '11px',
                            }}>
                              {formatSignalWidth(signal)}
                            </span>
                          )}

                          {/* Type badge */}
                          <span style={{
                            padding: '1px 6px',
                            backgroundColor: '#e3f2fd',
                            color: '#1976d2',
                            borderRadius: '3px',
                            fontSize: '10px',
                          }}>
                            {getSignalTypeLabel(signal.signalType)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
