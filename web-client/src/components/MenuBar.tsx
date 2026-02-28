import { useState, useRef, useEffect } from 'react';

interface MenuBarProps {
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenKdbList: () => void;
  onOpenWaveList: () => void;
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

export function MenuBar({ connected, onConnect, onDisconnect, onOpenKdbList, onOpenWaveList }: MenuBarProps) {
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
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Copy' },
        { label: 'Paste' },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom In' },
        { label: 'Zoom Out' },
      ],
    },
    {
      label: 'Navigate',
      items: [
        { label: 'Go to Definition' },
        { label: 'Find References' },
      ],
    },
    {
      label: 'Waveform',
      items: [
        { label: 'Add Signal' },
        { label: 'Remove Signal' },
      ],
    },
    {
      label: 'Tools',
      items: [
        { label: 'Settings' },
      ],
    },
    {
      label: 'Help',
      items: [
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
