import { useState, useEffect } from 'react';
import axios from 'axios';
import './PersonaList.css';
import { API_URL } from '../config';

function PersonaList({ onSelectPersona, onEditPersona, onNewPersona }) {
  const [personas, setPersonas] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPersonas();
  }, []);

  useEffect(() => {
    const handleUpdate = () => loadPersonas();
    window.addEventListener('personasUpdated', handleUpdate);
    return () => window.removeEventListener('personasUpdated', handleUpdate);
  }, []);

  const loadPersonas = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/personas`);
      setPersonas(response.data);
    } catch (error) {
      console.error('Error loading personas:', error);
    } finally {
      setLoading(false);
    }
  };

  const deletePersona = async (id) => {
    if (!window.confirm('Delete this persona? This cannot be undone.')) return;

    try {
      await axios.delete(`${API_URL}/api/personas/${id}`);
      setPersonas(personas.filter(p => p._id !== id));
    } catch (error) {
      alert('Error deleting persona: ' + error.message);
    }
  };

  if (loading) {
    return <div className="persona-list-loading">Loading personas...</div>;
  }

  return (
      <div className="persona-list-container">
        <div className="persona-list-header">
          <h2>👤 Personas</h2>
          <button onClick={onNewPersona} className="btn-primary">
            ➕ New Persona
          </button>
        </div>

        {personas.length === 0 ? (
            <div className="empty-personas">
              <h3>No personas yet</h3>
              <p>Create your first AI persona to get started!</p>
              <button onClick={onNewPersona} className="btn-primary">
                Create Persona
              </button>
            </div>
        ) : (
            <div className="personas-grid">
              {personas.map(persona => (
                  <div key={persona._id} className="persona-card">
                    <div className="persona-card-header">
                      <span className="persona-avatar">{persona.avatar}</span>
                      <div className="persona-info">
                        <h3>{persona.name}</h3>
                        <p className="persona-model">{persona.model.split('/')[1] || persona.model}</p>
                      </div>
                    </div>

                    <div className="persona-stats">
                      <span>📚 {persona.knowledgeIds?.length || 0} files</span>
                    </div>

                    {persona.systemPrompt && (
                        <div className="persona-prompt-preview">
                          {persona.systemPrompt.substring(0, 100)}...
                        </div>
                    )}

                    <div className="persona-actions">
                      <button
                          onClick={() => onSelectPersona(persona)}
                          className="btn-secondary"
                      >
                        💬 Chat
                      </button>
                      <button
                          onClick={() => onEditPersona(persona)}
                          className="btn-edit"
                      >
                        ✏️ Edit
                      </button>
                      <button
                          onClick={() => deletePersona(persona._id)}
                          className="btn-delete"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
              ))}
            </div>
        )}
      </div>
  );
}

export default PersonaList;