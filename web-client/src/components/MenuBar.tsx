interface MenuBarProps {
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function MenuBar({ connected, onConnect, onDisconnect }: MenuBarProps) {
  return (
    <div className="menu-bar">
      <div className="menu-bar-item">File</div>
      <div className="menu-bar-item">Edit</div>
      <div className="menu-bar-item">View</div>
      <div className="menu-bar-item">Navigate</div>
      <div className="menu-bar-item">Waveform</div>
      <div className="menu-bar-item">Tools</div>
      <div className="menu-bar-item">Help</div>
      <div style={{ flex: 1 }}></div>
      <div className="menu-bar-item" onClick={connected ? onDisconnect : onConnect}>
        <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`}></span>
        {connected ? 'Connected' : 'Connect'}
      </div>
    </div>
  );
}
