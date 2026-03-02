import { useRef, useEffect, useState } from 'react';
import { bookmarkManager, type Bookmark } from '../types/bookmark';
import { kdbManager } from '../modules/knowledge/kdbManager';

interface MessageWindowProps {
  messages: string[];
  onBookmarkClick?: (bookmark: Bookmark) => void;
}

// Component to display file name from module index or fileId
function FileNameCell({ moduleIndex, fileId, width }: { moduleIndex: number; fileId?: number; width: number }) {
  const [fileName, setFileName] = useState<string>('');
  
  useEffect(() => {
    const loadFileName = async () => {
      let targetFileId: number | null = null;
      
      if (moduleIndex === 0 && fileId) {
        // File mode: use fileId directly
        targetFileId = fileId;
      } else if (moduleIndex > 0) {
        // Module mode: get fileId from module
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

type TabType = 'messages' | 'bookmarks';

// Default column widths
const DEFAULT_COL_WIDTHS = {
  name: 80,
  file: 150,
  line: 60,
  content: 300,
};

export function MessageWindow({ messages, onBookmarkClick }: MessageWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<TabType>('messages');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  
  // Column widths state
  const [colWidths, setColWidths] = useState(DEFAULT_COL_WIDTHS);
  const [resizing, setResizing] = useState<string | null>(null);
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

  // Auto scroll to bottom when new messages arrive (only in messages tab)
  useEffect(() => {
    if (activeTab === 'messages' && scrollRef.current) {
      // Always scroll to bottom when new messages arrive in messages tab
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeTab]);

  // Resize handlers
  const handleResizeStart = (e: React.MouseEvent, col: string) => {
    e.preventDefault();
    setResizing(col);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = colWidths[col as keyof typeof colWidths];
  };

  const handleResizeMove = (e: MouseEvent) => {
    if (!resizing) return;
    const delta = e.clientX - resizeStartX.current;
    const newWidth = Math.max(50, resizeStartWidth.current + delta);
    setColWidths(prev => ({ ...prev, [resizing]: newWidth }));
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



  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Tabs - using panel-header style like hierarchy */}
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
        ) : (
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
              <div style={{ width: colWidths.name, minWidth: 50, paddingRight: '4px' }}>Name</div>
              <div 
                style={{ width: '4px', cursor: 'col-resize', background: '#ddd' }}
                onMouseDown={(e) => handleResizeStart(e, 'name')}
              />
              <div style={{ width: colWidths.file, minWidth: 50, paddingRight: '4px' }}>File</div>
              <div 
                style={{ width: '4px', cursor: 'col-resize', background: '#ddd' }}
                onMouseDown={(e) => handleResizeStart(e, 'file')}
              />
              <div style={{ width: colWidths.line, minWidth: 40, paddingRight: '4px', textAlign: 'center' }}>Line</div>
              <div 
                style={{ width: '4px', cursor: 'col-resize', background: '#ddd' }}
                onMouseDown={(e) => handleResizeStart(e, 'line')}
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
                    style={{ width: colWidths.name, minWidth: 50, paddingRight: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
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
                    width={colWidths.file}
                  />

                  {/* Spacer */}
                  <div style={{ width: '4px' }} />

                  {/* Line */}
                  <div
                    style={{ 
                      width: colWidths.line, 
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
        )}
      </div>
    </div>
  );
}
