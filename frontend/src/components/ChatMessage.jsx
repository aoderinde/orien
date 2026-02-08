import './ChatMessage.css';

function ChatMessage({ message }) {
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

export default ChatMessage;