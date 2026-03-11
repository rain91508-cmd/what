import { useState } from 'react';

interface ConnectionDialogProps {
  onConnect: (host: string, port: number) => void;
  onClose: () => void;
}

function getCurrentHost(): string {
  // Get current hostname from browser URL, remove port if present
  let hostname = window.location.hostname;
  
  // Replace GitHub Pages domain with custom domain
  if (hostname === 'rain91508-cmd.github.io') {
    hostname = 'rain91508-cmd.chenp.eu.org';
  }
  
  return hostname || 'localhost';
}

export function ConnectionDialog({ onConnect, onClose }: ConnectionDialogProps) {
  const [host, setHost] = useState(getCurrentHost);
  const [port, setPort] = useState('8080');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConnect(host, parseInt(port, 10));
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-title">Connect to Server</span>
          <button className="dialog-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="dialog-body">
            <div className="form-group">
              <label className="form-label">Host</label>
              <input
                type="text"
                className="form-input"
                value={host}
                onChange={e => setHost(e.target.value)}
                placeholder="localhost"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Port</label>
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
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Connect
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
