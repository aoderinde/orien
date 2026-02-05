import './MessageCounter.css';

function MessageCounter({ messageCount, onExport }) {
  const WARNING_THRESHOLD = 200;
  const CRITICAL_THRESHOLD = 300;

  const getStatusClass = () => {
    if (messageCount >= CRITICAL_THRESHOLD) return 'critical';
    if (messageCount >= WARNING_THRESHOLD) return 'warning';
    return 'normal';
  };

  const getMessage = () => {
    if (messageCount >= CRITICAL_THRESHOLD) {
      return '⚠️ Chat is very large. Export recommended!';
    }
    if (messageCount >= WARNING_THRESHOLD) {
      return '💡 Consider exporting this chat';
    }
    return `${messageCount} messages`;
  };

  const shouldShowWarning = messageCount >= WARNING_THRESHOLD;

  if (!shouldShowWarning) {
    return (
        <div className="message-counter normal">
          <span className="counter-text">{messageCount} messages</span>
        </div>
    );
  }

  return (
      <div className={`message-counter ${getStatusClass()}`}>
        <span className="counter-text">{getMessage()}</span>
        <button onClick={onExport} className="btn-export-inline">
          Export
        </button>
      </div>
  );
}

export default MessageCounter;