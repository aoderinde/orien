import {useState, useEffect} from 'react';
import axios from 'axios';
import './PersonaSelector.css';
import {API_URL} from '../config';

function PersonaSelector({selectedPersonaId, onSelectPersona}) {
  const [personas, setPersonas] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPersonas();
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

  const selectedPersona = personas.find(p => p._id === selectedPersonaId);

  if (loading) {
    return <div className="persona-selector-loading">Loading...</div>;
  }

  if (personas.length === 0) {
    return (
        <div className="persona-selector-empty">
          <span>No personas yet. Create one first!</span>
        </div>
    );
  }

  return (
      <div className="persona-selector">
        <label>Persona:</label>
        <select
            value={selectedPersonaId || ''}
            onChange={(e) => onSelectPersona(e.target.value)}
        >
          <option value="">No Persona (Direct Model)</option>
          {personas.map(persona => (
              <option key={persona._id} value={persona._id}>
                {persona.avatar} {persona.name}
              </option>
          ))}
        </select>
      </div>
  );
}

export default PersonaSelector;