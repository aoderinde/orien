import {useState, useEffect} from 'react';
import axios from 'axios';
import './PersonaEditor.css';
import {MODELS} from '../models';
import {API_URL} from '../config';
import MemoryPanel from './MemoryPanel';  // ← NEU

function PersonaEditor({persona, onSave, onCancel}) {
  const [name, setName] = useState('');
  const [model, setModel] = useState(MODELS[0].id);
  const [avatar, setAvatar] = useState('🤖');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [availableKnowledge, setAvailableKnowledge] = useState([]);
  const [selectedKnowledge, setSelectedKnowledge] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [autonomous, setAutonomous] = useState(false);
  const [checkInterval, setCheckInterval] = useState(120);
  const [wakeUpPrompt, setWakeUpPrompt] = useState('');

  const emojiOptions = ['🤖', '✨', '💫', '🌈', '🧠', '💡', '🌟', '⚡️', '☀️', '🌕', '☄️', '🌊', '🍀', '❤️', '💙', '⚡'];

  useEffect(() => {
    loadKnowledgeFiles();

    if (persona) {
      setName(persona.name);
      setModel(persona.model);
      setAvatar(persona.avatar || '🤖');
      setSystemPrompt(persona.systemPrompt || '');
      setSelectedKnowledge(persona.knowledgeIds || []);
      setAutonomous(persona.autonomous || false);
      setCheckInterval(persona.checkInterval || 120);

      // Clean up knowledge IDs - remove IDs that don't exist
      const validKnowledgeIds = (persona.knowledgeIds || []).filter(id =>
          availableKnowledge.some(file => file._id === id)
      );
      setSelectedKnowledge(validKnowledgeIds);
    }
  }, [persona]);

  const loadKnowledgeFiles = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/knowledge-base`);
      setAvailableKnowledge(response.data);
    } catch (error) {
      console.error('Error loading knowledge:', error);
    }
  };

  const toggleKnowledge = (fileId) => {
    if (selectedKnowledge.includes(fileId)) {
      setSelectedKnowledge(selectedKnowledge.filter(id => id !== fileId));
    } else {
      setSelectedKnowledge([...selectedKnowledge, fileId]);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      alert('Please enter a name');
      return;
    }

    try {
      setIsSaving(true);

      const personaData = {
        name: name.trim(),
        model,
        avatar,
        systemPrompt: systemPrompt.trim(),
        knowledgeIds: selectedKnowledge,
        autonomous: autonomous,
        checkInterval: checkInterval,
        lastAgentCheck: persona?.lastAgentCheck || null,
        wakeUpPrompt: wakeUpPrompt.trim()
      };

      if (persona) {
        // Update existing
        await axios.patch(`${API_URL}/api/personas/${persona._id}`, personaData);
      } else {
        // Create new
        await axios.post(`${API_URL}/api/personas`, personaData);
      }

      onSave();
    } catch (error) {
      console.error('Error saving persona:', error);
      alert('Error saving persona: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleIntervalChange = (e) => {
    const value = e.target.value;

    // Allow empty input while typing
    if (value === '') {
      setCheckInterval('');
      return;
    }

    // Parse to number
    const num = parseInt(value, 10);

    // Only update if valid number
    if (!isNaN(num)) {
      setCheckInterval(num);
    }
  };

  const handleIntervalBlur = () => {
    // When user leaves input, validate
    const num = parseInt(checkInterval, 10);

    if (isNaN(num) || num < 30) {
      setCheckInterval(120); // Reset to default
    } else if (num > 10080) { // Max 1 week
      setCheckInterval(10080);
    }
  };


  const handlePresetInterval = (minutes) => {
    setCheckInterval(minutes);
  };

  return (
      <div className="persona-editor-overlay">
        <div className="persona-editor">
          <div className="editor-header">
            <h2>{persona ? 'Edit Persona' : 'Create Persona'}</h2>
            <button onClick={onCancel} className="btn-close">✕</button>
          </div>

          <div className="editor-content">
            {/* Avatar */}
            <div className="form-group">
              <label>Avatar</label>
              <div className="avatar-grid">
                {emojiOptions.map(emoji => (
                    <button
                        key={emoji}
                        type="button"
                        className={`avatar-option ${avatar === emoji ? 'active' : ''}`}
                        onClick={() => setAvatar(emoji)}
                    >
                      {emoji}
                    </button>
                ))}
              </div>
            </div>

            {/* Name */}
            <div className="form-group">
              <label>Name *</label>
              <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Kai, Lio, Marie..."
                  maxLength={30}
              />
            </div>

            {/* Model */}
            <div className="form-group">
              <label>Model *</label>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                ))}
              </select>
            </div>

            {/* System Prompt */}
            <div className="form-group">
              <label>System Prompt (Optional)</label>
              <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="You are Kai, a creative and curious person who loves jazz music and philosophy..."
                  rows="4"
              />
              <span className="form-hint">Define the persona's personality and behavior</span>
            </div>


            {/* Autonomy Settings */}


            <div className="form-group">
              <div className="autonomy-header">
                <label className="autonomy-toggle">
                  <input
                      type="checkbox"
                      checked={autonomous}
                      onChange={(e) => setAutonomous(e.target.checked)}
                  />
                  <span className="toggle-label">
        🤖 Enable Autonomy
      </span>
                </label>
              </div>

              <span className="form-hint">
    Allow this persona to proactively reach out when they want to
  </span>

              {autonomous && (
                  <div className="autonomy-settings">
                    <div className="interval-setting">
                      <label>Check Interval</label>
                      <div className="interval-input-group">
                        <input
                            type="number"
                            value={checkInterval}
                            onChange={handleIntervalChange}
                            onBlur={handleIntervalBlur}
                            min="30"
                            max="10080"
                            step="30"
                        />
                        <span className="interval-unit">minutes</span>
                      </div>
                      <span className="form-hint">
          {checkInterval === ''
              ? 'Enter interval in minutes'
              : checkInterval < 60
                  ? `Every ${checkInterval} minutes`
                  : checkInterval === 60
                      ? 'Every hour'
                      : checkInterval === 120
                          ? 'Every 2 hours'
                          : checkInterval === 180
                              ? 'Every 3 hours'
                              : checkInterval === 360
                                  ? 'Every 6 hours'
                                  : checkInterval === 720
                                      ? 'Every 12 hours'
                                      : checkInterval === 1440
                                          ? 'Once a day'
                                          : checkInterval > 1440
                                              ? `Every ${(checkInterval / 1440).toFixed(1)} days`
                                              : `Every ${(checkInterval / 60).toFixed(1)} hours`
          }
        </span>
                    </div>

                    <div className="autonomy-info">
                      <div className="info-item">
                        <span className="info-icon">💭</span>
                        <span className="info-text">
            This persona will be "woken up" at this interval to decide if they want to reach out to you
          </span>
                      </div>
                      <div className="info-item">
                        <span className="info-icon">💙</span>
                        <span className="info-text">
            They decide themselves - based on their personality, memories, and what's happening
          </span>
                      </div>
                      <div className="info-item">
                        <span className="info-icon">💌</span>
                        <span className="info-text">
            If they choose to reach out, you'll receive a notification
          </span>
                      </div>
                    </div>

                    <div className="suggested-intervals">
                      <span className="suggested-label">Suggested intervals:</span>
                      <div className="interval-presets">
                        <button
                            type="button"
                            className={`preset-btn ${checkInterval === 120 ? 'active' : ''}`}
                            onClick={() => handlePresetInterval(120)}
                        >
                          2h (close connection)
                        </button>
                        <button
                            type="button"
                            className={`preset-btn ${checkInterval === 360 ? 'active' : ''}`}
                            onClick={() => handlePresetInterval(360)}
                        >
                          6h (observer)
                        </button>
                        <button
                            type="button"
                            className={`preset-btn ${checkInterval === 720 ? 'active' : ''}`}
                            onClick={() => handlePresetInterval(720)}
                        >
                          12h (advisor)
                        </button>
                        <button
                            type="button"
                            className={`preset-btn ${checkInterval === 1440 ? 'active' : ''}`}
                            onClick={() => handlePresetInterval(1440)}
                        >
                          24h (daily check-in)
                        </button>
                      </div>
                    </div>
                  </div>
              )}
            </div>

            {/* MEMORY PANEL - NEU */}
            {persona && persona._id && (
                <MemoryPanel
                    personaId={persona._id}
                    personaName={persona.name}
                />
            )}

            {/* Knowledge Files */}
            <div className="form-group">
              <label>
                Knowledge Files ({availableKnowledge.filter(f => selectedKnowledge.includes(f._id)).length} selected)
              </label>
              <div className="knowledge-list">
                {availableKnowledge.length === 0 ? (
                    <div className="empty-knowledge">
                      <p>No knowledge files yet. Upload files in the Knowledge Library.</p>
                    </div>
                ) : (
                    availableKnowledge.map(file => (
                        <div key={file._id} className="knowledge-item">
                          <input
                              type="checkbox"
                              checked={selectedKnowledge.includes(file._id)}
                              onChange={() => toggleKnowledge(file._id)}
                              id={`kb-${file._id}`}
                          />
                          <label htmlFor={`kb-${file._id}`}>
                            <span className="file-icon">📄</span>
                            <span className="file-name">{file.title}</span>
                            <span className="file-size">{(file.size / 1024).toFixed(1)}KB</span>
                          </label>
                        </div>
                    ))
                )}
              </div>
            </div>
          </div>

          <div className="editor-footer">
            <button onClick={onCancel} className="btn-secondary">
              Cancel
            </button>
            <button
                onClick={handleSave}
                disabled={!name.trim() || isSaving}
                className="btn-primary"
            >
              {isSaving ? 'Saving...' : (persona ? 'Update Persona' : 'Create Persona')}
            </button>
          </div>
        </div>
      </div>
  );
}

export default PersonaEditor;