import { useState } from 'react';
import { useT } from '../i18n';

interface ConnectionDialogProps {
  onConnect: (host: string, port: number) => void;
  onClose: () => void;
}

function getCurrentHost(): string {
  let hostname = window.location.hostname;

  if (hostname === 'what.chenp.eu.org') {
    hostname = 'rain91508-cmd.chenp.eu.org';
  }

  return hostname || 'localhost';
}

function getDefaultPort(): string {
  const hostname = window.location.hostname;
  if (hostname === 'what.chenp.eu.org') {
    return '443';
  }
  return '8080';
}

export function ConnectionDialog({ onConnect, onClose }: ConnectionDialogProps) {
  const { t } = useT();
  const [host, setHost] = useState(getCurrentHost);
  const [port, setPort] = useState(getDefaultPort);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConnect(host, parseInt(port, 10));
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-title">{t('dialog.connection.title')}</span>
          <button className="dialog-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="dialog-body">
            <div className="form-group">
              <label className="form-label">{t('dialog.connection.host')}</label>
              <input
                type="text"
                className="form-input"
                value={host}
                onChange={e => setHost(e.target.value)}
                placeholder="localhost"
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('dialog.connection.port')}</label>
              <input
                type="number"
                className="form-input"
                value={port}
                onChange={e => setPort(e.target.value)}
                placeholder="8080"
              />
            </div>
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn" onClick={onClose}>
              {t('dialog.cancel')}
            </button>
            <button type="submit" className="btn btn-primary">
              {t('dialog.connect')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
