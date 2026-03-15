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
}: TableViewWindowProps) {
  // Get shared provider from context (same as WaveformWindow)
  const { provider: sharedProvider, isLoading: providerLoading } = useWaveformProvider();
  
  // Create adapter ref (same as WaveformWindow)
  const adapterRef = useRef<WaveformProviderAdapter | null>(null);
  const [adapterCreated, setAdapterCreated] = useState(false);
  
  // Provider ready state (same as WaveformWindow)
  const providerReady = !providerLoading && sharedProvider !== null && adapterRef.current !== null;

  // Column filters state
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  // Column visibility state
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  // Show/hide column visibility dropdown
  const [showColumnVisibility, setShowColumnVisibility] = useState(false);
  // Loading state for data fetch
  const [isFetching, setIsFetching] = useState(false);
  // Per-column metadata filter state: { [columnId]: { hasX, hasZ, mixed, hasTransition } }
  const [columnMetadataFilters, setColumnMetadataFilters] = useState<{
    [columnId: string]: {
      hasX: boolean;
      hasZ: boolean;
      mixed: boolean;
      hasTransition: boolean;
    };
  }>({});
  // Track which column's metadata filter dropdown is open
  const [openMetadataFilterColumn, setOpenMetadataFilterColumn] = useState<string | null>(null);

  // Create adapter when provider is ready (same pattern as WaveformWindow)
  useEffect(() => {
    if (sharedProvider && !adapterRef.current) {
      const adapter = new WaveformProviderAdapter(sharedProvider, tabId);
      adapterRef.current = adapter;
      setAdapterCreated(true);
      console.log(`[TableViewWindow] Created adapter for tab: ${tabId}`);
    }
  }, [sharedProvider, tabId]);

  // Auto-fetch data when refreshTrigger changes (e.g., when Toolbar Apply is clicked)
  useEffect(() => {
    if (refreshTrigger > 0 && providerReady && signals.length > 0) {
      console.log('[TableViewWindow] Refresh triggered, fetching data...');
      handleFetchData();
    }
  }, [refreshTrigger, providerReady, signals.length]);

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
      (filter) => filter.hasX || filter.hasZ || filter.mixed || filter.hasTransition
    );

    if (!hasActiveMetadataFilter) {
      return tableData; // No metadata filter active, return all data
    }

    return tableData.filter((row) => {
      // Check each column that has metadata filters
      for (const [columnId, filter] of Object.entries(columnMetadataFilters)) {
        // Skip if this column has no active filters
        if (!filter.hasX && !filter.hasZ && !filter.mixed && !filter.hasTransition) {
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

        // If no metadata filter matches for this column, exclude the row (AND relationship across columns)
        if (!matchesHasX && !matchesHasZ && !matchesMixed && !matchesTransition) {
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
        const displayTime = lod0ToDisplay(time, timeConfig);
        return displayTime.toFixed(3);
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
        return (
          <span
            style={{
              color: value.valueType === 'has_x' ? '#ff6b6b' :
                     value.valueType === 'has_z' ? '#4ecdc4' :
                     value.valueType === 'mixed' ? '#ffe66d' :
                     value.hasTransition ? '#000' : '#666', // 有跳变黑色，无跳变深灰色
              fontWeight: value.hasTransition ? 'bold' : 'normal', // 有跳变加粗
            }}
          >
            {value.displayStr}
          </span>
        );
      },
      filterFn: 'includesString',
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
        pageSize: 100,
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

  // Handle data fetch using adapter (similar to WaveformWindow)
  const handleFetchData = useCallback(async () => {
    if (!adapterRef.current) {
      console.error('[TableViewWindow] Adapter not ready');
      return;
    }

    if (signals.length === 0) {
      console.log('[TableViewWindow] No signals to fetch');
      return;
    }

    setIsFetching(true);

    try {
      // Build WASM signals with proper draw_sig_id (same as WaveformWindow)
      const wasmSignals = await buildWasmSignals(
        signals.map(s => ({
          global_id: s.globalId,
          name: s.name,
          row: s.row,
          width: s.width,
          displayFormat: s.displayFormat,
        })),
        _waveformName || 'unknown'
      );

      // Update signals with correct drawSigId
      const updatedSignals = signals.map((s, idx) => ({
        ...s,
        drawSigId: wasmSignals[idx]?.draw_sig_id || s.drawSigId,
      }));
      onSignalsChange(updatedSignals);

      // Fetch data using adapter
      // Pass prefix settings to let WASM handle signal name conversion
      const result = await adapterRef.current.get_signal_values_at_transitions({
        signalNames: signals.map(s => s.name), // Use local names, WASM will convert
        searchStartTime: startTime,
        searchEndTime: endTime,
        resultMax: 100, // 100 rows per page
        signals: updatedSignals,
        // Pass prefix settings for signal name conversion
        signalPrefix: _signalPrefix,
        serverPrefix: _serverPrefix,
        spaceBeforeBracket: _spaceBeforeBracket,
        // Pass time unit conversion factor
        displayUnitPerLoD0Unit: _displayUnitPerLoD0Unit,
      });

      // Debug: Log WASM returned data
      console.log('[TableViewWindow] WASM returned data:', {
        searchStartTime: result.searchStartTime,
        searchEndTime: result.searchEndTime,
        rowCount: result.data.length,
        firstRow: result.data[0] ? {
          time: result.data[0].time,
          values: result.data[0].values.map(v => ({ displayStr: v.displayStr, valueType: v.valueType, hasTransition: v.hasTransition }))
        } : null,
        allRowTimes: result.data.map(r => r.time)
      });

      // Update parent with fetched data
      onFetchData(result);

      console.log(`[TableViewWindow] Fetched ${result.data.length} rows`);
    } catch (error) {
      console.error('[TableViewWindow] Failed to fetch data:', error);
    } finally {
      setIsFetching(false);
    }
  }, [adapterRef, signals, startTime, endTime, onSignalsChange, onFetchData, _waveformName, _signalPrefix, _serverPrefix, _spaceBeforeBracket]);

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
        }}
      >
        <button
          onClick={handleFetchData}
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
          {isFetching ? 'Fetching...' : 'Refresh Data'}
        </button>

        {!providerReady && (
          <span style={{ fontSize: '11px', color: '#999' }}>
            {providerLoading ? 'Loading provider...' : 'Provider not ready'}
          </span>
        )}

        {/* Column Visibility Toggle */}
        <div style={{ position: 'relative' }}>
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
            Columns
          </button>

          {showColumnVisibility && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
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
                Toggle Columns
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

        <div style={{ marginLeft: 'auto', fontSize: '12px', color: '#666' }}>
          Total: {filteredTableData.length} / {tableData.length} rows
        </div>
      </div>

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
                      {/* Metadata Filter Button (small triangle) - only for signal columns */}
                      {header.column.id !== 'time' && (
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
                                                columnMetadataFilters[header.column.id]?.hasTransition)
                                                ? '#ff9800' : '#f0f0f0',
                              color: (columnMetadataFilters[header.column.id]?.hasX ||
                                      columnMetadataFilters[header.column.id]?.hasZ ||
                                      columnMetadataFilters[header.column.id]?.mixed ||
                                      columnMetadataFilters[header.column.id]?.hasTransition)
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
                              <div style={{ marginBottom: '6px', fontWeight: 'bold', fontSize: '11px' }}>
                                Metadata Filter (OR)
                              </div>
                              {(() => {
                                const columnId = header.column.id;
                                const filters = columnMetadataFilters[columnId] || { hasX: false, hasZ: false, mixed: false, hasTransition: false };
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
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer' }}>
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
                                  </>
                                );
                              })()}
                            </div>
                          )}
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
