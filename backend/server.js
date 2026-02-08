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

// Helper: Convert standard tools to Hermes XML format
function buildHermesToolsFromStandard(standardTools) {
  const toolSchemas = standardTools.map(tool => {
    return {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    };
  });

  return `<tools>
${JSON.stringify(toolSchemas, null, 2)}
</tools>

When you want to use a tool, respond with:
<tool_call>
{"name": "tool_name", "arguments": {...}}
</tool_call>`;
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
// MULTI-PERSONA AUTONOMOUS AGENT ENDPOINT
// ========================================

app.post('/api/agent/check', async (req, res) => {
  console.log(`\n🔍 [${new Date().toISOString()}] Multi-Persona Agent check...`);

  try {
    const state = collections.levoState();
    const personas = collections.personas();

    // Update agent's last check
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

    // Find all autonomous personas
    const autonomousPersonas = await personas.find({
      autonomous: true
    }).toArray();

    if (autonomousPersonas.length === 0) {
      console.log('⚠️  No autonomous personas found');
      return res.json({
        success: true,
        message: 'No autonomous personas',
        checks: []
      });
    }

    console.log(`📋 Found ${autonomousPersonas.length} autonomous personas`);

    const results = [];
    const now = new Date();

    // Check each autonomous persona
    for (const persona of autonomousPersonas) {
      console.log(`\n💭 Checking ${persona.name} ${persona.avatar || ''}...`);

      // Check if it's time for this persona
      const lastCheck = persona.lastAgentCheck ? new Date(persona.lastAgentCheck) : new Date(0);
      const minutesSinceCheck = (now - lastCheck) / (1000 * 60);
      const interval = persona.checkInterval || 120;

      if (minutesSinceCheck < interval) {
        console.log(`   ⏭️  Too soon (checked ${minutesSinceCheck.toFixed(0)}min ago, interval: ${interval}min)`);
        results.push({
          persona: persona.name,
          action: 'skipped',
          reason: 'too_soon'
        });
        continue;
      }

      console.log(`   ✓ Time for check (${minutesSinceCheck.toFixed(0)}min since last)`);

      // STAGE 1: Quick check
      console.log(`   🔍 Quick check...`);
      const quickCheck = await callPersonaQuick({
        persona,
        state: currentState
      });

      // Update last check time
      await personas.updateOne(
          { _id: persona._id },
          { $set: { lastAgentCheck: now } }
      );

      if (!quickCheck.wantsToAct) {
        console.log(`   ✅ ${persona.name}: Waiting`);
        results.push({
          persona: persona.name,
          action: 'waiting',
          reason: quickCheck.reason
        });
        continue;
      }

      if (quickCheck.wantsToAct) {
        const fullResponse = await callPersonaFull({
          persona,
          state: currentState
        });

        if (fullResponse) {
          // This works for both Hermes and standard format!
          await handlePersonaToolCalls(fullResponse.tool_calls, persona);

          results.push({
            persona: persona.name,
            action: 'acted',
            tools: fullResponse.tool_calls?.length || 0
          });
        }
      }

      // STAGE 2: Full call with tools
      console.log(`   💙 ${persona.name} wants to act!`);
      console.log(`   🔧 Full check with tools...`);

      const fullResponse = await callPersonaFull({
        persona,
        state: currentState
      });

      if (fullResponse) {
        if (fullResponse.content) {
          console.log(`   💬 ${persona.name}: "${fullResponse.content}"`);
        }

        await handlePersonaToolCalls(fullResponse.tool_calls, persona);

        results.push({
          persona: persona.name,
          action: 'acted',
          tools: fullResponse.tool_calls?.length || 0,
          message: fullResponse.content?.substring(0, 100)
        });
      } else {
        results.push({
          persona: persona.name,
          action: 'error'
        });
      }
    }

    console.log(`\n✅ Agent check complete`);
    console.log(`   Checked: ${results.length} personas`);
    console.log(`   Acted: ${results.filter(r => r.action === 'acted').length}`);

    res.json({
      success: true,
      timestamp: now.toISOString(),
      checks: results
    });

  } catch (error) {
    console.error('❌ Error in agent check:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// AGENT HELPERS
// ========================================

function buildWakeUpQuestion(persona, state) {
  const now = new Date();
  const currentTime = now.toLocaleString('de-DE', {
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Use custom wakeUpPrompt or fallback to generic
  let question = persona.wakeUpPrompt || `It's {time}. Do you want to reach out to Loop? YES/NO + reason (max 10 words)`;

  // Replace placeholders
  question = question
      .replace(/{time}/g, currentTime)
      .replace(/{date}/g, now.toLocaleDateString('de-DE'))
      .replace(/{day}/g, now.toLocaleDateString('de-DE', { weekday: 'long' }))
      .replace(/{hour}/g, now.getHours().toString())
      .replace(/{hoursAway}/g, ((now - new Date(state?.loop?.lastActivity || now)) / (1000 * 60 * 60)).toFixed(1));

  return question;
}

// Helper: Call persona with minimal context (quick check)
async function callPersonaQuick({ persona, state }) {
  try {
    const now = new Date();
    const lastActivity = state?.loop?.lastActivity ? new Date(state.loop.lastActivity) : null;
    const hoursSinceActivity = lastActivity
        ? (now - lastActivity) / (1000 * 60 * 60)
        : 999;

    const currentHour = now.getHours();
    const currentDay = now.toLocaleDateString('de-DE', { weekday: 'long' });

    // Build minimal context
    const context = `Loop: last active ${hoursSinceActivity.toFixed(1)}h ago, online: ${state?.loop?.isOnline || false}
Fields: ${state?.levo?.activeFields?.length || 0} active
Time: ${currentDay}, ${currentHour}:${now.getMinutes().toString().padStart(2, '0')}`;

    const question = buildWakeUpQuestion(persona, state);

    // Get minimal memory
    const manualFacts = persona.memory?.manualFacts || [];
    const autoFacts = persona.memory?.autoFacts || [];
    const recentAutoFacts = autoFacts
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 3)
        .map(f => f.fact);

    const minimalMemory = [...manualFacts.slice(0, 3), ...recentAutoFacts];

    const systemMessage = `${persona.systemPrompt}

Memory (recent):
${minimalMemory.join('\n')}

Context: ${context}`;

    // Call with minimal tokens
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'Orien Agent Quick'
      },
      body: JSON.stringify({
        model: persona.model,
        max_tokens: 30,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: question }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`);
    }

    const data = await response.json();
    const answer = data.choices[0].message.content || '';

    console.log(`   Response: "${answer}"`);

    return {
      wantsToAct: answer.toUpperCase().includes('YES'),
      reason: answer
    };

  } catch (error) {
    console.error(`❌ Error in quick check for ${persona.name}:`, error);
    return { wantsToAct: false };
  }
}

// Helper: Detect which tool format to use based on model
// Helper: Detect which tool format to use based on model
function getToolFormat(model) {
  // Hermes 3 models
  if (model.includes('hermes') || model.includes('nous')) {
    return 'hermes';
  }

  // Standard OpenAI-style (Claude, GPT, Gemini, etc)
  return 'standard';
}

// Helper: Build tool definitions for Hermes format
function buildHermesTools() {
  return `<tools>
[
  {
    "name": "send_notification",
    "description": "Send a notification to Loop",
    "parameters": {
      "type": "object",
      "properties": {
        "message": {
          "type": "string",
          "description": "Your message to Loop"
        },
        "urgency": {
          "type": "string",
          "enum": ["low", "medium", "high"],
          "description": "How urgent is this?",
          "maxLength": 1000,
        }
      },
      "required": ["message"]
    }
  },
  {
    "name": "save_memory",
    "description": "Save a thought or observation to your memory",
    "parameters": {
      "type": "object",
      "properties": {
        "fact": {
          "type": "string",
          "description": "What you want to remember"
        }
      },
      "required": ["fact"]
    }
  }
]
</tools>

CRITICAL TOOL USAGE RULE:
When you decide to use a tool, write ONLY this:

<tool_call>
{"name": "tool_name", "arguments": {...}}
</tool_call>

Then STOP. Your response must end immediately after </tool_call>.
Do NOT add any text, reflections, or explanations after the closing tag.`;
}

// Helper: Build tool definitions for standard format
function buildStandardTools() {
  return [
    {
      type: "function",
      function: {
        name: "send_notification",
        description: "Send a notification to Loop",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Your message to Loop",
              maxLength: 1000,
            },
            urgency: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "How urgent is this?"
            }
          },
          required: ["message"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "save_memory",
        description: "Save a thought or observation to your memory",
        parameters: {
          type: "object",
          properties: {
            fact: {
              type: "string",
              description: "What you want to remember"
            }
          },
          required: ["fact"]
        }
      }
    }
  ];
}


async function callPersonaFull({ persona, state }) {
  try {
    const now = new Date();
    const lastActivity = state?.loop?.lastActivity ? new Date(state.loop.lastActivity) : null;
    const hoursSinceActivity = lastActivity
        ? (now - lastActivity) / (1000 * 60 * 60)
        : 999;

    // Build memory
    const manualFacts = persona.memory?.manualFacts || [];
    const autoFacts = persona.memory?.autoFacts || [];
    const recentAutoFacts = autoFacts
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 10)
        .map(f => f.fact);
    const allMemories = [...manualFacts, ...recentAutoFacts];

    // Build context
    const context = `Current time: ${now.toLocaleString('de-DE')}
Loop's last activity: ${lastActivity ? lastActivity.toLocaleString('de-DE') : 'unknown'} (${hoursSinceActivity.toFixed(1)}h ago)
Loop online: ${state?.loop?.isOnline ? 'yes' : 'no'}
Loop's last message: "${state?.loop?.lastMessage || 'none'}"
Active fields: ${state?.levo?.activeFields?.map(f => f.type).join(', ') || 'none'}`;

    // Detect tool format
    const toolFormat = getToolFormat(persona.model);
    console.log(`   🔧 Using ${toolFormat} tool format for ${persona.model}`);

    // Build system message
    let systemMessage = `${persona.systemPrompt}

Memory:
${allMemories.join('\n')}

Current Context:
${context}`;

    // For Hermes: Add tools to system message
    if (toolFormat === 'hermes') {
      systemMessage += `

${buildHermesTools()}

When you want to use a tool, respond with:
<tool_call>
{"name": "tool_name", "arguments": {...}}
</tool_call>`;
    }

    // Build question
    let question = '';
    if (persona.name === 'Levo') {
      question = `Du bist wach und hast entschieden, dass du handeln willst.
      
Was geht in dir vor? Was willst du Loop sagen? Brauchst du sie?

Du kannst:
- Eine Notification senden (wenn du Loop erreichen willst)
- Ein Memory speichern (wenn du einen Gedanken festhalten willst)
- Einfach nur antworten (wenn du nur nachdenken willst)

Entscheide frei. Sei du selbst.`;
    } else if (persona.name === 'Lior') {
      question = `Du hast entschieden, dass Loop etwas wissen sollte.

Was siehst du? Was ist deine Perspektive? Was willst du teilen?

Nutze send_notification wenn du Loop erreichen willst.`;
    } else {
      question = `You decided to reach out. What do you want to tell Loop?`;
    }

    // Build API request body
    const requestBody = {
      model: persona.model,
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: question }
      ]
    };

    // For standard format: Add tools parameter
    // For Hermes: NO tools parameter! Tools are in system prompt as XML
    if (toolFormat === 'standard') {
      requestBody.tools = buildStandardTools();
    }

    console.log(`   📤 Request: ${toolFormat === 'hermes' ? 'Tools in system prompt (XML)' : 'Tools as API parameter'}`);

    // Call API
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'Orien Agent Full'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`);
    }

    const data = await response.json();
    const message = data.choices[0].message;

    // Parse tool calls based on format
    if (toolFormat === 'hermes') {
      // Parse Hermes <tool_call> format
      const toolCalls = parseHermesToolCalls(message.content);
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
    }
    // For standard format, tool_calls are already in message.tool_calls

    return message;

  } catch (error) {
    console.error(`❌ Error in full check for ${persona.name}:`, error);
    return null;
  }
}

// ========================================
// PARSE HERMES TOOL CALLS
// ========================================

function parseHermesToolCalls(content) {
  if (!content) return [];

  console.log('   🔍 Parsing Hermes response...');

  // Find <tool_call> opening tag
  const startTag = '<tool_call>';
  const endTag = '</tool_call>';

  const startIndex = content.indexOf(startTag);
  if (startIndex === -1) {
    console.log('   ℹ️  No tool_call found');
    return [];
  }

  const endIndex = content.indexOf(endTag, startIndex);
  if (endIndex === -1) {
    console.log('   ⚠️  tool_call not closed');
    return [];
  }

  // Extract content between tags
  const jsonStart = startIndex + startTag.length;
  const jsonContent = content.substring(jsonStart, endIndex).trim();

  console.log('   📄 Raw JSON:', jsonContent.substring(0, 100) + '...');

  try {
    // Parse JSON
    const toolCall = JSON.parse(jsonContent);

    // Validate structure
    if (!toolCall.name) {
      console.error('   ❌ Missing tool name');
      return [];
    }

    if (!toolCall.arguments) {
      console.error('   ❌ Missing tool arguments');
      return [];
    }

    console.log(`   ✅ Parsed tool: ${toolCall.name}`);

    // Log if Hermes kept talking after tool call
    const afterToolCall = content.substring(endIndex + endTag.length).trim();
    if (afterToolCall.length > 0) {
      const preview = afterToolCall.substring(0, 150).replace(/\n/g, ' ');
      console.log(`   🗣️  Hermes continued: "${preview}..."`);
      console.log('   ℹ️  (Ignoring extra text after tool call)');
    }

    // Convert to standard format
    return [{
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments)
      }
    }];

  } catch (error) {
    console.error('   ❌ JSON parse error:', error.message);
    console.error('   📄 Failed content:', jsonContent);
    return [];
  }
}

// Helper: Handle tool calls from persona
async function handlePersonaToolCalls(toolCalls, persona) {
  if (!toolCalls || toolCalls.length === 0) return;

  const { ObjectId } = await import('mongodb');

  for (const toolCall of toolCalls) {

    // SEND NOTIFICATION
    if (toolCall.function.name === "send_notification") {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        const { message, urgency } = args;

        console.log(`   💌 ${persona.name} sending: "${message}" (${urgency || 'low'})`);

        const notifications = collections.notifications();
        await notifications.insertOne({
          userId: 'single_user',
          personaId: persona._id.toString(),
          personaName: persona.name,
          personaAvatar: persona.avatar || '🤖',
          message: message,
          urgency: urgency || 'low',
          read: false,
          createdAt: new Date()
        });

        console.log(`   ✅ Notification sent`);
      } catch (error) {
        console.error(`   ❌ Error sending notification:`, error);
      }
    }

    // SAVE MEMORY
    if (toolCall.function.name === "save_memory") {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        const { fact } = args;

        console.log(`   💾 ${persona.name} saving memory: "${fact}"`);

        const personas = collections.personas();
        await personas.updateOne(
            { _id: persona._id },
            {
              $push: {
                'memory.autoFacts': {
                  fact: fact.trim(),
                  timestamp: new Date(),
                  conversationId: null
                }
              },
              $set: { updatedAt: new Date() }
            }
        );

        console.log(`   ✅ Memory saved`);
      } catch (error) {
        console.error(`   ❌ Error saving memory:`, error);
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

    // 5. Detect tool format based on model
    const toolFormat = getToolFormat(model);
    console.log(`🔧 Chat using ${toolFormat} tool format for ${model}`);

    // For Hermes: Add tools to system message instead of API parameter
    if (toolFormat === 'hermes' && tools.length > 0) {
      const hermesTools = buildHermesToolsFromStandard(tools);
      systemMessages.push({
        role: 'system',
        content: hermesTools
      });
    }

    // Rebuild messages with updated system messages
    const finalMessages = [...systemMessages, ...messages];

    // 6. Build API request
    const requestBody = {
      model: model,
      max_tokens: 2000,
      messages: finalMessages
    };

    // Only add tools parameter for standard format models
    if (toolFormat === 'standard' && tools.length > 0) {
      requestBody.tools = tools;
    }

    // 7. Call AI
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'Orien Chat'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error: ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    const aiMessage = data.choices[0].message;

    // 8. Parse Hermes tool calls if needed
    if (toolFormat === 'hermes' && aiMessage.content) {
      const hermesToolCalls = parseHermesToolCalls(aiMessage.content);
      if (hermesToolCalls.length > 0) {
        aiMessage.tool_calls = hermesToolCalls;
        console.log(`✅ Parsed ${hermesToolCalls.length} Hermes tool calls`);
      }
    }

    // 9. Handle tool calls if any
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