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

    // Signal columns
    const signalColumns: ColumnDef<TableRow>[] = signals.map((signal) => ({
      id: signal.name,
      accessorKey: signal.name,
      header: signal.name,
      cell: ({ getValue }) => {
        const value = getValue<RawValue | undefined>();
        if (!value) return '-';
        return (
          <span
            style={{
              color: value.valueType === 'has_x' ? '#ff6b6b' :
                     value.valueType === 'has_z' ? '#4ecdc4' :
                     value.valueType === 'mixed' ? '#ffe66d' : '#333',
              fontWeight: value.hasTransition ? 'bold' : 'normal',
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
    data: tableData,
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

      // Fetch data using adapter (use underscore format method name)
      const result = await adapterRef.current.get_signal_values_at_transitions({
        signalNames: wasmSignals.map(s => s.name),
        searchStartTime: startTime,
        searchEndTime: endTime,
        resultMax: 100, // 100 rows per page
        signals: updatedSignals,
      });

      // Update parent with fetched data
      onFetchData(result);

      console.log(`[TableViewWindow] Fetched ${result.data.length} rows`);
    } catch (error) {
      console.error('[TableViewWindow] Failed to fetch data:', error);
    } finally {
      setIsFetching(false);
    }
  }, [adapterRef, signals, startTime, endTime, onSignalsChange, onFetchData, _waveformName]);

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
          Total: {tableData.length} rows
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
                    }}
                  >
                    <div>{flexRender(header.column.columnDef.header, header.getContext())}</div>
                    {/* Column Filter Input */}
                    {header.column.getCanFilter() && (
                      <input
                        type="text"
                        value={(header.column.getFilterValue() as string) ?? ''}
                        onChange={(e) => header.column.setFilterValue(e.target.value)}
                        placeholder="Filter..."
                        style={{
                          width: '100%',
                          marginTop: '4px',
                          padding: '2px 4px',
                          fontSize: '11px',
                          border: '1px solid #ccc',
                          borderRadius: '3px',
                        }}
                      />
                    )}
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
