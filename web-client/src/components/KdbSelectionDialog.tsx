import { useState, useEffect } from 'react';
import { apiService } from '../services/api';
import { useT } from '../i18n';

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
  const { t } = useT();
  const [kdbs, setKdbs] = useState<KdbInfo[]>([]);
  const [selectedKdb, setSelectedKdb] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    loadKdbList();
  }, []);

  const loadKdbList = async () => {
    try {
      setLoading(true);
      setError(null);
      setKdbs([]);
      setSelectedKdb('');

      const response = await apiService.getKdbList();
      if (response.status === 'success' && response.data && response.data.kdbs) {
        const validKdbs = response.data.kdbs.filter((kdb: KdbInfo) => kdb.is_valid);
        setKdbs(validKdbs);
        if (validKdbs.length > 0) {
          setSelectedKdb(validKdbs[0].name);
        }
      } else {
        setError(t('dialog.kdbSelection.error'));
        setKdbs([]);
      }
    } catch (err) {
      setError(t('dialog.kdbSelection.error'));
      setKdbs([]);
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

  const filteredKdbs = kdbs.filter(kdb => {
    if (!filter.trim()) return true;
    return wildcardMatch(filter, kdb.name);
  });

  const handleSelect = (kdbName: string) => {
    onSelect(kdbName);
    onCancel();
  };

  const handleDoubleClick = (kdbName: string) => {
    onSelect(kdbName);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedKdb) {
      handleSelect(selectedKdb);
    }
  };

  if (loading) {
    return (
      <div className="dialog-overlay" onClick={onCancel}>
        <div className="dialog" onClick={e => e.stopPropagation()}>
          <div className="dialog-header">
            <span className="dialog-title">{t('dialog.kdbSelection.title')}</span>
          </div>
          <div className="dialog-body">
            <div style={{ textAlign: 'center', padding: '20px' }}>{t('dialog.kdbSelection.loading')}</div>
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
            <span className="dialog-title">{t('dialog.kdbSelection.title')}</span>
            <button className="dialog-close" onClick={onCancel}>×</button>
          </div>
          <div className="dialog-body">
            <div style={{ color: '#d32f2f', padding: '10px' }}>{error}</div>
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={onCancel}>{t('dialog.cancel')}</button>
            <button className="btn btn-primary" onClick={loadKdbList}>{t('dialog.retry')}</button>
          </div>
        </div>
      </div>
    );
  }

  if (kdbs.length === 0) {
    return (
      <div className="dialog-overlay" onClick={onCancel}>
        <div className="dialog" onClick={e => e.stopPropagation()}>
          <div className="dialog-header">
            <span className="dialog-title">{t('dialog.kdbSelection.title')}</span>
            <button className="dialog-close" onClick={onCancel}>×</button>
          </div>
          <div className="dialog-body">
            <div style={{ padding: '10px' }}>{t('dialog.kdbSelection.empty')}</div>
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={onCancel}>{t('dialog.cancel')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-title">{t('dialog.kdbSelection.title')}</span>
          <button className="dialog-close" onClick={onCancel}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="dialog-body">
            <div style={{ marginBottom: '10px', color: '#666', fontSize: '12px' }}>
              {t('dialog.kdbSelection.selectPrompt')}
            </div>
            <div style={{ marginBottom: '10px' }}>
              <input
                type="text"
                placeholder={t('dialog.kdbSelection.filterPlaceholder')}
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
            <div className="kdb-list" style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {filteredKdbs.length === 0 ? (
                <div style={{ padding: '10px', color: '#999', textAlign: 'center' }}>
                  {t('dialog.kdbSelection.noMatching')}
                </div>
              ) : (
                filteredKdbs.map((kdb) => (
                  <div
                    key={kdb.name}
                    className={`kdb-item ${selectedKdb === kdb.name ? 'selected' : ''}`}
                    onClick={() => setSelectedKdb(kdb.name)}
                    onDoubleClick={() => handleDoubleClick(kdb.name)}
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
                      {t('dialog.kdbSelection.size')}: {formatBytes(kdb.file_size)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn" onClick={onCancel}>
              {t('dialog.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!selectedKdb}>
              {t('dialog.downloadAndLoad')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
