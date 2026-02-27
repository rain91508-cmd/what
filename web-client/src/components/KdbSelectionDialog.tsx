import { useState, useEffect } from 'react';
import { apiService } from '../services/api';

interface KdbInfo {
  name: string;
  file_size: number;
  is_valid: boolean;
}

interface KdbSelectionDialogProps {
  onSelect: (kdbName: string) => void;
  onCancel: () => void;
}

export function KdbSelectionDialog({ onSelect, onCancel }: KdbSelectionDialogProps) {
  const [kdbs, setKdbs] = useState<KdbInfo[]>([]);
  const [selectedKdb, setSelectedKdb] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadKdbList();
  }, []);

  const loadKdbList = async () => {
    try {
      setLoading(true);
      const response = await apiService.getKdbList();
      if (response.status === 'success' && response.data && response.data.kdbs) {
        // 只显示有效的 KDB
        const validKdbs = response.data.kdbs.filter((kdb: KdbInfo) => kdb.is_valid);
        setKdbs(validKdbs);
        if (validKdbs.length > 0) {
          setSelectedKdb(validKdbs[0].name);
        }
      } else {
        setError('Failed to load KDB list');
      }
    } catch (err) {
      setError('Error loading KDB list');
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedKdb) {
      onSelect(selectedKdb);
    }
  };

  if (loading) {
    return (
      <div className="dialog-overlay">
        <div className="dialog">
          <div className="dialog-header">
            <span className="dialog-title">Select Knowledge Base</span>
          </div>
          <div className="dialog-body">
            <div style={{ textAlign: 'center', padding: '20px' }}>Loading KDB list...</div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dialog-overlay">
        <div className="dialog">
          <div className="dialog-header">
            <span className="dialog-title">Select Knowledge Base</span>
            <button className="dialog-close" onClick={onCancel}>×</button>
          </div>
          <div className="dialog-body">
            <div style={{ color: '#d32f2f', padding: '10px' }}>{error}</div>
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={onCancel}>Cancel</button>
            <button className="btn btn-primary" onClick={loadKdbList}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  if (kdbs.length === 0) {
    return (
      <div className="dialog-overlay">
        <div className="dialog">
          <div className="dialog-header">
            <span className="dialog-title">Select Knowledge Base</span>
            <button className="dialog-close" onClick={onCancel}>×</button>
          </div>
          <div className="dialog-body">
            <div style={{ padding: '10px' }}>No valid KDB files found on server.</div>
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
          <span className="dialog-title">Select Knowledge Base</span>
          <button className="dialog-close" onClick={onCancel}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="dialog-body">
            <div style={{ marginBottom: '10px', color: '#666', fontSize: '12px' }}>
              Select a knowledge base to download and load:
            </div>
            <div className="kdb-list" style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {kdbs.map((kdb) => (
                <div
                  key={kdb.name}
                  className={`kdb-item ${selectedKdb === kdb.name ? 'selected' : ''}`}
                  onClick={() => setSelectedKdb(kdb.name)}
                  style={{
                    padding: '10px',
                    border: '1px solid #e0e0e0',
                    borderRadius: '4px',
                    marginBottom: '8px',
                    cursor: 'pointer',
                    backgroundColor: selectedKdb === kdb.name ? '#e3f2fd' : '#fff',
                    borderColor: selectedKdb === kdb.name ? '#2196f3' : '#e0e0e0',
                  }}
                >
                  <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                    {kdb.name}
                  </div>
                  <div style={{ fontSize: '11px', color: '#666' }}>
                    Size: {formatBytes(kdb.file_size)}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!selectedKdb}>
              Download & Load
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
