import { useState, useRef, useEffect } from 'react';

interface MenuBarProps {
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenKdbList: () => void;
  onOpenWaveList: () => void;
  onCloseKdb: () => void;
  onCloseWave: () => void;
  hasKdbLoaded: boolean;
  hasWaveLoaded: boolean;
  infoText?: string;  // Info text to display (full hierarchy name)
  onOpenDebugTool?: () => void;  // Open KDB debug tool
  onSaveSession?: () => void;    // Save session
  onRestoreSession?: () => void; // Restore session
  opfsEnabled?: boolean;         // OPFS cache enabled state
  onToggleOpfs?: () => void;     // Toggle OPFS cache
  memoryCacheEnabled?: boolean;  // Memory LRU cache enabled state
  onToggleMemoryCache?: () => void; // Toggle Memory LRU cache
  // View menu
  onZoomIn?: () => void;         // Zoom in
  onZoomOut?: () => void;        // Zoom out
  onZoomFull?: () => void;       // Zoom full
  canZoom?: boolean;             // Whether zoom is available
  // Navigate menu
  onHistoryBack?: () => void;    // History back
  onHistoryForward?: () => void; // History forward
  canGoBack?: boolean;           // Whether can go back in history
  canGoForward?: boolean;        // Whether can go forward in history
  onAddBookmark?: () => void;    // Add bookmark
  onFindDriver?: () => void;     // Find driver (for selected word)
  onFindDefinition?: () => void; // Find definition (for selected word)
  hasSelectedWord?: boolean;     // Whether a word is selected
  // Waveform menu
  onAddSignal?: () => void;      // Add signal to waveform
  onRemoveSignal?: () => void;   // Remove signal from waveform
  canAddSignal?: boolean;        // Whether can add signal
  canRemoveSignal?: boolean;     // Whether can remove signal
}

interface MenuItem {
  label: string;
  onClick?: () => void;
  separator?: boolean;
  disabled?: boolean;
}

interface Menu {
  label: string;
  items: MenuItem[];
}

