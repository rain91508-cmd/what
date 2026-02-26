interface MessageWindowProps {
  messages: string[];
}

export function MessageWindow({ messages }: MessageWindowProps) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header">Messages</div>
      <div className="message-window">
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
    </div>
  );
}
