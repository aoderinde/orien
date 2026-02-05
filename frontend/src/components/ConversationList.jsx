import { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import axios from 'axios';
import './ConversationList.css';
import { API_URL } from '../config';

const ConversationList = forwardRef(({
                                       onSelectConversation,
                                       onNewChat,
                                       currentConvId,
                                       currentPersonaId,
                                       activeKnowledgeIds,
                                       messageCount
                                     }, ref) => {
  const [conversations, setConversations] = useState([]);
  const [personas, setPersonas] = useState({});
  const [loading, setLoading] = useState(true);

  useImperativeHandle(ref, () => ({
    reload: loadConversations
  }));

  useEffect(() => {
    loadConversations();
    loadPersonas();
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

  const loadPersonas = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/personas`);
      const personaMap = {};
      response.data.forEach(p => {
        personaMap[p._id] = p;
      });
      setPersonas(personaMap);
    } catch (error) {
      console.error('Error loading personas:', error);
    }
  };

  const deleteConversation = async (id, e) => {
    e.stopPropagation();

    if (!window.confirm('Delete this conversation?')) return;

    try {
      await axios.delete(`${API_URL}/api/conversations/${id}`);
      setConversations(conversations.filter(c => c._id !== id));

      if (currentConvId === id) {
        onNewChat();
      }
    } catch (error) {
      alert('Error deleting conversation: ' + error.message);
    }
  };

  // Filter conversations by persona if one is selected
  const filteredConversations = currentPersonaId
      ? conversations.filter(c => c.personaId === currentPersonaId)
      : conversations;

  return (
      <div className="conversation-list">
        <div className="conversation-list-header">
          <h3>💬 Conversations</h3>
          <button onClick={onNewChat} className="btn-new-chat">
            ✏️ New Chat
          </button>
        </div>

        {loading ? (
            <div className="loading-conversations">Loading...</div>
        ) : filteredConversations.length === 0 ? (
            <div className="empty-conversations">
              {currentPersonaId ? (
                  <>
                    <p>No conversations with this persona yet.</p>
                    <button onClick={onNewChat} className="btn-new-chat-large">
                      Start Chatting
                    </button>
                  </>
              ) : (
                  <>
                    <p>No conversations yet.</p>
                    <button onClick={onNewChat} className="btn-new-chat-large">
                      Start Your First Chat
                    </button>
                  </>
              )}
            </div>
        ) : (
            <div className="conversation-items">
              {filteredConversations.map(conv => {
                const isActive = currentConvId === conv._id;
                const persona = conv.personaId ? personas[conv.personaId] : null;
                const msgCount = conv.messages?.length || 0;

                return (
                    <div
                        key={conv._id}
                        className={`conversation-item ${isActive ? 'active' : ''}`}
                        onClick={() => onSelectConversation(conv)}
                    >
                      <div className="conv-header">
                        <span className="conv-title">{conv.title || 'Untitled'}</span>
                        <button
                            onClick={(e) => deleteConversation(conv._id, e)}
                            className="btn-delete-conv"
                            title="Delete"
                        >
                          🗑️
                        </button>
                      </div>

                      <div className="conv-meta">
                  <span className="conv-mode">
                    {conv.mode === 'chat' && '💬 CHAT'}
                    {conv.mode === 'group' && '👥 GROUP'}
                    {conv.mode === 'ai-vs-ai' && '🤖 AI vs AI'}
                  </span>
                        <span className="conv-date">
                    {new Date(conv.updatedAt).toLocaleDateString()}
                  </span>
                      </div>

                      {/* NEW: Stats row (only for active conversation) */}
                      {isActive && (
                          <div className="conv-stats">
                            {persona && (
                                <span className="stat-persona">
                        {persona.avatar} {persona.name}
                      </span>
                            )}
                            {messageCount > 0 && (
                                <span className="stat-messages">
                        💬 {messageCount}
                      </span>
                            )}
                            {persona.knowledgeIds?.length > 0 && (
                                <span className="stat-knowledge">
                        📚 {persona.knowledgeIds?.length}
                      </span>
                            )}
                          </div>
                      )}

                      {conv.messages && conv.messages.length > 0 && (
                          <div className="conv-preview">
                            {conv.messages[conv.messages.length - 1].content.substring(0, 60)}...
                          </div>
                      )}
                    </div>
                );
              })}
            </div>
        )}
      </div>
  );
});

export default ConversationList;