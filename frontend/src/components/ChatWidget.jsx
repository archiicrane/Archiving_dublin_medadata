import { useMemo, useState } from 'react';

export default function ChatWidget({ selectedImage, archiveSecondaryLine }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: 'Ask about this archive. I can help interpret relationships, metadata, and board context.',
    },
  ]);
  const [error, setError] = useState('');

  const selectedContext = useMemo(() => {
    if (!selectedImage) return null;
    return {
      title:
        selectedImage.resolvedDisplayTitle ||
        selectedImage.canonical_board_title ||
        selectedImage.board_title ||
        selectedImage.title ||
        'Untitled drawing',
      instanceId: selectedImage.instance_id || '',
      secondaryLine: archiveSecondaryLine || '',
    };
  }, [selectedImage, archiveSecondaryLine]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setError('');
    setInput('');

    const nextMessages = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages,
          selectedContext,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || 'Chat request failed');
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: payload.answer }]);
    } catch (err) {
      setError(err?.message || 'Unable to send message');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={`chat-widget ${isOpen ? 'chat-widget--open' : ''}`}>
      <button
        type="button"
        className="chat-widget-toggle"
        onClick={() => setIsOpen((v) => !v)}
      >
        {isOpen ? 'Close Chat' : 'Open Chat'}
      </button>

      {isOpen && (
        <div className="chat-widget-panel">
          <div className="chat-widget-header">
            <h3>Archive Chat</h3>
            {selectedContext && (
              <p className="subtle">Context: {selectedContext.title}</p>
            )}
          </div>

          <div className="chat-widget-messages">
            {messages.map((m, idx) => (
              <div
                key={`${m.role}-${idx}`}
                className={`chat-message chat-message--${m.role}`}
              >
                <span className="chat-role">{m.role === 'assistant' ? 'Assistant' : 'You'}</span>
                <p>{m.content}</p>
              </div>
            ))}
            {isLoading && <p className="subtle">Thinking...</p>}
          </div>

          {error && <p className="chat-error">{error}</p>}

          <div className="chat-widget-input-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about this drawing, cluster, or metadata..."
              rows={3}
            />
            <button type="button" onClick={sendMessage} disabled={isLoading || !input.trim()}>
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
