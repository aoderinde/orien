import { useState } from 'react';
import './ConversationControls.css';
import { MODELS } from '../models';

function ConversationControls({ isRunning, onStart, onStop, onSave, onSendMessage, currentModels }) {
  const [initialPrompt, setInitialPrompt] = useState('Hallo! Lass uns über die Zukunft der KI sprechen.');
  const [maxRounds, setMaxRounds] = useState(5);
  const [userMessage, setUserMessage] = useState('');
  const [selectedTarget, setSelectedTarget] = useState('model1'); // 'model1' or 'model2'

  // Model selection for AI vs AI
  const [model1, setModel1] = useState('anthropic/claude-sonnet-4.5');
  const [model2, setModel2] = useState('openai/gpt-4o');

  const handleStart = () => {
    if (initialPrompt.trim()) {
      onStart(initialPrompt, maxRounds, model1, model2);
    }
  };

  const handleSendMessage = () => {
    if (userMessage.trim()) {
      const targetModel = selectedTarget === 'model1' ? model1 : model2;
      onSendMessage(selectedTarget, userMessage, targetModel);
      setUserMessage('');
    }
  };

  const getModelName = (modelId) => {
    const model = MODELS.find(m => m.id === modelId);
    return model ? model.name : modelId;
  };

  // Use current running models if available, otherwise use selected models
  const displayModel1 = currentModels?.model1 || model1;
  const displayModel2 = currentModels?.model2 || model2;

  return (
      <div className="controls">
        <div className="control-group">
          <h3>🤖 Select AI Models</h3>
          <div className="model-selection-grid">
            <div className="model-select-box">
              <label>AI #1:</label>
              <select
                  value={model1}
                  onChange={(e) => setModel1(e.target.value)}
                  disabled={isRunning}
              >
                {MODELS.map(model => (
                    <option key={model.id} value={model.id}>
                      {model.name} - {model.provider}
                    </option>
                ))}
              </select>
              <span className="model-description">
              {MODELS.find(m => m.id === model1)?.description}
            </span>
            </div>

            <div className="vs-divider">VS</div>

            <div className="model-select-box">
              <label>AI #2:</label>
              <select
                  value={model2}
                  onChange={(e) => setModel2(e.target.value)}
                  disabled={isRunning}
              >
                {MODELS.map(model => (
                    <option key={model.id} value={model.id}>
                      {model.name} - {model.provider}
                    </option>
                ))}
              </select>
              <span className="model-description">
              {MODELS.find(m => m.id === model2)?.description}
            </span>
            </div>
          </div>
        </div>

        <div className="control-group">
          <h3>Start Conversation</h3>
          <textarea
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder="Initial prompt..."
              rows="3"
              disabled={isRunning}
          />
          <div className="inline-controls">
            <label>
              Max Rounds:
              <input
                  type="number"
                  value={maxRounds}
                  onChange={(e) => setMaxRounds(e.target.value)}
                  min="1"
                  max="50"
                  disabled={isRunning}
              />
            </label>
            <button onClick={handleStart} disabled={isRunning} className="btn-primary">
              ▶️ Start
            </button>
            <button onClick={onStop} disabled={!isRunning} className="btn-danger">
              ⏹️ Stop
            </button>
            <button onClick={onSave} className="btn-success">
              💾 Save
            </button>
          </div>
          {isRunning && (
              <div className="current-matchup">
                <strong>Current Match:</strong> {getModelName(displayModel1)} vs {getModelName(displayModel2)}
              </div>
          )}
        </div>

        <div className="control-group">
          <h3>💬 Interrupt & Send Message</h3>
          <div className="interrupt-info">
            <span className="info-icon">ℹ️</span>
            <span>Send a message to one of the AIs. This will pause the conversation.</span>
          </div>
          <div className="message-controls">
            <select
                value={selectedTarget}
                onChange={(e) => setSelectedTarget(e.target.value)}
                disabled={!isRunning}
            >
              <option value="model1">
                {getModelName(displayModel1)} (AI #1)
              </option>
              <option value="model2">
                {getModelName(displayModel2)} (AI #2)
              </option>
            </select>
            <input
                type="text"
                value={userMessage}
                onChange={(e) => setUserMessage(e.target.value)}
                placeholder={isRunning ? "Your message..." : "Start a conversation first..."}
                onKeyPress={(e) => e.key === 'Enter' && isRunning && handleSendMessage()}
                disabled={!isRunning}
            />
            <button
                onClick={handleSendMessage}
                className="btn-secondary"
                disabled={!isRunning || !userMessage.trim()}
            >
              📤 Send
            </button>
          </div>
        </div>
      </div>
  );
}

export default ConversationControls;