import { useMemo, useState } from 'react';

export default function ChatWidget({
  selectedImage,
  archiveSecondaryLine,
  totalDrawings = 0,
  onOpenDrawing,
  searchDrawings,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: 'Ask about this archive. Try broad searches like "show me all buildings with water," "find topography drawings," or "what plants appear in this collection?" I\'ll search across all drawings in the archive.',
    },
  ]);
  const [error, setError] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [lastSearchLabel, setLastSearchLabel] = useState('');

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

      const search = payload?.search || { enabled: false, query: '', terms: [] };
      if (search.enabled && typeof searchDrawings === 'function') {
        const matches = searchDrawings(search.query || text, search.terms || []);
        setSearchResults(matches);
        setLastSearchLabel(search.query || text);
      }
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
            <p className="subtle">Dataset loaded: {totalDrawings} drawings</p>
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

            {searchResults.length > 0 && (
              <div className="chat-results">
                <p className="chat-results-title">
                  Matched drawings ({searchResults.length})
                  {lastSearchLabel ? ` for "${lastSearchLabel}"` : ''}
                </p>
                <div className="chat-results-grid">
                  {searchResults.slice(0, 24).map((r) => (
                    <button
                      type="button"
                      key={r.instance_id}
                      className="chat-result-card"
                      onClick={() => onOpenDrawing && onOpenDrawing(r.instance_id)}
                      title="Open drawing"
                    >
                      <img src={r.url} alt={r.title} loading="lazy" />
                      <span className="chat-result-title">{r.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {error && <p className="chat-error">{error}</p>}

          <div className="chat-widget-input-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Try: show me trees, find topography, buildings with plants, water features, site plans in Europe..."
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
