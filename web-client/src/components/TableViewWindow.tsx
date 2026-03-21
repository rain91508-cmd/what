/**
 * TableView Window Component
 *
 * Displays signal values in a table format with:
 * - Time column (first column)
 * - Signal columns (one per signal)
 * - Pagination (100 rows per page)
 * - Column filtering
 * - Column visibility control
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type ColumnFiltersState,
  type VisibilityState,
} from '@tanstack/react-table';
import type { SignalWithFormat, RawSignalValuesResult, RawValue } from '../core/waveformProviderInterface';
import type { TimeConfig } from './TabPanel';
import { lod0ToDisplay } from './TabPanel';
import { useWaveformProvider } from '../contexts/WaveformProviderContext';
import { WaveformProviderAdapter } from '../wasm/waveformProviderAdapter';
import { buildWasmSignals } from '../wasm/waveformProvider';
import { useT } from '../i18n';

interface TableViewWindowProps {
  tabId: string;
  signals: SignalWithFormat[];
  startTime: number;
  endTime: number;
  data: RawSignalValuesResult | null;
  timeConfig: TimeConfig;
  onSignalsChange: (signals: SignalWithFormat[]) => void;
  onStartTimeChange: (time: number) => void;
  onEndTimeChange: (time: number) => void;
  onFetchData: (data: RawSignalValuesResult) => void;
  currentPage: number;
  onPageChange: (page: number) => void;
  // Prefix settings (same as WaveformWindow)
  signalPrefix?: string;
  serverPrefix?: string;
  spaceBeforeBracket?: boolean;
  waveformName?: string;
  // Refresh trigger to force data refetch
  refreshTrigger?: number;
  // Time unit conversion factor (display unit / LoD0 unit)
  displayUnitPerLoD0Unit?: number;
  // Cache settings
  enableOpfs?: boolean;
  enableMemoryCache?: boolean;
  // Initial column filters for session restore
  initialColumnFilters?: Array<{ id: string; value: string }>;
  // Initial metadata filters for session restore
  initialColumnMetadataFilters?: Record<string, { hasX: boolean; hasZ: boolean; mixed: boolean; hasTransition: boolean; hasToggle: boolean }>;
  // Initial radix selection for session restore
  initialColumnRadix?: Record<string, 'hex' | 'bin' | 'oct' | 'dec'>;
  // Callbacks to save state for session
  onColumnFiltersChange?: (filters: Array<{ id: string; value: string }>) => void;
  onColumnMetadataFiltersChange?: (filters: Record<string, { hasX: boolean; hasZ: boolean; mixed: boolean; hasTransition: boolean; hasToggle: boolean }>) => void;
  onColumnRadixChange?: (radix: Record<string, 'hex' | 'bin' | 'oct' | 'dec'>) => void;
}

// Row data structure for the table
interface TableRow {
  time: number;
  [signalName: string]: number | RawValue | undefined;
}

export function TableViewWindow({
  tabId,
  signals,
  startTime,
  endTime,
  data,
  timeConfig,
  onSignalsChange,
  onFetchData,
  currentPage,
  onPageChange,
  signalPrefix: _signalPrefix = '',
  serverPrefix: _serverPrefix = '',
  spaceBeforeBracket: _spaceBeforeBracket = false,
  waveformName: _waveformName = '',
  refreshTrigger = 0,
  displayUnitPerLoD0Unit: _displayUnitPerLoD0Unit = 1.0,
  enableOpfs: _enableOpfs = false,
  enableMemoryCache: _enableMemoryCache = true,
  initialColumnFilters,
  initialColumnMetadataFilters,
  initialColumnRadix,
  onColumnFiltersChange,
  onColumnMetadataFiltersChange,
  onColumnRadixChange,
}: TableViewWindowProps) {
  const { t } = useT();
  // Get shared provider from context (same as WaveformWindow)
  const { provider: sharedProvider, isLoading: providerLoading } = useWaveformProvider();

  // Create adapter ref (same as WaveformWindow)
  const adapterRef = useRef<WaveformProviderAdapter | null>(null);
  const [adapterCreated, setAdapterCreated] = useState(false);

  // Provider ready state (same as WaveformWindow)
  const providerReady = !providerLoading && sharedProvider !== null && adapterRef.current !== null;

  // Column filters state - initialize from session if provided
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    initialColumnFilters?.map(f => ({ id: f.id, value: f.value })) || []
  );
  // Column visibility state
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  // Show/hide column visibility dropdown
  const [showColumnVisibility, setShowColumnVisibility] = useState(false);
  // Loading state for data fetch
  const [isFetching, setIsFetching] = useState(false);
  // Per-column metadata filter state: { [columnId]: { hasX, hasZ, mixed, hasTransition, hasToggle } }
  // Initialize from session if provided
  const [columnMetadataFilters, setColumnMetadataFilters] = useState<{
    [columnId: string]: {
      hasX: boolean;
      hasZ: boolean;
      mixed: boolean;
      hasTransition: boolean;
      hasToggle: boolean;
    };
  }>(initialColumnMetadataFilters || {});
  // Track which column's metadata filter dropdown is open
  const [openMetadataFilterColumn, setOpenMetadataFilterColumn] = useState<string | null>(null);
  // Ref for the currently open dropdown to detect clicks outside
  const metadataFilterDropdownRef = useRef<HTMLDivElement | null>(null);
  // Per-column radix (display format) selection: { [columnId]: 'hex' | 'bin' | 'oct' | 'dec' }
  // Initialize from session if provided
  const [columnRadix, setColumnRadix] = useState<{
    [columnId: string]: 'hex' | 'bin' | 'oct' | 'dec';
  }>(initialColumnRadix || {});
  
  // Early exit on insufficient transitions (default to true for better performance)
  const [earlyExitOnInsufficientTransitions, setEarlyExitOnInsufficientTransitions] = useState(true);
  // Max result count
  const [resultMax, setResultMax] = useState(100);
  // Show warning message when transition count < 3
  const [showLowTransitionWarning, setShowLowTransitionWarning] = useState(false);
  // Current search end time for continue fetch
  const [currentSearchEndTime, setCurrentSearchEndTime] = useState<number>(endTime);
  // Whether we can continue fetching (returned max results)
  const [canContinueFetch, setCanContinueFetch] = useState(false);
  // Page size for table pagination
  const [pageSize, setPageSize] = useState(100);
  // Accumulated data for continue fetch
  const [accumulatedData, setAccumulatedData] = useState<RawSignalValuesResult | null>(null);

  // Use refs to store callback functions to avoid dependency issues in useEffect
  const onColumnFiltersChangeRef = useRef(onColumnFiltersChange);
  const onColumnMetadataFiltersChangeRef = useRef(onColumnMetadataFiltersChange);
  const onColumnRadixChangeRef = useRef(onColumnRadixChange);

  // Update refs when callbacks change
  useEffect(() => {
    onColumnFiltersChangeRef.current = onColumnFiltersChange;
    onColumnMetadataFiltersChangeRef.current = onColumnMetadataFiltersChange;
    onColumnRadixChangeRef.current = onColumnRadixChange;
  }, [onColumnFiltersChange, onColumnMetadataFiltersChange, onColumnRadixChange]);

  // Create adapter when provider is ready (same pattern as WaveformWindow)
  useEffect(() => {
    if (sharedProvider && !adapterRef.current) {
      const adapter = new WaveformProviderAdapter(sharedProvider, tabId);
      adapterRef.current = adapter;
      setAdapterCreated(true);
    }
  }, [sharedProvider, tabId]);

  // Track previous start/end times to detect changes
  const prevStartTimeRef = useRef(startTime);
  const prevEndTimeRef = useRef(endTime);

  // Auto-fetch data when refreshTrigger changes (e.g., when Toolbar Apply is clicked)
  useEffect(() => {
    if (refreshTrigger > 0 && providerReady && signals.length > 0) {
      handleFetchData();
    }
  }, [refreshTrigger, providerReady, signals.length]);

  // Auto-fetch data when startTime or endTime changes
  useEffect(() => {
    const hasStartTimeChanged = startTime !== prevStartTimeRef.current;
    const hasEndTimeChanged = endTime !== prevEndTimeRef.current;

    if ((hasStartTimeChanged || hasEndTimeChanged) && providerReady && signals.length > 0) {
      prevStartTimeRef.current = startTime;
      prevEndTimeRef.current = endTime;
      handleFetchData();
    }
  }, [startTime, endTime, providerReady, signals.length]);

  // Notify parent component when column filters change (for session save)
  useEffect(() => {
    if (onColumnFiltersChangeRef.current) {
      onColumnFiltersChangeRef.current(columnFilters.map(f => ({ id: f.id, value: f.value as string })));
    }
  }, [columnFilters]);

  // Notify parent component when metadata filters change (for session save)
  useEffect(() => {
    if (onColumnMetadataFiltersChangeRef.current) {
      onColumnMetadataFiltersChangeRef.current(columnMetadataFilters);
    }
  }, [columnMetadataFilters]);

  // Notify parent component when radix selection changes (for session save)
  useEffect(() => {
    if (onColumnRadixChangeRef.current) {
      onColumnRadixChangeRef.current(columnRadix);
    }
  }, [columnRadix]);

  // Close metadata filter dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        openMetadataFilterColumn &&
        metadataFilterDropdownRef.current &&
        !metadataFilterDropdownRef.current.contains(event.target as Node)
      ) {
        setOpenMetadataFilterColumn(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [openMetadataFilterColumn]);

  // Transform data into table rows
  const tableData = useMemo(() => {
    if (!data || !data.data) return [];

    return data.data.map((row) => {
      const tableRow: TableRow = {
        time: row.time,
      };

      // Map signal values by signal name
      row.values.forEach((value, index) => {
        const signalName = signals[index]?.name;
        if (signalName) {
          tableRow[signalName] = value;
        }
      });

      return tableRow;
    });
  }, [data, signals]);

  // Apply per-column metadata filter to table data
  // For each column, if it has metadata filters, the row must match at least one
  // Across columns, metadata filters use AND relationship
  const filteredTableData = useMemo(() => {
    // Check if any column has active metadata filter
    const hasActiveMetadataFilter = Object.values(columnMetadataFilters).some(
      (filter) => filter.hasX || filter.hasZ || filter.mixed || filter.hasTransition || filter.hasToggle
    );

    if (!hasActiveMetadataFilter) {
      return tableData; // No metadata filter active, return all data
    }

    return tableData.filter((row) => {
      // Check each column that has metadata filters
      for (const [columnId, filter] of Object.entries(columnMetadataFilters)) {
        // Skip if this column has no active filters
        if (!filter.hasX && !filter.hasZ && !filter.mixed && !filter.hasTransition && !filter.hasToggle) {
          continue;
        }

        // Get the value for this column in the current row
        const value = row[columnId] as RawValue | undefined;
        if (!value) {
          // If no value but filter is active, row doesn't match
          return false;
        }

        // Check if this value matches any selected metadata filter for this column (OR relationship within column)
        const matchesHasX = filter.hasX && value.valueType === 'has_x';
        const matchesHasZ = filter.hasZ && value.valueType === 'has_z';
        const matchesMixed = filter.mixed && value.valueType === 'mixed';
        const matchesTransition = filter.hasTransition && value.hasTransition;
        const matchesToggle = filter.hasToggle && (value as any).hasToggle; // Note: RawValue now has hasToggle

        // If no metadata filter matches for this column, exclude the row (AND relationship across columns)
        if (!matchesHasX && !matchesHasZ && !matchesMixed && !matchesTransition && !matchesToggle) {
          return false;
        }
      }

      // Row matches all column metadata filters
      return true;
    });
  }, [tableData, columnMetadataFilters]);

  // Define columns
  const columns = useMemo<ColumnDef<TableRow>[]>(() => {
    // Time column (always first)
    const timeColumn: ColumnDef<TableRow> = {
      id: 'time',
      accessorKey: 'time',
      header: 'Time',
      cell: ({ getValue }) => {
        const time = getValue<number>();
        // WASM already returns time in display units, no need to convert again
        return time.toFixed(3);
      },
      filterFn: 'includesString',
    };

    // Helper function to split signal name into chunks for multi-line display
    // Minimum 8 characters per line, try to break at dots
    const splitSignalName = (name: string): string[] => {
      const minCharsPerLine = 8;
      const lines: string[] = [];
      let remaining = name;

      while (remaining.length > 0) {
        if (remaining.length <= minCharsPerLine) {
          lines.push(remaining);
          break;
        }

        // Try to find a dot after minCharsPerLine to break
        let breakPoint = remaining.length;
        for (let i = minCharsPerLine; i < remaining.length; i++) {
          if (remaining[i] === '.') {
            breakPoint = i;
            break;
          }
        }

        // If no dot found, try to find an underscore
        if (breakPoint === remaining.length) {
          for (let i = minCharsPerLine; i < remaining.length; i++) {
            if (remaining[i] === '_') {
              breakPoint = i;
              break;
            }
          }
        }

        // If still no good breakpoint, just break at minCharsPerLine
        if (breakPoint === remaining.length) {
          breakPoint = minCharsPerLine;
        }

        lines.push(remaining.substring(0, breakPoint));
        remaining = remaining.substring(breakPoint);
        // Remove leading dot/underscore from remaining if present
        if (remaining.startsWith('.') || remaining.startsWith('_')) {
          remaining = remaining.substring(1);
        }
      }

      return lines;
    };

    // Signal columns
    const signalColumns: ColumnDef<TableRow>[] = signals.map((signal) => ({
      id: signal.name,
      // Use accessorFn instead of accessorKey to handle signal names with dots
      accessorFn: (row) => row[signal.name],
      header: () => {
        const lines = splitSignalName(signal.name);
        return (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            {lines.map((line, index) => (
              <div key={index} style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                {line}
              </div>
            ))}
          </div>
        );
      },
      cell: ({ getValue }) => {
        const value = getValue<RawValue | undefined>();
        if (!value) return '-';
        const rawValue = value as any; // Type assertion to access hasToggle
        return (
          <span
            style={{
              color: rawValue.hasToggle ? '#2196f3' : // Blue for hasToggle
                     value.valueType === 'has_x' ? '#ff6b6b' :
                     value.valueType === 'has_z' ? '#4ecdc4' :
                     value.valueType === 'mixed' ? '#ffe66d' :
                     value.hasTransition ? '#000' : '#666', // 有跳变黑色，无跳变深灰色
              fontWeight: rawValue.hasToggle || value.hasTransition ? 'bold' : 'normal', // 有toggle或有跳变加粗
            }}
          >
            {value.displayStr}
          </span>
        );
      },
      filterFn: (row, columnId, filterValue) => {
        const value = row.getValue(columnId) as RawValue | undefined;
        if (!value) return false;
        const displayStr = value.displayStr.toLowerCase();
        const filter = (filterValue as string).toLowerCase();
        return displayStr.includes(filter);
      },
    }));

    return [timeColumn, ...signalColumns];
  }, [signals, timeConfig]);

  // Initialize column visibility (all visible by default)
  useMemo(() => {
    const visibility: VisibilityState = {};
    signals.forEach((signal) => {
      visibility[signal.name] = true;
    });
    setColumnVisibility(visibility);
  }, [signals]);

  // Create table instance
  const table = useReactTable({
    data: filteredTableData,
    columns,
    state: {
      columnFilters,
      columnVisibility,
      pagination: {
        pageIndex: currentPage,
        pageSize: pageSize,
      },
    },
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: false,
  });

  // Handle page change
  const handlePageChange = useCallback((newPage: number) => {
    onPageChange(newPage);
    table.setPageIndex(newPage);
  }, [onPageChange, table]);

  // Calculate the closest LoD value based on displayUnitPerLoD0Unit
  const calculateClosestLoD = useCallback((displayUnitPerLoD0Unit: number): number => {
    console.log('[TableViewWindow] calculateClosestLoD called with displayUnitPerLoD0Unit:', displayUnitPerLoD0Unit);
    // For displayUnitPerLoD0Unit, find the closest 2^n
    // Try LoD 0 to 20 (practical upper limit)
    let closestLoD = 0;
    let closestDiff = Math.abs(1 - displayUnitPerLoD0Unit); // LoD 0 is 2^0 = 1
    
    for (let lod = 1; lod <= 20; lod++) {
      const lodValue = Math.pow(2, lod);
      const diff = Math.abs(lodValue - displayUnitPerLoD0Unit);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestLoD = lod;
      }
    }
    
    return closestLoD;
  }, []);

  // Handle data fetch using adapter (similar to WaveformWindow)
  const handleFetchData = useCallback(async (continueFetch: boolean = false) => {
    if (!adapterRef.current) {
      console.error('[TableViewWindow] Adapter not ready');
      return;
    }

    if (signals.length === 0) {
      return;
    }

    setIsFetching(true);
    setShowLowTransitionWarning(false);

    try {
      // Build WASM signals with proper draw_sig_id (same as WaveformWindow)
      // Use columnRadix if set, otherwise fall back to signal's default displayFormat
      const wasmSignals = await buildWasmSignals(
        signals.map(s => ({
          global_id: s.globalId,
          name: s.name,
          row: s.row,
          width: s.width,
          displayFormat: columnRadix[s.name] || s.displayFormat,
        })),
        _waveformName || 'unknown'
      );

      // Update signals with correct drawSigId
      const updatedSignals = signals.map((s, idx) => ({
        ...s,
        drawSigId: wasmSignals[idx]?.draw_sig_id || s.drawSigId,
      }));
      onSignalsChange(updatedSignals);

      // Calculate the closest LoD
      const selectedLoD = calculateClosestLoD(_displayUnitPerLoD0Unit);

      // Determine search range
      let searchStartTime = startTime;
      let searchEndTime = endTime;
      
      if (continueFetch && accumulatedData) {
        // Continue from last search end + 1
        searchStartTime = currentSearchEndTime + 1;
      }

      // Fetch data using adapter
      // Pass prefix settings to let WASM handle signal name conversion
      const getSignalValuesParams = {
        signalNames: signals.map(s => s.name), // Use local names, WASM will convert
        searchStartTime: searchStartTime,
        searchEndTime: searchEndTime,
        resultMax: resultMax, // Use user-specified max result count
        signals: updatedSignals,
        // Pass LoD parameter
        lod: selectedLoD,
        // Pass early exit parameter
        earlyExitOnInsufficientTransitions: earlyExitOnInsufficientTransitions,
        // Pass prefix settings for signal name conversion
        signalPrefix: _signalPrefix,
        serverPrefix: _serverPrefix,
        spaceBeforeBracket: _spaceBeforeBracket,
        // Pass time unit conversion factor
        displayUnitPerLoD0Unit: _displayUnitPerLoD0Unit,
        // Pass cache settings
        enableOpfs: _enableOpfs,
        enableMemoryCache: _enableMemoryCache,
      };
      const result = await adapterRef.current.get_signal_values_at_transitions(getSignalValuesParams);

      // Check if we got max results (can continue fetching)
      const gotMaxResults = result.data.length >= resultMax;
      setCanContinueFetch(gotMaxResults && result.searchEndTime < endTime);
      setCurrentSearchEndTime(result.searchEndTime);

      // Check if transition count is less than 3
      if (result.data.length < 3) {
        setShowLowTransitionWarning(true);
      }

      // Merge or replace data
      if (continueFetch && accumulatedData) {
        // Filter out duplicate times (WASM may return boundary transition again)
        const existingTimes = new Set(accumulatedData.data.map(r => r.time));
        const newData = result.data.filter(r => !existingTimes.has(r.time));
        
        // Append new data to accumulated data
        const mergedResult: RawSignalValuesResult = {
          searchStartTime: accumulatedData.searchStartTime,
          searchEndTime: result.searchEndTime,
          data: [...accumulatedData.data, ...newData],
        };
        setAccumulatedData(mergedResult);
        onFetchData(mergedResult);
        // Navigate to the last page to show new data
        const totalPages = Math.ceil(mergedResult.data.length / pageSize);
        handlePageChange(totalPages - 1);
      } else {
        // Replace data
        setAccumulatedData(result);
        onFetchData(result);
      }
    } catch (error) {
      console.error('[TableViewWindow] Failed to fetch data:', error);
    } finally {
      setIsFetching(false);
    }
  }, [
    adapterRef, 
    signals, 
    startTime, 
    endTime, 
    onSignalsChange, 
    onFetchData, 
    _waveformName, 
    _signalPrefix, 
    _serverPrefix, 
    _spaceBeforeBracket,
    _displayUnitPerLoD0Unit,
    calculateClosestLoD,
    resultMax,
    earlyExitOnInsufficientTransitions,
    accumulatedData,
    currentSearchEndTime,
    columnRadix
  ]);

  // Get total pages
  const totalPages = table.getPageCount();
  const canPreviousPage = table.getCanPreviousPage();
  const canNextPage = table.getCanNextPage();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderBottom: '1px solid #e0e0e0',
          backgroundColor: '#f5f5f5',
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={() => handleFetchData(false)}
          disabled={!providerReady || isFetching}
          style={{
            padding: '6px 12px',
            fontSize: '12px',
            backgroundColor: providerReady ? '#4caf50' : '#ccc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: providerReady ? 'pointer' : 'not-allowed',
          }}
        >
          {isFetching ? t('tableView.fetching') : t('tableView.refreshData')}
        </button>

        {!providerReady && (
          <span style={{ fontSize: '11px', color: '#999' }}>
            {providerLoading ? 'Loading provider...' : 'Provider not ready'}
          </span>
        )}

        {/* Early Exit Toggle */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={earlyExitOnInsufficientTransitions}
            onChange={(e) => setEarlyExitOnInsufficientTransitions(e.target.checked)}
          />
          {t('tableView.earlyExit')}
        </label>

        {/* Max Result Input */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
          {t('tableView.maxRows')}
          <input
            type="number"
            value={resultMax}
            onChange={(e) => setResultMax(Math.max(1, parseInt(e.target.value) || 100))}
            min="1"
            max="10000"
            style={{
              width: '60px',
              padding: '2px 4px',
              fontSize: '11px',
              border: '1px solid #ccc',
              borderRadius: '3px',
            }}
          />
        </label>

        {/* Continue Fetch Button */}
        {canContinueFetch && (
          <button
            onClick={() => handleFetchData(true)}
            disabled={!providerReady || isFetching}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              backgroundColor: providerReady ? '#ff9800' : '#ccc',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: providerReady ? 'pointer' : 'not-allowed',
            }}
          >
            {isFetching ? 'Fetching...' : 'Continue Fetch'}
          </button>
        )}

        {/* Page Size Control */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
          Page Size:
          <select
            value={pageSize}
            onChange={(e) => {
              const newPageSize = parseInt(e.target.value);
              setPageSize(newPageSize);
              // Reset to first page when page size changes
              handlePageChange(0);
            }}
            style={{
              padding: '2px 4px',
              fontSize: '11px',
              border: '1px solid #ccc',
              borderRadius: '3px',
            }}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
          </select>
        </label>

        {/* Column Visibility Toggle */}
        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button
            onClick={() => setShowColumnVisibility(!showColumnVisibility)}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              backgroundColor: '#2196f3',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            {t('tableView.columns')}
          </button>

          {showColumnVisibility && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                zIndex: 100,
                backgroundColor: 'white',
                border: '1px solid #ccc',
                borderRadius: '4px',
                padding: '8px',
                minWidth: '200px',
                maxHeight: '300px',
                overflowY: 'auto',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              }}
            >
              <div style={{ marginBottom: '8px', fontWeight: 'bold', fontSize: '12px' }}>
                {t('tableView.toggleColumns')}
              </div>
              {table.getAllLeafColumns().map((column) => {
                if (column.id === 'time') return null; // Always show time column
                return (
                  <div key={column.id} style={{ marginBottom: '4px' }}>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '12px',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={column.getIsVisible()}
                        onChange={column.getToggleVisibilityHandler()}
                      />
                      {column.id}
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ fontSize: '12px', color: '#666' }}>
          Total: {filteredTableData.length} / {tableData.length} rows
        </div>
      </div>

      {/* Low Transition Warning */}
      {showLowTransitionWarning && (
        <div
          style={{
            backgroundColor: '#fff3cd',
            borderBottom: '1px solid #ffc107',
            padding: '8px 12px',
            fontSize: '12px',
            color: '#856404',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>
            ⚠️ Only {tableData.length} transition(s) found. Consider increasing display unit per LoD0 unit for more data.
          </span>
          <button
            onClick={() => setShowLowTransitionWarning(false)}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '16px',
              cursor: 'pointer',
              color: '#856404',
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, backgroundColor: '#f5f5f5' }}>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    style={{
                      padding: '8px 12px',
                      textAlign: 'left',
                      borderBottom: '2px solid #ddd',
                      fontSize: '12px',
                      fontWeight: 'bold',
                      whiteSpace: 'nowrap',
                      verticalAlign: 'bottom', // Ensure all filter bars align at bottom
                    }}
                  >
                    <div>{flexRender(header.column.columnDef.header, header.getContext())}</div>
                    {/* Filter bar container - aligned at bottom */}
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', marginTop: '4px' }}>
                      {/* Column Filter Input */}
                      {header.column.getCanFilter() && (
                        <input
                          type="text"
                          value={(header.column.getFilterValue() as string) ?? ''}
                          onChange={(e) => header.column.setFilterValue(e.target.value)}
                          placeholder="Filter..."
                          style={{
                            flex: 1,
                            padding: '2px 4px',
                            fontSize: '11px',
                            border: '1px solid #ccc',
                            borderRadius: '3px',
                          }}
                        />
                      )}
                      {/* Delete Button and Metadata Filter Button - only for signal columns */}
                      {header.column.id !== 'time' && (
                        <div style={{ display: 'flex', gap: '4px' }}>
                          {/* Delete Button */}
                          <button
                            onClick={() => {
                              const signalName = header.column.id;
                              const signalIndex = signals.findIndex(s => s.name === signalName);
                              const newSignals = signals.filter(s => s.name !== signalName);
                              onSignalsChange(newSignals);
                              // Remove radix and filter settings for this signal
                              setColumnRadix(prev => {
                                const { [signalName]: _, ...rest } = prev;
                                return rest;
                              });
                              setColumnMetadataFilters(prev => {
                                const { [signalName]: _, ...rest } = prev;
                                return rest;
                              });
                              // Remove data for this signal from accumulatedData to keep data in sync
                              if (accumulatedData && signalIndex !== -1) {
                                const newAccumulatedData: RawSignalValuesResult = {
                                  ...accumulatedData,
                                  data: accumulatedData.data.map(row => ({
                                    time: row.time,
                                    values: row.values.filter((_, idx) => idx !== signalIndex),
                                  })),
                                };
                                setAccumulatedData(newAccumulatedData);
                                onFetchData(newAccumulatedData);
                              }
                            }}
                            style={{
                              padding: '2px 4px',
                              fontSize: '10px',
                              backgroundColor: '#ff4444',
                              color: 'white',
                              border: '1px solid #ccc',
                              borderRadius: '3px',
                              cursor: 'pointer',
                              lineHeight: 1,
                            }}
                            title="Remove signal"
                          >
                            ✕
                          </button>
                          
                          {/* Metadata Filter Button (small triangle) */}
                          <div style={{ position: 'relative' }}>
                            <button
                              onClick={() => setOpenMetadataFilterColumn(
                                openMetadataFilterColumn === header.column.id ? null : header.column.id
                              )}
                              style={{
                                padding: '2px 4px',
                                fontSize: '10px',
                                backgroundColor: (columnMetadataFilters[header.column.id]?.hasX ||
                                                  columnMetadataFilters[header.column.id]?.hasZ ||
                                                  columnMetadataFilters[header.column.id]?.mixed ||
                                                  columnMetadataFilters[header.column.id]?.hasTransition ||
                                                  columnMetadataFilters[header.column.id]?.hasToggle)
                                                  ? '#ff9800' : '#f0f0f0',
                                color: (columnMetadataFilters[header.column.id]?.hasX ||
                                        columnMetadataFilters[header.column.id]?.hasZ ||
                                        columnMetadataFilters[header.column.id]?.mixed ||
                                        columnMetadataFilters[header.column.id]?.hasTransition ||
                                        columnMetadataFilters[header.column.id]?.hasToggle)
                                        ? 'white' : '#666',
                                border: '1px solid #ccc',
                                borderRadius: '3px',
                                cursor: 'pointer',
                                lineHeight: 1,
                              }}
                              title="Filter by metadata"
                            >
                              ▼
                            </button>

                          {/* Metadata Filter Dropdown */}
                          {openMetadataFilterColumn === header.column.id && (
                            <div
                              ref={metadataFilterDropdownRef}
                              style={{
                                position: 'absolute',
                                top: '100%',
                                right: 0,
                                zIndex: 100,
                                backgroundColor: 'white',
                                border: '1px solid #ccc',
                                borderRadius: '4px',
                                padding: '8px',
                                minWidth: '160px',
                                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                                marginTop: '4px',
                              }}
                            >
                              {/* Radix Selection Section */}
                              <div style={{ marginBottom: '8px', fontWeight: 'bold', fontSize: '11px' }}>
                                Radix
                              </div>
                              {(() => {
                                const columnId = header.column.id;
                                const currentRadix = columnRadix[columnId] || 'hex';
                                return (
                                  <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
                                    {(['bin', 'oct', 'dec', 'hex'] as const).map((radix) => (
                                      <button
                                        key={radix}
                                        onClick={() => {
                                          setColumnRadix(prev => ({ ...prev, [columnId]: radix }));
                                          // Trigger refetch to apply new radix
                                          setTimeout(() => handleFetchData(false), 0);
                                        }}
                                        style={{
                                          padding: '2px 6px',
                                          fontSize: '10px',
                                          backgroundColor: currentRadix === radix ? '#2196f3' : '#f0f0f0',
                                          color: currentRadix === radix ? 'white' : '#333',
                                          border: '1px solid #ccc',
                                          borderRadius: '3px',
                                          cursor: 'pointer',
                                        }}
                                      >
                                        {radix.toUpperCase()}
                                      </button>
                                    ))}
                                  </div>
                                );
                              })()}

                              <div style={{ borderTop: '1px solid #eee', marginBottom: '8px' }}></div>

                              <div style={{ marginBottom: '6px', fontWeight: 'bold', fontSize: '11px' }}>
                                Metadata Filter (OR)
                              </div>
                              {(() => {
                                const columnId = header.column.id;
                                const filters = columnMetadataFilters[columnId] || { hasX: false, hasZ: false, mixed: false, hasTransition: false, hasToggle: false };
                                return (
                                  <>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px', fontSize: '11px', cursor: 'pointer' }}>
                                      <input
                                        type="checkbox"
                                        checked={filters.hasX}
                                        onChange={(e) => {
                                          setColumnMetadataFilters(prev => ({
                                            ...prev,
                                            [columnId]: { ...filters, hasX: e.target.checked }
                                          }));
                                        }}
                                      />
                                      <span style={{ color: '#ff6b6b' }}>Has X</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px', fontSize: '11px', cursor: 'pointer' }}>
                                      <input
                                        type="checkbox"
                                        checked={filters.hasZ}
                                        onChange={(e) => {
                                          setColumnMetadataFilters(prev => ({
                                            ...prev,
                                            [columnId]: { ...filters, hasZ: e.target.checked }
                                          }));
                                        }}
                                      />
                                      <span style={{ color: '#4ecdc4' }}>Has Z</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px', fontSize: '11px', cursor: 'pointer' }}>
                                      <input
                                        type="checkbox"
                                        checked={filters.mixed}
                                        onChange={(e) => {
                                          setColumnMetadataFilters(prev => ({
                                            ...prev,
                                            [columnId]: { ...filters, mixed: e.target.checked }
                                          }));
                                        }}
                                      />
                                      <span style={{ color: '#ffa500' }}>Mixed</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px', fontSize: '11px', cursor: 'pointer' }}>
                                      <input
                                        type="checkbox"
                                        checked={filters.hasTransition}
                                        onChange={(e) => {
                                          setColumnMetadataFilters(prev => ({
                                            ...prev,
                                            [columnId]: { ...filters, hasTransition: e.target.checked }
                                          }));
                                        }}
                                      />
                                      <span style={{ fontWeight: 'bold' }}>Transition</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer' }}>
                                      <input
                                        type="checkbox"
                                        checked={filters.hasToggle}
                                        onChange={(e) => {
                                          setColumnMetadataFilters(prev => ({
                                            ...prev,
                                            [columnId]: { ...filters, hasToggle: e.target.checked }
                                          }));
                                        }}
                                      />
                                      <span style={{ color: '#2196f3' }}>Toggle</span>
                                    </label>
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      </div>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                style={{
                  borderBottom: '1px solid #eee',
                  backgroundColor: row.index % 2 === 0 ? '#fff' : '#fafafa',
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderTop: '1px solid #e0e0e0',
          backgroundColor: '#f5f5f5',
        }}
      >
        <button
          onClick={() => handlePageChange(0)}
          disabled={!canPreviousPage}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            cursor: canPreviousPage ? 'pointer' : 'not-allowed',
            opacity: canPreviousPage ? 1 : 0.5,
          }}
        >
          {'<<'}
        </button>
        <button
          onClick={() => handlePageChange(currentPage - 1)}
          disabled={!canPreviousPage}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            cursor: canPreviousPage ? 'pointer' : 'not-allowed',
            opacity: canPreviousPage ? 1 : 0.5,
          }}
        >
          {'<'}
        </button>
        <span style={{ fontSize: '12px' }}>
          Page {currentPage + 1} of {totalPages}
        </span>
        <button
          onClick={() => handlePageChange(currentPage + 1)}
          disabled={!canNextPage}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            cursor: canNextPage ? 'pointer' : 'not-allowed',
            opacity: canNextPage ? 1 : 0.5,
          }}
        >
          {'>'}
        </button>
        <button
          onClick={() => handlePageChange(totalPages - 1)}
          disabled={!canNextPage}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            cursor: canNextPage ? 'pointer' : 'not-allowed',
            opacity: canNextPage ? 1 : 0.5,
          }}
        >
          {'>>'}
        </button>
      </div>
    </div>
  );
}
