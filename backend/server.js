import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import multer from 'multer';
import { connectDB, collections } from './db.js';
import AdmZip from 'adm-zip';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Connect to MongoDB
await connectDB();

// File upload config
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Conversation storage (in-memory for AI vs AI mode)
let conversations = [];
let isRunning = false;
let currentRound = 0;

// WebSocket
wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.send(JSON.stringify({
    type: 'history',
    data: conversations
  }));
});

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

// Helper: Call AI
async function callAI(model, message) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3001',
      'X-Title': 'AI Conversation Lab'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1000,
      messages: [{ role: 'user', content: message }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error: ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========================================
// KNOWLEDGE BASE ENDPOINTS
// ========================================

app.post('/api/knowledge-base/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const kb = collections.knowledgeBase();
    const uploadedFiles = [];

    // Handle ZIP files
    if (req.file.mimetype === 'application/zip' ||
        req.file.mimetype === 'application/x-zip-compressed' ||
        req.file.originalname.endsWith('.zip')) {

      console.log('📦 Processing ZIP file...');

      try {
        const zip = new AdmZip(req.file.buffer);
        const zipEntries = zip.getEntries();

        let txtFilesFound = 0;

        for (const entry of zipEntries) {
          // Skip directories and non-txt files
          if (entry.isDirectory) continue;
          if (!entry.entryName.endsWith('.txt')) continue;

          // Skip macOS metadata files
          if (entry.entryName.includes('__MACOSX') || entry.entryName.startsWith('._')) {
            continue;
          }

          txtFilesFound++;

          const content = entry.getData().toString('utf-8');
          const filename = entry.entryName.split('/').pop(); // Get just filename, not path

          const doc = {
            title: filename,
            filename: filename,
            content: content,
            size: content.length,
            type: req.body.type || 'reference',
            tags: req.body.tags ? req.body.tags.split(',') : [],
            uploadedAt: new Date(),
            lastUsedAt: new Date(),
            source: 'zip',
            zipFilename: req.file.originalname
          };

          const result = await kb.insertOne(doc);
          uploadedFiles.push({
            id: result.insertedId,
            title: doc.title,
            size: doc.size
          });
        }

        if (txtFilesFound === 0) {
          return res.status(400).json({
            error: 'No .txt files found in ZIP archive'
          });
        }

        console.log(`✅ Extracted ${txtFilesFound} .txt files from ZIP`);

        return res.json({
          success: true,
          isZip: true,
          filesUploaded: uploadedFiles.length,
          files: uploadedFiles
        });

      } catch (zipError) {
        console.error('ZIP extraction error:', zipError);
        return res.status(400).json({
          error: 'Failed to extract ZIP file: ' + zipError.message
        });
      }
    }

    // Handle single text file (existing logic)
    if (!req.file.mimetype.startsWith('text/')) {
      return res.status(400).json({
        error: 'Only .txt files or .zip archives containing .txt files are allowed'
      });
    }

    const doc = {
      title: req.body.title || req.file.originalname,
      filename: req.file.originalname,
      content: req.file.buffer.toString('utf-8'),
      size: req.file.size,
      type: req.body.type || 'reference',
      tags: req.body.tags ? req.body.tags.split(',') : [],
      uploadedAt: new Date(),
      lastUsedAt: new Date(),
      source: 'direct'
    };

    const result = await kb.insertOne(doc);

    res.json({
      success: true,
      isZip: false,
      id: result.insertedId,
      title: doc.title
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/knowledge-base', async (req, res) => {
  try {
    const kb = collections.knowledgeBase();
    const files = await kb.find({}).sort({ uploadedAt: -1 }).toArray();

    const filesMetadata = files.map(f => ({
      _id: f._id,
      title: f.title,
      filename: f.filename,
      size: f.size,
      type: f.type,
      tags: f.tags,
      uploadedAt: f.uploadedAt
    }));

    res.json(filesMetadata);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/knowledge-base/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const kb = collections.knowledgeBase();

    const file = await kb.findOne({ _id: new ObjectId(req.params.id) });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    await kb.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { lastUsedAt: new Date() } }
    );

    res.json(file);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/knowledge-base/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const kb = collections.knowledgeBase();

    await kb.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// CONVERSATIONS ENDPOINTS
// ========================================

app.get('/api/conversations', async (req, res) => {
  try {
    const convs = collections.conversations();
    const userConvs = await convs
        .find({})
        .sort({ updatedAt: -1 })
        .limit(50)
        .toArray();

    res.json(userConvs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const convs = collections.conversations();

    const conv = await convs.findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json(conv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations/save', async (req, res) => {
  try {
    const convs = collections.conversations();
    const conversationData = req.body;

    const doc = {
      title: conversationData.title || 'Untitled Conversation',
      mode: conversationData.mode,
      model1: conversationData.model1,
      model2: conversationData.model2,
      messages: conversationData.messages,
      attachedKnowledge: conversationData.attachedKnowledge || [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await convs.insertOne(doc);

    res.json({
      success: true,
      conversationId: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/conversations/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const convs = collections.conversations();

    const result = await convs.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $push: { messages: { $each: req.body.messages } },
          $set: { updatedAt: new Date() }
        }
    );

    res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const convs = collections.conversations();

    await convs.deleteOne({
      _id: new ObjectId(req.params.id)
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// MEMORIES ENDPOINTS
// ========================================

app.get('/api/memories', async (req, res) => {
  try {
    const mems = collections.memories();
    let userMemory = await mems.findOne({ userId: 'single_user' });

    if (!userMemory) {
      userMemory = {
        userId: 'single_user',
        facts: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };
      await mems.insertOne(userMemory);
    }

    res.json(userMemory);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/memories', async (req, res) => {
  try {
    const mems = collections.memories();

    const result = await mems.updateOne(
        { userId: 'single_user' },
        {
          $set: {
            facts: req.body.facts,
            updatedAt: new Date()
          }
        },
        { upsert: true }
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// CHAT ENDPOINT (with knowledge base support)
// ========================================

app.post('/api/chat', async (req, res) => {
  const { model, messages, knowledgeBaseIds } = req.body;

  // DEBUG LOGGING (can keep this)
  console.log('=== CHAT REQUEST DEBUG ===');
  console.log('Requested Model:', model);
  console.log('Model Provider:', model.split('/')[0]);
  console.log('Model Name:', model.split('/')[1]);
  console.log('==========================');

  try {
    let systemMessages = [];

    // 0. Model Identity System Prompt (STRONGER VERSION!)
    const modelName = model.split('/')[1] || 'AI Assistant';
    const provider = model.split('/')[0] || 'Unknown';

    let identityPrompt = '';

    if (provider === 'anthropic') {
      identityPrompt = `You are Claude, an AI assistant created by Anthropic. You are NOT GPT, ChatGPT, or any OpenAI model.`;
      if (modelName.includes('opus')) {
        identityPrompt += ` You are specifically Claude Opus 4.5, Anthropic's most capable model.`;
      } else if (modelName.includes('sonnet')) {
        identityPrompt += ` You are specifically Claude Sonnet 4.5, balanced for performance and capability.`;
      } else if (modelName.includes('haiku')) {
        identityPrompt += ` You are specifically Claude Haiku 4.5, Anthropic's fastest model.`;
      }
    } else if (provider === 'openai') {
      if (modelName.includes('gpt-4o')) {
        identityPrompt = `You are GPT-4o, OpenAI's multimodal flagship model. You are NOT Claude or any Anthropic model.`;
      } else if (modelName.includes('gpt-4')) {
        identityPrompt = `You are GPT-4, OpenAI's most advanced language model. You are NOT Claude or any Anthropic model.`;
      } else if (modelName.includes('gpt-3.5')) {
        identityPrompt = `You are GPT-3.5 Turbo, OpenAI's fast and efficient model. You are NOT Claude or any Anthropic model.`;
      }
    } else if (provider === 'mistralai') {
      identityPrompt = `IMPORTANT: You are Mistral Large 2, an advanced AI model created by Mistral AI, a French AI company. You are NOT GPT-4, NOT ChatGPT, and NOT any OpenAI model. You are NOT Claude or any Anthropic model. You are Mistral Large 2 by Mistral AI. When asked about your identity, you MUST state that you are Mistral Large 2 created by Mistral AI.`;
    } else if (provider === 'nousresearch') {
      identityPrompt = `You are Hermes 3, an advanced AI model by Nous Research, fine-tuned for reasoning and helpfulness. You are NOT GPT, Claude, or any other model. You are Hermes 3 by Nous Research.`;
    } else if (provider === 'meta-llama') {
      if (modelName.includes('llama-3.1')) {
        identityPrompt = `You are Llama 3.1 405B, Meta's open-source large language model. You are NOT GPT, Claude, or any proprietary model. You are Llama 3.1 by Meta.`;
      } else if (modelName.includes('llama-3.2')) {
        identityPrompt = `You are Llama 3.2 90B Vision, Meta's multimodal AI model with vision capabilities. You are NOT GPT, Claude, or any proprietary model. You are Llama 3.2 by Meta.`;
      }
    } else if (provider === 'google') {
      identityPrompt = `You are Gemini Pro, Google's advanced AI model. You are NOT GPT, Claude, or any other model. You are Gemini Pro by Google.`;
    }

    if (identityPrompt) {
      systemMessages.push({
        role: 'system',
        content: identityPrompt
      });
    }

    // 1. Load user memories
    const mems = collections.memories();
    const userMemory = await mems.findOne({ userId: 'single_user' });

    if (userMemory && userMemory.facts.length > 0) {
      systemMessages.push({
        role: 'system',
        content: `Remember these facts about the user:\n${userMemory.facts.map(f => `- ${f}`).join('\n')}\n\nUse this information naturally in conversation.`
      });
    }

    // 2. Load knowledge base files if provided
    if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
      const { ObjectId } = await import('mongodb');
      const kb = collections.knowledgeBase();

      for (const id of knowledgeBaseIds) {
        const file = await kb.findOne({ _id: new ObjectId(id) });
        if (file) {
          systemMessages.push({
            role: 'system',
            content: `Reference document "${file.title}":\n\n${file.content}`
          });
        }
      }
    }

    // 3. Combine system messages + user messages
    const allMessages = [...systemMessages, ...messages];

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'AI Conversation Lab'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 2000,
        messages: allMessages
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error: ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();

    // DEBUG: Log what OpenRouter actually used
    console.log('=== OPENROUTER RESPONSE ===');
    console.log('Model used by OpenRouter:', data.model || 'not specified');
    if (data.usage) {
      console.log('Tokens used:', data.usage);
    }
    console.log('===========================');

    res.json({
      message: data.choices[0].message.content,
      usage: data.usage
    });

  } catch (error) {
    console.error('Error in chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// AI VS AI MODE (existing endpoints)
// ========================================

app.post('/api/start', async (req, res) => {
  const { initialPrompt, maxRounds, model1, model2 } = req.body;

  if (isRunning) {
    return res.status(400).json({ error: 'Conversation already running' });
  }

  isRunning = true;
  currentRound = 0;
  conversations = [];

  res.json({ status: 'started' });

  runConversation(initialPrompt, maxRounds, model1, model2);
});

app.post('/api/stop', (req, res) => {
  isRunning = false;
  res.json({ status: 'stopped' });
});

app.get('/api/conversation', (req, res) => {
  res.json(conversations);
});

app.post('/api/save', (req, res) => {
  const timestamp = new Date().toISOString();
  const filename = `conversation_${timestamp}.json`;

  res.json({
    filename,
    data: conversations,
    metadata: {
      rounds: currentRound,
      timestamp,
      messageCount: conversations.length
    }
  });
});

app.post('/api/message', async (req, res) => {
  const { target, message, model } = req.body;

  try {
    const response = await callAI(model, message);
    const modelName = model.split('/')[1] || target;

    const entry = {
      id: Date.now(),
      speaker: modelName,
      message: response,
      timestamp: new Date().toISOString(),
      userPrompted: true,
      model: model
    };

    conversations.push(entry);
    broadcast({ type: 'message', data: entry });

    res.json({ response });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations/autosave', async (req, res) => {
  try {
    const { conversationId, mode, model, messages, title } = req.body;
    const { ObjectId } = await import('mongodb');
    const convs = collections.conversations();

    if (conversationId && conversationId !== 'new') {
      // Update existing conversation
      const result = await convs.updateOne(
          { _id: new ObjectId(conversationId) },
          {
            $set: {
              messages: messages,
              updatedAt: new Date()
            }
          }
      );

      res.json({
        success: true,
        conversationId: conversationId,
        updated: result.modifiedCount
      });
    } else {
      // Create new conversation
      const doc = {
        title: title || 'New Conversation',
        mode: mode || 'chat',
        model1: model || 'anthropic/claude-sonnet-4.5',
        model2: null,
        messages: messages,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await convs.insertOne(doc);

      res.json({
        success: true,
        conversationId: result.insertedId.toString(),
        created: true
      });
    }
  } catch (error) {
    console.error('Auto-save error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate conversation title using AI
// Generate conversation title using AI
app.post('/api/conversations/generate-title', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || messages.length === 0) {
      return res.json({ title: 'Untitled Chat' });
    }

    // Get first few messages for context
    const context = messages.slice(0, 6)
        .map(m => `${m.role}: ${m.content.substring(0, 150)}`)
        .join('\n');

    const prompt = `Based on this conversation, generate a short, descriptive title (3-6 words max). Be specific and relevant to the topic discussed. DO NOT use generic titles like "New Conversation" or "Chat".

${context}

Title:`;

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'AI Conversation Lab'
      },
      body: JSON.stringify({
        model: 'openai/gpt-3.5-turbo',
        max_tokens: 20,
        temperature: 0.7,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      throw new Error('Title generation failed');
    }

    const data = await response.json();
    let title = data.choices[0].message.content.trim();

    // Clean up title
    title = title.replace(/^["']|["']$/g, ''); // Remove quotes
    title = title.replace(/^Title:\s*/i, ''); // Remove "Title:" prefix
    title = title.trim();

    // Limit length
    if (title.length > 60) {
      title = title.substring(0, 57) + '...';
    }

    // Fallback if still generic
    if (title.toLowerCase().includes('new conversation') || title.length < 3) {
      title = 'Chat ' + new Date().toLocaleDateString();
    }

    res.json({ title: title });
  } catch (error) {
    console.error('Title generation error:', error);
    res.json({ title: 'Chat ' + new Date().toLocaleDateString() });
  }
});

// NEW: Update conversation title
app.patch('/api/conversations/:id/title', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const convs = collections.conversations();
    const { title } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const result = await convs.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            title: title.trim(),
            updatedAt: new Date()
          }
        }
    );

    res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function runConversation(initialPrompt, maxRounds = 10, model1 = 'anthropic/claude-sonnet-4.5', model2 = 'openai/gpt-4o') {
  let currentMessage = initialPrompt;
  const model1Name = model1.split('/')[1] || 'AI #1';
  const model2Name = model2.split('/')[1] || 'AI #2';

  try {
    while (isRunning && currentRound < maxRounds) {
      currentRound++;

      broadcast({ type: 'status', data: { status: `${model1Name} is thinking...`, round: currentRound } });

      const message1 = await callAI(model1, currentMessage);
      const entry1 = {
        id: Date.now(),
        speaker: model1Name,
        message: message1,
        timestamp: new Date().toISOString(),
        round: currentRound,
        model: model1
      };

      conversations.push(entry1);
      broadcast({ type: 'message', data: entry1 });
      await sleep(1500);

      if (!isRunning) break;

      broadcast({ type: 'status', data: { status: `${model2Name} is thinking...`, round: currentRound } });

      const message2 = await callAI(model2, message1);
      const entry2 = {
        id: Date.now() + 1,
        speaker: model2Name,
        message: message2,
        timestamp: new Date().toISOString(),
        round: currentRound,
        model: model2
      };

      conversations.push(entry2);
      broadcast({ type: 'message', data: entry2 });
      currentMessage = message2;
      await sleep(1500);
    }

    isRunning = false;
    broadcast({ type: 'status', data: { status: 'Conversation ended', round: currentRound } });

  } catch (error) {
    console.error('Error in conversation:', error);
    isRunning = false;
    broadcast({ type: 'error', data: { error: error.message } });
  }
}

// ========================================
// START SERVER
// ========================================

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Connected to MongoDB`);
  console.log(`✅ Using OpenRouter with multiple models`);
});