import { useRef, useEffect } from 'react';

interface MessageWindowProps {
  messages: string[];
}

export function MessageWindow({ messages }: MessageWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header">Messages</div>
      <div ref={scrollRef} className="message-window">
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