export function MenuBar({
  connected, onConnect, onDisconnect, onOpenKdbList, onOpenWaveList, onCloseKdb, onCloseWave, hasKdbLoaded, hasWaveLoaded, infoText,
  onOpenDebugTool, onSaveSession, onRestoreSession, opfsEnabled, onToggleOpfs, memoryCacheEnabled, onToggleMemoryCache,
  // View menu
  onZoomIn, onZoomOut, onZoomFull, canZoom,
  // Navigate menu
  onHistoryBack, onHistoryForward, canGoBack, canGoForward, onAddBookmark, onFindDriver, onFindDefinition, hasSelectedWord,
  // Waveform menu
  onAddSignal, onRemoveSignal, canAddSignal, canRemoveSignal
}: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        { label: connected ? 'Disconnect' : 'Connect...', onClick: connected ? onDisconnect : onConnect },
        { separator: true, label: '' },
        { label: 'Open KDB...', onClick: onOpenKdbList, disabled: !connected },
        { label: 'Open Waveform...', onClick: onOpenWaveList, disabled: !connected },
        { separator: true, label: '' },
        { label: 'Close KDB', onClick: onCloseKdb, disabled: !hasKdbLoaded },
        { label: 'Close Waveform', onClick: onCloseWave, disabled: !hasWaveLoaded },
        { separator: true, label: '' },
        { label: 'Save Session...', onClick: onSaveSession },
        { label: 'Restore Session...', onClick: onRestoreSession },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom In', onClick: onZoomIn, disabled: !canZoom },
        { label: 'Zoom Out', onClick: onZoomOut, disabled: !canZoom },
        { label: 'Zoom Full', onClick: onZoomFull, disabled: !canZoom },
      ],
    },
    {
      label: 'Navigate',
      items: [
        { label: 'History Back', onClick: onHistoryBack, disabled: !canGoBack },
        { label: 'History Forward', onClick: onHistoryForward, disabled: !canGoForward },
        { separator: true, label: '' },
        { label: 'Add Bookmark', onClick: onAddBookmark },
        { separator: true, label: '' },
        { label: 'Find Driver', onClick: onFindDriver, disabled: !hasSelectedWord },
        { label: 'Find Definition', onClick: onFindDefinition, disabled: !hasSelectedWord },
      ],
    },
    {
      label: 'Waveform',
      items: [
        { label: 'Add Signal', onClick: onAddSignal, disabled: !canAddSignal },
        { label: 'Remove Signal', onClick: onRemoveSignal, disabled: !canRemoveSignal },
        { separator: true, label: '' },
        {
          label: opfsEnabled ? '✓ OPFS Cache' : '  OPFS Cache',
          onClick: onToggleOpfs,
        },
        {
          label: memoryCacheEnabled ? '✓ Memory Cache' : '  Memory Cache',
          onClick: onToggleMemoryCache,
        },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'KDB Debug Tool', onClick: onOpenDebugTool },
        { separator: true, label: '' },
        { label: 'About' },
      ],
    },
  ];

  const handleMenuClick = (menuLabel: string) => {
    setOpenMenu(openMenu === menuLabel ? null : menuLabel);
  };

  const handleMenuItemClick = (item: MenuItem) => {
    if (item.onClick && !item.disabled) {
      item.onClick();
    }
    setOpenMenu(null);
  };

  return (
    <div className="menu-bar" ref={menuBarRef}>
      {menus.map(menu => (
        <div 
          key={menu.label} 
          className="menu-bar-item-container"
          style={{ position: 'relative' }}
        >
          <div 
            className={`menu-bar-item ${openMenu === menu.label ? 'active' : ''}`}
            onClick={() => handleMenuClick(menu.label)}
            onMouseEnter={() => openMenu && setOpenMenu(menu.label)}
          >
            {menu.label}
          </div>
          {openMenu === menu.label && (
            <div 
              className="menu-dropdown"
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                backgroundColor: '#fff',
                border: '1px solid #c0c0c0',
                boxShadow: '2px 2px 4px rgba(0,0,0,0.15)',
                zIndex: 1000,
                minWidth: '150px',
              }}
            >
              {menu.items.map((item, index) => 
                item.separator ? (
                  <div 
                    key={index}
                    style={{ 
                      height: '1px', 
                      backgroundColor: '#e0e0e0', 
                      margin: '4px 0' 
                    }} 
                  />
                ) : (
                  <div
                    key={index}
                    className={`menu-dropdown-item ${item.disabled ? 'disabled' : ''}`}
                    onClick={() => handleMenuItemClick(item)}
                    style={{
                      padding: '6px 24px',
                      cursor: item.disabled ? 'default' : 'pointer',
                      color: item.disabled ? '#999' : '#333',
                      whiteSpace: 'nowrap',
                    }}
                    onMouseEnter={(e) => {
                      if (!item.disabled) {
                        (e.target as HTMLElement).style.backgroundColor = '#e3f2fd';
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.target as HTMLElement).style.backgroundColor = 'transparent';
                    }}
                  >
                    {item.label}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      ))}
      <div style={{ flex: 1 }}></div>
      {/* Info text display area */}
      {infoText && (
        <div
          className="menu-bar-info"
          style={{
            padding: '0 16px',
            fontSize: '12px',
            color: '#666',
            maxWidth: '600px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            borderLeft: '1px solid #e0e0e0',
            marginRight: '8px',
          }}
          title={infoText}
        >
          {infoText}
        </div>
      )}
      <div 
        className="menu-bar-item"
        style={{ 
          color: connected ? '#4caf50' : '#f44336',
          cursor: 'pointer',
        }}
        onClick={connected ? onDisconnect : onConnect}
      >
        <span style={{ 
          display: 'inline-block',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: connected ? '#4caf50' : '#f44336',
          marginRight: '6px',
        }}></span>
        {connected ? 'Connected' : 'Disconnected'}
      </div>
    </div>
  );
}
