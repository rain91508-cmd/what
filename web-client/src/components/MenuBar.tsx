import { useState, useRef, useEffect } from 'react';
import { useT, type Language } from '../i18n';

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
  infoText?: string;
  onOpenDebugTool?: () => void;
  onSaveSession?: () => void;
  onRestoreSession?: () => void;
  opfsEnabled?: boolean;
  onToggleOpfs?: () => void;
  memoryCacheEnabled?: boolean;
  onToggleMemoryCache?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomFull?: () => void;
  canZoom?: boolean;
  onHistoryBack?: () => void;
  onHistoryForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onAddBookmark?: () => void;
  onFindDriver?: () => void;
  onFindDefinition?: () => void;
  hasSelectedWord?: boolean;
  onAddSignal?: () => void;
  onRemoveSignal?: () => void;
  canAddSignal?: boolean;
  canRemoveSignal?: boolean;
  onLanguageChange?: (lang: Language) => void;
}

interface MenuItem {
  label: string;
  onClick?: () => void;
  separator?: boolean;
  disabled?: boolean;
  submenu?: MenuItem[];
}

interface Menu {
  label: string;
  items: MenuItem[];
}

export function MenuBar({
  connected, onConnect, onDisconnect, onOpenKdbList, onOpenWaveList, onCloseKdb, onCloseWave, hasKdbLoaded, hasWaveLoaded, infoText,
  onOpenDebugTool, onSaveSession, onRestoreSession, opfsEnabled, onToggleOpfs, memoryCacheEnabled, onToggleMemoryCache,
  onZoomIn, onZoomOut, onZoomFull, canZoom,
  onHistoryBack, onHistoryForward, canGoBack, canGoForward, onAddBookmark, onFindDriver, onFindDefinition, hasSelectedWord,
  onAddSignal, onRemoveSignal, canAddSignal, canRemoveSignal,
  onLanguageChange
}: MenuBarProps) {
  const { t, language, languages, setLanguage } = useT();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
        setOpenSubmenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLanguageChange = (lang: Language) => {
    setLanguage(lang);
    onLanguageChange?.(lang);
    setOpenMenu(null);
    setOpenSubmenu(null);
  };

  const languageSubmenu: MenuItem[] = languages.map(lang => ({
    label: lang.nativeName,
    onClick: () => handleLanguageChange(lang.code),
  }));

  const menus: Menu[] = [
    {
      label: t('menu.file'),
      items: [
        { label: connected ? t('menuItems.disconnect') : t('menuItems.connect'), onClick: connected ? onDisconnect : onConnect },
        { separator: true, label: '' },
        { label: t('menuItems.openKdb'), onClick: onOpenKdbList, disabled: !connected },
        { label: t('menuItems.openWaveform'), onClick: onOpenWaveList, disabled: !connected },
        { separator: true, label: '' },
        { label: t('menuItems.closeKdb'), onClick: onCloseKdb, disabled: !hasKdbLoaded },
        { label: t('menuItems.closeWaveform'), onClick: onCloseWave, disabled: !hasWaveLoaded },
        { separator: true, label: '' },
        { label: t('menuItems.saveSession'), onClick: onSaveSession },
        { label: t('menuItems.restoreSession'), onClick: onRestoreSession },
      ],
    },
    {
      label: t('menu.view'),
      items: [
        { label: t('menuItems.zoomIn'), onClick: onZoomIn, disabled: !canZoom },
        { label: t('menuItems.zoomOut'), onClick: onZoomOut, disabled: !canZoom },
        { label: t('menuItems.zoomFull'), onClick: onZoomFull, disabled: !canZoom },
        { separator: true, label: '' },
        { label: t('menuItems.language'), submenu: languageSubmenu },
      ],
    },
    {
      label: t('menu.navigate'),
      items: [
        { label: t('menuItems.historyBack'), onClick: onHistoryBack, disabled: !canGoBack },
        { label: t('menuItems.historyForward'), onClick: onHistoryForward, disabled: !canGoForward },
        { separator: true, label: '' },
        { label: t('menuItems.addBookmark'), onClick: onAddBookmark },
        { separator: true, label: '' },
        { label: t('menuItems.findDriver'), onClick: onFindDriver, disabled: !hasSelectedWord },
        { label: t('menuItems.findDefinition'), onClick: onFindDefinition, disabled: !hasSelectedWord },
      ],
    },
    {
      label: t('menu.waveform'),
      items: [
        { label: t('menuItems.addSignal'), onClick: onAddSignal, disabled: !canAddSignal },
        { label: t('menuItems.removeSignal'), onClick: onRemoveSignal, disabled: !canRemoveSignal },
        { separator: true, label: '' },
        {
          label: opfsEnabled ? `✓ ${t('menuItems.opfsCache')}` : `  ${t('menuItems.opfsCache')}`,
          onClick: onToggleOpfs,
        },
        {
          label: memoryCacheEnabled ? `✓ ${t('menuItems.memoryCache')}` : `  ${t('menuItems.memoryCache')}`,
          onClick: onToggleMemoryCache,
        },
      ],
    },
    {
      label: t('menu.help'),
      items: [
        { label: t('menuItems.kdbDebugTool'), onClick: onOpenDebugTool },
        { separator: true, label: '' },
        { label: t('menuItems.about'), onClick: () => window.open('https://github.com/rain91508-cmd/what', '_blank') },
      ],
    },
  ];

  const handleMenuClick = (menuLabel: string) => {
    setOpenMenu(openMenu === menuLabel ? null : menuLabel);
    setOpenSubmenu(null);
  };

  const handleMenuItemClick = (item: MenuItem) => {
    if (item.submenu) {
      return;
    }
    if (item.onClick && !item.disabled) {
      item.onClick();
    }
    setOpenMenu(null);
    setOpenSubmenu(null);
  };

  const handleSubmenuItemClick = (item: MenuItem) => {
    if (item.onClick && !item.disabled) {
      item.onClick();
    }
    setOpenMenu(null);
    setOpenSubmenu(null);
  };

  const renderMenuItem = (item: MenuItem, index: number, depth: number = 0) => {
    const hasSubmenu = item.submenu && item.submenu.length > 0;
    const isSubmenuOpen = openSubmenu === `${item.label}-${index}`;

    if (item.separator) {
      return (
        <div
          key={`sep-${index}`}
          style={{
            height: '1px',
            backgroundColor: '#e0e0e0',
            margin: '4px 0'
          }}
        />
      );
    }

    return (
      <div
        key={`item-${index}`}
        style={{ position: 'relative' }}
        onMouseEnter={() => hasSubmenu && setOpenSubmenu(`${item.label}-${index}`)}
        onMouseLeave={() => hasSubmenu && setOpenSubmenu(null)}
      >
        <div
          className={`menu-dropdown-item ${item.disabled ? 'disabled' : ''}`}
          onClick={() => handleMenuItemClick(item)}
          style={{
            padding: '6px 24px',
            cursor: item.disabled ? 'default' : 'pointer',
            color: item.disabled ? '#999' : '#333',
            whiteSpace: 'nowrap',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
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
          <span>{item.label}</span>
          {hasSubmenu && <span style={{ marginLeft: '16px' }}>▶</span>}
        </div>
        {hasSubmenu && isSubmenuOpen && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: '100%',
              backgroundColor: '#fff',
              border: '1px solid #c0c0c0',
              boxShadow: '2px 2px 4px rgba(0,0,0,0.15)',
              zIndex: 1001,
              minWidth: '120px',
            }}
          >
            {item.submenu!.map((subItem, subIndex) => (
              <div key={`sub-${subIndex}`}>
                {subItem.separator ? (
                  <div
                    style={{
                      height: '1px',
                      backgroundColor: '#e0e0e0',
                      margin: '4px 0'
                    }}
                  />
                ) : (
                  <div
                    className={`menu-dropdown-item ${subItem.disabled ? 'disabled' : ''}`}
                    onClick={() => handleSubmenuItemClick(subItem)}
                    style={{
                      padding: '6px 16px',
                      cursor: subItem.disabled ? 'default' : 'pointer',
                      color: subItem.disabled ? '#999' : '#333',
                      whiteSpace: 'nowrap',
                      backgroundColor: language === (subItem.onClick as unknown as Language) ? '#e3f2fd' : 'transparent',
                    }}
                    onMouseEnter={(e) => {
                      if (!subItem.disabled) {
                        (e.target as HTMLElement).style.backgroundColor = '#e3f2fd';
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.target as HTMLElement).style.backgroundColor = language === (subItem.onClick as unknown as Language) ? '#e3f2fd' : 'transparent';
                    }}
                  >
                    {language === languages.find(l => l.nativeName === subItem.label)?.code ? '✓ ' : ''}{subItem.label}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
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
              {menu.items.map((item, index) => renderMenuItem(item, index))}
            </div>
          )}
        </div>
      ))}
      <div style={{ flex: 1 }}></div>
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
        {connected ? t('status.connected') : t('status.disconnected')}
      </div>
    </div>
  );
}
