import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';
import ChatMessage from './components/ChatMessage';
import ConversationControls from './components/ConversationControls';
import ChatMode from './components/ChatMode';
import GroupChat from './components/GroupChat';
import MemoryPanel from './components/MemoryPanel';
import KnowledgeBase from './components/KnowledgeBase';
import PersonaList from './components/PersonaList';
import PersonaEditor from './components/PersonaEditor';
import NotificationBell from './components/NotificationBell';
import NotificationPanel from './components/NotificationPanel';
import MemoryView from './components/MemoryView';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

function App() {
  const [mode, setMode] = useState('chat');
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [ws, setWs] = useState(null);
  const [currentModels, setCurrentModels] = useState(null);
  const messagesEndRef = useRef(null);
  const [activeKnowledgeIds, setActiveKnowledgeIds] = useState([]);

  const [showPersonaEditor, setShowPersonaEditor] = useState(false);
  const [editingPersona, setEditingPersona] = useState(null);
  const [personas, setPersonas] = useState([]);
  const [selectedPersonaForChat, setSelectedPersonaForChat] = useState(null);
  const [showNotificationPanel, setShowNotificationPanel] = useState(false);
  
  // Memory View state
  const [showMemoryView, setShowMemoryView] = useState(false);
  const [memoryViewPersona, setMemoryViewPersona] = useState(null);

  // NEW: Export handler reference
  const exportChatHandler = useRef(null);

  // Load personas function
  const loadPersonas = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/personas`);
      setPersonas(response.data);
    } catch (error) {
      console.error('Error loading personas:', error);
    }
  };

  // Load on mount
  useEffect(() => {
    loadPersonas();
  }, []);

  const handleModeChange = (newMode) => {
    setMode(newMode);
    setShowModeMenu(false);
  };

  const handleOpenMenu = () => {
    setShowModeMenu(true);
  };

  // NEW: Handle export click from menu
  const handleExportClick = () => {
    setShowModeMenu(false);
    if (exportChatHandler.current) {
      exportChatHandler.current();
    }
  };

  // NEW: Receive export handler from ChatMode
  const handleExportHandlerReady = (handler) => {
    exportChatHandler.current = handler;
  };

  const handleNewPersona = () => {
    setEditingPersona(null);
    setShowPersonaEditor(true);
  };

  const handleEditPersona = (persona) => {
    const currentPersona = personas.find(p => p._id === persona._id);
    setEditingPersona(currentPersona);
    setShowPersonaEditor(true);
  };

  const handleSelectPersona = (persona) => {
    setSelectedPersonaForChat(persona._id);
    setMode('chat');
  };

  const handleMemory = (persona) => {
    setMemoryViewPersona(persona);
    setShowMemoryView(true);
  };

  const handleSavePersona = async () => {
    setShowPersonaEditor(false);
    setEditingPersona(null);
    // ← ADD THIS: Reload personas

    await loadPersonas();
  };

  const handleCancelPersona = () => {
    setShowPersonaEditor(false);
    setEditingPersona(null);
  };

  const toggleKnowledge = (fileId) => {
    setActiveKnowledgeIds(prev =>
        prev.includes(fileId)
            ? prev.filter(id => id !== fileId)
            : [...prev, fileId]
    );
  };

  useEffect(() => {
    // Add body class based on mode
    if (mode === 'memory') {
      document.body.classList.add('memory-mode-active');
    } else {
      document.body.classList.remove('memory-mode-active');
    }

    if (mode === 'knowledge') {
      document.body.classList.add('knowledge-mode-active');
    } else {
      document.body.classList.remove('knowledge-mode-active');
    }
  }, [mode]);

  useEffect(() => {
    if (mode === 'ai-vs-ai') {
      const websocket = new WebSocket(WS_URL);

      websocket.onopen = () => {
        console.log('WebSocket connected');
      };

      websocket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'history') {
          setMessages(data.data);
        } else if (data.type === 'message') {
          setMessages(prev => [...prev, data.data]);
        } else if (data.type === 'status') {
          setStatus(data.data.status);
          if (data.data.status === 'Conversation ended') {
            setIsRunning(false);
          }
        } else if (data.type === 'error') {
          alert('Error: ' + data.data.error);
          setIsRunning(false);
        }
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      setWs(websocket);

      return () => websocket.close();
    }
  }, [mode]);

  useEffect(() => {
    if (mode === 'ai-vs-ai' && messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, mode]);

  const startConversation = async (initialPrompt, maxRounds, model1, model2) => {
    try {
      await axios.post(`${API_URL}/api/start`, {
        initialPrompt,
        maxRounds: parseInt(maxRounds),
        model1,
        model2
      });
      setIsRunning(true);
      setMessages([]);
      setCurrentModels({ model1, model2 });
    } catch (error) {
      alert('Error: ' + error.message);
    }
  };

  const stopConversation = async () => {
    try {
      await axios.post(`${API_URL}/api/stop`);
      setIsRunning(false);
    } catch (error) {
      alert('Error stopping: ' + error.message);
    }
  };

  const saveConversation = async () => {
    try {
      const response = await axios.post(`${API_URL}/api/save`);
      const blob = new Blob([JSON.stringify(response.data.data, null, 2)], {
        type: 'application/json'
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = response.data.filename;
      a.click();
    } catch (error) {
      alert('Error saving: ' + error.message);
    }
  };

  const sendMessage = async (target, message, model) => {
    try {
      const response = await axios.post(`${API_URL}/api/message`, {
        target,
        message,
        model
      });
    } catch (error) {
      alert('Error sending message: ' + error.message);
    }
  };

  return (
      <div className="app">
        <header>
          <h1>
            <span className="logo">💫</span> Orien <span className="chat-bubble"></span>
          </h1>

          <div className="header-actions">
            <NotificationBell onOpenPanel={() => setShowNotificationPanel(true)} />

            <button
                className="mode-menu-toggle"
                onClick={() => setShowModeMenu(!showModeMenu)}
            >
              ☰ Menu
            </button>
          </div>
        </header>

        <NotificationPanel
            isOpen={showNotificationPanel}
            onClose={() => setShowNotificationPanel(false)}
        />

        {showModeMenu && (
            <>
              <div
                  className="mode-menu-overlay"
                  onClick={() => setShowModeMenu(false)}
              />
              <div className="mode-menu">
                <button
                    className={`mode-menu-item ${mode === 'ai-vs-ai' ? 'active' : ''}`}
                    onClick={() => handleModeChange('ai-vs-ai')}
                >
                  🤖 AI vs AI
                </button>
                <button
                    className={`mode-menu-item ${mode === 'group' ? 'active' : ''}`}
                    onClick={() => handleModeChange('group')}
                >
                  👥 Group Chat
                </button>
                <button
                    className={`mode-menu-item ${mode === 'chat' ? 'active' : ''}`}
                    onClick={() => handleModeChange('chat')}
                >
                  💬 Chat Mode
                </button>

                <div style={{ borderTop: '2px solid #e2e8f0', margin: '10px 0' }} />

                {/* NEW: Export Chat (only in chat mode) */}
                {mode === 'chat' && (
                    <button
                        className="mode-menu-item"
                        onClick={handleExportClick}
                    >
                      📥 Export Chat
                    </button>
                )}

                <button
                    className={`mode-menu-item ${mode === 'personas' ? 'active' : ''}`}
                    onClick={() => handleModeChange('personas')}
                >
                  👤 Manage Personas
                </button>
                <button
                    className={`mode-menu-item ${mode === 'knowledge' ? 'active' : ''}`}
                    onClick={() => handleModeChange('knowledge')}
                >
                  📚 Knowledge Library
                </button>
                <button
                    className={`mode-menu-item`}
                    onClick={() => setShowNotificationPanel(true)}
                >
                  📭 Notifications
                </button>
              </div>
            </>
        )}
        <div className="app-content">
          {mode === 'ai-vs-ai' && (
              <>
                <ConversationControls
                    isRunning={isRunning}
                    onStart={startConversation}
                    onStop={stopConversation}
                    onSave={saveConversation}
                    onSendMessage={sendMessage}
                    currentModels={currentModels}
                />

                {status && (
                    <div className="status-bar">
                      {status}
                    </div>
                )}

                {activeKnowledgeIds.length > 0 && (
                    <div className="active-knowledge-bar">
                      📚 Using {activeKnowledgeIds.length} knowledge file{activeKnowledgeIds.length > 1 ? 's' : ''}
                    </div>
                )}

                <div className="messages-container">
                  {messages.map((msg) => (
                      <ChatMessage key={msg.id} message={msg} mode={mode} />
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              </>
          )}

          {mode === 'group' && (
              <GroupChat
                  activeKnowledgeIds={activeKnowledgeIds}
              />
          )}

          {mode === 'chat' && (
              <ChatMode
                  activeKnowledgeIds={activeKnowledgeIds}
                  onToggleKnowledge={toggleKnowledge}
                  onOpenMenu={handleOpenMenu}
                  onRequestExport={handleExportHandlerReady}
                  initialPersonaId={selectedPersonaForChat}
              />
          )}

          {mode === 'personas' && (
              <PersonaList
                  onSelectPersona={handleSelectPersona}
                  onEditPersona={handleEditPersona}
                  onNewPersona={handleNewPersona}
                  onMemory={handleMemory}
              />
          )}

          {mode === 'knowledge' && (
              <KnowledgeBase
                  activeKnowledgeIds={activeKnowledgeIds}
                  onToggleKnowledge={toggleKnowledge}
              />
          )}

          {mode === 'memory' && (
              <MemoryPanel />
          )}
        </div>

        {showPersonaEditor && (
            <PersonaEditor
                persona={editingPersona}
                onSave={handleSavePersona}
                onCancel={handleCancelPersona}
            />
        )}
        
        {showMemoryView && memoryViewPersona && (
            <MemoryView
                personaId={memoryViewPersona._id}
                personaName={memoryViewPersona.name}
                personaAvatar={memoryViewPersona.avatar}
                onClose={() => {
                  setShowMemoryView(false);
                  setMemoryViewPersona(null);
                }}
            />
        )}
      </div>
  );
}

export default App;