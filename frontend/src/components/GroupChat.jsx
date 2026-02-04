import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import './GroupChat.css';
import { MODELS } from '../models';

import { API_URL } from '../config';

function GroupChat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [model1, setModel1] = useState('anthropic/claude-sonnet-4.5');
  const [model2, setModel2] = useState('openai/gpt-4o');
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [smartMode, setSmartMode] = useState(true); // true = Smart, false = Simple
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingText, setThinkingText] = useState('');
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const getModelName = (modelId) => {
    const model = MODELS.find(m => m.id === modelId);
    return model ? model.name : modelId;
  };

  const startGroupChat = async (initialPrompt) => {
    if (!initialPrompt.trim()) return;

    setMessages([]);
    setIsRunning(true);
    setIsPaused(false);

    // Add initial prompt as user message
    const userMsg = {
      role: 'user',
      content: initialPrompt,
      timestamp: new Date().toISOString(),
      speaker: 'You'
    };

    setMessages([userMsg]);

    // Start the conversation
    if (smartMode) {
      runSmartConversation([userMsg]);
    } else {
      runSimpleConversation([userMsg]);
    }
  };

  const runSimpleConversation = async (history) => {
    let currentHistory = [...history];

    while (isRunning && !isPaused) {
      // AI #1's turn
      setIsThinking(true);
      setThinkingText(`${getModelName(model1)} is typing...`);

      const response1 = await callAI(model1, currentHistory);
      const msg1 = {
        role: 'assistant',
        content: response1,
        timestamp: new Date().toISOString(),
        speaker: getModelName(model1),
        model: model1
      };

      currentHistory = [...currentHistory, msg1];
      setMessages(currentHistory);
      setIsThinking(false);

      await sleep(1500);

      if (!isRunning || isPaused) break;

      // AI #2's turn
      setIsThinking(true);
      setThinkingText(`${getModelName(model2)} is typing...`);

      const response2 = await callAI(model2, currentHistory);
      const msg2 = {
        role: 'assistant',
        content: response2,
        timestamp: new Date().toISOString(),
        speaker: getModelName(model2),
        model: model2
      };

      currentHistory = [...currentHistory, msg2];
      setMessages(currentHistory);
      setIsThinking(false);

      await sleep(1500);
    }
  };

  const runSmartConversation = async (history) => {
    let currentHistory = [...history];

    while (isRunning && !isPaused) {
      // Decide who should respond
      setIsThinking(true);
      setThinkingText('💭 Deciding who should respond...');

      const decision = await decideWhoResponds(currentHistory);

      if (decision.next === 'model1' || decision.next === 'both') {
        setThinkingText(`${getModelName(model1)} is typing...`);
        const response1 = await callAI(model1, currentHistory);
        const msg1 = {
          role: 'assistant',
          content: response1,
          timestamp: new Date().toISOString(),
          speaker: getModelName(model1),
          model: model1
        };
        currentHistory = [...currentHistory, msg1];
        setMessages(currentHistory);
        await sleep(1000);
      }

      if (decision.next === 'model2' || decision.next === 'both') {
        setThinkingText(`${getModelName(model2)} is typing...`);
        const response2 = await callAI(model2, currentHistory);
        const msg2 = {
          role: 'assistant',
          content: response2,
          timestamp: new Date().toISOString(),
          speaker: getModelName(model2),
          model: model2
        };
        currentHistory = [...currentHistory, msg2];
        setMessages(currentHistory);
        await sleep(1000);
      }

      setIsThinking(false);

      // Pause after each round in smart mode to allow user to jump in
      await sleep(2000);

      if (!isRunning) break;
    }
  };

  const decideWhoResponds = async (history) => {
    const recentMessages = history.slice(-5).map(m =>
        `${m.speaker}: ${m.content.substring(0, 200)}...`
    ).join('\n');

    const prompt = `You are a conversation coordinator for a group chat.

Participants:
- User (human)
- ${getModelName(model1)} (AI #1)
- ${getModelName(model2)} (AI #2)

Recent conversation:
${recentMessages}

Last message: "${history[history.length - 1].speaker}: ${history[history.length - 1].content.substring(0, 100)}..."

Decide who should respond next. Rules:
- If User asks a direct question, both AIs should respond
- If User uses @mention, only that AI responds  
- If one AI just spoke, usually the other should respond
- Keep conversation balanced
- Sometimes both can respond to create dialogue

Respond ONLY with valid JSON (no markdown):
{"next": "model1" or "model2" or "both", "reason": "brief explanation"}`;

    try {
      const response = await axios.post(`${API_URL}/api/chat`, {
        model: 'openai/gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }]
      });

      const text = response.data.message.trim();
      // Remove markdown code blocks if present
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('Decision error:', error);
      // Fallback to simple alternating
      const lastAI = history[history.length - 1].model;
      return {
        next: lastAI === model1 ? 'model2' : 'model1',
        reason: 'fallback'
      };
    }
  };

  const callAI = async (model, history) => {
    const apiMessages = history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    }));

    const response = await axios.post(`${API_URL}/api/chat`, {
      model: model,
      messages: apiMessages
    });

    return response.data.message;
  };

  const sendUserMessage = async () => {
    if (!input.trim()) return;

    const userMsg = {
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
      speaker: 'You'
    };

    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput('');

    // Pause auto-conversation when user writes
    if (isRunning) {
      setIsPaused(true);
    }

    // Both AIs respond to user (in simple mode)
    if (!smartMode) {
      setIsThinking(true);

      setThinkingText(`${getModelName(model1)} is typing...`);
      const response1 = await callAI(model1, newHistory);
      const msg1 = {
        role: 'assistant',
        content: response1,
        timestamp: new Date().toISOString(),
        speaker: getModelName(model1),
        model: model1
      };
      const history1 = [...newHistory, msg1];
      setMessages(history1);

      await sleep(1000);

      setThinkingText(`${getModelName(model2)} is typing...`);
      const response2 = await callAI(model2, history1);
      const msg2 = {
        role: 'assistant',
        content: response2,
        timestamp: new Date().toISOString(),
        speaker: getModelName(model2),
        model: model2
      };
      setMessages([...history1, msg2]);

      setIsThinking(false);
    } else {
      // In smart mode, let the AI decide
      runSmartConversation(newHistory);
    }
  };

  const continueConversation = () => {
    setIsPaused(false);
    if (smartMode) {
      runSmartConversation(messages);
    } else {
      runSimpleConversation(messages);
    }
  };

  const stopConversation = () => {
    setIsRunning(false);
    setIsPaused(false);
    setIsThinking(false);
  };

  const clearChat = () => {
    if (window.confirm('Clear all messages?')) {
      setMessages([]);
      setIsRunning(false);
      setIsPaused(false);
    }
  };

  const saveChat = () => {
    const timestamp = new Date().toISOString();
    const filename = `group-chat_${timestamp}.json`;

    const data = {
      mode: smartMode ? 'smart' : 'simple',
      model1: model1,
      model2: model2,
      messages: messages,
      timestamp: timestamp
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendUserMessage();
    }
  };

  return (
      <div className="group-chat">
        <div className="group-chat-header">
          <div className="participants">
            <div className="participant user">
              <span className="avatar">👤</span>
              <span className="name">You</span>
            </div>
            <div className="participant ai">
              <span className="avatar">🤖</span>
              <span className="name">{getModelName(model1)}</span>
            </div>
            <div className="participant ai">
              <span className="avatar">🤖</span>
              <span className="name">{getModelName(model2)}</span>
            </div>
          </div>

          <div className="mode-toggle-small">
            <button
                className={`mode-btn-small ${!smartMode ? 'active' : ''}`}
                onClick={() => setSmartMode(false)}
                disabled={isRunning}
            >
              ⚡ Simple
            </button>
            <button
                className={`mode-btn-small ${smartMode ? 'active' : ''}`}
                onClick={() => setSmartMode(true)}
                disabled={isRunning}
            >
              🧠 Smart
            </button>
          </div>
        </div>

        {!isRunning && messages.length === 0 && (
            <div className="group-chat-setup">
              <h3>🎉 Start Group Chat</h3>
              <div className="model-selection-compact">
                <select value={model1} onChange={(e) => setModel1(e.target.value)}>
                  {MODELS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <span className="vs-text">+</span>
                <select value={model2} onChange={(e) => setModel2(e.target.value)}>
                  {MODELS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <textarea
                  placeholder="Start topic: e.g., 'Let's discuss AI ethics...'"
                  rows="3"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
              />
              <button
                  className="btn-primary"
                  onClick={() => startGroupChat(input)}
                  disabled={!input.trim()}
              >
                🚀 Start Group Chat
              </button>
            </div>
        )}

        {messages.length > 0 && (
            <>
              <div className="group-messages">
                {messages.map((msg, idx) => (
                    <div key={idx} className={`group-message ${msg.role}`}>
                      <div className="message-avatar">
                        {msg.role === 'user' ? '👤' : '🤖'}
                      </div>
                      <div className="message-bubble">
                        <div className="message-sender">{msg.speaker}</div>
                        <div className="message-text">{msg.content}</div>
                        <div className="message-time">
                          {new Date(msg.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                    </div>
                ))}

                {isThinking && (
                    <div className="group-message assistant thinking">
                      <div className="message-avatar">💭</div>
                      <div className="message-bubble">
                        <div className="message-sender">{thinkingText}</div>
                        <div className="typing-indicator">
                          <span></span><span></span><span></span>
                        </div>
                      </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              <div className="group-controls">
                <button
                    onClick={continueConversation}
                    disabled={!isPaused && isRunning}
                    className="btn-primary"
                >
                  ▶️ Continue
                </button>
                <button
                    onClick={stopConversation}
                    disabled={!isRunning}
                    className="btn-danger"
                >
                  ⏹️ Stop
                </button>
                <button onClick={saveChat} className="btn-success">
                  💾 Save
                </button>
                <button onClick={clearChat} className="btn-secondary">
                  🗑️ Clear
                </button>
              </div>

              <div className="group-input">
            <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your message... (Enter to send)"
                rows="2"
            />
                <button
                    onClick={sendUserMessage}
                    disabled={!input.trim()}
                    className="btn-primary"
                >
                  📤 Send
                </button>
              </div>
            </>
        )}
      </div>
  );
}

export default GroupChat;