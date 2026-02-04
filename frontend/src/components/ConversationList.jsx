import { useState, useEffect } from 'react';
import axios from 'axios';
import './ConversationList.css';
import { MODELS } from '../models';

import { API_URL } from '../config';

function ConversationList({ onSelectConversation, onNewChat, currentConvId }) {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConversations();
  }, []);

  const loadConversations = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/conversations`);
      setConversations(response.data);
    } catch (error) {
      console.error('Error loading conversations:', error);
    } finally {
      setLoading(false);
    }
  };

  const deleteConversation = async (id) => {
    if (!window.confirm('Delete this conversation?')) return;

    try {
      await axios.delete(`${API_URL}/api/conversations/${id}`);
      setConversations(conversations.filter(c => c._id !== id));
    } catch (error) {
      alert('Error deleting conversation: ' + error.message);
    }
  };

  const formatDate = (date) => {
    const d = new Date(date);
    const now = new Date();
    const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return d.toLocaleDateString();
  };

  const getModelName = (modelId) => {
    if (!modelId) return 'Unknown Model';
    const model = MODELS.find(m => m.id === modelId);
    if (model) {
      return model.name.split(' ')[0]; // e.g., "Claude" from "Claude Sonnet 4.5"
    }
    return modelId.split('/')[1]?.split('-')[0] || 'AI';
  };

  return (
      <div className="conversation-list">
        <div className="list-header">
          <h3>💬 Conversations</h3>
          <button onClick={onNewChat} className="btn-new-chat">
            ➕ New Chat
          </button>
        </div>

        {loading ? (
            <div className="loading">Loading...</div>
        ) : conversations.length === 0 ? (
            <div className="empty-list">
              <p>No conversations yet</p>
              <button onClick={onNewChat} className="btn-primary">
                Start your first chat!
              </button>
            </div>
        ) : (
            <div className="list-items">
              {conversations.map(conv => (
                  <div
                      key={conv._id}
                      className={`list-item ${currentConvId === conv._id ? 'active' : ''}`}
                      onClick={() => onSelectConversation(conv)}
                  >
                    <div className="item-header">
                      <span className="item-title">{conv.title}</span>
                      <button
                          className="btn-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteConversation(conv._id);
                          }}
                      >
                        🗑️
                      </button>
                    </div>
                    <div className="item-meta">
                      <span className="mode-badge">{conv.mode}</span>
                      {conv.model1 && (
                          <span className="model-badge">
                    🤖 {getModelName(conv.model1)}
                  </span>
                      )}
                      <span className="date">{formatDate(conv.updatedAt)}</span>
                    </div>
                    <div className="item-preview">
                      {conv.messages[conv.messages.length - 1]?.content.substring(0, 60)}...
                    </div>
                  </div>
              ))}
            </div>
        )}
      </div>
  );
}

export default ConversationList;