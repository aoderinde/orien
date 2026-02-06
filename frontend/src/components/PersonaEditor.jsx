import { useState, useEffect } from 'react';
import axios from 'axios';
import './PersonaEditor.css';
import { MODELS } from '../models';
import { API_URL } from '../config';
import MemoryPanel from './MemoryPanel';  // ← NEU

function PersonaEditor({ persona, onSave, onCancel }) {
  const [name, setName] = useState('');
  const [model, setModel] = useState(MODELS[0].id);
  const [avatar, setAvatar] = useState('🤖');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [availableKnowledge, setAvailableKnowledge] = useState([]);
  const [selectedKnowledge, setSelectedKnowledge] = useState([]);
  const [isSaving, setIsSaving] = useState(false);

  const emojiOptions = ['🤖', '🎸', '📚', '🎨', '🧠', '💡', '🌟', '🔬', '🎭', '🎯', '🎪', '🎬', '🎤', '🎧', '🎮', '⚡'];

  useEffect(() => {
    loadKnowledgeFiles();

    if (persona) {
      setName(persona.name);
      setModel(persona.model);
      setAvatar(persona.avatar || '🤖');
      setSystemPrompt(persona.systemPrompt || '');
      setSelectedKnowledge(persona.knowledgeIds || []);
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
        knowledgeIds: selectedKnowledge
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

            {/* MEMORY PANEL - NEU */}
            {persona && persona._id && (
                <MemoryPanel
                    personaId={persona._id}
                    personaName={persona.name}
                />
            )}

            {/* Knowledge Files */}
            <div className="form-group">
              <label>Knowledge Files ({selectedKnowledge.length} selected)</label>
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