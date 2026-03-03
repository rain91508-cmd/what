import { useRef, useEffect, useState } from 'react';
import { bookmarkManager, type Bookmark } from '../types/bookmark';
import { driverManager } from '../modules/knowledge/driverManager';
import { kdbManager } from '../modules/knowledge/kdbManager';
import type { DriverGroup, DriverEntry } from '../types/driver';

interface MessageWindowProps {
  messages: string[];
  onBookmarkClick?: (bookmark: Bookmark) => void;
  onDriverClick?: (driver: {
    signalGlobalId: number;
    line: number;
    fileId?: number;
  }) => void;
}

// Component to display file name from module index or fileId
function FileNameCell({ moduleIndex, fileId, width }: { moduleIndex: number; fileId?: number; width: number }) {
  const [fileName, setFileName] = useState<string>('');
  
  useEffect(() => {
    const loadFileName = async () => {
      let targetFileId: number | null = null;
      
      if (moduleIndex === 0 && fileId) {
        targetFileId = fileId;
      } else if (moduleIndex > 0) {
        targetFileId = await kdbManager.getModuleFileId(moduleIndex);
      }
      
      if (targetFileId) {
        const fileInfo = await kdbManager.getFileInfo(targetFileId);
        if (fileInfo) {
          setFileName(fileInfo.fullName);
        }
      }
    };
    loadFileName();
  }, [moduleIndex, fileId]);
  
  return (
    <div
      style={{ 
        width, 
        minWidth: 50, 
        paddingRight: '4px', 
        color: '#666',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'right',
        direction: 'rtl',
      }}
      title={fileName}
    >
      {fileName}
    </div>
  );
}

// Component to display driver file name
function DriverFileNameCell({ fileId, width }: { fileId?: number; width: number }) {
  const [fileName, setFileName] = useState<string>('');
  
  useEffect(() => {
    const loadFileName = async () => {
      if (!fileId) return;
      const fileInfo = await kdbManager.getFileInfo(fileId);
      if (fileInfo) {
        setFileName(fileInfo.fullName);
      }
    };
    loadFileName();
  }, [fileId]);
  
  return (
    <div
      style={{ 
        width, 
        minWidth: 50, 
        paddingRight: '4px', 
        color: '#666',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'right',
        direction: 'rtl',
      }}
      title={fileName}
    >
      {fileName}
    </div>
  );
}

type TabType = 'messages' | 'bookmarks' | 'drivers';

// Default column widths for bookmarks
const DEFAULT_BOOKMARK_COL_WIDTHS = {
  name: 80,
  file: 150,
  line: 60,
  content: 300,
};

// Default column widths for drivers
const DEFAULT_DRIVER_COL_WIDTHS = {
  signal: 200,
  file: 150,
  line: 60,
};

