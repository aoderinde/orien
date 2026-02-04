import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';
import ChatMessage from './components/ChatMessage';
import ConversationControls from './components/ConversationControls';
import ChatMode from './components/ChatMode';
import GroupChat from './components/GroupChat';
import MemoryPanel from './components/MemoryPanel';
import KnowledgeBase from './components/KnowledgeBase';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

function App() {
  const [mode, setMode] = useState('chat');
  const [showModeMenu, setShowModeMenu] = useState(false); // ← NEW
  const [messages, setMessages] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [ws, setWs] = useState(null);
  const [currentModels, setCurrentModels] = useState(null);
  const messagesEndRef = useRef(null);
  const [activeKnowledgeIds, setActiveKnowledgeIds] = useState([]);

  const handleModeChange = (newMode) => {
    setMode(newMode);
    setShowModeMenu(false); // ← Close menu after selection
  };


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
    // Only scroll if in AI vs AI mode AND messages exist
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
      alert('Error starting conversation: ' + error.message);
    }
  };

  const stopConversation = async () => {
    try {
      await axios.post(`${API_URL}/api/stop`);
      setIsRunning(false);
      setCurrentModels(null);
    } catch (error) {
      alert('Error stopping conversation: ' + error.message);
    }
  };

  const saveConversation = async () => {
    try {
      const response = await axios.post(`${API_URL}/api/save`);
      const { filename, data } = response.data;

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      alert('Error saving conversation: ' + error.message);
    }
  };

  const sendMessage = async (target, message, model) => {
    try {
      if (isRunning) {
        await axios.post(`${API_URL}/api/stop`);
        setIsRunning(false);
      }

      await axios.post(`${API_URL}/api/message`, {
        target,
        message,
        model
      });
    } catch (error) {
      alert('Error sending message: ' + error.message);
    }
  };

  const toggleKnowledge = (id) => {
    setActiveKnowledgeIds(prev =>
        prev.includes(id)
            ? prev.filter(x => x !== id)
            : [...prev, id]
    );
  };

  return (
      <div className="app">
        <header>
          <h1>🤖 Orien 💬</h1>
          <p className="subtitle">
            {mode === 'ai-vs-ai' && 'AI vs AI'}
            {mode === 'group' && 'Group Chat'}
            {mode === 'chat' && 'Chat Mode'}
          </p>
          <button
              className="mode-menu-toggle"
              onClick={() => setShowModeMenu(!showModeMenu)}
          >
            ☰ Modes
          </button>
        </header>

        {showModeMenu && (
            <div className="mode-menu-overlay" onClick={() => setShowModeMenu(false)}>
              <div className="mode-menu" onClick={(e) => e.stopPropagation()}>
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
              </div>
            </div>
        )}

        <div className="mode-toggle">
          <button
              className={`mode-btn ${mode === 'ai-vs-ai' ? 'active' : ''}`}
              onClick={() => setMode('ai-vs-ai')}
          >
            🤖 AI vs AI
          </button>
          <button
              className={`mode-btn ${mode === 'group' ? 'active' : ''}`}
              onClick={() => setMode('group')}
          >
            👥 Group Chat
          </button>
          <button
              className={`mode-btn ${mode === 'chat' ? 'active' : ''}`}
              onClick={() => setMode('chat')}
          >
            💬 Chat Mode
          </button>
        </div>


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
                      <ChatMessage key={msg.id} message={msg} />
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
              />
          )}

          {/* SHARED PANELS - Always at bottom! */}
          <MemoryPanel />
          <KnowledgeBase
              activeKnowledgeIds={activeKnowledgeIds}
              onToggleKnowledge={toggleKnowledge}
          />
        </div>
      </div>
  );
}

export default App;