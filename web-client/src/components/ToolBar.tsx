interface ToolBarProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onSearch: () => void;
  onAddSourceTab?: () => void;
  onAddWaveformTab?: () => void;
}

export function ToolBar({ 
  onZoomIn, 
  onZoomOut, 
  onZoomFit, 
  onSearch,
  onAddSourceTab,
  onAddWaveformTab,
}: ToolBarProps) {
  return (
    <div className="tool-bar">
      <button className="tool-bar-button" title="Zoom In" onClick={onZoomIn}>
        🔍+
      </button>
      <button className="tool-bar-button" title="Zoom Out" onClick={onZoomOut}>
        🔍-
      </button>
      <button className="tool-bar-button" title="Zoom Fit" onClick={onZoomFit}>
        ⬛
      </button>
      <div className="tool-bar-separator"></div>
      <button className="tool-bar-button" title="Search" onClick={onSearch}>
        🔍
      </button>
      <div className="tool-bar-separator"></div>
      <button className="tool-bar-button" title="Add Source Tab" onClick={onAddSourceTab}>
        📄+
      </button>
      <button className="tool-bar-button" title="Add Waveform Tab" onClick={onAddWaveformTab}>
        📊+
      </button>
      <div className="tool-bar-separator"></div>
      <button className="tool-bar-button" title="Previous">
        ◀
      </button>
      <button className="tool-bar-button" title="Next">
        ▶
      </button>
    </div>
  );
}
