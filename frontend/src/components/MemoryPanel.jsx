import { useState, useEffect } from 'react';
import axios from 'axios';
import './MemoryPanel.css';
import { API_URL } from '../config';

function MemoryPanel({ personaId, personaName }) {
  const [memory, setMemory] = useState({ manualFacts: [], autoFacts: [] });
  const [newFact, setNewFact] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    console.log('MemoryPanel personaId:', personaId, typeof personaId);
    if (personaId) {
      loadMemory();
    } else {
      console.warn('MemoryPanel: No personaId provided');
      setLoading(false);
    }
  }, [personaId]);

  const loadMemory = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API_URL}/api/personas/${personaId}/memory`);
      setMemory(response.data);
    } catch (error) {
      console.error('Error loading memory:', error);
    } finally {
      setLoading(false);
    }
  };

  const addManualFact = async () => {
    if (!newFact.trim()) return;

    try {
      setSaving(true);
      await axios.post(`${API_URL}/api/personas/${personaId}/memory/manual`, {
        fact: newFact.trim()
      });
      setNewFact('');
      await loadMemory();
    } catch (error) {
      console.error('Error adding fact:', error);
      alert('Error adding fact: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  const removeManualFact = async (index) => {
    try {
      await axios.delete(`${API_URL}/api/personas/${personaId}/memory/manual/${index}`);
      await loadMemory();
    } catch (error) {
      console.error('Error removing fact:', error);
    }
  };

  const removeAutoFact = async (index) => {
    try {
      await axios.delete(`${API_URL}/api/personas/${personaId}/memory/auto/${index}`);
      await loadMemory();
    } catch (error) {
      console.error('Error removing fact:', error);
    }
  };

  if (loading) {
    return <div className="memory-panel loading">Loading memory...</div>;
  }

  return (
      <div className="memory-panel">
        <div className="memory-header">
          <h3>Memory</h3>
          <span className="memory-count">
          {memory.manualFacts.length + memory.autoFacts.length} facts
        </span>
        </div>

        {/* Manual Facts Section */}
        <div className="memory-section">
          <div className="section-header">
            <h4>📝 Manual Facts</h4>
            <span className="section-desc">Facts you add manually</span>
          </div>

          <div className="add-fact">
            <input
                type="text"
                value={newFact}
                onChange={(e) => setNewFact(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && addManualFact()}
                placeholder={`Add a fact about ${personaName || 'this persona'}...`}
                disabled={saving}
            />
            <button
                onClick={addManualFact}
                disabled={!newFact.trim() || saving}
                className="btn-add"
            >
              {saving ? '...' : '+ Add'}
            </button>
          </div>

          {memory.manualFacts.length === 0 ? (
              <div className="empty-state">
                No manual facts yet. Add important information that should always be remembered.
              </div>
          ) : (
              <div className="facts-list">
                {memory.manualFacts.map((fact, index) => (
                    <div key={index} className="fact-item manual">
                      <span className="fact-text">{fact}</span>
                      <button
                          onClick={() => removeManualFact(index)}
                          className="btn-remove"
                          title="Remove fact"
                      >
                        ✕
                      </button>
                    </div>
                ))}
              </div>
          )}
        </div>

        {/* Auto Facts Section */}
        <div className="memory-section">
          <div className="section-header">
            <h4>🤖 Auto Facts</h4>
            <span className="section-desc">Facts saved by {personaName || 'AI'} during chats</span>
          </div>

          {memory.autoFacts.length === 0 ? (
              <div className="empty-state">
                No auto facts yet. {personaName || 'The AI'} will save important moments during conversations.
              </div>
          ) : (
              <div className="facts-list">
                {memory.autoFacts.map((item, index) => (
                    <div key={index} className="fact-item auto">
                      <div className="fact-content">
                        <span className="fact-text">{item.fact}</span>
                        <span className="fact-meta">
                    {new Date(item.timestamp).toLocaleDateString()} at{' '}
                          {new Date(item.timestamp).toLocaleTimeString()}
                  </span>
                      </div>
                      <button
                          onClick={() => removeAutoFact(index)}
                          className="btn-remove"
                          title="Remove fact"
                      >
                        ✕
                      </button>
                    </div>
                ))}
              </div>
          )}
        </div>
      </div>
  );
}

export default MemoryPanel;