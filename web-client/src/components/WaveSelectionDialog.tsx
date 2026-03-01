import { useState, useEffect } from 'react';
import { waveManager } from '../modules/wSignal';

interface ServerWaveformInfo {
  name: string;
  file_size: number;
  is_valid: boolean;
}

interface WaveSelectionDialogProps {
  onSelect: (waveName: string) => void;
  onCancel: () => void;
}

export function WaveSelectionDialog({ onSelect, onCancel }: WaveSelectionDialogProps) {
  const [waves, setWaves] = useState<ServerWaveformInfo[]>([]);
  const [selectedWave, setSelectedWave] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    loadWaveList();
  }, []);

  const loadWaveList = async () => {
    try {
      setLoading(true);
      setError(null);
      setWaves([]); // Clear previous list
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedWave) {
      onSelect(selectedWave);
    }
  };

  const handleDoubleClick = (waveName: string) => {
    onSelect(waveName);
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
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-title">Select Waveform</span>
          <button className="dialog-close" onClick={onCancel}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="dialog-body">
            <div style={{ marginBottom: '10px', color: '#666', fontSize: '12px' }}>
              Select a waveform file to view:
            </div>
            <div style={{ marginBottom: '10px' }}>
              <input
                type="text"
                placeholder="Filter (* wildcard)..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  border: '1px solid #c0c0c0',
                  borderRadius: '3px',
                  fontSize: '12px',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div className="wave-list" style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {filteredWaves.length === 0 ? (
                <div style={{ padding: '10px', color: '#999', textAlign: 'center' }}>
                  No matching waveform files
                </div>
              ) : (
                filteredWaves.map((wave) => (
                  <div
                    key={wave.name}
                    className={`wave-item ${selectedWave === wave.name ? 'selected' : ''}`}
                    onClick={() => setSelectedWave(wave.name)}
                    onDoubleClick={() => handleDoubleClick(wave.name)}
                    style={{
                      padding: '10px',
                      border: '1px solid #e0e0e0',
                      borderRadius: '4px',
                      marginBottom: '8px',
                      cursor: 'pointer',
                      backgroundColor: selectedWave === wave.name ? '#e3f2fd' : '#fff',
                      borderColor: selectedWave === wave.name ? '#2196f3' : '#e0e0e0',
                    }}
                  >
                    <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                      {wave.name}
                    </div>
                    <div style={{ fontSize: '11px', color: '#666' }}>
                      Size: {formatBytes(wave.file_size)}
                    </div>
                  </div>
                ))
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
