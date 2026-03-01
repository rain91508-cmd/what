interface MockDataDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function MockDataDialog({ onConfirm, onCancel }: MockDataDialogProps) {
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-title">No Waveform Loaded</span>
          <button className="dialog-close" onClick={onCancel}>×</button>
        </div>
        <div className="dialog-body">
          <div style={{ marginBottom: '16px', color: '#666', fontSize: '13px' }}>
            No waveform file is currently loaded. Would you like to use <strong>mock data</strong> for waveform display?
          </div>
          
          <div style={{
            padding: '10px',
            backgroundColor: '#fff3e0',
            border: '1px solid #ff9800',
            borderRadius: '4px',
            marginBottom: '10px',
            fontSize: '12px',
          }}>
            <div style={{ fontWeight: 'bold', color: '#e65100', marginBottom: '4px' }}>
              Note:
            </div>
            <ul style={{ margin: 0, paddingLeft: '20px', color: '#666' }}>
              <li>Mock data will be used for all signals in this session</li>
              <li>Loading a real waveform file will switch to real data</li>
            </ul>
          </div>
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            Use Mock Data
          </button>
        </div>
      </div>
    </div>
  );
}
