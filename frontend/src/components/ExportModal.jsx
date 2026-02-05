import { useState } from 'react';
import axios from 'axios';
import './ExportModal.css';
import { exportChatAsText, exportChatAsJSON, exportChatAsMarkdown } from '../utils/exportChat';
import { API_URL } from '../config';

function ExportModal({ messages, conversationTitle, personaName, personaId, onClose }) {
  const [format, setFormat] = useState('txt');
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [saveToKnowledge, setSaveToKnowledge] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);

    try {
      let content;
      let filename;
      let mimeType;

      // Generate content based on format
      switch (format) {
        case 'txt':
          content = generateTextContent();
          filename = `${conversationTitle.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.txt`;
          mimeType = 'text/plain';
          break;
        case 'json':
          content = generateJSONContent();
          filename = `${conversationTitle.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.json`;
          mimeType = 'application/json';
          break;
        case 'md':
          content = generateMarkdownContent();
          filename = `${conversationTitle.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.md`;
          mimeType = 'text/markdown';
          break;
        default:
          content = generateTextContent();
          filename = `${conversationTitle.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.txt`;
          mimeType = 'text/plain';
      }

      // Save to knowledge base if checked
      if (saveToKnowledge) {
        await uploadToKnowledge(content, filename, mimeType);
      } else {
        // Regular download
        downloadFile(content, filename, mimeType);
      }

      setTimeout(() => {
        setExporting(false);
        onClose();
      }, 500);

    } catch (error) {
      alert('Error exporting: ' + error.message);
      setExporting(false);
    }
  };

  const generateTextContent = () => {
    let content = '';
    content += '=================================\n';
    content += 'CONVERSATION EXPORT\n';
    content += '=================================\n';
    if (personaName) {
      content += `Persona: ${personaName}\n`;
    }
    content += `Title: ${conversationTitle}\n`;
    content += `Date: ${new Date().toISOString().split('T')[0]}\n`;
    content += `Messages: ${messages.length}\n`;
    content += '=================================\n\n';

    messages.forEach(msg => {
      const time = includeTimestamps ? `[${new Date(msg.timestamp).toLocaleString()}] ` : '';
      const speaker = msg.role === 'user' ? 'You' : (personaName || 'AI');
      content += `${time}${speaker}:\n${msg.content}\n\n`;
    });

    content += '=================================\n';
    content += 'END OF EXPORT\n';
    content += '=================================\n';

    return content;
  };

  const generateJSONContent = () => {
    const exportData = {
      title: conversationTitle,
      persona: personaName || null,
      exportDate: new Date().toISOString(),
      messageCount: messages.length,
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        timestamp: includeTimestamps ? msg.timestamp : undefined,
        model: msg.model
      }))
    };
    return JSON.stringify(exportData, null, 2);
  };

  const generateMarkdownContent = () => {
    let content = '';
    content += `# ${conversationTitle}\n\n`;
    if (personaName) {
      content += `**Persona:** ${personaName}\n\n`;
    }
    content += `**Date:** ${new Date().toISOString().split('T')[0]}\n\n`;
    content += `**Messages:** ${messages.length}\n\n`;
    content += '---\n\n';

    messages.forEach(msg => {
      const time = includeTimestamps ? ` · *${new Date(msg.timestamp).toLocaleString()}*` : '';
      const speaker = msg.role === 'user' ? '**You**' : `**${personaName || 'AI'}**`;
      content += `### ${speaker}${time}\n\n`;
      content += `${msg.content}\n\n`;
    });

    content += '---\n\n';
    content += '*End of conversation*\n';

    return content;
  };

  const uploadToKnowledge = async (content, filename, mimeType) => {
    const blob = new Blob([content], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, filename);
    formData.append('title', filename);

    const response = await axios.post(`${API_URL}/api/knowledge-base/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });

    // If persona is active, assign the file to the persona
    if (personaId && response.data.id) {
      await axios.post(`${API_URL}/api/personas/${personaId}/knowledge`, {
        knowledgeId: response.data.id
      });
    }

    alert(`✅ Saved to Knowledge Base${personaId ? ` and assigned to ${personaName}` : ''}!`);
  };

  const downloadFile = (content, filename, mimeType) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
      <div className="export-modal-overlay" onClick={onClose}>
        <div className="export-modal" onClick={(e) => e.stopPropagation()}>
          <div className="export-header">
            <h3>📥 Export Conversation</h3>
            <button onClick={onClose} className="btn-close">✕</button>
          </div>

          <div className="export-content">
            <div className="export-info">
              <p><strong>{conversationTitle}</strong></p>
              <p className="export-meta">
                {messages.length} messages
                {personaName && ` • Persona: ${personaName}`}
              </p>
            </div>

            <div className="export-format">
              <label>Format:</label>
              <div className="format-options">
                <button
                    className={`format-btn ${format === 'txt' ? 'active' : ''}`}
                    onClick={() => setFormat('txt')}
                >
                  📄 Plain Text (.txt)
                  <span className="format-desc">Simple, readable format</span>
                </button>
                <button
                    className={`format-btn ${format === 'md' ? 'active' : ''}`}
                    onClick={() => setFormat('md')}
                >
                  📝 Markdown (.md)
                  <span className="format-desc">Formatted with headers</span>
                </button>
                <button
                    className={`format-btn ${format === 'json' ? 'active' : ''}`}
                    onClick={() => setFormat('json')}
                >
                  🗂️ JSON (.json)
                  <span className="format-desc">Structured data format</span>
                </button>
              </div>
            </div>

            <div className="export-options">
              <label className="checkbox-label">
                <input
                    type="checkbox"
                    checked={includeTimestamps}
                    onChange={(e) => setIncludeTimestamps(e.target.checked)}
                />
                <span>Include timestamps</span>
              </label>

              <label className="checkbox-label knowledge-checkbox">
                <input
                    type="checkbox"
                    checked={saveToKnowledge}
                    onChange={(e) => setSaveToKnowledge(e.target.checked)}
                />
                <span>
                💾 Save to Knowledge Base
                  {personaId && personaName && (
                      <span className="persona-assignment">
                    → Assign to {personaName}
                  </span>
                  )}
              </span>
              </label>
            </div>
          </div>

          <div className="export-footer">
            <button onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button
                onClick={handleExport}
                disabled={exporting}
                className="btn-primary"
            >
              {exporting ? '⏳ Exporting...' : (saveToKnowledge ? '💾 Save' : '📥 Download')}
            </button>
          </div>
        </div>
      </div>
  );
}

export default ExportModal;