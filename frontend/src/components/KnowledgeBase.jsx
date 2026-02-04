import { useState, useEffect } from 'react';
import axios from 'axios';
import './KnowledgeBase.css';

import { API_URL } from '../config';

function KnowledgeBase({ activeKnowledgeIds, onToggleKnowledge }) {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/knowledge-base`);
      setFiles(response.data);
    } catch (error) {
      console.error('Error loading files:', error);
    }
  };

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const isZip = file.name.endsWith('.zip');
    const isTxt = file.name.endsWith('.txt');

    if (!isTxt && !isZip) {
      alert('Only .txt or .zip files allowed!');
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', 'reference');

      const response = await axios.post(`${API_URL}/api/knowledge-base/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      if (response.data.isZip) {
        alert(`✅ ZIP extracted successfully!\n${response.data.filesUploaded} .txt files uploaded.`);
      }

      loadFiles();
      e.target.value = '';
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      alert('Upload error: ' + errorMsg);
    } finally {
      setUploading(false);
    }
  };

  const deleteFile = async (id) => {
    if (!window.confirm('Delete this file?')) return;

    try {
      await axios.delete(`${API_URL}/api/knowledge-base/${id}`);
      setFiles(files.filter(f => f._id !== id));
    } catch (error) {
      alert('Delete error: ' + error.message);
    }
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
      <div className="knowledge-base">
        <div className="kb-header">
          <h3>📚 Knowledge Base</h3>
          <label className="upload-btn">
            {uploading ? '⏳ Uploading...' : '📄 Upload .txt or .zip'}
            <input
                type="file"
                accept=".txt,.zip"
                onChange={handleUpload}
                disabled={uploading}
                style={{ display: 'none' }}
            />
          </label>
        </div>

        {files.length === 0 ? (
            <div className="empty-kb">
              <p>No files yet. Upload text files to use as reference!</p>
            </div>
        ) : (
            <div className="kb-files">
              {files.map(file => (
                  <div key={file._id} className="kb-file">
                    <div className="file-info">
                      <input
                          type="checkbox"
                          checked={activeKnowledgeIds?.includes(file._id)}
                          onChange={() => onToggleKnowledge(file._id)}
                      />
                      <div className="file-details">
                        <span className="file-title">{file.title}</span>
                        <span className="file-meta">
                    {formatSize(file.size)} • {new Date(file.uploadedAt).toLocaleDateString()}
                  </span>
                      </div>
                    </div>
                    <button
                        className="btn-delete-small"
                        onClick={() => deleteFile(file._id)}
                    >
                      🗑️
                    </button>
                  </div>
              ))}
            </div>
        )}
      </div>
  );
}

export default KnowledgeBase;