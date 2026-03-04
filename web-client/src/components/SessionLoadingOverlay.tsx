// ============================================
// Session Loading Overlay - Shows during save/restore
// ============================================

interface SessionLoadingOverlayProps {
  isVisible: boolean;
  message: string;
}

export function SessionLoadingOverlay({ isVisible, message }: SessionLoadingOverlayProps) {
  if (!isVisible) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(255, 255, 255, 0.9)',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 2000,
    }}>
      <div style={{
        width: '50px',
        height: '50px',
        border: '4px solid #f3f3f3',
        borderTop: '4px solid #1976d2',
        borderRadius: '50%',
        animation: 'spin 1s linear infinite',
      }} />
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
      <div style={{
        marginTop: '20px',
        fontSize: '16px',
        color: '#333',
      }}>
        {message}
      </div>
    </div>
  );
}
