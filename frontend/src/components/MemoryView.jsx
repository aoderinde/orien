import { useState, useEffect } from 'react';
import axios from 'axios';
import { API_URL } from '../config';
import './MemoryView.css';

function MemoryView({ personaId, personaName, personaAvatar, onClose }) {
  const [memory, setMemory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newFact, setNewFact] = useState('');
  const [activeTab, setActiveTab] = useState('facts');
  const [conversations, setConversations] = useState({});

  useEffect(() => {
    loadMemory();
    loadConversations();
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

  const loadConversations = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/conversations`);
      const convMap = {};
      response.data.forEach(conv => {
        convMap[conv._id] = conv.title || 'Untitled';
      });
      setConversations(convMap);
    } catch (error) {
      console.error('Error loading conversations:', error);
    }
  };

  const addFact = async () => {
    if (!newFact.trim()) return;
    
    try {
      await axios.post(`${API_URL}/api/personas/${personaId}/memory/facts`, {
        fact: newFact.trim()
      });
      setNewFact('');
      loadMemory();
    } catch (error) {
      console.error('Error adding fact:', error);
    }
  };

  const deleteFact = async (index) => {
    if (!window.confirm('Diesen Fact wirklich löschen?')) return;
    
    try {
      await axios.delete(`${API_URL}/api/personas/${personaId}/memory/facts/${index}`);
      loadMemory();
    } catch (error) {
      console.error('Error deleting fact:', error);
    }
  };

  const deleteSummary = async (index) => {
    if (!window.confirm('Diese Summary wirklich löschen?')) return;
    
    try {
      await axios.delete(`${API_URL}/api/personas/${personaId}/memory/summaries/${index}`);
      loadMemory();
    } catch (error) {
      console.error('Error deleting summary:', error);
    }
  };

  // Group summaries by conversation
  const groupSummariesByConversation = (summaries) => {
    const grouped = {};
    summaries.forEach((summary, index) => {
      const convId = summary.conversationId || 'unknown';
      if (!grouped[convId]) {
        grouped[convId] = [];
      }
      grouped[convId].push({ ...summary, originalIndex: index });
    });
    return grouped;
  };

  if (loading) {
    return (
      <div className="memory-view-overlay">
        <div className="memory-view">
          <div className="memory-loading">Loading memory...</div>
        </div>
      </div>
    );
  }

  const groupedSummaries = memory?.summaries ? groupSummariesByConversation(memory.summaries) : {};

  return (
    <div className="memory-view-overlay" onClick={onClose}>
      <div className="memory-view" onClick={e => e.stopPropagation()}>
        <div className="memory-header">
          <h2>{personaAvatar} {personaName}'s Memory</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="memory-tabs">
          <button 
            className={`tab ${activeTab === 'facts' ? 'active' : ''}`}
            onClick={() => setActiveTab('facts')}
          >
            💾 Facts ({memory?.facts?.length || 0})
          </button>
          <button 
            className={`tab ${activeTab === 'summaries' ? 'active' : ''}`}
            onClick={() => setActiveTab('summaries')}
          >
            📝 Summaries ({memory?.summaries?.length || 0})
          </button>
          <button 
            className={`tab ${activeTab === 'legacy' ? 'active' : ''}`}
            onClick={() => setActiveTab('legacy')}
          >
            📦 Legacy ({(memory?.manualFacts?.length || 0) + (memory?.autoFacts?.length || 0)})
          </button>
        </div>

        <div className="memory-content">
          {activeTab === 'facts' && (
            <div className="facts-section">
              <div className="add-fact">
                <input
                  type="text"
                  value={newFact}
                  onChange={(e) => setNewFact(e.target.value)}
                  placeholder="Neuen Fact hinzufügen..."
                  onKeyPress={(e) => e.key === 'Enter' && addFact()}
                />
                <button onClick={addFact}>+</button>
              </div>
              
              {memory?.facts?.length === 0 ? (
                <div className="empty-state">Keine Facts gespeichert</div>
              ) : (
                <div className="facts-list">
                  {memory?.facts?.map((fact, index) => (
                    <div key={index} className="memory-item fact">
                      <div className="memory-text">{fact.fact}</div>
                      <div className="memory-meta">
                        <span className="timestamp">
                          {new Date(fact.timestamp).toLocaleDateString('de-DE')}
                        </span>
                        <button 
                          className="delete-btn"
                          onClick={() => deleteFact(index)}
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'summaries' && (
            <div className="summaries-section">
              {Object.keys(groupedSummaries).length === 0 ? (
                <div className="empty-state">Keine Summaries gespeichert</div>
              ) : (
                Object.entries(groupedSummaries).map(([convId, summaries]) => (
                  <div key={convId} className="conversation-group">
                    <div className="conversation-header">
                      📁 {conversations[convId] || `Conversation ${convId.substring(0, 8)}...`}
                    </div>
                    <div className="summaries-list">
                      {summaries.map((summary, idx) => (
                        <div key={idx} className="memory-item summary">
                          <div className="memory-text">{summary.text}</div>
                          <div className="memory-meta">
                            <button 
                              className="delete-btn"
                              onClick={() => deleteSummary(summary.originalIndex)}
                            >
                              🗑️
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'legacy' && (
            <div className="legacy-section">
              <p className="legacy-note">
                Diese Einträge stammen aus dem alten Memory-System und werden nach und nach migriert.
              </p>
              
              {memory?.manualFacts?.length > 0 && (
                <div className="legacy-group">
                  <h4>Manual Facts</h4>
                  {memory.manualFacts.map((fact, index) => (
                    <div key={index} className="memory-item legacy">
                      <div className="memory-text">{fact}</div>
                    </div>
                  ))}
                </div>
              )}
              
              {memory?.autoFacts?.length > 0 && (
                <div className="legacy-group">
                  <h4>Auto Facts</h4>
                  {memory.autoFacts.map((fact, index) => (
                    <div key={index} className="memory-item legacy">
                      <div className="memory-text">{fact.fact}</div>
                      <div className="memory-meta">
                        <span className="timestamp">
                          {new Date(fact.timestamp).toLocaleDateString('de-DE')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              {memory?.currentSummary && (
                <div className="legacy-group">
                  <h4>Current Summary (Legacy)</h4>
                  <div className="memory-item legacy">
                    <div className="memory-text">{memory.currentSummary.summary}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MemoryView;
