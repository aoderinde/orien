import { useState, useEffect } from 'react';
import axios from 'axios';
import './MemoryPanel.css';

import { API_URL } from '../config';

function MemoryPanel() {
  const [facts, setFacts] = useState([]);
  const [newFact, setNewFact] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadMemories();
  }, []);

  const loadMemories = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/memories`);
      setFacts(response.data.facts || []);
    } catch (error) {
      console.error('Error loading memories:', error);
    } finally {
      setLoading(false);
    }
  };

  const addFact = () => {
    if (!newFact.trim()) return;

    setFacts([...facts, newFact.trim()]);
    setNewFact('');
  };

  const removeFact = (index) => {
    setFacts(facts.filter((_, i) => i !== index));
  };

  const saveMemories = async () => {
    setSaving(true);
    try {
      await axios.post(`${API_URL}/api/memories`, { facts });
      alert('✅ Memories saved!');
    } catch (error) {
      alert('Error saving memories: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addFact();
    }
  };

  return (
      <div className="memory-panel">
        <div className="memory-header">
          <h3>🧠 Memory</h3>
          <button
              onClick={saveMemories}
              disabled={saving}
              className="btn-save-memory"
          >
            {saving ? '⏳ Saving...' : '💾 Save'}
          </button>
        </div>

        <div className="memory-info">
          <span className="info-icon">ℹ️</span>
          <span>The AI will remember these facts across all conversations.</span>
        </div>

        {loading ? (
            <div className="loading">Loading memories...</div>
        ) : (
            <>
              <div className="memory-list">
                {facts.length === 0 ? (
                    <div className="empty-memory">
                      <p>No memories yet. Add facts about yourself!</p>
                    </div>
                ) : (
                    facts.map((fact, index) => (
                        <div key={index} className="memory-item">
                          <span className="memory-text">{fact}</span>
                          <button
                              onClick={() => removeFact(index)}
                              className="btn-remove-memory"
                          >
                            ✕
                          </button>
                        </div>
                    ))
                )}
              </div>

              <div className="add-memory">
                <input
                    type="text"
                    value={newFact}
                    onChange={(e) => setNewFact(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder="Add a fact... (e.g., 'I'm a software developer')"
                />
                <button
                    onClick={addFact}
                    disabled={!newFact.trim()}
                    className="btn-add-memory"
                >
                  ➕ Add
                </button>
              </div>
            </>
        )}
      </div>
  );
}

export default MemoryPanel;