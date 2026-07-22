import { useState, useEffect, type FormEvent } from 'react';
import { useT } from '../i18n';

interface OpenKdbUrlDialogProps {
  onConfirm: (url: string) => void;
  onCancel: () => void;
}

export function OpenKdbUrlDialog({ onConfirm, onCancel }: OpenKdbUrlDialogProps) {
  const { t } = useT();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl('');
    setError(null);
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setError(t('dialog.kdbUrl.empty'));
      return;
    }
    try {
      // Validate it is at least a plausible URL.
      // eslint-disable-next-line no-new
      new URL(trimmed);
    } catch {
      setError(t('dialog.kdbUrl.invalid'));
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-title">{t('dialog.kdbUrl.title')}</span>
          <button className="dialog-close" onClick={onCancel}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="dialog-body">
            <div style={{ marginBottom: '10px', color: '#666', fontSize: '12px' }}>
              {t('dialog.kdbUrl.prompt')}
            </div>
            <input
              type="text"
              placeholder={t('dialog.kdbUrl.placeholder')}
              value={url}
              autoFocus
              onChange={(e) => {
                setUrl(e.target.value);
                if (error) setError(null);
              }}
              style={{
                width: '100%',
                padding: '6px 8px',
                border: '1px solid #c0c0c0',
                borderRadius: '3px',
                fontSize: '12px',
                boxSizing: 'border-box',
              }}
            />
            {error && (
              <div style={{ color: '#d32f2f', padding: '8px 0 0', fontSize: '12px' }}>
                {error}
              </div>
            )}
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn" onClick={onCancel}>
              {t('dialog.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!url.trim()}>
              {t('dialog.kdbUrl.load')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
