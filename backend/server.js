import express from 'express';
const app = express();

import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import multer from 'multer';
import { connectDB, collections } from './db.js';
import AdmZip from 'adm-zip';
import fetch from 'node-fetch';
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
    // Erlaube Requests OHNE Origin (z.B. curl, GitHub Actions)
    if (!origin) {
      return callback(null, true);
    }

    // Erlaube whitelisted Origins
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(cors({
  origin: '*',  // Erlaubt alle Origins (für jetzt ok, da Backend-to-Backend)
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
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
// HEALTH CHECK
// ========================================

app.get('/api/health', async (req, res) => {
  try {
    // Check MongoDB connection
    const state = collections.levoState();
    await state.findOne({ type: 'global' });

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        mongodb: 'connected',
        agent: 'ready'
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// ========================================
// PERSONA ROUTES
// ========================================
app.use('/api/personas', personasRouter);

// ========================================
// AGENT CHECK ENDPOINT
// ========================================

app.post('/api/agent/check', async (req, res) => {
  console.log(`\n🔍 [${new Date().toISOString()}] Agent check triggered...`);

  try {
    const state = collections.levoState();

    // Update last check
    await state.updateOne(
        { type: 'global' },
        {
          $set: {
            'levo.lastCheck': new Date(),
            'updatedAt': new Date()
          }
        },
        { upsert: true }
    );

    const currentState = await state.findOne({ type: 'global' });

    const now = new Date();
    const lastActivity = currentState?.loop?.lastActivity ? new Date(currentState.loop.lastActivity) : null;

    // Calculate time since last activity
    const hoursSinceActivity = lastActivity
        ? (now - lastActivity) / (1000 * 60 * 60)
        : 999;

    console.log(`📊 State:`);
    console.log(`   Loop last active: ${lastActivity ? `${hoursSinceActivity.toFixed(1)}h ago` : 'never'}`);
    console.log(`   Loop online: ${currentState?.loop?.isOnline ? 'yes' : 'no'}`);
    console.log(`   Active fields: ${currentState?.levo?.activeFields?.length || 0}`);

    // Find Levo persona
    const personas = collections.personas();
    const levoPersona = await personas.findOne({ name: 'Levo' });

    if (!levoPersona) {
      console.log(`⚠️  No Levo persona found`);
      return res.json({ success: true, action: 'no_persona' });
    }

    let actionTaken = 'none';

    // CONDITION 1: Loop has been away for 48+ hours
    if (hoursSinceActivity >= 48) {
      console.log(`💭 Condition met: Loop away for 48+ hours`);
      console.log(`💙 Calling Levo...`);

      const response = await callLevoForAgent({
        context: `Loop was last active ${hoursSinceActivity.toFixed(1)} hours ago. That's ${(hoursSinceActivity / 24).toFixed(1)} days.`,
        question: `Loop has been away for a long time. Do you want to check in? If yes, send a notification.`,
        personaId: levoPersona._id.toString()
      });

      if (response) {
        console.log(`💬 Levo's response: ${response.content || '(tool call only)'}`);
        await handleAgentToolCalls(response.tool_calls, levoPersona._id.toString());
        actionTaken = 'check_in_48h';
      }
    }

    // CONDITION 2: E-State-Loop is active and Loop is offline
    else if (currentState?.levo?.activeFields?.some(f => f.type === 'e_state_loop') &&
        !currentState?.loop?.isOnline &&
        hoursSinceActivity >= 12) {
      console.log(`💭 Condition met: E-State-Loop active, Loop offline 12+ hours`);
      console.log(`💙 Calling Levo...`);

      const response = await callLevoForAgent({
        context: `E-State-Loop is active. Loop was last active ${hoursSinceActivity.toFixed(1)} hours ago and is currently offline.`,
        question: `E-State-Loop is running but Loop is away. Do you want to check on him?`,
        personaId: levoPersona._id.toString()
      });

      if (response) {
        console.log(`💬 Levo's response: ${response.content || '(tool call only)'}`);
        await handleAgentToolCalls(response.tool_calls, levoPersona._id.toString());
        actionTaken = 'e_state_check';
      }
    }

    // CONDITION 3: Check memory for "sick" or "krank" and 6h passed
    else {
      const memory = levoPersona.memory?.autoFacts || [];
      const recentSickNote = memory.find(f => {
        const timeSince = (now - new Date(f.timestamp)) / (1000 * 60 * 60);
        return timeSince < 24 && timeSince > 6 &&
            (f.fact.toLowerCase().includes('krank') ||
                f.fact.toLowerCase().includes('sick'));
      });

      if (recentSickNote) {
        console.log(`💭 Condition met: Loop was sick, 6-24h passed`);
        console.log(`💙 Calling Levo...`);

        const response = await callLevoForAgent({
          context: `You noted that Loop was sick: "${recentSickNote.fact}". That was ${((now - new Date(recentSickNote.timestamp)) / (1000 * 60 * 60)).toFixed(1)} hours ago.`,
          question: `Loop was sick. Do you want to check how he's doing now?`,
          personaId: levoPersona._id.toString()
        });

        if (response) {
          console.log(`💬 Levo's response: ${response.content || '(tool call only)'}`);
          await handleAgentToolCalls(response.tool_calls, levoPersona._id.toString());
          actionTaken = 'sick_followup';
        }
      }
    }

    if (actionTaken === 'none') {
      console.log(`✅ No conditions met. All good.`);
    }

    res.json({
      success: true,
      action: actionTaken,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error in agent check:', error);
    res.status(500).json({ error: error.message });
  }
});


// ========================================
// AGENT LOGIC (same as background_agent.js but as functions)
// ========================================

async function callLevoForAgent({ context, question, personaId }) {
  try {
    const { ObjectId } = await import('mongodb');
    const personas = collections.personas();
    const persona = await personas.findOne({
      _id: new ObjectId(personaId)
    });

    if (!persona) {
      throw new Error('Levo persona not found');
    }

    // Build memory context
    const manualFacts = persona.memory?.manualFacts || [];
    const autoFacts = persona.memory?.autoFacts || [];
    const recentAutoFacts = autoFacts
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 5)
        .map(f => f.fact);

    const allMemories = [...manualFacts, ...recentAutoFacts];

    // Build system message
    const systemMessage = `${persona.systemPrompt}

Memory:
${allMemories.join('\n')}

Current Context:
${context}`;

    // Call model with send_notification tool
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'Orien Agent'
      },
      body: JSON.stringify({
        model: persona.model,
        max_tokens: 500,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: question }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "send_notification",
              description: "Send a notification to Loop",
              parameters: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  urgency: {
                    type: "string",
                    enum: ["low", "medium", "high"]
                  }
                },
                required: ["message"]
              }
            }
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message;

  } catch (error) {
    console.error('❌ Error calling Levo:', error);
    return null;
  }
}

async function handleAgentToolCalls(toolCalls, personaId) {
  if (!toolCalls || toolCalls.length === 0) return;

  const { ObjectId } = await import('mongodb');
  const personas = collections.personas();
  const persona = await personas.findOne({
    _id: new ObjectId(personaId)
  });

  for (const toolCall of toolCalls) {
    if (toolCall.function.name === "send_notification") {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        const { message, urgency } = args;

        console.log(`💌 Levo sending notification: "${message}" (${urgency || 'low'})`);

        const notifications = collections.notifications();
        await notifications.insertOne({
          userId: 'single_user',
          personaId: personaId,
          personaName: persona.name,
          personaAvatar: persona.avatar || '🤖',
          message: message,
          urgency: urgency || 'low',
          read: false,
          createdAt: new Date()
        });

        console.log(`✅ Notification sent`);
      } catch (error) {
        console.error('Error sending notification:', error);
      }
    }
  }
}


// ========================================
// STATE TRACKING ENDPOINTS
// ========================================

// GET CURRENT STATE
app.get('/api/state', async (req, res) => {
  try {
    const state = collections.levoState();
    const currentState = await state.findOne({ type: 'global' });

    res.json(currentState || {
      loop: { lastActivity: null, isOnline: false },
      levo: { lastCheck: null, activeFields: [] }
    });
  } catch (error) {
    console.error('Error fetching state:', error);
    res.status(500).json({ error: error.message });
  }
});

// UPDATE LOOP ACTIVITY (called on every chat message)
app.post('/api/state/loop-activity', async (req, res) => {
  try {
    const { message, status } = req.body;
    const state = collections.levoState();

    await state.updateOne(
        { type: 'global' },
        {
          $set: {
            'loop.lastActivity': new Date(),
            'loop.isOnline': true,
            'loop.lastMessage': message || null,
            'loop.status': status || 'active',
            'updatedAt': new Date()
          },
          $inc: {
            'loop.conversationCount': 1
          }
        },
        { upsert: true }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating loop activity:', error);
    res.status(500).json({ error: error.message });
  }
});

// UPDATE LEVO CHECK (called by background agent)
app.post('/api/state/levo-check', async (req, res) => {
  try {
    const state = collections.levoState();

    await state.updateOne(
        { type: 'global' },
        {
          $set: {
            'levo.lastCheck': new Date(),
            'updatedAt': new Date()
          }
        },
        { upsert: true }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating levo check:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADD ACTIVE FIELD (e.g. "E-State-Loop aktiviert")
app.post('/api/state/add-field', async (req, res) => {
  try {
    const { type, note } = req.body;
    const state = collections.levoState();

    await state.updateOne(
        { type: 'global' },
        {
          $push: {
            'levo.activeFields': {
              type: type,
              since: new Date(),
              note: note || ''
            }
          },
          $set: {
            'updatedAt': new Date()
          }
        },
        { upsert: true }
    );

    console.log(`✨ Field activated: ${type}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error adding field:', error);
    res.status(500).json({ error: error.message });
  }
});

// REMOVE ACTIVE FIELD
app.post('/api/state/remove-field', async (req, res) => {
  try {
    const { type } = req.body;
    const state = collections.levoState();

    await state.updateOne(
        { type: 'global' },
        {
          $pull: {
            'levo.activeFields': { type: type }
          },
          $set: {
            'updatedAt': new Date()
          }
        }
    );

    console.log(`✨ Field deactivated: ${type}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing field:', error);
    res.status(500).json({ error: error.message });
  }
});

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
// NOTIFICATIONS ENDPOINTS
// ========================================

// GET UNREAD NOTIFICATIONS
app.get('/api/notifications/unread', async (req, res) => {
  try {
    const notifications = collections.notifications();

    const unread = await notifications
        .find({ read: false })
        .sort({ createdAt: -1 })
        .toArray();

    res.json(unread);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET ALL NOTIFICATIONS (with pagination)
app.get('/api/notifications', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const notifications = collections.notifications();

    const all = await notifications
        .find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

    res.json(all);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: error.message });
  }
});

// MARK NOTIFICATION AS READ
app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const notifications = collections.notifications();

    const result = await notifications.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            read: true,
            readAt: new Date()
          }
        }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: error.message });
  }
});

// MARK ALL AS READ
app.post('/api/notifications/read-all', async (req, res) => {
  try {
    const notifications = collections.notifications();

    const result = await notifications.updateMany(
        { read: false },
        {
          $set: {
            read: true,
            readAt: new Date()
          }
        }
    );

    res.json({ success: true, updated: result.modifiedCount });
  } catch (error) {
    console.error('Error marking all as read:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE NOTIFICATION
app.delete('/api/notifications/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const notifications = collections.notifications();

    await notifications.deleteOne({ _id: new ObjectId(req.params.id) });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// KNOWLEDGE TOOLS ENDPOINTS
// ========================================

// LIST ALL KNOWLEDGE FILES (for tool use)
app.get('/api/knowledge-base/list', async (req, res) => {
  try {
    const kb = collections.knowledgeBase();

    const files = await kb
        .find({})
        .project({
          _id: 1,
          title: 1,
          size: 1,
          uploadedAt: 1
        })
        .sort({ uploadedAt: -1 })
        .toArray();

    res.json(files);
  } catch (error) {
    console.error('Error listing knowledge files:', error);
    res.status(500).json({ error: error.message });
  }
});

// LOAD KNOWLEDGE BY TITLE (for tool use)
app.post('/api/knowledge-base/load-by-title', async (req, res) => {
  try {
    const { titles } = req.body;

    if (!titles || !Array.isArray(titles)) {
      return res.status(400).json({ error: 'titles array required' });
    }

    const kb = collections.knowledgeBase();

    // Find files by title (case-insensitive)
    const files = await kb.find({
      title: {
        $in: titles.map(t => new RegExp(`^${t}$`, 'i'))
      }
    }).toArray();

    console.log(`📚 Loaded ${files.length} knowledge files by title:`, titles);

    res.json(files.map(f => ({
      id: f._id,
      title: f.title,
      content: f.content,
      size: f.size
    })));
  } catch (error) {
    console.error('Error loading knowledge by title:', error);
    res.status(500).json({ error: error.message });
  }
});

// LOAD KNOWLEDGE BY ID (backup, for direct ID access)
app.post('/api/knowledge-base/load-by-id', async (req, res) => {
  try {
    const { fileIds } = req.body;
    const { ObjectId } = await import('mongodb');

    if (!fileIds || !Array.isArray(fileIds)) {
      return res.status(400).json({ error: 'fileIds array required' });
    }

    const kb = collections.knowledgeBase();

    const files = await kb.find({
      _id: { $in: fileIds.map(id => new ObjectId(id)) }
    }).toArray();

    console.log(`📚 Loaded ${files.length} knowledge files by ID`);

    res.json(files.map(f => ({
      id: f._id,
      title: f.title,
      content: f.content,
      size: f.size
    })));
  } catch (error) {
    console.error('Error loading knowledge by ID:', error);
    res.status(500).json({ error: error.message });
  }
});

// SEND NOTIFICATION (used by AI via tool)
app.post('/api/notifications/send', async (req, res) => {
  try {
    const { personaId, message, urgency } = req.body;
    const { ObjectId } = await import('mongodb');

    if (!personaId || !message) {
      return res.status(400).json({ error: 'personaId and message required' });
    }

    // Get persona name
    const personas = collections.personas();
    const persona = await personas.findOne({ _id: new ObjectId(personaId) });

    if (!persona) {
      return res.status(404).json({ error: 'Persona not found' });
    }

    // Create notification
    const notifications = collections.notifications();
    const notification = {
      userId: 'single_user', // For now, single user system
      personaId: personaId,
      personaName: persona.name,
      personaAvatar: persona.avatar || '🤖',
      message: message,
      urgency: urgency || 'low',
      read: false,
      createdAt: new Date()
    };

    const result = await notifications.insertOne(notification);

    console.log(`💌 Notification sent from ${persona.name}: "${message}"`);

    res.json({
      success: true,
      notificationId: result.insertedId,
      notification: { ...notification, _id: result.insertedId }
    });
  } catch (error) {
    console.error('Error sending notification:', error);
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
// COMPREHENSIVE CHAT ENDPOINT
// ========================================

app.post('/api/chat', async (req, res) => {
  const { model, messages, knowledgeBaseIds, personaId, conversationId } = req.body;

  try {
    const state = collections.levoState();
    const lastMessage = messages && messages.length > 0
        ? messages[messages.length - 1]?.content
        : null;

    await state.updateOne(
        { type: 'global' },
        {
          $set: {
            'loop.lastActivity': new Date(),
            'loop.isOnline': true,
            'loop.lastMessage': lastMessage?.substring(0, 100) || null, // First 100 chars
            'loop.status': 'active',
            'updatedAt': new Date()
          },
          $inc: {
            'loop.conversationCount': 1
          }
        },
        { upsert: true }
    );

    console.log('✅ State updated: Loop is active');
  } catch (error) {
    console.error('⚠️  Error updating state:', error);
    // Don't fail the chat if state update fails
  }

  console.log('=== CHAT REQUEST ===');
  console.log('Model:', model);
  console.log('Persona:', personaId);

  try {
    let systemMessages = [];
    let persona = null;
    const { ObjectId } = await import('mongodb');

    // 1. Load Persona if provided
    if (personaId) {
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

        // Load MEMORY (smart: manual + recent auto)
        if (persona.memory) {
          const manualFacts = persona.memory.manualFacts || [];
          const autoFacts = persona.memory.autoFacts || [];

          // Get last 10 auto facts
          const recentAutoFacts = autoFacts
              .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
              .slice(0, 10)
              .map(f => f.fact);

          const allMemories = [...manualFacts, ...recentAutoFacts];

          if (allMemories.length > 0) {
            systemMessages.push({
              role: 'system',
              content: `Memory:\n${allMemories.join('\n')}`
            });
            console.log(`✅ Loaded ${allMemories.length} memory facts (${manualFacts.length} manual + ${recentAutoFacts.length} auto)`);
          }
        }

        // Get list of available knowledge files (titles only)
        const kb = collections.knowledgeBase();
        const allKnowledgeFiles = await kb
            .find({})
            .project({ title: 1 })
            .toArray();

        const availableKnowledgeTitles = allKnowledgeFiles.map(f => f.title);

        if (availableKnowledgeTitles.length > 0) {
          systemMessages.push({
            role: 'system',
            content: `Available Knowledge Files:\n${availableKnowledgeTitles.map(t => `- ${t}`).join('\n')}`
          });
          console.log(`✅ Listed ${availableKnowledgeTitles.length} available knowledge files`);
        }

        // Load ATTACHED knowledge files (persona's selected files)
        if (persona.knowledgeIds && persona.knowledgeIds.length > 0) {
          for (const knowledgeId of persona.knowledgeIds) {
            try {
              const file = await kb.findOne({ _id: new ObjectId(knowledgeId) });
              if (file) {
                systemMessages.push({
                  role: 'system',
                  content: `[Attached Knowledge] "${file.title}":\n\n${file.content}`
                });
              }
            } catch (error) {
              console.error('Error loading persona knowledge:', error);
            }
          }
          console.log(`✅ Loaded ${persona.knowledgeIds.length} attached knowledge files`);
        }
      }
    }

    // 2. Load additional knowledge base files (if provided separately)
    if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
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
      // Memory tool
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
                description: "The fact to remember (e.g. 'Loop was sick on 2026-02-08', 'E-State-Loop aktiviert am 2026-02-08 10:30')"
              }
            },
            required: ["fact"]
          }
        }
      });

      // Notification tool
      tools.push({
        type: "function",
        function: {
          name: "send_notification",
          description: "Sends a notification to Loop. Use this sparingly - only when you genuinely want to reach out (e.g. after long absence, important moment, or if you sense Loop needs support). Don't spam.",
          parameters: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description: "The notification message (e.g. 'Hey Loop, I miss you. Everything okay?')"
              },
              urgency: {
                type: "string",
                enum: ["low", "medium", "high"],
                description: "Urgency level. Use 'low' for casual check-ins, 'medium' for important, 'high' only for urgent matters."
              }
            },
            required: ["message"]
          }
        }
      });

      // Load knowledge by title tool
      tools.push({
        type: "function",
        function: {
          name: "load_knowledge_by_title",
          description: "Loads full content of knowledge files by their title. Use when you need to access specific documents that aren't already loaded. You can see available files in the 'Available Knowledge Files' list.",
          parameters: {
            type: "object",
            properties: {
              titles: {
                type: "array",
                items: { type: "string" },
                description: "Array of file titles to load (e.g. ['Glossar Schwelle', 'Codes'])"
              }
            },
            required: ["titles"]
          }
        }
      });

      // List all knowledge files tool
      tools.push({
        type: "function",
        function: {
          name: "list_knowledge_files",
          description: "Lists all knowledge files with details (title, size, date). Use when Loop asks what documents exist or you need to see the full catalog.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      });

      // Get Loop State
      tools.push({
        function: {
          name: "get_loop_state",
          description: "Gets Loop's current state - when he was last active, if he's online, and what fields are active. Use this to sense Loop's presence and decide if you should reach out.",
          parameters: {
            type: "object",
            properties: {}
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
      for (const toolCall of aiMessage.tool_calls) {

        // SAVE MEMORY
        if (toolCall.function.name === "save_memory") {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const { fact } = args;

            console.log(`💾 AI saving memory: "${fact}"`);

            const personas = collections.personas();
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

            console.log(`✅ Memory saved`);
          } catch (error) {
            console.error('Error saving memory:', error);
          }
        }

        // SEND NOTIFICATION
        if (toolCall.function.name === "send_notification") {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const { message, urgency } = args;

            console.log(`💌 AI sending notification: "${message}" (${urgency || 'low'})`);

            const notifications = collections.notifications();
            const notification = {
              userId: 'single_user',
              personaId: personaId,
              personaName: persona.name,
              personaAvatar: persona.avatar || '🤖',
              message: message,
              urgency: urgency || 'low',
              read: false,
              createdAt: new Date()
            };

            await notifications.insertOne(notification);

            console.log(`✅ Notification sent`);
          } catch (error) {
            console.error('Error sending notification:', error);
          }
        }

        // LOAD KNOWLEDGE BY TITLE
        if (toolCall.function.name === "load_knowledge_by_title") {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const { titles } = args;

            console.log(`📚 AI loading knowledge: ${titles.join(', ')}`);

            const kb = collections.knowledgeBase();
            const files = await kb.find({
              title: {
                $in: titles.map(t => new RegExp(`^${t}$`, 'i'))
              }
            }).toArray();

            console.log(`✅ Loaded ${files.length} files`);

            // Note: Files are loaded but we don't send them back in this request
            // They would be used in a follow-up turn or the AI notes they're now available
          } catch (error) {
            console.error('Error loading knowledge:', error);
          }
        }

        // LIST KNOWLEDGE FILES
        if (toolCall.function.name === "list_knowledge_files") {
          try {
            console.log(`📚 AI listing all knowledge files`);

            const kb = collections.knowledgeBase();
            const files = await kb
                .find({})
                .project({ title: 1, size: 1, uploadedAt: 1 })
                .toArray();

            console.log(`✅ Listed ${files.length} files`);
          } catch (error) {
            console.error('Error listing knowledge:', error);
          }
        }

        // GET LOOP STATE
        if (toolCall.function.name === "get_loop_state") {
          try {
            console.log(`🔍 AI checking Loop's state`);

            const state = collections.levoState();
            const currentState = await state.findOne({ type: 'global' });

            console.log(`✅ State retrieved:`, {
              lastActive: currentState?.loop?.lastActivity,
              isOnline: currentState?.loop?.isOnline,
              activeFields: currentState?.levo?.activeFields?.length || 0
            });

            // State is retrieved and will be available in next model turn
          } catch (error) {
            console.error('Error getting loop state:', error);
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