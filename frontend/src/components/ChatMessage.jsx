import './ChatMessage.css';

function ChatMessage({ message, mode }) {
  // ========================================
  // MODE: AI vs AI Chat
  // ========================================
  if (mode === 'ai-vs-ai') {
    const isClaude = message.speaker?.includes('claude') || message.speaker === 'Claude';

    return (
        <div className={`message ${isClaude ? 'claude' : 'chatgpt'} ${message.userPrompted ? 'user-prompted' : ''}`}>
          <div className="message-header">
            <span className="speaker">{message.speaker}</span>
            <span className="timestamp">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
            {message.round && <span className="round">Round {message.round}</span>}
            {message.userPrompted && <span className="badge">User Prompt</span>}
            {message.model && (
                <span className="model-badge" title={message.model}>
              {message.model.split('/')[0]}
            </span>
            )}
          </div>
          <div className="message-content">
            {message.message}
          </div>
        </div>
    );
  }

  // ========================================
  // MODE: Normal Chat (Loop ↔ Persona)
  // ========================================

  // SYSTEM MESSAGE (tool notifications)
  if (message.role === 'system') {
    return (
        <div className="message-system">
          <div className="system-content">
            {message.content}
          </div>
          {message.timestamp && (
              <span className="system-timestamp">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
          )}
        </div>
    );
  }

  // USER MESSAGE (Loop)
  if (message.role === 'user') {
    return (
        <div className="message user-message">
          <div className="message-header">
            <span className="speaker">Du</span>
            {message.timestamp && (
                <span className="timestamp">
              {new Date(message.timestamp).toLocaleTimeString()}
            </span>
            )}
          </div>
          <div className="message-content">
            {message.content}
          </div>
        </div>
    );
  }

  // ASSISTANT MESSAGE (Persona)
  if (message.role === 'assistant') {
    return (
        <div className="message assistant-message">
          <div className="message-header">
          <span className="speaker">
            {message.personaName || 'AI'} {message.personaAvatar || ''}
          </span>
            {message.timestamp && (
                <span className="timestamp">
              {new Date(message.timestamp).toLocaleTimeString()}
            </span>
            )}
            {message.model && (
                <span className="model-badge" title={message.model}>
              {message.model.split('/')[1]?.split('-')[0] || message.model.split('/')[0]}
            </span>
            )}
          </div>
          <div className="message-content">
            {message.content}
          </div>
        </div>
    );
  }

  // FALLBACK (shouldn't happen)
  return (
      <div className="message">
        <div className="message-content">
          {message.content || message.message}
        </div>
      </div>
  );
}

export default ChatMessage;