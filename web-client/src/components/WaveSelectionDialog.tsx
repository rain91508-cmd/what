import { useState, useEffect } from 'react';
import { waveManager } from '../modules/wSignal';
import { apiService } from '../services/api';

interface ServerWaveformInfo {
  name: string;
  file_size: number;
  is_valid: boolean;
}

interface WaveSelectionDialogProps {
  onSelect: (waveName: string, customRange?: { start: number; end: number }) => void;
  onCancel: () => void;
}

export function WaveSelectionDialog({ onSelect, onCancel }: WaveSelectionDialogProps) {
  const [waves, setWaves] = useState<ServerWaveformInfo[]>([]);
  const [selectedWave, setSelectedWave] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  
  // Time range settings (in LoD0 units - time_unit)
  const [useCustomRange, setUseCustomRange] = useState(false);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [isLoadingWaveInfo, setIsLoadingWaveInfo] = useState(false);

  useEffect(() => {
    loadWaveList();
  }, []);

  const loadWaveList = async () => {
    try {
      setLoading(true);
      setError(null);
      setWaves([]);
      setSelectedWave('');
      
      console.log('[WaveSelectionDialog] Loading waveform list...');
      const waveList = await waveManager.fetchWaveformList();
      console.log('[WaveSelectionDialog] Got wave list:', waveList);
      
      if (!waveList || waveList.length === 0) {
        setError('No waveforms available - server may be disconnected');
        setWaves([]);
        return;
      }
      
      const validWaves = (waveList as unknown as ServerWaveformInfo[]).filter((wave) => wave.is_valid);
      console.log('[WaveSelectionDialog] Valid waves:', validWaves);
      setWaves(validWaves);
      if (validWaves.length > 0) {
        setSelectedWave(validWaves[0].name);
        // Auto-load first wave info
        loadWaveInfo(validWaves[0].name);
      }
    } catch (err) {
      console.error('[WaveSelectionDialog] Error loading waveform list:', err);
      setError(`Error loading waveform list: ${err instanceof Error ? err.message : String(err)}`);
      setWaves([]);
    } finally {
      setLoading(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const wildcardMatch = (pattern: string, text: string): boolean => {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      return text.toLowerCase().includes(pattern.toLowerCase());
    }
    const regex = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i'
    );
    return regex.test(text);
  };

  const filteredWaves = waves.filter(wave => {
    if (!filter.trim()) return true;
    return wildcardMatch(filter, wave.name);
  });

  // Load waveform info from server and pre-fill time range
  const loadWaveInfo = async (waveName: string) => {
    setIsLoadingWaveInfo(true);
    try {
      const infoResponse = await apiService.getWaveformInfo(waveName);
      if (infoResponse.status === 'success' && infoResponse.data?.wave_info) {
        const waveInfo = infoResponse.data.wave_info;
        console.log('[WaveSelectionDialog] Wave info:', waveInfo);
        
        // Parse time_unit to get multiplier
        const timeUnit = waveInfo.time_unit || '1fs';
        const match = timeUnit.match(/(\d+)([a-z]+)/i);
        // @ts-ignore - 暂时未使用但保留
        let _multiplier = 1;
        if (match) {
          const unit = match[2].toLowerCase();
          switch (unit) {
            case 'fs': _multiplier = 1; break;
            case 'ps': _multiplier = 1000; break;
            case 'ns': _multiplier = 1000000; break;
            case 'us': _multiplier = 1000000000; break;
            case 'ms': _multiplier = 1000000000000; break;
          }
        }
        
        // waveInfo times are already in LoD0 units (time_unit)
        // No conversion needed
        const startLod0 = waveInfo.start_time || 0;
        const endLod0 = waveInfo.end_time || 0;
        
        setStartTime(startLod0.toString());
        setEndTime(endLod0.toString());
        console.log(`[WaveSelectionDialog] Pre-filled range: ${startLod0} - ${endLod0} LoD0 units`);
      }
    } catch (err) {
      console.error('[WaveSelectionDialog] Error loading wave info:', err);
    } finally {
      setIsLoadingWaveInfo(false);
    }
  };

  const handleWaveClick = (waveName: string) => {
    setSelectedWave(waveName);
    loadWaveInfo(waveName);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedWave) {
      if (useCustomRange && startTime && endTime) {
        const start = parseFloat(startTime);
        const end = parseFloat(endTime);
        onSelect(selectedWave, { start, end });
      } else {
        onSelect(selectedWave);
      }
    }
  };

  const handleDoubleClick = (waveName: string) => {
    if (useCustomRange && startTime && endTime) {
      const start = parseFloat(startTime);
      const end = parseFloat(endTime);
      onSelect(waveName, { start, end });
    } else {
      onSelect(waveName);
    }
  };

  if (loading) {
    return (
      <div className="dialog-overlay" onClick={onCancel}>
        <div className="dialog" onClick={e => e.stopPropagation()}>
          <div className="dialog-header">
            <span className="dialog-title">Select Waveform</span>
          </div>
          <div className="dialog-body">
            <div style={{ textAlign: 'center', padding: '20px' }}>Loading waveform list...</div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dialog-overlay" onClick={onCancel}>
        <div className="dialog" onClick={e => e.stopPropagation()}>
          <div className="dialog-header">
            <span className="dialog-title">Select Waveform</span>
            <button className="dialog-close" onClick={onCancel}>×</button>
          </div>
          <div className="dialog-body">
            <div style={{ color: '#d32f2f', padding: '10px' }}>{error}</div>
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={onCancel}>Cancel</button>
            <button className="btn btn-primary" onClick={loadWaveList}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  if (waves.length === 0) {
    return (
      <div className="dialog-overlay" onClick={onCancel}>
        <div className="dialog" onClick={e => e.stopPropagation()}>
          <div className="dialog-header">
            <span className="dialog-title">Select Waveform</span>
            <button className="dialog-close" onClick={onCancel}>×</button>
          </div>
          <div className="dialog-body">
            <div style={{ padding: '10px' }}>No valid waveform files found on server.</div>
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
        <div className="dialog-header">
          <span className="dialog-title">Select Waveform</span>
          <button className="dialog-close" onClick={onCancel}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="dialog-body">
            <div style={{ marginBottom: '8px', color: '#666', fontSize: '12px' }}>
              Select a waveform file to view:
            </div>
            <div style={{ marginBottom: '8px' }}>
              <input
                type="text"
                placeholder="Filter (* wildcard)..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{
                  width: '100%',
                  padding: '5px 8px',
                  border: '1px solid #c0c0c0',
                  borderRadius: '3px',
                  fontSize: '12px',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div className="wave-list" style={{ maxHeight: '150px', overflowY: 'auto', marginBottom: '12px' }}>
              {filteredWaves.length === 0 ? (
                <div style={{ padding: '8px', color: '#999', textAlign: 'center', fontSize: '12px' }}>
                  No matching waveform files
                </div>
              ) : (
                filteredWaves.map((wave) => (
                  <div
                    key={wave.name}
                    className={`wave-item ${selectedWave === wave.name ? 'selected' : ''}`}
                    onClick={() => handleWaveClick(wave.name)}
                    onDoubleClick={() => handleDoubleClick(wave.name)}
                    style={{
                      padding: '6px 10px',
                      border: '1px solid #e0e0e0',
                      borderRadius: '3px',
                      marginBottom: '4px',
                      cursor: 'pointer',
                      backgroundColor: selectedWave === wave.name ? '#e3f2fd' : '#fff',
                      borderColor: selectedWave === wave.name ? '#2196f3' : '#e0e0e0',
                      fontSize: '12px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      lineHeight: '1.4',
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>{wave.name}</span>
                    <span style={{ color: '#888', fontSize: '11px', marginLeft: '10px' }}>
                      {formatBytes(wave.file_size)}
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* Time Range Settings */}
            <div style={{ borderTop: '1px solid #e0e0e0', paddingTop: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', marginBottom: '8px' }}>
                <input
                  type="checkbox"
                  checked={useCustomRange}
                  onChange={(e) => setUseCustomRange(e.target.checked)}
                  style={{ marginRight: '6px' }}
                />
                <span style={{ fontSize: '12px', fontWeight: 500 }}>Custom Time Range</span>
                {isLoadingWaveInfo && (
                  <span style={{ marginLeft: '10px', fontSize: '11px', color: '#666' }}>
                    Loading...
                  </span>
                )}
              </label>
              
              {useCustomRange && (
                <div style={{ paddingLeft: '18px' }}>
                  <div style={{ marginBottom: '8px', fontSize: '11px', color: '#666' }}>
                    Time range in LoD0 units (time_unit). Leave empty to use full range.
                  </div>
                  
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '11px', color: '#666', marginBottom: '2px' }}>
                        Start
                      </label>
                      <input
                        type="number"
                        placeholder="0"
                        value={startTime}
                        onChange={(e) => setStartTime(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '4px 6px',
                          border: '1px solid #c0c0c0',
                          borderRadius: '3px',
                          fontSize: '12px',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '11px', color: '#666', marginBottom: '2px' }}>
                        End
                      </label>
                      <input
                        type="number"
                        placeholder="End"
                        value={endTime}
                        onChange={(e) => setEndTime(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '4px 6px',
                          border: '1px solid #c0c0c0',
                          borderRadius: '3px',
                          fontSize: '12px',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!selectedWave}>
              Select Waveform
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
