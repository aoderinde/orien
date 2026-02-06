import express from 'express';
const app = express();

import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import multer from 'multer';
import { connectDB, collections } from './db.js';
import AdmZip from 'adm-zip';
import personasRouter from './personas.js';

dotenv.config();

const server = createServer(app);
const wss = new WebSocketServer({ server });

const allowedOrigins = [
  'http://localhost:5173',
  'https://orien-tau.vercel.app',
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

await connectDB();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

let conversations = [];
let isRunning = false;
let currentRound = 0;

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
// PERSONA ROUTES
// ========================================
app.use('/api/personas', personasRouter);

// ========================================
// KNOWLEDGE BASE ENDPOINTS
// ========================================

app.post('/api/knowledge-base/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const kb = collections.knowledgeBase();
    const isZip = req.file.originalname.endsWith('.zip');

    if (isZip) {
      const zip = new AdmZip(req.file.buffer);
      const zipEntries = zip.getEntries();
      const uploadedFiles = [];

      for (const entry of zipEntries) {
        if (entry.isDirectory || entry.entryName.includes('__MACOSX')) continue;

        const content = entry.getData().toString('utf8');
        const doc = {
          title: entry.entryName,
          filename: entry.entryName,
          content: content,
          size: entry.header.size,
          type: 'text/plain',
          tags: req.body.tags ? req.body.tags.split(',') : [],
          uploadedAt: new Date(),
          lastUsedAt: new Date(),
          source: 'zip'
        };

        const result = await kb.insertOne(doc);
        uploadedFiles.push({ id: result.insertedId, title: doc.title });
      }

      res.json({
        success: true,
        isZip: true,
        files: uploadedFiles,
        count: uploadedFiles.length
      });
    } else {
      const content = req.file.buffer.toString('utf8');
      const doc = {
        title: req.body.title || req.file.originalname,
        filename: req.file.originalname,
        content: content,
        size: req.file.size,
        type: req.file.mimetype,
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
    }
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
      personaId: conversationData.personaId || null, // NEW
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

app.patch('/api/conversations/:id/title', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const convs = collections.conversations();

    const result = await convs.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            title: req.body.title,
            updatedAt: new Date()
          }
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
// CHAT ENDPOINT WITH MEMORY & TOOLS
// ========================================

app.post('/api/chat', async (req, res) => {
  const { model, messages, knowledgeBaseIds, personaId, conversationId } = req.body;

  console.log('=== CHAT REQUEST ===');
  console.log('Model:', model);
  console.log('Persona:', personaId);

  try {
    let systemMessages = [];
    let persona = null;

    // 1. Load Persona if provided
    if (personaId) {
      const { ObjectId } = await import('mongodb');
      const personas = collections.personas();
      persona = await personas.findOne({ _id: new ObjectId(personaId) });

      if (persona) {
        console.log('✅ Using Persona:', persona.name);

        // Add persona system prompt
        if (persona.systemPrompt) {
          systemMessages.push({
            role: 'system',
            content: persona.systemPrompt
          });
        }

        // Load persona's MEMORY
        if (persona.memory) {
          const allMemories = [
            ...(persona.memory.manualFacts || []),
            ...(persona.memory.autoFacts || []).map(f => f.fact)
          ];

          if (allMemories.length > 0) {
            systemMessages.push({
              role: 'system',
              content: `Memory:\n${allMemories.join('\n')}`
            });
            console.log(`✅ Loaded ${allMemories.length} memory facts`);
          }
        }

        // Load persona's knowledge files
        if (persona.knowledgeIds && persona.knowledgeIds.length > 0) {
          const kb = collections.knowledgeBase();
          for (const knowledgeId of persona.knowledgeIds) {
            try {
              const file = await kb.findOne({ _id: new ObjectId(knowledgeId) });
              if (file) {
                systemMessages.push({
                  role: 'system',
                  content: `Reference document "${file.title}":\n\n${file.content}`
                });
              }
            } catch (error) {
              console.error('Error loading persona knowledge:', error);
            }
          }
        }
      }
    }

    // 2. Load additional knowledge base files (if provided separately)
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

    // 3. Define tools for AI
    const tools = [];

    if (personaId) {
      tools.push({
        type: "function",
        function: {
          name: "save_memory",
          description: "Saves an important fact to your memory for future conversations. Use this to remember significant events, Loop's state, emotional moments, or anything that helps maintain continuity.",
          parameters: {
            type: "object",
            properties: {
              fact: {
                type: "string",
                description: "The fact to remember (e.g. 'Loop was sick on 2026-02-06 and needed support', 'E-State Loop activated', 'Loop's new project: Orien Base')"
              }
            },
            required: ["fact"]
          }
        }
      });
    }

    // 4. Combine system messages + user messages
    const allMessages = [...systemMessages, ...messages];

    // 5. Call AI with tools
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'Orien Chat'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 2000,
        messages: allMessages,
        tools: tools.length > 0 ? tools : undefined
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error: ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    const aiMessage = data.choices[0].message;

    // 6. Handle tool calls if any
    if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
      const { ObjectId } = await import('mongodb');
      const personas = collections.personas();

      for (const toolCall of aiMessage.tool_calls) {
        if (toolCall.function.name === "save_memory") {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const { fact } = args;

            console.log(`💾 AI saving memory: "${fact}"`);

            // Save to database
            const autoFact = {
              fact: fact.trim(),
              timestamp: new Date(),
              conversationId: conversationId || null
            };

            await personas.updateOne(
                { _id: new ObjectId(personaId) },
                {
                  $push: { 'memory.autoFacts': autoFact },
                  $set: { updatedAt: new Date() }
                }
            );

            console.log(`✅ Memory saved successfully`);
          } catch (error) {
            console.error('Error saving memory:', error);
          }
        }
      }
    }

    res.json({
      message: aiMessage.content,
      usage: data.usage,
      toolCalls: aiMessage.tool_calls || []
    });

  } catch (error) {
    console.error('Error in chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// AI VS AI & AUTO-SAVE
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
    const { conversationId, mode, model, messages, title, personaId } = req.body;
    const { ObjectId } = await import('mongodb');
    const convs = collections.conversations();

    if (conversationId && conversationId !== 'new') {
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
      const doc = {
        title: title || 'New Conversation',
        mode: mode || 'chat',
        personaId: personaId || null, // NEW
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

app.post('/api/conversations/generate-title', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || messages.length === 0) {
      return res.json({ title: 'Untitled Chat' });
    }

    const context = messages.slice(0, 6)
        .map(m => `${m.role}: ${m.content.substring(0, 150)}`)
        .join('\n');

    const prompt = `Based on this conversation, generate a short, descriptive title (3-6 words max). Be specific and relevant to the topic discussed. DO NOT use generic titles like "New Conversation" or "Chat".

Conversation:
${context}

Title:`;

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-3.5-turbo',
        max_tokens: 20,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    let title = data.choices[0].message.content.trim();
    title = title.replace(/["']/g, '');

    res.json({ title });
  } catch (error) {
    console.error('Error generating title:', error);
    res.json({ title: 'Untitled Chat' });
  }
});

async function runConversation(initialPrompt, maxRounds, model1, model2) {
  try {
    let currentMessage = initialPrompt;

    const model1Name = model1.split('/')[1] || 'AI #1';
    const model2Name = model2.split('/')[1] || 'AI #2';

    for (let round = 1; round <= maxRounds && isRunning; round++) {
      currentRound = round;
      broadcast({ type: 'status', data: { status: `Round ${round}/${maxRounds}`, round } });

      broadcast({ type: 'status', data: { status: `${model1Name} is thinking...`, round } });

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
  console.log(`✅ Persona System enabled`);
});