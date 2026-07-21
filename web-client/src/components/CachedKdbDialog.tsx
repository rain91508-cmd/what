import { useState, useEffect } from 'react';
import { useT } from '../i18n';
import { indexedDBManager } from '../core/storage/indexedDB';

interface CachedKdbInfo {
  id: string;
  header: { version: string; projectName: string; createdAt: string };
  timestamp: number;
}

interface CachedKdbDialogProps {
  onSelect: (kdbId: string) => void;
  onCancel: () => void;
}

export function CachedKdbDialog({ onSelect, onCancel }: CachedKdbDialogProps) {
  const { t } = useT();
  const [kdbs, setKdbs] = useState<CachedKdbInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    loadCachedKdbList();
  }, []);

  const loadCachedKdbList = async () => {
    try {
      setLoading(true);
      setError(null);
      setKdbs([]);
      setSelectedId('');

      await indexedDBManager.initialize();
      const list = await indexedDBManager.listKnowledgeBases();
      setKdbs(list);
      if (list.length > 0) {
        setSelectedId(list[0].id);
      }
    } catch (err) {
      console.error('[CachedKdbDialog] Failed to list cached KDBs:', err);
      setError(t('dialog.cachedKdb.error'));
      setKdbs([]);
    } finally {
      setLoading(false);
    }
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

  // Derive a readable title for a cached KDB. Prefers the recorded design title
  // (header.projectName); if that is empty or just echoes the id, fall back to
  // the last path segment of the id (e.g. "c910" from ".../c910.kdb") so the
  // list is never just a raw URL.
  const displayName = (kdb: CachedKdbInfo): string => {
    const p = kdb.header?.projectName?.trim();
    if (p && p !== kdb.id) return p;
    const seg = kdb.id.split(/[/\\]/).pop() || kdb.id;
    return seg.replace(/\.(kdb|bin)$/i, '') || kdb.id;
  };

  const filteredKdbs = kdbs.filter(kdb => {
    if (!filter.trim()) return true;
    const haystack = `${displayName(kdb)} ${kdb.header.projectName || ''} ${kdb.id}`;
    return wildcardMatch(filter, haystack);
  });

  const handleSelect = (kdbId: string) => {
    onSelect(kdbId);
    onCancel();
  };

  const handleDoubleClick = (kdbId: string) => {
    onSelect(kdbId);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedId) {
      handleSelect(selectedId);
    }
  };

  const formatTime = (ts: number): string => {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return '';
    }
  };

  if (loading) {
    return (
      <div className="dialog-overlay" onClick={onCancel}>
        <div className="dialog" onClick={e => e.stopPropagation()}>
          <div className="dialog-header">
            <span className="dialog-title">{t('dialog.cachedKdb.title')}</span>
          </div>
          <div className="dialog-body">
            <div style={{ textAlign: 'center', padding: '20px' }}>{t('dialog.cachedKdb.loading')}</div>
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
            <span className="dialog-title">{t('dialog.cachedKdb.title')}</span>
            <button className="dialog-close" onClick={onCancel}>×</button>
          </div>
          <div className="dialog-body">
            <div style={{ color: '#d32f2f', padding: '10px' }}>{error}</div>
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={onCancel}>{t('dialog.cancel')}</button>
            <button className="btn btn-primary" onClick={loadCachedKdbList}>{t('dialog.retry')}</button>
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
            <span className="dialog-title">{t('dialog.cachedKdb.title')}</span>
            <button className="dialog-close" onClick={onCancel}>×</button>
          </div>
          <div className="dialog-body">
            <div style={{ padding: '10px' }}>{t('dialog.cachedKdb.empty')}</div>
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
          <span className="dialog-title">{t('dialog.cachedKdb.title')}</span>
          <button className="dialog-close" onClick={onCancel}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="dialog-body">
            <div style={{ marginBottom: '10px', color: '#666', fontSize: '12px' }}>
              {t('dialog.cachedKdb.selectPrompt')}
            </div>
            <div style={{ marginBottom: '10px' }}>
              <input
                type="text"
                placeholder={t('dialog.cachedKdb.filterPlaceholder')}
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
                  {t('dialog.cachedKdb.noMatching')}
                </div>
              ) : (
                filteredKdbs.map((kdb) => (
                  <div
                    key={kdb.id}
                    className={`kdb-item ${selectedId === kdb.id ? 'selected' : ''}`}
                    onClick={() => setSelectedId(kdb.id)}
                    onDoubleClick={() => handleDoubleClick(kdb.id)}
                    style={{
                      padding: '10px',
                      border: '1px solid #e0e0e0',
                      borderRadius: '4px',
                      marginBottom: '8px',
                      cursor: 'pointer',
                      backgroundColor: selectedId === kdb.id ? '#e3f2fd' : '#fff',
                      borderColor: selectedId === kdb.id ? '#2196f3' : '#e0e0e0',
                    }}
                  >
                    <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                      {displayName(kdb)}
                    </div>
                    <div style={{ fontSize: '11px', color: '#666' }}>
                      {kdb.id}
                    </div>
                    {kdb.timestamp > 0 && (
                      <div style={{ fontSize: '11px', color: '#999' }}>
                        {formatTime(kdb.timestamp)}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn" onClick={onCancel}>
              {t('dialog.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!selectedId}>
              {t('dialog.cachedKdb.open')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
