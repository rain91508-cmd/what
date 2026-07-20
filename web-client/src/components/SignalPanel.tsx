import { useState, useEffect, useRef } from 'react';
import { kdbManager } from '../modules/knowledge/kdbManager';
import type { Signal } from '../types/kdb';
import { SignalType } from '../types/kdb';
import { FilterInput } from './FilterInput';
import { useT } from '../i18n';

interface SignalPanelProps {
  selectedModuleIndex: number | null;  // 1-based module index
  onSignalAddToWaveform?: (signal: Signal) => void;
  onSignalAddToTableView?: (signal: Signal) => void;  // Called when double-click to add to tableview
  onSignalDoubleClick?: (signal: Signal, moduleIndex: number) => void;
  onSignalSelect?: (signal: Signal) => void;  // Called when a signal is selected
  activeTabType?: 'source' | 'waveform' | 'tableview' | null;  // Current active tab type
  onSignalDrop?: (signalData: {
    globalId: number;
    parentModuleId: number;
    name: string;
    fullName: string;
  }) => void;
  pendingSelectedSignal?: number | null;
}

const DEFAULT_PAGE_SIZE = 50;

export function SignalPanel({ selectedModuleIndex, onSignalAddToWaveform, onSignalAddToTableView, onSignalDoubleClick, onSignalSelect, activeTabType, onSignalDrop, pendingSelectedSignal }: SignalPanelProps) {
  const { t } = useT();
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [ioFilters, setIoFilters] = useState<Set<string>>(new Set(['all']));
  const [showIoDropdown, setShowIoDropdown] = useState(false);
  const [selectedSignalGlobalId, setSelectedSignalGlobalId] = useState<number | null>(null);
  const ioDropdownRef = useRef<HTMLDivElement>(null);

  // Multi-select state
  const [selectedSignalGlobalIds, setSelectedSignalGlobalIds] = useState<Set<number>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  // Ref to track click timeout for distinguishing single vs double click
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Pagination state - stores the actual signal index range in the module
  const [currentRangeStart, setCurrentRangeStart] = useState(0); // 0-based index in module
  const [currentRangeEnd, setCurrentRangeEnd] = useState(-1);    // 0-based index in module
  const [pageSize] = useState(DEFAULT_PAGE_SIZE);
  const [showJumpDialog, setShowJumpDialog] = useState(false);
  const [jumpPosition, setJumpPosition] = useState('');
  const jumpDialogRef = useRef<HTMLDivElement>(null);

  // Module info
  const [totalSignalCount, setTotalSignalCount] = useState(0);
  const [hasMoreForward, setHasMoreForward] = useState(false);
  const [hasMoreBackward, setHasMoreBackward] = useState(false);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ioDropdownRef.current && !ioDropdownRef.current.contains(event.target as Node)) {
        setShowIoDropdown(false);
      }
      if (jumpDialogRef.current && !jumpDialogRef.current.contains(event.target as Node)) {
        setShowJumpDialog(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Reset when module changes
  useEffect(() => {
    setCurrentRangeStart(0);
    setCurrentRangeEnd(-1);
    setSignals([]);
    setHasMoreForward(false);
    setHasMoreBackward(false);
    // Clear multi-selection when module changes
    setSelectedSignalGlobalIds(new Set());
    setLastSelectedIndex(null);
    if (selectedModuleIndex) {
      kdbManager.getModuleSignalCount(selectedModuleIndex).then(count => setTotalSignalCount(count));
    } else {
      setTotalSignalCount(0);
    }
  }, [selectedModuleIndex]);

  // Load signals when module or pageSize changes - from current position
  useEffect(() => {
    loadSignalsForward(currentRangeStart);
  }, [selectedModuleIndex, pageSize]);

  // Load signals when filter changes - always start from beginning
  useEffect(() => {
    setCurrentRangeStart(0);
    setCurrentRangeEnd(-1);
    loadSignalsForward(0);
  }, [searchTerm, ioFilters]);

  // Handle pending selected signal from drag-drop
  useEffect(() => {
    if (pendingSelectedSignal && selectedModuleIndex) {
      // Check if the signal is in current signals list
      const signal = signals.find(s => s.globalId === pendingSelectedSignal);
      if (signal) {
        // Signal is in current page, select it
        setSelectedSignalGlobalId(pendingSelectedSignal);
        onSignalSelect?.(signal);
        // Scroll to the signal element
        scrollToSignal(pendingSelectedSignal);
      } else {
        // Signal is not in current page, need to navigate to it
        kdbManager.getSignalIndexInModule(selectedModuleIndex, pendingSelectedSignal).then(signalIndex => {
          if (signalIndex >= 0) {
            // Navigate to the page containing this signal
            navigateToSignalIndex(signalIndex);
          }
        });
      }
    }
  }, [pendingSelectedSignal, selectedModuleIndex]);

  // Navigate to specific signal index (for drag-drop)
  const navigateToSignalIndex = async (targetIndex: number) => {
    if (!selectedModuleIndex) return;

    // Check if signal is already in current range
    if (targetIndex >= currentRangeStart && targetIndex <= currentRangeEnd) {
      // Signal should be in current signals, but might be filtered out.
      // Compute the local index directly from the skeleton's signalInstsStartId
      // (no async signalDefs lookup needed for an already-loaded page).
      const module = kdbManager.getModuleById(selectedModuleIndex);
      const signal = module ? signals.find(s => s.globalId - module.signalInstsStartId === targetIndex) : undefined;
      if (signal) {
        setSelectedSignalGlobalId(signal.globalId);
        onSignalSelect?.(signal);
        scrollToSignal(signal.globalId);
        return;
      }
    }

    // Need to load the page containing this signal
    // Clear filters to ensure signal is visible
    if (searchTerm || !ioFilters.has('all')) {
      setSearchTerm('');
      setIoFilters(new Set(['all']));
      // After filters are cleared, the useEffect will trigger loadSignalsForward(0)
      // We need to wait for that and then navigate
      setTimeout(() => {
        navigateToSignalIndex(targetIndex);
      }, 100);
      return;
    }

    // Load signals starting from target index
    await loadSignalsForward(targetIndex);
  };

  // Scroll to signal element in the list
  const scrollToSignal = (globalId: number) => {
    const signalElement = document.querySelector(`[data-signal-global-id="${globalId}"]`);
    if (signalElement) {
      signalElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const createFilterFn = (): ((signal: Signal) => boolean) => {
    return (signal: Signal): boolean => {
      // IO filter
      if (!ioFilters.has('all')) {
        const dirNum = Number(signal.direction);
        const dirName = dirNum === 1 ? 'input' : dirNum === 2 ? 'output' : dirNum === 3 ? 'inout' : 'internal';
        if (!ioFilters.has(dirName)) {
          return false;
        }
      }
      
      // Search term filter
      if (searchTerm) {
        const term = searchTerm.trim();
        if (term) {
          if (term.includes('*') || term.includes('?')) {
            // Wildcard pattern - convert to regex with anchor-based matching
            // * at start: matches any prefix (ends with pattern after *)
            // * at end: matches any suffix (starts with pattern before *)
            // * in middle: matches any sequence in that position
            // ? matches any single character
            let pattern = term
              .replace(/[.+^${}()|[\]\\]/g, '\\$&');  // Escape regex special chars first
            
            // Check if pattern starts with * (match suffix)
            const startsWithWildcard = pattern.startsWith('*');
            // Check if pattern ends with * (match prefix)
            const endsWithWildcard = pattern.endsWith('*');
            
            // Replace wildcards
            pattern = pattern
              .replace(/\*/g, '.*')                    // * -> .*
              .replace(/\?/g, '.');                    // ? -> .
            
            // Build regex with proper anchors
            let regexPattern = pattern;
            if (!startsWithWildcard) {
              // If doesn't start with *, anchor to start
              regexPattern = '^' + regexPattern;
            }
            if (!endsWithWildcard) {
              // If doesn't end with *, anchor to end
              regexPattern = regexPattern + '$';
            }
            
            const regex = new RegExp(regexPattern, 'i');
            if (!regex.test(signal.name) && !regex.test(signal.fullName)) {
              return false;
            }
          } else {
            // Simple contains
            const lowerTerm = term.toLowerCase();
            if (!signal.name.toLowerCase().includes(lowerTerm) && 
                !signal.fullName.toLowerCase().includes(lowerTerm)) {
              return false;
            }
          }
        }
      }
      
      return true;
    };
  };

  const loadSignalsForward = async (startIndex: number) => {
    if (!selectedModuleIndex) {
      setSignals([]);
      return;
    }

    try {
      setLoading(true);
      const filterFn = createFilterFn();
      
      // Get total count fresh to avoid stale state issues
      const moduleSignalCount = await kdbManager.getModuleSignalCount(selectedModuleIndex);
      
      const result = await kdbManager.findFilteredSignalsPaged(
        selectedModuleIndex,
        startIndex,
        pageSize,
        filterFn,
        'forward'
      );
      
      setSignals(result.signals);
      
      // Calculate display range based on the search window, not just matched signals
      // This gives users context about where they are in the module
      if (result.signals.length > 0) {
        // Start from the first matched signal
        const displayStartIdx = result.actualStartIndex;
        // End is either the last matched signal or the search window end
        // If we're at the end of module, show up to module end
        const displayEndIdx = result.hasMore 
          ? Math.max(result.actualEndIndex, startIndex + Math.min(pageSize, moduleSignalCount) - 1)  // More signals available, extend to search window
          : Math.max(result.actualEndIndex, startIndex + Math.min(pageSize, moduleSignalCount) - 1, moduleSignalCount - 1); // At end, extend to module end
        
        setCurrentRangeStart(displayStartIdx);
        setCurrentRangeEnd(Math.min(displayEndIdx, moduleSignalCount - 1));
      } else {
        // No signals found, keep current range or reset
        setCurrentRangeStart(startIndex);
        setCurrentRangeEnd(Math.min(startIndex + pageSize - 1, moduleSignalCount - 1));
      }
      
      // Update total count state as well
      setTotalSignalCount(moduleSignalCount);
      setHasMoreForward(result.hasMore);
      setHasMoreBackward(result.actualStartIndex > 0);
      
      console.log(`[SignalPanel] Loaded ${result.signals.length} signals, range: ${result.actualStartIndex}-${result.actualEndIndex}, total: ${moduleSignalCount}`);
    } catch (err) {
      console.error('[SignalPanel] Failed to load signals:', err);
      setSignals([]);
    } finally {
      setLoading(false);
    }
  };

  const loadSignalsBackward = async (startIndex: number) => {
    if (!selectedModuleIndex) {
      setSignals([]);
      return;
    }

    try {
      setLoading(true);
      const filterFn = createFilterFn();
      
      const result = await kdbManager.findFilteredSignalsPaged(
        selectedModuleIndex,
        startIndex,
        pageSize,
        filterFn,
        'backward'
      );
      
      setSignals(result.signals);
      setCurrentRangeStart(result.actualStartIndex);
      setCurrentRangeEnd(result.actualEndIndex >= 0 ? result.actualEndIndex : startIndex);
      setHasMoreForward(result.actualEndIndex < totalSignalCount - 1);
      setHasMoreBackward(result.hasMore);
      
      console.log(`[SignalPanel] Loaded ${result.signals.length} signals (backward), range: ${result.actualStartIndex}-${result.actualEndIndex}`);
    } catch (err) {
      console.error('[SignalPanel] Failed to load signals:', err);
      setSignals([]);
    } finally {
      setLoading(false);
    }
  };

  const goToPrevPage = () => {
    if (currentRangeStart > 0) {
      // Search backward from one index before current range start
      loadSignalsBackward(Math.max(0, currentRangeStart - 1));
    }
  };

  const goToNextPage = () => {
    if (currentRangeEnd >= 0 && currentRangeEnd < totalSignalCount - 1) {
      // Search forward from one index after current range end
      loadSignalsForward(currentRangeEnd + 1);
    }
  };

  const handleRangeDoubleClick = () => {
    // Show jump dialog with current start position
    setJumpPosition((currentRangeStart >= 0 ? currentRangeStart + 1 : 1).toString());
    setShowJumpDialog(true);
  };

  const applyJumpPosition = () => {
    const position = parseInt(jumpPosition, 10);
    
    if (isNaN(position) || position < 1 || position > totalSignalCount) {
      return;
    }
    
    // Convert to 0-based index and load
    const startIndex = position - 1;
    loadSignalsForward(startIndex);
    setShowJumpDialog(false);
  };

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

  const getSignalTypeLabel = (type: SignalType): string => {
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

  const getSignalDisplayLabel = (signal: Signal): string => {
    const dirNum = Number(signal.direction);
    if (dirNum === 1) return 'input';
    if (dirNum === 2) return 'output';
    if (dirNum === 3) return 'inout';
    return getSignalTypeLabel(signal.signalType);
  };

  const formatSignalWidth = (signal: Signal): string => {
    if (signal.msb === signal.lsb) {
      return '';
    }
    return `[${signal.msb}:${signal.lsb}]`;
  };

  // Display range (1-based for user, using actual signal indices)
  // When no signals found (rangeEnd < 0), show 0-0
  const displayStart = (currentRangeStart >= 0 && currentRangeEnd >= 0) ? currentRangeStart + 1 : 0;
  const displayEnd = (currentRangeStart >= 0 && currentRangeEnd >= 0) ? currentRangeEnd + 1 : 0;
  
  // Show pagination only when total signals > 50
  const isPagedMode = totalSignalCount > 50;

  return (
    <div
      className="signal-panel"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const data = e.dataTransfer.getData('application/json');
        if (data) {
          try {
            const signalData = JSON.parse(data);
            onSignalDrop?.(signalData);
          } catch (err) {
            console.error('[SignalPanel] Failed to parse drop data:', err);
          }
        }
      }}
    >
      {/* Header */}
      <div className="panel-header" style={{ 
        padding: '8px 12px', 
        borderBottom: '1px solid #e0e0e0', 
        fontWeight: 'bold',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span>{t('panel.signal.title')}</span>
        {selectedModuleIndex && (
          <span style={{ fontSize: '11px', color: '#666', fontWeight: 'normal' }}>
            {selectedSignalGlobalIds.size > 1 
              ? `${selectedSignalGlobalIds.size} selected / ${totalSignalCount}`
              : `${totalSignalCount} ${t('panel.signal.title').toLowerCase()}`}
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
          placeholder={t('panel.signal.searchPlaceholder')}
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
              {[
                { key: 'all', label: 'All' },
                { key: 'input', label: 'Input' },
                { key: 'output', label: 'Output' },
                { key: 'inout', label: 'InOut' },
                { key: 'internal', label: 'Internal' },
              ].map(({ key, label }) => (
                <div
                  key={key}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleIoFilter(key);
                  }}
                  style={{
                    padding: '4px 8px',
                    fontSize: '11px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backgroundColor: ioFilters.has(key) ? '#e3f2fd' : 'white',
                  }}
                >
                  <span style={{ width: '12px', textAlign: 'center' }}>
                    {ioFilters.has(key) ? '✓' : ''}
                  </span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Pagination bar (only show in paged mode) */}
      {isPagedMode && selectedModuleIndex && (
        <div style={{
          padding: '4px 8px',
          borderBottom: '1px solid #e0e0e0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          fontSize: '11px',
          backgroundColor: '#f5f5f5',
          flexShrink: 0,
        }}>
          <button
            onClick={goToPrevPage}
            disabled={!hasMoreBackward}
            style={{
              padding: '2px 6px',
              border: '1px solid #ddd',
              borderRadius: '3px',
              backgroundColor: !hasMoreBackward ? '#f0f0f0' : 'white',
              cursor: !hasMoreBackward ? 'not-allowed' : 'pointer',
              fontSize: '11px',
            }}
            title="Previous page"
          >
            ◀
          </button>

          <div
            ref={jumpDialogRef}
            style={{ position: 'relative' }}
          >
            <span
              onDoubleClick={handleRangeDoubleClick}
              style={{
                cursor: 'pointer',
                padding: '2px 6px',
                borderRadius: '3px',
                backgroundColor: '#fff',
              }}
              title="Double-click to jump to position"
            >
              {displayStart} - {displayEnd} / {totalSignalCount}
            </span>

            {showJumpDialog && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  marginTop: '4px',
                  backgroundColor: 'white',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                  zIndex: 1000,
                  padding: '8px',
                  minWidth: '150px',
                }}
              >
                <div style={{ marginBottom: '8px', fontWeight: 'bold', fontSize: '11px' }}>
                  Jump to Position
                </div>
                
                <div style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <input
                    type="number"
                    value={jumpPosition}
                    onChange={(e) => setJumpPosition(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        applyJumpPosition();
                      }
                    }}
                    min={1}
                    max={totalSignalCount}
                    autoFocus
                    style={{
                      width: '60px',
                      padding: '4px 6px',
                      fontSize: '12px',
                      border: '1px solid #ddd',
                      borderRadius: '3px',
                    }}
                  />
                  <span style={{ fontSize: '11px', color: '#666' }}>/ {totalSignalCount}</span>
                </div>
                
                <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowJumpDialog(false)}
                    style={{
                      padding: '4px 8px',
                      border: '1px solid #ddd',
                      borderRadius: '3px',
                      backgroundColor: 'white',
                      cursor: 'pointer',
                      fontSize: '11px',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={applyJumpPosition}
                    style={{
                      padding: '4px 8px',
                      border: '1px solid #1976d2',
                      borderRadius: '3px',
                      backgroundColor: '#1976d2',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: '11px',
                    }}
                  >
                    Jump
                  </button>
                </div>
              </div>
            )}
          </div>
          
          <button
            onClick={goToNextPage}
            disabled={!hasMoreForward}
            style={{
              padding: '2px 6px',
              border: '1px solid #ddd',
              borderRadius: '3px',
              backgroundColor: !hasMoreForward ? '#f0f0f0' : 'white',
              cursor: !hasMoreForward ? 'not-allowed' : 'pointer',
              fontSize: '11px',
            }}
            title="Next page"
          >
            ▶
          </button>
        </div>
      )}

      {/* Signal list */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {!selectedModuleIndex ? (
          <div style={{ 
            padding: '40px 20px', 
            textAlign: 'center', 
            color: '#999',
            fontSize: '12px',
          }}>
            {t('panel.signal.selectModule')}
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
            {searchTerm || !ioFilters.has('all') ? 'No signals match the filter' : 'No signals in this module'}
          </div>
        ) : (
          <div>
            {signals.map((signal, index) => (
              <div
                key={`${signal.globalId}-${index}`}
                data-signal-global-id={signal.globalId}
                style={{
                  padding: '6px 12px',
                  borderBottom: '1px solid #f0f0f0',
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  userSelect: 'none',
                  backgroundColor: selectedSignalGlobalIds.has(signal.globalId) ? '#e3f2fd' : 'transparent',
                }}
                onClick={(e) => {
                  // Clear any pending click timeout
                  if (clickTimeoutRef.current) {
                    clearTimeout(clickTimeoutRef.current);
                    clickTimeoutRef.current = null;
                  }

                  // Delay click handling to distinguish from double-click
                  clickTimeoutRef.current = setTimeout(() => {
                    if (e.ctrlKey || e.metaKey) {
                      // Ctrl/Cmd + Click: Toggle selection
                      setSelectedSignalGlobalIds(prev => {
                        const newSet = new Set(prev);
                        if (newSet.has(signal.globalId)) {
                          newSet.delete(signal.globalId);
                        } else {
                          newSet.add(signal.globalId);
                        }
                        return newSet;
                      });
                      setLastSelectedIndex(index);
                    } else if (e.shiftKey && lastSelectedIndex !== null) {
                      // Shift + Click: Select range
                      const start = Math.min(lastSelectedIndex, index);
                      const end = Math.max(lastSelectedIndex, index);
                      setSelectedSignalGlobalIds(prev => {
                        const newSet = new Set(prev);
                        for (let i = start; i <= end; i++) {
                          if (signals[i]) {
                            newSet.add(signals[i].globalId);
                          }
                        }
                        return newSet;
                      });
                      setLastSelectedIndex(index);
                    } else {
                      // Normal click: Clear selection and select current
                      setSelectedSignalGlobalIds(new Set([signal.globalId]));
                      setLastSelectedIndex(index);
                      // Notify parent component about signal selection
                      if (activeTabType === 'tableview') {
                        console.log('[SignalPanel] Signal selected (tableview):', signal.name);
                      } else if (onSignalSelect) {
                        onSignalSelect(signal);
                      }
                    }
                  }, 200); // 200ms delay to wait for potential double-click
                }}
                onDoubleClick={() => {
                  // Clear the pending click timeout to prevent single-click handler from running
                  if (clickTimeoutRef.current) {
                    clearTimeout(clickTimeoutRef.current);
                    clickTimeoutRef.current = null;
                  }

                  // Get all selected signals
                  const selectedSignals = signals.filter(s => selectedSignalGlobalIds.has(s.globalId));

                  if (selectedSignals.length === 0) {
                    // No signals selected, use current signal
                    selectedSignals.push(signal);
                  }

                  // If source tab is active or no tab, jump to declaration (will open source tab)
                  // For source tab, only handle the first selected signal
                  if ((activeTabType === 'source' || !activeTabType) && onSignalDoubleClick && selectedModuleIndex) {
                    onSignalDoubleClick(selectedSignals[0], selectedModuleIndex);
                  } else if (activeTabType === 'waveform' && onSignalAddToWaveform) {
                    // Add selected signals one by one, removing each from selection after adding
                    // This allows user to continue with remaining signals if a dialog interrupts
                    selectedSignals.forEach(s => {
                      onSignalAddToWaveform(s);
                      // Remove from selection after adding
                      setSelectedSignalGlobalIds(prev => {
                        const newSet = new Set(prev);
                        newSet.delete(s.globalId);
                        return newSet;
                      });
                    });
                  } else if (activeTabType === 'tableview' && onSignalAddToTableView) {
                    // Add selected signals one by one, removing each from selection after adding
                    selectedSignals.forEach(s => {
                      onSignalAddToTableView(s);
                      // Remove from selection after adding
                      setSelectedSignalGlobalIds(prev => {
                        const newSet = new Set(prev);
                        newSet.delete(s.globalId);
                        return newSet;
                      });
                    });
                  }
                }}
                title={activeTabType === 'waveform' 
                  ? `Ctrl/Cmd+Click: Multi-select, Shift+Click: Range select, Double-click: Add ${selectedSignalGlobalIds.size > 1 ? selectedSignalGlobalIds.size + ' signals' : 'signal'} to waveform`
                  : activeTabType === 'tableview'
                  ? `Ctrl/Cmd+Click: Multi-select, Shift+Click: Range select, Double-click: Add ${selectedSignalGlobalIds.size > 1 ? selectedSignalGlobalIds.size + ' signals' : 'signal'} to tableview`
                  : 'Double-click to jump to declaration'}
              >
                <span style={{ 
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: '#333',
                  fontFamily: 'monospace',
                  pointerEvents: 'none',
                }}>
                  {signal.name}{formatSignalWidth(signal)}
                </span>

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
