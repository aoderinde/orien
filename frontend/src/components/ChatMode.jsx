import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import './ChatMode.css';
import { MODELS } from '../models';
import ConversationList from './ConversationList';

import { API_URL } from '../config';

function ChatMode({ activeKnowledgeIds, onToggleKnowledge }) {
const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id);
  const [isLoading, setIsLoading] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState('new');
  const [conversationTitle, setConversationTitle] = useState('New Conversation');
  const [isSaving, setIsSaving] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const messagesEndRef = useRef(null);
  const autoSaveTimeout = useRef(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const conversationListRef = useRef(null);

  // NEW: Load last conversation on mount
  useEffect(() => {
    loadLastConversation();
  }, []);

  const refreshConversationList = () => {
    // Trigger reload in ConversationList component
    if (conversationListRef.current) {
      conversationListRef.current.reload();
    }
  };

  const loadLastConversation = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/conversations`);
      const conversations = response.data;

      if (conversations.length > 0) {
        // Load the most recent conversation
        const lastConv = conversations[0];
        loadConversation(lastConv);
      }
    } catch (error) {
      console.error('Error loading last conversation:', error);
      // Silently fail - user starts with empty chat
    }
  };

  useEffect(() => {
    // Only scroll when messages actually change (not on mount)
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Auto-save whenever messages change
  useEffect(() => {
    if (messages.length === 0) return;

    // Clear previous timeout
    if (autoSaveTimeout.current) {
      clearTimeout(autoSaveTimeout.current);
    }

    // Set new timeout (debounce - save 2 seconds after last change)
    autoSaveTimeout.current = setTimeout(() => {
      autoSaveConversation();
    }, 2000);

    return () => {
      if (autoSaveTimeout.current) {
        clearTimeout(autoSaveTimeout.current);
      }
    };
  }, [messages]);

  const startEditTitle = () => {
    setEditTitleValue(conversationTitle);
    setIsEditingTitle(true);
  };

  const saveTitle = async () => {
    if (!editTitleValue.trim()) {
      setIsEditingTitle(false);
      return;
    }

    if (currentConversationId === 'new') {
      setConversationTitle(editTitleValue.trim());
      setIsEditingTitle(false);
      return;
    }

    try {
      await axios.patch(`${API_URL}/api/conversations/${currentConversationId}/title`, {
        title: editTitleValue.trim()
      });
      setConversationTitle(editTitleValue.trim());
      setIsEditingTitle(false);
      refreshConversationList(); // ← NEW: Refresh sidebar!
    } catch (error) {
      alert('Error updating title: ' + error.message);
    }
  };

  const handleTitleKeyPress = (e) => {
    if (e.key === 'Enter') {
      saveTitle();
    } else if (e.key === 'Escape') {
      setIsEditingTitle(false);
    }
  };

  const autoSaveConversation = async () => {
    if (messages.length === 0) return;

    setIsSaving(true);
    try {
      let title = conversationTitle;
      if (currentConversationId === 'new' && messages.length >= 2 && conversationTitle === 'New Conversation') {
        const titleResponse = await axios.post(`${API_URL}/api/conversations/generate-title`, {
          messages: messages
        });
        title = titleResponse.data.title;
        setConversationTitle(title);
      }

      const response = await axios.post(`${API_URL}/api/conversations/autosave`, {
        conversationId: currentConversationId,
        mode: 'chat',
        model: selectedModel,
        messages: messages,
        title: title
      });

      if (response.data.created && response.data.conversationId) {
        setCurrentConversationId(response.data.conversationId);
        refreshConversationList(); // ← NEW: Refresh sidebar when new chat created!
      }

      console.log('✅ Auto-saved');
    } catch (error) {
      console.error('Auto-save error:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const loadConversation = async (conversation) => {
    try {
      const response = await axios.get(`${API_URL}/api/conversations/${conversation._id}`);
      const conv = response.data;

      setMessages(conv.messages || []);
      setCurrentConversationId(conv._id);
      setConversationTitle(conv.title || 'Conversation');
      setSelectedModel(conv.model1 || MODELS[0].id);
      setShowSidebar(false); // Hide sidebar on mobile after selecting
    } catch (error) {
      console.error('Error loading conversation:', error);
      alert('Error loading conversation: ' + error.message);
    }
  };

  const startNewChat = () => {
    setMessages([]);
    setCurrentConversationId('new');
    setConversationTitle('New Conversation');
    setInput('');
    setShowSidebar(false);
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = {
      role: 'user',
      content: input,
      timestamp: new Date().toISOString()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const apiMessages = [...messages, userMessage].map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      const response = await axios.post(`${API_URL}/api/chat`, {
        model: selectedModel,
        messages: apiMessages,
        knowledgeBaseIds: activeKnowledgeIds
      });

      const assistantMessage = {
        role: 'assistant',
        content: response.data.message,
        timestamp: new Date().toISOString(),
        model: selectedModel
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Error:', error);
      const errorMessage = {
        role: 'assistant',
        content: `Error: ${error.response?.data?.error || error.message}`,
        timestamp: new Date().toISOString(),
        isError: true
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const selectedModelInfo = MODELS.find(m => m.id === selectedModel);

  return (
      <div className="chat-mode-container">
        <button
            className="sidebar-toggle"
            onClick={() => setShowSidebar(!showSidebar)}
        >
          {showSidebar ? '✕' : '☰'}
        </button>

        <div className={`chat-sidebar ${showSidebar ? 'show' : ''}`}>
          <ConversationList
              ref={conversationListRef}
              onSelectConversation={loadConversation}
              onNewChat={startNewChat}
              currentConvId={currentConversationId}
          />
        </div>

        <div className="chat-main">

          <div className="chat-mode">
            <div className="chat-header">
              <div className="conversation-title">
                {isEditingTitle ? (
                    <input
                        type="text"
                        value={editTitleValue}
                        onChange={(e) => setEditTitleValue(e.target.value)}
                        onKeyDown={handleTitleKeyPress}
                        onBlur={saveTitle}
                        className="title-edit-input"
                    />
                ) : (
                    <>
                      <h3 onClick={startEditTitle} className="editable-title">
                        {conversationTitle}
                      </h3>
                      <button
                          onClick={startEditTitle}
                          className="btn-edit-title"
                          title="Edit title"
                      >
                        ✏️
                      </button>
                    </>
                )}
                {isSaving && <span className="saving-indicator">💾 Saving...</span>}
              </div>

              <div className="model-selector">
                <label>Model:</label>
                <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={isLoading}
                >
                  {MODELS.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                  ))}
                </select>
              </div>


            </div>

            {/* Rest stays the same... */}
            {activeKnowledgeIds.length > 0 && (
                <div className="active-knowledge-bar">
                  📚 Using {activeKnowledgeIds.length} knowledge file{activeKnowledgeIds.length > 1 ? 's' : ''}
                </div>
            )}

            <div className="chat-messages">
              {messages.length === 0 && (
                  <div className="empty-state">
                    <h3>👋 Start chatting with {selectedModelInfo?.name}!</h3>
                    <p>Your conversation will be automatically saved.</p>
                    {activeKnowledgeIds.length > 0 && (
                        <p className="kb-hint">💡 Your selected knowledge files will be used as context!</p>
                    )}
                  </div>
              )}

              {messages.map((msg, idx) => (
                  <div key={idx} className={`chat-message ${msg.role} ${msg.isError ? 'error' : ''}`}>
                    <div className="message-header">
                  <span className="role">
                    {msg.role === 'user' ? '👤 You' : `🤖 ${selectedModelInfo?.name || 'AI'}`}
                  </span>
                      <span className="timestamp">
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </span>
                    </div>
                    <div className="message-content">
                      {msg.content}
                    </div>
                  </div>
              ))}

              {isLoading && (
                  <div className="chat-message assistant loading">
                    <div className="message-header">
                      <span className="role">🤖 {selectedModelInfo?.name}</span>
                    </div>
                    <div className="message-content">
                  <span className="typing-indicator">
                    <span></span><span></span><span></span>
                  </span>
                    </div>
                  </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-container">
            <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
                rows="3"
                disabled={isLoading}
            />
              <button
                  onClick={sendMessage}
                  disabled={!input.trim() || isLoading}
                  className="btn-primary send-button"
              >
                {isLoading ? '⏳ Sending...' : '📤 Send'}
              </button>
            </div>
          </div>

        </div>

      </div>
  );
}

export default ChatMode;