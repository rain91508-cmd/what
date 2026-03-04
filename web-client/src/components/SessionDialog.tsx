// ============================================
// Session Dialog - Save/Restore Session
// ============================================

import { useState, useEffect } from 'react';
import type { SessionInfo } from '../types/session';
import { sessionManager } from '../modules/session/sessionManager';

interface SessionDialogProps {
  mode: 'save' | 'restore';
  isOpen: boolean;
  onClose: () => void;
  onSave?: (name: string) => void;
  onRestore?: (name: string) => void;
}

export function SessionDialog({ mode, isOpen, onClose, onSave, onRestore }: SessionDialogProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadSessions();
      setSearchTerm('');
      setSelectedName('');
      setError('');
    }
  }, [isOpen]);

  const loadSessions = () => {
    const allSessions = sessionManager.getAllSessions();
    setSessions(allSessions);
  };

  const filteredSessions = sessions.filter(s =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleDelete = (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    if (confirm(`Delete session "${name}"?`)) {
      sessionManager.deleteSession(name);
      loadSessions();
    }
  };

  const handleSave = () => {
    if (!selectedName.trim()) {
      setError('Please enter a session name');
      return;
    }
    onSave?.(selectedName.trim());
  };

  const handleRestore = (name: string) => {
    onRestore?.(name);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '4px',
        width: '500px',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px',
          borderBottom: '1px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <h3 style={{ margin: 0, fontSize: '16px' }}>
            {mode === 'save' ? 'Save Session' : 'Restore Session'}
          </h3>
          <button
            onClick={onClose}
            style={{
              border: 'none',
              background: 'none',
              fontSize: '20px',
              cursor: 'pointer',
              color: '#666',
            }}
          >
            ×
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e0e0e0' }}>
          <input
            type="text"
            placeholder="Search sessions..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '14px',
            }}
          />
        </div>

        {/* Session List */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          maxHeight: '300px',
        }}>
          {filteredSessions.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>
              {mode === 'save' ? 'No existing sessions' : 'No sessions found'}
            </div>
          ) : (
            filteredSessions.map((session) => (
              <div
                key={session.name}
                onClick={() => {
                  setSelectedName(session.name);
                  if (mode === 'restore') {
                    handleRestore(session.name);
                  }
                }}
                onDoubleClick={() => {
                  if (mode === 'save') {
                    setSelectedName(session.name);
                  }
                }}
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid #f0f0f0',
                  cursor: mode === 'restore' ? 'pointer' : 'default',
                  backgroundColor: selectedName === session.name ? '#e3f2fd' : 'transparent',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ fontWeight: 'bold', fontSize: '14px' }}>{session.name}</div>
                  <div style={{ fontSize: '12px', color: '#666' }}>
                    Created: {formatDate(session.createdAt)}
                  </div>
                  <div style={{ fontSize: '12px', color: '#666' }}>
                    Updated: {formatDate(session.updatedAt)}
                  </div>
                </div>
                <button
                  onClick={(e) => handleDelete(e, session.name)}
                  style={{
                    border: 'none',
                    background: 'none',
                    color: '#d32f2f',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>

        {/* Save Mode: Input for new session name */}
        {mode === 'save' && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid #e0e0e0' }}>
            <input
              type="text"
              placeholder="Enter session name (or select existing to overwrite)"
              value={selectedName}
              onChange={(e) => {
                setSelectedName(e.target.value);
                setError('');
              }}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                fontSize: '14px',
              }}
            />
            {error && (
              <div style={{ color: '#d32f2f', fontSize: '12px', marginTop: '4px' }}>
                {error}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              border: '1px solid #ddd',
              background: 'white',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          {mode === 'save' && (
            <button
              onClick={handleSave}
              style={{
                padding: '8px 16px',
                border: 'none',
                background: '#1976d2',
                color: 'white',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
