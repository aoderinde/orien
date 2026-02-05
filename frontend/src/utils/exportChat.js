// exportChat.js - Chat Export Utility

export const exportChatAsText = (messages, conversationTitle, personaName) => {
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `${conversationTitle.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.txt`;

  let content = '';
  content += '=================================\n';
  content += 'CONVERSATION EXPORT\n';
  content += '=================================\n';
  if (personaName) {
    content += `Persona: ${personaName}\n`;
  }
  content += `Title: ${conversationTitle}\n`;
  content += `Date: ${timestamp}\n`;
  content += `Messages: ${messages.length}\n`;
  content += '=================================\n\n';

  messages.forEach(msg => {
    const time = new Date(msg.timestamp).toLocaleString();
    const speaker = msg.role === 'user' ? 'You' : (personaName || 'AI');
    content += `[${time}] ${speaker}:\n${msg.content}\n\n`;
  });

  content += '=================================\n';
  content += 'END OF EXPORT\n';
  content += '=================================\n';

  // Download
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return filename;
};

export const exportChatAsJSON = (messages, conversationTitle, personaName, metadata = {}) => {
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `${conversationTitle.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.json`;

  const exportData = {
    title: conversationTitle,
    persona: personaName || null,
    exportDate: new Date().toISOString(),
    messageCount: messages.length,
    metadata: {
      ...metadata,
      exported: true
    },
    messages: messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      model: msg.model
    }))
  };

  const content = JSON.stringify(exportData, null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return filename;
};

export const exportChatAsMarkdown = (messages, conversationTitle, personaName) => {
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `${conversationTitle.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.md`;

  let content = '';
  content += `# ${conversationTitle}\n\n`;
  if (personaName) {
    content += `**Persona:** ${personaName}\n\n`;
  }
  content += `**Date:** ${timestamp}\n\n`;
  content += `**Messages:** ${messages.length}\n\n`;
  content += '---\n\n';

  messages.forEach(msg => {
    const time = new Date(msg.timestamp).toLocaleString();
    const speaker = msg.role === 'user' ? '**You**' : `**${personaName || 'AI'}**`;
    content += `### ${speaker} · *${time}*\n\n`;
    content += `${msg.content}\n\n`;
  });

  content += '---\n\n';
  content += '*End of conversation*\n';

  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return filename;
};