export function MessageWindow({ messages, onBookmarkClick, onDriverClick }: MessageWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<TabType>('messages');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [driverGroups, setDriverGroups] = useState<DriverGroup[]>([]);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  
  // Column widths state
  const [bookmarkColWidths, setBookmarkColWidths] = useState(DEFAULT_BOOKMARK_COL_WIDTHS);
  const [driverColWidths, setDriverColWidths] = useState(DEFAULT_DRIVER_COL_WIDTHS);
  const [resizing, setResizing] = useState<{ tab: TabType; col: string } | null>(null);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // Subscribe to bookmark changes
  useEffect(() => {
    const unsubscribe = bookmarkManager.subscribe(() => {
      setBookmarks(bookmarkManager.getBookmarks());
    });
    setBookmarks(bookmarkManager.getBookmarks());
    return unsubscribe;
  }, []);

  // Subscribe to driver changes
  useEffect(() => {
    const unsubscribe = driverManager.subscribe(() => {
      setDriverGroups(driverManager.getDriverGroups());
    });
    setDriverGroups(driverManager.getDriverGroups());
    return unsubscribe;
  }, []);

  // Auto scroll to bottom when new messages arrive (only in messages tab)
  useEffect(() => {
    if (activeTab === 'messages' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeTab]);

  // Resize handlers
  const handleResizeStart = (e: React.MouseEvent, tab: TabType, col: string) => {
    e.preventDefault();
    setResizing({ tab, col });
    resizeStartX.current = e.clientX;
    const widths = tab === 'drivers' ? driverColWidths : bookmarkColWidths;
    resizeStartWidth.current = widths[col as keyof typeof widths] || 100;
  };

  const handleResizeMove = (e: MouseEvent) => {
    if (!resizing) return;
    const delta = e.clientX - resizeStartX.current;
    const newWidth = Math.max(50, resizeStartWidth.current + delta);
    
    if (resizing.tab === 'drivers') {
      setDriverColWidths(prev => ({ ...prev, [resizing.col]: newWidth }));
    } else {
      setBookmarkColWidths(prev => ({ ...prev, [resizing.col]: newWidth }));
    }
  };

  const handleResizeEnd = () => {
    setResizing(null);
  };

  useEffect(() => {
    if (resizing) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
      return () => {
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleResizeEnd);
      };
    }
  }, [resizing]);

  // Bookmark handlers
  const handleDeleteBookmark = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    bookmarkManager.deleteBookmark(id);
  };

  const handleStartEditName = (e: React.MouseEvent, bookmark: Bookmark) => {
    e.stopPropagation();
    setEditingName(bookmark.id);
    setEditValue(bookmark.name);
  };

  const handleSaveName = () => {
    if (editingName) {
      bookmarkManager.updateBookmarkName(editingName, editValue);
      setEditingName(null);
    }
  };

  const handleCancelEdit = () => {
    setEditingName(null);
  };

  const handleBookmarkDoubleClick = (bookmark: Bookmark) => {
    if (onBookmarkClick) {
      onBookmarkClick(bookmark);
    }
  };

  // Driver handlers
  const handleDeleteDriverGroup = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    driverManager.deleteDriverGroup(id);
  };

  const handleToggleGroup = (id: string) => {
    driverManager.toggleGroupExpanded(id);
  };

  const handleDriverDoubleClick = (driver: DriverEntry) => {
    if (onDriverClick) {
      onDriverClick({
        signalGlobalId: driver.driverSignalGlobalId,
        line: driver.line,
        fileId: driver.fileId,
      });
    }
  };

  // Load driver signal info (full name, file id)
  useEffect(() => {
    const loadDriverInfo = async () => {
      for (const group of driverGroups) {
        for (let i = 0; i < group.drivers.length; i++) {
          const driver = group.drivers[i];
          if (!driver.driverFullName) {
            const signal = await kdbManager.buildSignal(driver.driverSignalGlobalId);
            if (signal) {
              driverManager.updateDriverFullName(group.id, i, signal.fullName);
              // Get file id from parent module
              const module = await kdbManager.getModuleById(signal.parentModuleId);
              if (module?.definition?.fileId) {
                driverManager.updateDriverFileId(group.id, i, module.definition.fileId);
              }
            }
          }
        }
      }
    };
    loadDriverInfo();
  }, [driverGroups]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Tabs */}
      <div style={{ 
        display: 'flex', 
        borderBottom: '1px solid #a0b0c0',
        background: 'linear-gradient(to bottom, #e0e8f0, #c0d0e0)',
        height: '22px',
        alignItems: 'center',
      }}>
        <div
          onClick={() => setActiveTab('messages')}
          style={{
            padding: '2px 10px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 600,
            borderRight: '1px solid #a0b0c0',
            backgroundColor: activeTab === 'messages' ? '#fff' : 'transparent',
            color: activeTab === 'messages' ? '#1976d2' : '#333',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          Messages ({messages.length})
        </div>
        <div
          onClick={() => setActiveTab('bookmarks')}
          style={{
            padding: '2px 10px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 600,
            borderRight: '1px solid #a0b0c0',
            backgroundColor: activeTab === 'bookmarks' ? '#fff' : 'transparent',
            color: activeTab === 'bookmarks' ? '#1976d2' : '#333',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          Bookmarks ({bookmarks.length})
        </div>
        <div
          onClick={() => setActiveTab('drivers')}
          style={{
            padding: '2px 10px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 600,
            borderRight: '1px solid #a0b0c0',
            backgroundColor: activeTab === 'drivers' ? '#fff' : 'transparent',
            color: activeTab === 'drivers' ? '#1976d2' : '#333',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          Drivers ({driverGroups.length})
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'messages' ? (
          // Messages Tab
          <div ref={scrollRef} className="message-window" style={{ flex: 1, overflow: 'auto' }}>
            {messages.length === 0 ? (
              <div style={{ color: '#999', padding: '8px' }}>No messages</div>
            ) : (
              messages.map((msg, index) => (
                <div key={index} className="message-item">
                  {msg}
                </div>
              ))
            )}
          </div>
        ) : activeTab === 'bookmarks' ? (
          // Bookmarks Tab
          <div style={{ padding: '4px' }}>
            {/* Header row with resize handles */}
            <div style={{ 
              display: 'flex', 
              borderBottom: '2px solid #ddd',
              fontWeight: 'bold',
              fontSize: '11px',
              padding: '4px 0',
              marginBottom: '4px',
            }}>
              <div style={{ width: bookmarkColWidths.name, minWidth: 50, paddingRight: '4px' }}>Name</div>
              <div 
                style={{ width: '4px', cursor: 'col-resize', background: '#ddd' }}
                onMouseDown={(e) => handleResizeStart(e, 'bookmarks', 'name')}
              />
              <div style={{ width: bookmarkColWidths.file, minWidth: 50, paddingRight: '4px' }}>File</div>
              <div 
                style={{ width: '4px', cursor: 'col-resize', background: '#ddd' }}
                onMouseDown={(e) => handleResizeStart(e, 'bookmarks', 'file')}
              />
              <div style={{ width: bookmarkColWidths.line, minWidth: 40, paddingRight: '4px', textAlign: 'center' }}>Line</div>
              <div 
                style={{ width: '4px', cursor: 'col-resize', background: '#ddd' }}
                onMouseDown={(e) => handleResizeStart(e, 'bookmarks', 'line')}
              />
              <div style={{ flex: 1, paddingRight: '4px' }}>Content</div>
              <div style={{ width: '30px' }}></div>
            </div>
            
            {bookmarks.length === 0 ? (
              <div style={{ color: '#999', padding: '8px', fontSize: '12px' }}>
                No bookmarks. Click "Add Bookmark" button in toolbar to add one.
              </div>
            ) : (
              bookmarks.map((bookmark) => (
                <div
                  key={bookmark.id}
                  onDoubleClick={() => handleBookmarkDoubleClick(bookmark)}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f5f5f5'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '4px 0',
                    borderBottom: '1px solid #f0f0f0',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                  title={`Line ${bookmark.lineNumber}\n${bookmark.lineContent}`}
                >
                  {/* Name (editable) */}
                  <div
                    style={{ width: bookmarkColWidths.name, minWidth: 50, paddingRight: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    onClick={(e) => handleStartEditName(e, bookmark)}
                  >
                    {editingName === bookmark.id ? (
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={handleSaveName}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveName();
                          if (e.key === 'Escape') handleCancelEdit();
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                        style={{
                          width: '100%',
                          padding: '2px 4px',
                          fontSize: '11px',
                          border: '1px solid #1976d2',
                          borderRadius: '2px',
                        }}
                      />
                    ) : (
                      <span
                        style={{
                          fontWeight: 'bold',
                          color: '#333',
                          cursor: 'text',
                          borderBottom: '1px dotted #ccc',
                        }}
                        title="Click to edit name"
                      >
                        {bookmark.name || 'Unnamed'}
                      </span>
                    )}
                  </div>

                  {/* Spacer */}
                  <div style={{ width: '4px' }} />

                  {/* File - right aligned */}
                  <FileNameCell 
                    moduleIndex={bookmark.moduleIndex}
                    fileId={bookmark.fileId}
                    width={bookmarkColWidths.file}
                  />

                  {/* Spacer */}
                  <div style={{ width: '4px' }} />

                  {/* Line */}
                  <div
                    style={{ 
                      width: bookmarkColWidths.line, 
                      minWidth: 40, 
                      paddingRight: '4px', 
                      color: '#1976d2',
                      textAlign: 'center',
                    }}
                  >
                    {bookmark.lineNumber}
                  </div>

                  {/* Spacer */}
                  <div style={{ width: '4px' }} />

                  {/* Line Content */}
                  <div
                    style={{
                      flex: 1,
                      color: '#999',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontFamily: 'monospace',
                      fontSize: '10px',
                      paddingRight: '4px',
                    }}
                    title={bookmark.lineContent}
                  >
                    {bookmark.lineContent}
                  </div>

                  {/* Delete Button */}
                  <button
                    onClick={(e) => handleDeleteBookmark(e, bookmark.id)}
                    style={{
                      width: '30px',
                      padding: '2px 6px',
                      fontSize: '10px',
                      border: '1px solid #ddd',
                      borderRadius: '2px',
                      background: '#fff',
                      cursor: 'pointer',
                      color: '#d32f2f',
                    }}
                    title="Delete bookmark"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        ) : (
          // Drivers Tab
          <div style={{ overflow: 'auto' }}>
            {driverGroups.length === 0 ? (
              <div style={{ color: '#999', padding: '8px', fontSize: '12px' }}>
                No drivers. Double-click on a signal in the source code to view its drivers.
              </div>
            ) : (
              <>
                {/* Common Header */}
                <div
                  style={{
                    display: 'flex',
                    borderBottom: '1px solid #ddd',
                    fontWeight: 'bold',
                    fontSize: '11px',
                    padding: '4px 8px',
                    color: '#666',
                    background: '#f5f5f5',
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                  }}
                >
                  <div style={{ width: '20px' }}></div>
                  <div style={{ width: driverColWidths.signal, minWidth: 50, paddingRight: '4px' }}>Driver Signal</div>
                  <div
                    style={{ width: '4px', cursor: 'col-resize', background: '#eee' }}
                    onMouseDown={(e) => handleResizeStart(e, 'drivers', 'signal')}
                  />
                  <div style={{ width: driverColWidths.file, minWidth: 50, paddingRight: '4px' }}>File</div>
                  <div
                    style={{ width: '4px', cursor: 'col-resize', background: '#eee' }}
                    onMouseDown={(e) => handleResizeStart(e, 'drivers', 'file')}
                  />
                  <div style={{ width: driverColWidths.line, minWidth: 40, paddingRight: '4px', textAlign: 'center' }}>Line</div>
                  <div style={{ width: '4px' }} />
                  <div style={{ width: '60px', textAlign: 'center' }}>Source</div>
                  <div style={{ width: '24px' }} />
                </div>

                {/* Driver Groups */}
                <div style={{ padding: '4px' }}>
                  {driverGroups.map((group) => (
                    <DriverGroupComponent
                      key={group.id}
                      group={group}
                      colWidths={driverColWidths}
                      onToggle={() => handleToggleGroup(group.id)}
                      onDelete={(e) => handleDeleteDriverGroup(e, group.id)}
                      onParentDoubleClick={() => {
                        // Navigate to parent signal source
                        if (onDriverClick) {
                          onDriverClick({
                            signalGlobalId: group.targetSignal.globalId,
                            line: group.clickLocation.lineNumber,
                            fileId: group.clickLocation.fileId,
                          });
                        }
                      }}
                      onDriverDoubleClick={handleDriverDoubleClick}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Driver Group Component
interface DriverGroupComponentProps {
  group: DriverGroup;
  colWidths: typeof DEFAULT_DRIVER_COL_WIDTHS;
  onToggle: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onParentDoubleClick: () => void;
  onDriverDoubleClick: (driver: DriverEntry) => void;
}

function DriverGroupComponent({
  group,
  colWidths,
  onToggle,
  onDelete,
  onParentDoubleClick,
  onDriverDoubleClick,
}: DriverGroupComponentProps) {
  return (
    <div style={{ marginBottom: '2px' }}>
      {/* Compact Group Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '2px 4px',
          background: '#fafafa',
          borderBottom: '1px solid #eee',
          userSelect: 'none',
          fontSize: '10px',
          color: '#666',
        }}
      >
        {/* Expand/Collapse Icon - Click to toggle */}
        <div 
          style={{ width: '16px', fontSize: '10px', cursor: 'pointer' }}
          onClick={onToggle}
        >
          {group.isExpanded ? '▼' : '▶'}
        </div>

        {/* Target Signal Info - Double click to navigate */}
        <div 
          style={{ 
            flex: 1, 
            overflow: 'hidden', 
            textOverflow: 'ellipsis', 
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          }}
          onDoubleClick={onParentDoubleClick}
          title="Double-click to navigate to signal"
        >
          <span style={{ fontWeight: 'bold', color: '#0d47a1' }}>{group.targetSignal.fullName}</span>
          <span style={{ marginLeft: '8px', color: '#999' }}>
            ({group.drivers.length} drivers)
          </span>
        </div>

        {/* Source Location */}
        <div style={{ color: '#1976d2', marginRight: '8px' }}>
          {group.clickLocation.fileName.split('/').pop()}:{group.clickLocation.lineNumber}
        </div>

        {/* Delete Button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(e);
          }}
          style={{
            width: '16px',
            height: '16px',
            padding: '0',
            fontSize: '10px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: '#d32f2f',
          }}
          title="Delete"
        >
          ✕
        </button>
      </div>

      {/* Driver Rows */}
      {group.isExpanded && (
        <div>
          {group.drivers.map((driver, index) => (
            <div
              key={index}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Check if double-clicked on driver signal name column
                const target = e.target as HTMLElement;
                const isDriverSignalColumn = target.closest('.driver-signal-name') !== null;
                
                if (isDriverSignalColumn && driver.driverDeclarationLine) {
                  // Jump to driver signal declaration line
                  onDriverDoubleClick({
                    ...driver,
                    line: driver.driverDeclarationLine,
                  });
                } else {
                  // Jump to driver assignment line (original behavior)
                  onDriverDoubleClick(driver);
                }
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f5f5f5'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '2px 4px',
                borderBottom: '1px solid #f5f5f5',
                fontSize: '11px',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <div style={{ width: '20px' }}></div>
              
              {/* Driver Signal Full Name */}
              <div
                className="driver-signal-name"
                style={{
                  width: colWidths.signal,
                  minWidth: 50,
                  paddingRight: '4px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: '#333',
                }}
                title={driver.driverFullName || `Signal ${driver.driverSignalGlobalId}${driver.driverDeclarationLine ? ` (declared at line ${driver.driverDeclarationLine})` : ''}`}
              >
                {driver.driverFullName || `Signal ${driver.driverSignalGlobalId}`}
              </div>

              {/* Spacer */}
              <div style={{ width: '4px' }} />

              {/* Driver File */}
              <DriverFileNameCell fileId={driver.fileId} width={colWidths.file} />

              {/* Spacer */}
              <div style={{ width: '4px' }} />

              {/* Driver Line */}
              <div
                style={{
                  width: colWidths.line,
                  minWidth: 40,
                  paddingRight: '4px',
                  color: '#1976d2',
                  textAlign: 'center',
                }}
              >
                {driver.line}
              </div>

              {/* Spacer */}
              <div style={{ width: '4px' }} />

              {/* Source Info */}
              <div style={{ width: '60px', textAlign: 'center', fontSize: '10px', color: '#999' }}>
                -{'>'.replace('>', '')}
              </div>

              {/* Spacer for delete button alignment */}
              <div style={{ width: '24px' }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
