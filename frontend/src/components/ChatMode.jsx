import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import './ChatMode.css';
import { MODELS } from '../models';
import ConversationList from './ConversationList';
import PersonaSelector from './PersonaSelector';
import ExportModal from './ExportModal';
import MemoryView from './MemoryView';
import { API_URL } from '../config';
import ReactMarkdown from 'react-markdown';

function ChatMode({ activeKnowledgeIds, onOpenMenu, onRequestExport, initialPersonaId, onPersonaSet  }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id);
  const [selectedPersonaId, setSelectedPersonaId] = useState(null);
  const [currentPersona, setCurrentPersona] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState('new');
  const [conversationTitle, setConversationTitle] = useState('New Conversation');
  const [isSaving, setIsSaving] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showMemoryView, setShowMemoryView] = useState(false);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const autoSaveTimeout = useRef(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const conversationListRef = useRef(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Scroll functions
  const scrollToTop = () => {
    messagesContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };
  
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    document.body.classList.add('chat-mode-active');
    return () => {
      document.body.classList.remove('chat-mode-active');
    };
  }, []);

  useEffect(() => {
    if (!initialPersonaId) {  // ← Nur laden wenn KEINE Persona übergeben wird
      loadLastConversation();
    }
  }, [initialPersonaId]);

  useEffect(() => {

    if (initialPersonaId && !hasInitialized) {
      setMessages([]);
      setCurrentConversationId('new');
      setConversationTitle('New Conversation');
      setSelectedPersonaId(initialPersonaId);
      setHasInitialized(true);
    }
  }, [initialPersonaId, hasInitialized]);

  // Reset flag when persona changes manually
  useEffect(() => {
    if (!initialPersonaId) {
      setHasInitialized(false);
    }
  }, [initialPersonaId]);

  useEffect(() => {
    if (selectedPersonaId) {
      loadPersona(selectedPersonaId);
    } else {
      setCurrentPersona(null);
    }
  }, [selectedPersonaId]);

  // Expose export function to parent
  useEffect(() => {
    if (onRequestExport) {
      onRequestExport(() => setShowExportModal(true));
    }
  }, [onRequestExport]);

  const loadPersona = async (personaId) => {
    try {
      const response = await axios.get(`${API_URL}/api/personas/${personaId}`);
      setCurrentPersona(response.data);
    } catch (error) {
      console.error('Error loading persona:', error);
    }
  };

  const refreshConversationList = () => {
    if (conversationListRef.current) {
      conversationListRef.current.reload();
    }
  };

  const loadLastConversation = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/conversations`);
      const conversations = response.data;

      if (conversations.length > 0) {
        const lastConv = conversations[0];
        loadConversation(lastConv);
      }
    } catch (error) {
      console.error('Error loading last conversation:', error);
    }
  };

  useEffect(() => {
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  useEffect(() => {
    if (messages.length === 0) return;

    if (autoSaveTimeout.current) {
      clearTimeout(autoSaveTimeout.current);
    }

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
      refreshConversationList();
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
        model: currentPersona ? currentPersona.model : selectedModel,
        messages: messages,
        title: title,
        personaId: selectedPersonaId
      });

      if (response.data.created && response.data.conversationId) {
        setCurrentConversationId(response.data.conversationId);
        refreshConversationList();
      }
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
      setSelectedPersonaId(conv.personaId || null);
      setShowSidebar(false);
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
    setSelectedPersonaId(null);
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

      const modelToUse = currentPersona ? currentPersona.model : selectedModel;

      const response = await axios.post(`${API_URL}/api/chat`, {
        model: modelToUse,
        messages: apiMessages,
        knowledgeBaseIds: activeKnowledgeIds,
        personaId: selectedPersonaId
      });

      // Collect all messages to add (assistant + tool notifications)
      const newMessages = [];

      // Check if AI used tools - add tool notifications BEFORE the message
      if (response.data.toolCalls && response.data.toolCalls.length > 0) {
        console.log('🔧 Tool calls received:', response.data.toolCalls);
        for (const toolCall of response.data.toolCalls) {
          console.log('Processing tool call:', toolCall.function?.name || toolCall);
          // Show notification for save_memory
          if (toolCall.function.name === 'save_memory') {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const fact = args.fact;
              newMessages.push({
                role: 'system',
                content: `💾 Memory gespeichert: "${fact.substring(0, 100)}${fact.length > 100 ? '...' : ''}"`,
                timestamp: new Date().toISOString(),
                type: 'tool_notification'
              });
            } catch (e) {
              console.error('Error parsing tool call:', e);
            }
          }

          // Show notification for save_fact
          if (toolCall.function.name === 'save_fact') {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const fact = args.fact;
              newMessages.push({
                role: 'system',
                content: `💾 Fact gespeichert: "${fact.substring(0, 80)}${fact.length > 80 ? '...' : ''}"`,
                timestamp: new Date().toISOString(),
                type: 'tool_notification'
              });
            } catch (e) {
              console.error('Error parsing tool call:', e);
            }
          }

          // Show notification for save_summary
          if (toolCall.function.name === 'save_summary') {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const summary = args.summary;
              newMessages.push({
                role: 'system',
                content: `📝 Summary aktualisiert: "${summary.substring(0, 60)}${summary.length > 60 ? '...' : ''}"`,
                timestamp: new Date().toISOString(),
                type: 'tool_notification'
              });
            } catch (e) {
              console.error('Error parsing tool call:', e);
            }
          }

          // Show notification for send_notification
          if (toolCall.function.name === 'send_notification') {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const message = args.message;
              newMessages.push({
                role: 'system',
                content: `💌 Notification gesendet`,
                timestamp: new Date().toISOString(),
                type: 'tool_notification'
              });
            } catch (e) {
              console.error('Error parsing tool call:', e);
            }
          }

          // Show notification for load_knowledge
          if (toolCall.function.name === 'load_knowledge_by_title') {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const titles = args.titles;
              newMessages.push({
                role: 'system',
                content: `📚 Knowledge geladen: ${titles.join(', ')}`,
                timestamp: new Date().toISOString(),
                type: 'tool_notification'
              });
            } catch (e) {
              console.error('Error parsing tool call:', e);
            }
          }

          // Show notification for search_knowledge
          if (toolCall.function.name === 'search_knowledge') {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const query = args.query;
              const resultCount = response.data.searchResults?.[0]?.results?.length || 0;
              newMessages.push({
                role: 'system',
                content: `🔍 Suche: "${query}" → ${resultCount} Treffer`,
                timestamp: new Date().toISOString(),
                type: 'tool_notification'
              });
            } catch (e) {
              console.error('Error parsing tool call:', e);
            }
          }
        }
      }

      // Add the assistant message (only if there's content)
      if (response.data.message) {
        newMessages.push({
          role: 'assistant',
          content: response.data.message,
          timestamp: new Date().toISOString(),
          model: modelToUse
        });
      }

      setMessages(prev => [...prev, ...newMessages]);
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
    if (e.key === 'Enter') {
      const isMobile = window.innerWidth <= 768;

      if (isMobile) {
        return;
      } else {
        if (!e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      }
    }
  };

  const selectedModelInfo = MODELS.find(m => m.id === (currentPersona ? currentPersona.model : selectedModel));

  return (
      <div className="chat-mode-container">
        <button
            className="sidebar-toggle"
            onClick={() => setShowSidebar(!showSidebar)}
        >
          {showSidebar ? '✕' : '☰'}
        </button>

        <button
            className="mobile-menu-toggle"
            onClick={onOpenMenu}
        >
          ⋮
        </button>

        <div className={`chat-sidebar ${showSidebar ? 'show' : ''}`}>
          <ConversationList
              ref={conversationListRef}
              onSelectConversation={loadConversation}
              onNewChat={startNewChat}
              currentConvId={currentConversationId}
              currentPersonaId={selectedPersonaId}
              activeKnowledgeIds={activeKnowledgeIds}
              messageCount={messages.length}
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

              <PersonaSelector
                  selectedPersonaId={selectedPersonaId}
                  onSelectPersona={setSelectedPersonaId}
              />
              
              {currentPersona && (
                <button 
                  className="memory-btn-subtle"
                  onClick={() => setShowMemoryView(true)}
                  title="View Memory"
                >
                  🧠
                </button>
              )}

              <div className="model-selector">
                <label>Model:</label>
                <select
                    value={currentPersona ? currentPersona.model : selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={isLoading || !!currentPersona}
                >
                  {MODELS.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                  ))}
                </select>
                {currentPersona && (
                    <span className="model-locked-hint">🔒 Locked by Persona</span>
                )}
              </div>
            </div>

            {/* REMOVED: active-knowledge-bar (moved to sidebar) */}

            <div className="chat-messages" ref={messagesContainerRef}>
              {/* Scroll buttons */}
              {messages.length > 5 && (
                <div className="scroll-buttons">
                  <button onClick={scrollToTop} className="scroll-btn" title="Scroll to top">⬆️</button>
                  <button onClick={scrollToBottom} className="scroll-btn" title="Scroll to bottom">⬇️</button>
                </div>
              )}
              
              {messages.length === 0 && (
                  <div className="empty-state">
                    <h3>👋 Start chatting{currentPersona ? ` with ${currentPersona.name}` : ''}!</h3>
                    <p>Your conversation will be automatically saved.</p>
                  </div>
              )}

              {messages.map((msg, idx) => (
                  <div key={idx} className={`chat-message ${msg.role} ${msg.isError ? 'error' : ''}`}>
                    <div className="message-header">
                  <span className="role">
                    {msg.role === 'user' ? '👤 You' : `${currentPersona?.avatar || '🤖'} ${currentPersona?.name || selectedModelInfo?.name || 'AI'}`}
                  </span>
                      <span className="timestamp">
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </span>
                    </div>
                    <div className="message-content">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
              ))}

              {isLoading && (
                  <div className="chat-message assistant loading">
                    <div className="message-header">
                      <span className="role">{currentPersona?.avatar || '🤖'} {currentPersona?.name || selectedModelInfo?.name || 'AI'}</span>
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
                placeholder="Type your message..."
                rows="3"
                disabled={isLoading}
            />
              <button
                  onClick={sendMessage}
                  disabled={!input.trim() || isLoading}
                  className="btn-primary send-button"
              >
                {isLoading ? '⏳' : 'Send'}
              </button>
            </div>
          </div>
        </div>
        {showExportModal && (
            <ExportModal
                messages={messages}
                conversationTitle={conversationTitle}
                personaName={currentPersona?.name}
                personaId={selectedPersonaId}  // ← ADD THIS
                onClose={() => setShowExportModal(false)}
            />
        )}
        
        {showMemoryView && currentPersona && (
            <MemoryView
                personaId={selectedPersonaId}
                personaName={currentPersona.name}
                personaAvatar={currentPersona.avatar}
                onClose={() => setShowMemoryView(false)}
            />
        )}
      </div>
  );
}

export default ChatMode;