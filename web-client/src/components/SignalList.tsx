import { useState, useEffect, useMemo } from 'react';
import type { Instance, Signal } from '../types';

interface SignalListProps {
  instance: Instance | null;
  onSignalSelect: (signal: Signal) => void;
  onSignalAddToWaveform: (signal: Signal) => void;
}

// Mock signals for demonstration
const mockSignals: Record<string, Signal[]> = {
  'top': [
    { handle: 1, name: 'clk', fullPath: 'top.clk', bitWidth: 1, msb: 0, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 2, name: 'rst_n', fullPath: 'top.rst_n', bitWidth: 1, msb: 0, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 3, name: 'data_in', fullPath: 'top.data_in', bitWidth: 32, msb: 31, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 4, name: 'data_out', fullPath: 'top.data_out', bitWidth: 32, msb: 31, lsb: 0, type: 0, direction: 1, filePath: '', lineNumber: 0, column: 0 },
    { handle: 5, name: 'state', fullPath: 'top.state', bitWidth: 4, msb: 3, lsb: 0, type: 1, direction: 3, filePath: '', lineNumber: 0, column: 0 },
    { handle: 6, name: 'counter', fullPath: 'top.counter', bitWidth: 16, msb: 15, lsb: 0, type: 1, direction: 3, filePath: '', lineNumber: 0, column: 0 },
  ],
  'top.u_cpu': [
    { handle: 7, name: 'clk', fullPath: 'top.u_cpu.clk', bitWidth: 1, msb: 0, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 8, name: 'rst_n', fullPath: 'top.u_cpu.rst_n', bitWidth: 1, msb: 0, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 9, name: 'pc', fullPath: 'top.u_cpu.pc', bitWidth: 32, msb: 31, lsb: 0, type: 1, direction: 1, filePath: '', lineNumber: 0, column: 0 },
    { handle: 10, name: 'instr', fullPath: 'top.u_cpu.instr', bitWidth: 32, msb: 31, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 11, name: 'alu_result', fullPath: 'top.u_cpu.alu_result', bitWidth: 32, msb: 31, lsb: 0, type: 1, direction: 3, filePath: '', lineNumber: 0, column: 0 },
    { handle: 12, name: 'reg_write_en', fullPath: 'top.u_cpu.reg_write_en', bitWidth: 1, msb: 0, lsb: 0, type: 0, direction: 3, filePath: '', lineNumber: 0, column: 0 },
  ],
  'top.u_mem': [
    { handle: 13, name: 'clk', fullPath: 'top.u_mem.clk', bitWidth: 1, msb: 0, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 14, name: 'addr', fullPath: 'top.u_mem.addr', bitWidth: 16, msb: 15, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 15, name: 'data_in', fullPath: 'top.u_mem.data_in', bitWidth: 32, msb: 31, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 16, name: 'data_out', fullPath: 'top.u_mem.data_out', bitWidth: 32, msb: 31, lsb: 0, type: 1, direction: 1, filePath: '', lineNumber: 0, column: 0 },
    { handle: 17, name: 'we', fullPath: 'top.u_mem.we', bitWidth: 1, msb: 0, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
  ],
  'top.u_bus': [
    { handle: 18, name: 'clk', fullPath: 'top.u_bus.clk', bitWidth: 1, msb: 0, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 19, name: 'master_req', fullPath: 'top.u_bus.master_req', bitWidth: 4, msb: 3, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 20, name: 'grant', fullPath: 'top.u_bus.grant', bitWidth: 4, msb: 3, lsb: 0, type: 1, direction: 1, filePath: '', lineNumber: 0, column: 0 },
    { handle: 21, name: 'arbiter_state', fullPath: 'top.u_bus.arbiter_state', bitWidth: 3, msb: 2, lsb: 0, type: 1, direction: 3, filePath: '', lineNumber: 0, column: 0 },
  ],
  'top.u_cpu.u_alu': [
    { handle: 22, name: 'a', fullPath: 'top.u_cpu.u_alu.a', bitWidth: 32, msb: 31, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 23, name: 'b', fullPath: 'top.u_cpu.u_alu.b', bitWidth: 32, msb: 31, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 24, name: 'op', fullPath: 'top.u_cpu.u_alu.op', bitWidth: 4, msb: 3, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 25, name: 'result', fullPath: 'top.u_cpu.u_alu.result', bitWidth: 32, msb: 31, lsb: 0, type: 1, direction: 1, filePath: '', lineNumber: 0, column: 0 },
    { handle: 26, name: 'zero', fullPath: 'top.u_cpu.u_alu.zero', bitWidth: 1, msb: 0, lsb: 0, type: 1, direction: 1, filePath: '', lineNumber: 0, column: 0 },
  ],
  'top.u_cpu.u_regfile': [
    { handle: 27, name: 'clk', fullPath: 'top.u_cpu.u_regfile.clk', bitWidth: 1, msb: 0, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 28, name: 'read_addr1', fullPath: 'top.u_cpu.u_regfile.read_addr1', bitWidth: 5, msb: 4, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 29, name: 'read_addr2', fullPath: 'top.u_cpu.u_regfile.read_addr2', bitWidth: 5, msb: 4, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 30, name: 'write_addr', fullPath: 'top.u_cpu.u_regfile.write_addr', bitWidth: 5, msb: 4, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 31, name: 'write_data', fullPath: 'top.u_cpu.u_regfile.write_data', bitWidth: 32, msb: 31, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 32, name: 'write_en', fullPath: 'top.u_cpu.u_regfile.write_en', bitWidth: 1, msb: 0, lsb: 0, type: 0, direction: 0, filePath: '', lineNumber: 0, column: 0 },
    { handle: 33, name: 'read_data1', fullPath: 'top.u_cpu.u_regfile.read_data1', bitWidth: 32, msb: 31, lsb: 0, type: 1, direction: 1, filePath: '', lineNumber: 0, column: 0 },
    { handle: 34, name: 'read_data2', fullPath: 'top.u_cpu.u_regfile.read_data2', bitWidth: 32, msb: 31, lsb: 0, type: 1, direction: 1, filePath: '', lineNumber: 0, column: 0 },
  ],
};

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

  useEffect(() => {
    if (instance) {
      const instanceSignals = mockSignals[instance.fullPath] || [];
      setSignals(instanceSignals);
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

    // Filter by name pattern
    if (nameFilter.trim()) {
      const pattern = nameFilter.toLowerCase();
      result = result.filter(signal => 
        signal.name.toLowerCase().includes(pattern) ||
        signal.fullPath.toLowerCase().includes(pattern)
      );
    }

    return result;
  }, [signals, ioFilter, nameFilter]);

  const handleSignalClick = (signal: Signal) => {
    setSelectedSignal(signal);
    onSignalSelect(signal);
  };

  const handleDoubleClick = (signal: Signal) => {
    onSignalAddToWaveform(signal);
  };

  const getSignalDisplayName = (signal: Signal) => {
    if (signal.bitWidth > 1) {
      return `${signal.name}[${signal.msb}:${signal.lsb}]`;
    }
    return signal.name;
  };

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
        <input
          type="text"
          placeholder="Filter signals..."
          value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          style={{
            flex: 1,
            padding: '3px 6px',
            fontSize: '11px',
            border: '1px solid #c0c0c0',
            borderRadius: '2px',
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
            {instance ? 'No signals found' : 'Select an instance'}
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
