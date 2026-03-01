interface FileChangeDialogProps {
  kdbChanged: boolean;
  waveChanged: boolean;
  kdbName?: string | null;
  waveName?: string | null;
  onReloadKdb: () => void;
  onReloadWave: () => void;
  onReloadBoth: () => void;
  onCancel: () => void;
}

export function FileChangeDialog({
  kdbChanged,
  waveChanged,
  kdbName,
  waveName,
  onReloadKdb,
  onReloadWave,
  onReloadBoth,
  onCancel,
}: FileChangeDialogProps) {
  const hasBothChanged = kdbChanged && waveChanged;
  
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-title">File Changes Detected</span>
          <button className="dialog-close" onClick={onCancel}>×</button>
        </div>
        <div className="dialog-body">
          <div style={{ marginBottom: '16px', color: '#666', fontSize: '13px' }}>
            The following files have changed on the server:
          </div>
          
          {kdbChanged && (
            <div style={{
              padding: '10px',
              backgroundColor: '#fff3e0',
              border: '1px solid #ff9800',
              borderRadius: '4px',
              marginBottom: '10px',
            }}>
              <div style={{ fontWeight: 'bold', color: '#e65100' }}>
                ⚠️ KDB Changed
              </div>
              <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                {kdbName || 'Current KDB'}
              </div>
            </div>
          )}
          
          {waveChanged && (
            <div style={{
              padding: '10px',
              backgroundColor: '#e3f2fd',
              border: '1px solid #2196f3',
              borderRadius: '4px',
              marginBottom: '10px',
            }}>
              <div style={{ fontWeight: 'bold', color: '#1565c0' }}>
                ⚠️ Waveform Changed
              </div>
              <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                {waveName || 'Current Waveform'}
              </div>
            </div>
          )}
          
          <div style={{ marginTop: '16px', color: '#666', fontSize: '12px' }}>
            Would you like to reload the changed files?
          </div>
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          
          {hasBothChanged ? (
            <button className="btn btn-primary" onClick={onReloadBoth}>
              Reload Both
            </button>
          ) : (
            <>
              {kdbChanged && (
                <button className="btn btn-primary" onClick={onReloadKdb}>
                  Reload KDB
                </button>
              )}
              {waveChanged && (
                <button className="btn btn-primary" onClick={onReloadWave}>
                  Reload Waveform
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
