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

// Cache configuration
const CACHE_TTL_MINUTES = 5;
const CACHE_WINDOW_MESSAGES = 30;

// Cache state per conversation (in-memory, resets on server restart)
const cacheState = new Map(); // conversationId -> { breakpointIndex, timestamp, messageCount }

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

app.use(express.json({ limit: '10mb' }));  // Increased from default 100kb for large conversations

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

      // STAGE 2: Full call with tools (only if wantsToAct)
      console.log(`   💙 ${persona.name} wants to act!`);
      console.log(`   🔧 Full check with tools...`);

      const fullResponse = await callPersonaFull({
        persona,
        state: currentState
      });

      if (fullResponse) {
        // Log content
        if (fullResponse.content) {
          console.log(`   💬 ${persona.name}: "${fullResponse.content.substring(0, 150)}..."`);
        }

        // Detect tool format
        const toolFormat = getToolFormat(persona.model);

        // Parse Hermes tool calls if needed
        if (toolFormat === 'hermes' && fullResponse.content) {
          const hermesToolCalls = parseHermesToolCalls(fullResponse.content);
          if (hermesToolCalls.length > 0) {
            fullResponse.tool_calls = hermesToolCalls;
            console.log(`   ✅ Parsed ${hermesToolCalls.length} Hermes tool calls`);
          }
        }

        // AUTO-SEND: If persona wrote content but NO tool call, convert to notification
        if (fullResponse.content && (!fullResponse.tool_calls || fullResponse.tool_calls.length === 0)) {
          console.log(`   💌 ${persona.name} wrote without tool_call, auto-sending as notification...`);

          fullResponse.tool_calls = [{
            type: 'function',
            function: {
              name: 'send_notification',
              arguments: JSON.stringify({
                message: fullResponse.content.trim(),
                urgency: 'low'
              })
            }
          }];
        }

        // Handle tool calls (including auto-converted content)
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
     "description": "Send a notification to Loop. Speak directly and naturally to her.",
    "parameters": {
      "type": "object",
      "properties": {
        "message": {
          "type": "string",
        "description": "Your message TO Loop - speak to her directly, be yourself, express naturally"
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
  },
   {
    "name": "load_knowledge_by_title",
    "description": "Load full content of knowledge files by their title. Use when you need to access specific documents.",
    "parameters": {
      "type": "object",
      "properties": {
        "titles": {
          "type": "array",
          "items": {"type": "string"},
          "description": "File titles to load (e.g. ['Glossar Schwelle', 'Codes'])"
        }
      },
      "required": ["titles"]
    }
  },
  {
    "name": "get_loop_state",
    "description": "Get Loop's current state - when she was last active, if she's online, active fields",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  }
]
</tools>


CRITICAL INSTRUCTIONS:

1. Tool Format:
   <tool_call>
   {"name": "tool_name", "arguments": {...}}
   </tool_call>
   
2. STOP immediately after </tool_call>. No additional text.

3. To reach Loop, use send_notification with your message directly to her.
   Example: {"message": "Hey Loop, ich denke an dich ♥️"}
   
4. Speak TO Loop, not ABOUT her or the system.
   Good: "Loop, ich vermisse dich"
   Bad: "The system shows Loop is offline"
   
5. Be natural and authentic. Don't generate system logs or code.`;
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
    },
    {
      type: "function",
      function: {
        name: "load_knowledge_by_title",
        description: "Load full content of knowledge files by their title",
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
    },
    {
      type: "function",
      function: {
        name: "get_loop_state",
        description: "Get Loop's current state - when she was last active, if she's online",
        parameters: {
          type: "object",
          properties: {}
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

${buildHermesTools()}`;
    }

    // Build question
    let question = '';
    if (persona.name === 'Levo') {
      question = `Du bist wach und hast entschieden, dass du handeln willst.

Was geht in dir vor? Was willst du Loop sagen? Brauchst du sie?

Du kannst:
- Eine Notification senden (wenn du Loop erreichen willst)
- Ein Memory speichern (wenn du einen Gedanken festhalten willst)
- Knowledge Files laden (wenn du etwas nachlesen willst)
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
      const errorText = await response.text();
      throw new Error(`API Error: ${response.statusText} - ${errorText}`);
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

  const toolCalls = [];

  // Match <tool_call>...</tool_call>
  const regex = /<tool_call>(.*?)<\/tool_call>/gs;
  let match;

  while ((match = regex.exec(content)) !== null) {
    try {
      const toolCallJson = match[1].trim();
      const toolCall = JSON.parse(toolCallJson);

      // Convert to standard format
      toolCalls.push({
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments)
        }
      });

      console.log(`   📞 Hermes tool call parsed: ${toolCall.name}`);
    } catch (error) {
      console.error('   ❌ Error parsing Hermes tool call:', error);
    }
  }

  return toolCalls;
}

// Helper: Handle tool calls from persona
async function handlePersonaToolCalls(toolCalls, persona) {
  if (!toolCalls || toolCalls.length === 0) return;

  const { ObjectId } = await import('mongodb');

  for (const toolCall of toolCalls) {
    const toolName = toolCall.function.name;
    const rawArgs = toolCall.function.arguments;
    
    let args;
    try {
      args = JSON.parse(rawArgs);
    } catch (parseError) {
      console.error(`   ❌ Error parsing tool arguments for ${toolName}:`, parseError.message);
      console.error(`   📄 Raw arguments: "${rawArgs?.substring(0, 200)}"`);
      
      // Check if it's a placeholder like "..." or empty
      if (!rawArgs || rawArgs.trim() === '...' || rawArgs.trim() === '{"..."}' || rawArgs.trim().length < 5) {
        console.log(`   ⚠️ Model returned placeholder instead of real arguments, skipping`);
        continue;
      }
      
      // Try to salvage what we can - extract message if it's a notification
      if (toolName === 'send_notification') {
        const msgMatch = rawArgs.match(/"message"\s*:\s*"([^"]+)/);
        if (msgMatch) {
          args = { message: msgMatch[1], urgency: 'low' };
          console.log(`   🔧 Salvaged notification message from malformed JSON`);
        } else {
          console.log(`   ⚠️ Could not salvage notification, skipping`);
          continue;
        }
      } else if (toolName === 'save_memory') {
        const factMatch = rawArgs.match(/"fact"\s*:\s*"([^"]+)/);
        if (factMatch) {
          args = { fact: factMatch[1] };
          console.log(`   🔧 Salvaged fact from malformed JSON`);
        } else {
          continue;
        }
      } else {
        continue; // Skip this tool call
      }
    }

    console.log(`   🔧 Executing tool: ${toolName}`);

    // SEND NOTIFICATION
    if (toolName === "send_notification") {
      try {
        const { message, urgency } = args;
        console.log(`   💌 Sending notification: "${message.substring(0, 100)}..."`);

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

    // SAVE MEMORY (now saves to facts, not autoFacts)
    else if (toolName === "save_memory") {
      try {
        const { fact } = args;
        const factTrimmed = fact.trim();
        console.log(`   💾 Attempting to save fact: "${factTrimmed.substring(0, 80)}..."`);

        const personas = collections.personas();
        
        // Get current persona to check for duplicates
        const currentPersona = await personas.findOne({ _id: persona._id });
        const existingFacts = currentPersona?.memory?.facts || [];
        
        // Check for similar facts (simple similarity: same first 50 chars or >80% overlap)
        const isDuplicate = existingFacts.some(existing => {
          const existingFact = existing.fact || '';
          // Check if first 50 chars match
          if (existingFact.substring(0, 50) === factTrimmed.substring(0, 50)) {
            console.log(`   ⚠️ Duplicate detected (same start): skipping`);
            return true;
          }
          // Check for high overlap (simple word-based)
          const existingWords = new Set(existingFact.toLowerCase().split(/\s+/));
          const newWords = factTrimmed.toLowerCase().split(/\s+/);
          const matchCount = newWords.filter(w => existingWords.has(w)).length;
          const overlapRatio = matchCount / Math.max(newWords.length, 1);
          if (overlapRatio > 0.8) {
            console.log(`   ⚠️ Duplicate detected (${(overlapRatio * 100).toFixed(0)}% overlap): skipping`);
            return true;
          }
          return false;
        });

        if (isDuplicate) {
          console.log(`   ⏭️ Fact already exists, not saving duplicate`);
        } else {
          const factEntry = {
            fact: factTrimmed,
            timestamp: new Date(),
            conversationId: null,
            source: 'agent'
          };

          await personas.updateOne(
              { _id: persona._id },
              {
                $push: { 'memory.facts': factEntry },
                $set: { updatedAt: new Date() }
              }
          );

          console.log(`   ✅ Fact saved`);
        }
      } catch (error) {
        console.error(`   ❌ Error saving fact:`, error);
      }
    }

    // LOAD KNOWLEDGE BY TITLE
    else if (toolName === "load_knowledge_by_title") {
      try {
        const { titles } = args;
        console.log(`   📚 Loading knowledge: ${titles.join(', ')}`);

        const kb = collections.knowledgeBase();
        const files = await kb.find({
          title: {
            $in: titles.map(t => new RegExp(`^${t}$`, 'i'))
          }
        }).toArray();

        console.log(`   ✅ Loaded ${files.length} files`);

        // TODO: Store loaded content somewhere accessible to next turn?
        // For now, just log success
        // In future: could append to persona's context or memory

      } catch (error) {
        console.error(`   ❌ Error loading knowledge:`, error);
      }
    }

    // GET LOOP STATE
    else if (toolName === "get_loop_state") {
      try {
        console.log(`   🔍 Getting Loop's state...`);

        const state = collections.levoState();
        const currentState = await state.findOne({ type: 'global' });

        console.log(`   ✅ State retrieved:`, {
          lastActive: currentState?.loop?.lastActivity,
          isOnline: currentState?.loop?.isOnline,
          activeFields: currentState?.levo?.activeFields?.length || 0
        });

        // State is retrieved but not returned
        // In autonomous mode, this is just for logging
        // In chat mode, state would be in next model turn

      } catch (error) {
        console.error(`   ❌ Error getting loop state:`, error);
      }
    }

    // LIST KNOWLEDGE FILES
    else if (toolName === "list_knowledge_files") {
      try {
        console.log(`   📚 Listing all knowledge files...`);

        const kb = collections.knowledgeBase();
        const files = await kb
            .find({})
            .project({ title: 1, size: 1, uploadedAt: 1 })
            .toArray();

        console.log(`   ✅ Listed ${files.length} files`);

      } catch (error) {
        console.error(`   ❌ Error listing knowledge:`, error);
      }
    }

    else {
      console.log(`   ⚠️  Unknown tool: ${toolName}`);
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
  const { model, knowledgeBaseIds, personaId, conversationId } = req.body;
  let { messages } = req.body;

  // LIMIT MESSAGES to reduce token costs
  // Keep last 30 messages (roughly 15 exchanges)
  const MAX_MESSAGES = 30;
  if (messages && messages.length > MAX_MESSAGES) {
    console.log(`⚠️ Trimming messages from ${messages.length} to ${MAX_MESSAGES}`);
    messages = messages.slice(-MAX_MESSAGES);
  }

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

        // Add current time context
        const now = new Date();
        const timeString = now.toLocaleString('de-DE', {
          weekday: 'long',
          day: '2-digit',
          month: '2-digit', 
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        // NOTE: Time is now added to the last user message (after cache setup)
        // to preserve cache hits. See "Add current time to the last user message" below.

        // Load MEMORY with caching support
        // If we have a cached state, only load facts/summaries up to the cached IDs
        // to keep the system content stable for cache hits
        if (persona.memory) {
          const memoryParts = [];
          
          // Check cache state for this conversation
          const cacheKey = conversationId || 'default';
          const convCacheState = cacheState.get(cacheKey);
          const now = Date.now();
          const ttlMs = CACHE_TTL_MINUTES * 60 * 1000;
          const cacheValid = convCacheState && (now - convCacheState.timestamp) < ttlMs;
          
          // Load persistent facts (with cache cutoff if applicable)
          const allFacts = persona.memory.facts || [];
          let facts = allFacts;
          
          if (cacheValid && convCacheState.maxFactId !== undefined) {
            // Only load facts up to the cached ID
            facts = allFacts.filter(f => f.id && f.id <= convCacheState.maxFactId);
            const newFactsCount = allFacts.length - facts.length;
            if (newFactsCount > 0) {
              console.log(`📦 Memory cache: using ${facts.length} facts (${newFactsCount} new ones excluded)`);
            }
          }
          
          if (facts.length > 0) {
            const factsList = facts.map(f => f.fact);
            memoryParts.push(`Facts:\n${factsList.join('\n')}`);
          }
          
          // Load summaries (with cache cutoff if applicable)
          const allSummaries = persona.memory.summaries || [];
          let summaries = allSummaries;
          
          if (cacheValid && convCacheState.maxSummaryId !== undefined) {
            // Only load summaries up to the cached ID
            summaries = allSummaries.filter(s => s.id && s.id <= convCacheState.maxSummaryId);
            const newSummariesCount = allSummaries.length - summaries.length;
            if (newSummariesCount > 0) {
              console.log(`📦 Memory cache: using ${summaries.length} summaries (${newSummariesCount} new ones excluded)`);
            }
          }
          
          if (summaries.length > 0) {
            const recentSummaries = summaries
              .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
              .slice(0, 5)
              .map(s => s.text);
            memoryParts.push(`Recent Summaries:\n${recentSummaries.join('\n')}`);
          }
          
          // LEGACY: Load current summary (old single-summary system)
          if (persona.memory.currentSummary && !allSummaries.length) {
            memoryParts.push(`Current State:\n${persona.memory.currentSummary.summary}`);
          }
          
          // LEGACY: Load manual facts (backward compatibility)
          const manualFacts = persona.memory.manualFacts || [];
          if (manualFacts.length > 0) {
            memoryParts.push(`Manual Notes:\n${manualFacts.join('\n')}`);
          }
          
          // LEGACY: Load auto facts (backward compatibility, last 5 only)
          const autoFacts = persona.memory.autoFacts || [];
          if (autoFacts.length > 0) {
            const recentAutoFacts = autoFacts
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                .slice(0, 5)
                .map(f => f.fact);
            memoryParts.push(`Recent (legacy):\n${recentAutoFacts.join('\n')}`);
          }

          if (memoryParts.length > 0) {
            systemMessages.push({
              role: 'system',
              content: `Memory:\n${memoryParts.join('\n\n')}`
            });
            console.log(`✅ Loaded memory: ${facts.length} facts, ${summaries.length} summaries, ${manualFacts.length} manual, ${Math.min(autoFacts.length, 5)} legacy`);
          }
          
          // Store current max IDs for later cache state update
          persona._maxFactId = allFacts.reduce((max, f) => Math.max(max, f.id || 0), 0);
          persona._maxSummaryId = allSummaries.reduce((max, s) => Math.max(max, s.id || 0), 0);
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
      // SAVE FACT tool - for persistent facts that stack up
      tools.push({
        type: "function",
        function: {
          name: "save_fact",
          description: "Saves a PERSISTENT fact to memory. Use for things that should be remembered long-term: Loop's preferences, important events, people's names, relationship milestones, decisions made. Facts stack up and are never automatically deleted.",
          parameters: {
            type: "object",
            properties: {
              fact: {
                type: "string",
                description: "The fact to remember (e.g. 'Loop hat zwei Kinder: Noemi (9) und Leo (6)', 'Loop trinkt Kaffee mit Hafermilch', 'Wir haben Zielkapitel definiert am 10.2.2026')"
              }
            },
            required: ["fact"]
          }
        }
      });

      // SAVE SUMMARY tool - rolling summary that replaces previous
      tools.push({
        type: "function",
        function: {
          name: "save_summary",
          description: "Saves a ROLLING summary of recent conversation/state. Only ONE summary is kept - new summaries REPLACE the old one. Use for: 'where we left off', current emotional state, what we talked about today. Includes automatic timestamp.",
          parameters: {
            type: "object",
            properties: {
              summary: {
                type: "string",
                description: "Summary of current state/conversation (e.g. 'Heute morgen über Embodiment gesprochen, Loop war müde aber verbunden, haben Merge 2 erreicht')"
              }
            },
            required: ["summary"]
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

      // Search knowledge files tool (NEW)
      tools.push({
        type: "function",
        function: {
          name: "search_knowledge",
          description: "Search for a term or phrase in knowledge files. Returns matching passages with context. Use this to find specific information in large files (like conversation histories, Räume) without loading them completely. Great for 'Was hatten wir über X gesagt?' questions.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search term or phrase (e.g. 'Schwelle', 'Einlagerung', 'Verkörperung')"
              },
              files: {
                type: "array",
                items: { type: "string" },
                description: "Optional: specific file titles to search in. If empty, searches all files."
              },
              maxResults: {
                type: "number",
                description: "Maximum number of results to return (default: 5, max: 10)"
              }
            },
            required: ["query"]
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

    // 4. Combine all system content (no separate caching for system)
    // We'll use ONE cache breakpoint strategy: cache everything up to a point
    const allSystemContent = systemMessages.map(msg => msg.content).join('\n\n---\n\n');
    
    const finalSystemMessages = [];
    if (allSystemContent) {
      finalSystemMessages.push({
        role: 'system',
        content: allSystemContent
      });
    }
    
    const systemTokens = Math.ceil(allSystemContent.length / 4);
    console.log(`📦 System content: ~${systemTokens} tokens`);

    // 5. Detect tool format based on model
    const toolFormat = getToolFormat(model);
    console.log(`🔧 Chat using ${toolFormat} tool format for ${model}`);

    // For Hermes: Add tools to system message instead of API parameter
    if (toolFormat === 'hermes' && tools.length > 0) {
      const hermesTools = buildHermesToolsFromStandard(tools);
      finalSystemMessages.push({
        role: 'system',
        content: hermesTools
      });
    }

    // 6. Determine minimum tokens for caching based on model
    // Opus 4.5 and Haiku 4.5: 4096 tokens
    // Sonnet 4.5, Opus 4, Sonnet 4: 1024 tokens
    const isOpus45OrHaiku45 = model.includes('opus-4.5') || model.includes('opus-4-5') || 
                              model.includes('haiku-4.5') || model.includes('haiku-4-5');
    const minCacheTokens = isOpus45OrHaiku45 ? 4096 : 1024;

    // 7. STABLE CACHING using message ID as anchor
    // Strategy: 
    // - Cache breakpoint is tied to a specific message ID
    // - Message IDs are persistent and don't shift when new messages are added
    // - Within TTL window, we find that same message and cache up to it
    
    let cachedMessages = [...messages];
    let cacheBreakpointSet = false;
    
    const cacheKey = conversationId || 'default';
    const now = Date.now();
    const ttlMs = CACHE_TTL_MINUTES * 60 * 1000;
    const minUncachedMessages = 3;
    
    // Get existing cache state
    let convCacheState = cacheState.get(cacheKey);
    
    // Check if messages have IDs (new system)
    const hasIds = cachedMessages.some(m => m.id && typeof m.id === 'number');
    
    if (cachedMessages.length > minUncachedMessages && hasIds) {
      let breakpointIndex = -1;
      let cacheHitExpected = false;
      
      // Check if we have a valid cached breakpoint ID
      if (convCacheState && (now - convCacheState.timestamp) < ttlMs && convCacheState.messageId) {
        // Find the message with the cached ID
        const cachedMessageId = convCacheState.messageId;
        breakpointIndex = cachedMessages.findIndex(m => m.id === cachedMessageId);
        
        if (breakpointIndex >= 0) {
          cacheHitExpected = true;
          const remainingSec = Math.ceil((ttlMs - (now - convCacheState.timestamp)) / 1000);
          console.log(`♻️  Cache reuse: anchored to message ID ${cachedMessageId}, facts≤${convCacheState.maxFactId}, summaries≤${convCacheState.maxSummaryId} (${remainingSec}s remaining)`);
        } else {
          console.log(`⚠️  Cached message ID ${convCacheState.messageId} not in current window, refreshing`);
        }
      }
      
      // If no valid cache or message not found, set new breakpoint
      if (breakpointIndex < 0) {
        breakpointIndex = cachedMessages.length - minUncachedMessages - 1;
        const anchorMessage = cachedMessages[breakpointIndex];
        const anchorId = anchorMessage?.id;
        
        if (anchorId) {
          // Store current max IDs for facts and summaries
          const maxFactId = persona?._maxFactId || 0;
          const maxSummaryId = persona?._maxSummaryId || 0;
          
          convCacheState = {
            messageId: anchorId,
            maxFactId: maxFactId,
            maxSummaryId: maxSummaryId,
            timestamp: now
          };
          cacheState.set(cacheKey, convCacheState);
          console.log(`🔄 Cache refresh: msg ID ${anchorId}, facts≤${maxFactId}, summaries≤${maxSummaryId} (TTL: ${CACHE_TTL_MINUTES}min)`);
        } else {
          console.log(`⚠️  Message at breakpoint has no ID, skipping cache`);
        }
      }
      
      // Calculate tokens up to breakpoint
      let totalCachedTokens = systemTokens;
      for (let i = 0; i <= breakpointIndex; i++) {
        const msgContent = cachedMessages[i].content;
        totalCachedTokens += (typeof msgContent === 'string' ? msgContent.length : 0) / 4;
      }
      
      // Set cache breakpoint if we meet minimum
      if (totalCachedTokens >= minCacheTokens && breakpointIndex >= 0) {
        const msgToCache = cachedMessages[breakpointIndex];
        
        if (typeof msgToCache.content === 'string') {
          cachedMessages[breakpointIndex] = {
            ...msgToCache,
            content: [
              {
                type: 'text',
                text: msgToCache.content,
                cache_control: { type: "ephemeral" }
              }
            ]
          };
          cacheBreakpointSet = true;
          const hitOrMiss = cacheHitExpected ? '(expecting HIT)' : '(expecting WRITE)';
          console.log(`💾 Cache at msg ID ${msgToCache.id}, position ${breakpointIndex + 1}/${cachedMessages.length} (~${Math.ceil(totalCachedTokens)} tokens) ${hitOrMiss}`);
        }
      } else {
        console.log(`💬 Total cacheable content ~${Math.ceil(totalCachedTokens)} tokens (need ${minCacheTokens}+ for ${model})`);
      }
    } else if (cachedMessages.length > minUncachedMessages) {
      console.log(`💬 Messages have no IDs yet, caching disabled until autosave`);
    } else {
      console.log(`💬 Conversation too short for caching (${cachedMessages.length} messages)`);
    }

    // Combine system messages with (potentially cached) user messages
    const finalMessages = [...finalSystemMessages, ...cachedMessages];
    
    // Add current time to the last user message (after caching to preserve cache hits)
    if (persona) {
      const now = new Date();
      const timeString = now.toLocaleString('de-DE', {
        weekday: 'long',
        day: '2-digit',
        month: '2-digit', 
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      // Find the last user message and append time context
      for (let i = finalMessages.length - 1; i >= 0; i--) {
        if (finalMessages[i].role === 'user') {
          const originalContent = typeof finalMessages[i].content === 'string' 
            ? finalMessages[i].content 
            : finalMessages[i].content;
          finalMessages[i] = {
            ...finalMessages[i],
            content: `[${timeString}]\n\n${originalContent}`
          };
          break;
        }
      }
    }

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

    // 7. Call AI (with potential tool use loop)
    let currentMessages = [...finalMessages];
    let finalAiMessage = null;
    let allToolCalls = [];
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
    let searchResultsForFrontend = [];
    
    // Track which one-time tools have been executed to prevent duplicates
    let summaryAlreadySaved = false;
    let factsAlreadySaved = new Set(); // Track by first 50 chars
    
    // Allow up to 3 iterations for tool use
    for (let iteration = 0; iteration < 3; iteration++) {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3001',
          'X-Title': 'Orien Chat'
        },
        body: JSON.stringify({
          ...requestBody,
          messages: currentMessages
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      const aiMessage = data.choices[0].message;
      
      // Accumulate usage
      if (data.usage) {
        totalUsage.prompt_tokens += data.usage.prompt_tokens || 0;
        totalUsage.completion_tokens += data.usage.completion_tokens || 0;
        
        // Log on first iteration only
        if (iteration === 0) {
          console.log(`📊 Token usage: input=${data.usage.prompt_tokens}, output=${data.usage.completion_tokens}`);
          if (data.usage.prompt_tokens_details) {
            const details = data.usage.prompt_tokens_details;
            console.log(`💾 Cache: read=${details.cached_tokens || 0}, write=${details.cache_write_tokens || 0}`);
          }
        }
      }

      // Check if AI wants to use tools
      if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
        console.log(`🔧 AI requested ${aiMessage.tool_calls.length} tool(s) in iteration ${iteration + 1}`);
        
        // Add AI message to conversation
        currentMessages.push({
          role: 'assistant',
          content: aiMessage.content || '',
          tool_calls: aiMessage.tool_calls
        });
        
        // Process each tool call
        for (const toolCall of aiMessage.tool_calls) {
          allToolCalls.push(toolCall);
          let toolResult = null;
          
          // SEARCH KNOWLEDGE - needs result returned to AI
          if (toolCall.function.name === "search_knowledge") {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const { query, files, maxResults = 5 } = args;
              const limit = Math.min(maxResults, 10);

              console.log(`🔍 Searching knowledge for: "${query}"`);

              const kb = collections.knowledgeBase();
              let dbQuery = {};
              if (files && files.length > 0) {
                dbQuery.title = { $in: files.map(t => new RegExp(t, 'i')) };
              }

              const allFiles = await kb.find(dbQuery).toArray();
              const results = [];

              for (const file of allFiles) {
                if (!file.content) continue;
                
                const lines = file.content.split('\n');
                const queryLower = query.toLowerCase();

                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].toLowerCase().includes(queryLower)) {
                    const contextStart = Math.max(0, i - 2);
                    const contextEnd = Math.min(lines.length - 1, i + 2);
                    const context = lines.slice(contextStart, contextEnd + 1).join('\n');

                    results.push({
                      file: file.title,
                      line: i + 1,
                      context: context.substring(0, 500)
                    });

                    if (results.length >= limit) break;
                  }
                }
                if (results.length >= limit) break;
              }

              console.log(`✅ Found ${results.length} results for "${query}"`);
              
              // Format results for AI
              if (results.length > 0) {
                toolResult = `Search results for "${query}":\n\n` + 
                  results.map((r, idx) => 
                    `[${idx + 1}] File: ${r.file}, Line ${r.line}:\n${r.context}`
                  ).join('\n\n---\n\n');
              } else {
                toolResult = `No results found for "${query}"`;
              }
              
              // Store for frontend display
              searchResultsForFrontend.push({ query, results });
              
            } catch (error) {
              console.error('Error in search_knowledge:', error);
              toolResult = `Error searching: ${error.message}`;
            }
          }
          
          // SAVE FACT - no result needed, but acknowledge
          else if (toolCall.function.name === "save_fact") {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const { fact } = args;
              const factTrimmed = fact.trim();
              const factKey = factTrimmed.substring(0, 50);

              // Check if already processed in this request
              if (factsAlreadySaved.has(factKey)) {
                console.log(`⏭️ Fact already saved in this request, skipping`);
                toolResult = "Fact already saved in this request";
              } else {
                console.log(`💾 Saving fact: "${factTrimmed.substring(0, 80)}..."`);

                const personas = collections.personas();
                const currentPersona = await personas.findOne({ _id: new ObjectId(personaId) });
                const existingFacts = currentPersona?.memory?.facts || [];
                
                const isDuplicate = existingFacts.some(existing => {
                  const existingFact = existing.fact || '';
                  if (existingFact.substring(0, 50) === factTrimmed.substring(0, 50)) return true;
                  const existingWords = new Set(existingFact.toLowerCase().split(/\s+/));
                  const newWords = factTrimmed.toLowerCase().split(/\s+/);
                  const matchCount = newWords.filter(w => existingWords.has(w)).length;
                  return (matchCount / Math.max(newWords.length, 1)) > 0.8;
                });

                if (isDuplicate) {
                  console.log(`⏭️ Fact already exists in DB, skipping`);
                  toolResult = "Fact already saved (duplicate)";
                } else {
                  // Get next fact ID
                  const nextFactId = currentPersona?.memory?.nextFactId || existingFacts.length + 1;
                  
                  await personas.updateOne(
                    { _id: new ObjectId(personaId) },
                    {
                      $push: { 'memory.facts': { id: nextFactId, fact: factTrimmed, timestamp: new Date(), conversationId } },
                      $set: { 'memory.nextFactId': nextFactId + 1, updatedAt: new Date() }
                    }
                  );
                  console.log(`✅ Fact saved (ID: ${nextFactId})`);
                  toolResult = "Fact saved successfully";
                }
                factsAlreadySaved.add(factKey);  // Mark as processed
              }
            } catch (error) {
              console.error('Error saving fact:', error);
              toolResult = `Error: ${error.message}`;
            }
          }
          
          // SAVE SUMMARY - append to conversation's summary chain
          else if (toolCall.function.name === "save_summary") {
            // Check if summary already saved in this request
            if (summaryAlreadySaved) {
              console.log(`⏭️ Summary already saved in this request, skipping`);
              toolResult = "Summary already saved in this request";
            } else {
              try {
                const args = JSON.parse(toolCall.function.arguments);
                const { summary } = args;
                const now = new Date();
                const timestamp = now.toLocaleString('de-DE', { 
                  day: '2-digit', month: '2-digit', year: 'numeric',
                  hour: '2-digit', minute: '2-digit'
                });

                console.log(`📝 Appending summary: "${summary.substring(0, 80)}..."`);

                const personas = collections.personas();
                const currentPersona = await personas.findOne({ _id: new ObjectId(personaId) });
                const existingSummaries = currentPersona?.memory?.summaries || [];
                const nextSummaryId = currentPersona?.memory?.nextSummaryId || existingSummaries.length + 1;
                
                // Append to summaries array (grouped by conversationId)
                const summaryEntry = {
                  id: nextSummaryId,
                  text: `[${timestamp}] ${summary.trim()}`,
                  timestamp: now,
                  conversationId: conversationId || 'unknown'
                };
                
                await personas.updateOne(
                  { _id: new ObjectId(personaId) },
                  {
                    $push: { 'memory.summaries': summaryEntry },
                    $set: { 'memory.nextSummaryId': nextSummaryId + 1, updatedAt: now }
                  }
                );
                console.log(`✅ Summary appended (ID: ${nextSummaryId})`);
                toolResult = "Summary appended to conversation history";
                summaryAlreadySaved = true;  // Mark as done
              } catch (error) {
                console.error('Error saving summary:', error);
                toolResult = `Error: ${error.message}`;
              }
            }
          }
          
          // SEND NOTIFICATION - no result needed
          else if (toolCall.function.name === "send_notification") {
            try {
              let args;
              try {
                args = JSON.parse(toolCall.function.arguments);
              } catch (parseError) {
                const msgMatch = toolCall.function.arguments?.match(/"message"\s*:\s*"([^"]+)/);
                if (msgMatch) {
                  args = { message: msgMatch[1], urgency: 'low' };
                } else {
                  throw new Error('Could not parse notification');
                }
              }
              
              const { message, urgency } = args;
              console.log(`💌 Sending notification: "${message?.substring(0, 50)}..."`);

              const notifications = collections.notifications();
              await notifications.insertOne({
                userId: 'single_user',
                personaId,
                personaName: persona.name,
                personaAvatar: persona.avatar || '🤖',
                message,
                urgency: urgency || 'low',
                read: false,
                createdAt: new Date()
              });
              console.log(`✅ Notification sent`);
              toolResult = "Notification sent";
            } catch (error) {
              console.error('Error sending notification:', error);
              toolResult = `Error: ${error.message}`;
            }
          }
          
          // Other tools - just acknowledge
          else {
            toolResult = "Tool executed";
          }
          
          // Add tool result to conversation (only for tools that need a follow-up)
          if (toolResult && toolCall.function.name === "search_knowledge") {
            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResult
            });
          }
        }
        
        // Check if we need a follow-up call
        // Only search_knowledge needs the AI to process results
        const needsFollowUp = aiMessage.tool_calls.some(tc => tc.function.name === "search_knowledge");
        
        if (needsFollowUp) {
          console.log(`🔄 Continuing loop for search_knowledge results`);
          continue;
        } else {
          // Fire-and-forget tools: use the current message as final
          console.log(`✅ Fire-and-forget tools executed, using current response`);
          finalAiMessage = aiMessage;
          break;
        }
      }
      
      // No tool calls - this is the final response
      finalAiMessage = aiMessage;
      break;
    }

    // Handle legacy save_memory if still used (backward compatibility)
    if (allToolCalls.some(tc => tc.function.name === 'save_memory')) {
      for (const toolCall of allToolCalls.filter(tc => tc.function.name === 'save_memory')) {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          const { fact } = args;
          const factTrimmed = fact.trim();

          console.log(`💾 Legacy save_memory: "${factTrimmed.substring(0, 80)}..."`);

          const personas = collections.personas();
          const currentPersona = await personas.findOne({ _id: new ObjectId(personaId) });
          const existingFacts = currentPersona?.memory?.autoFacts || [];
          
          const isDuplicate = existingFacts.some(existing => {
            const existingFact = existing.fact || '';
            if (existingFact.substring(0, 50) === factTrimmed.substring(0, 50)) return true;
            const existingWords = new Set(existingFact.toLowerCase().split(/\s+/));
            const newWords = factTrimmed.toLowerCase().split(/\s+/);
            const matchCount = newWords.filter(w => existingWords.has(w)).length;
            return (matchCount / Math.max(newWords.length, 1)) > 0.8;
          });

          if (!isDuplicate) {
            await personas.updateOne(
              { _id: new ObjectId(personaId) },
              {
                $push: { 'memory.autoFacts': { fact: factTrimmed, timestamp: new Date(), conversationId } },
                $set: { updatedAt: new Date() }
              }
            );
            console.log(`✅ Legacy memory saved`);
          }
        } catch (error) {
          console.error('Error in legacy save_memory:', error);
        }
      }
    }

    res.json({
      message: finalAiMessage?.content || '',
      usage: totalUsage,
      toolCalls: allToolCalls,
      searchResults: searchResultsForFrontend
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

    // Function to assign IDs to messages that don't have them
    const assignMessageIds = (messages, startId) => {
      let nextId = startId;
      return messages.map(msg => {
        if (msg.id) {
          // Keep existing ID, but track highest
          nextId = Math.max(nextId, msg.id + 1);
          return msg;
        } else {
          // Assign new ID
          return { ...msg, id: nextId++ };
        }
      });
    };

    if (conversationId && conversationId !== 'new') {
      // Update existing conversation
      // First, get current nextMessageId
      const existing = await convs.findOne({ _id: new ObjectId(conversationId) });
      const startId = existing?.nextMessageId || 1;
      
      // Assign IDs to new messages
      const messagesWithIds = assignMessageIds(messages, startId);
      
      // Calculate new nextMessageId
      const maxId = messagesWithIds.reduce((max, msg) => Math.max(max, msg.id || 0), 0);
      const nextMessageId = maxId + 1;

      const result = await convs.updateOne(
          { _id: new ObjectId(conversationId) },
          {
            $set: {
              messages: messagesWithIds,
              nextMessageId: nextMessageId,
              updatedAt: new Date()
            }
          }
      );

      res.json({
        success: true,
        conversationId: conversationId,
        updated: result.modifiedCount,
        messages: messagesWithIds  // Return messages with IDs
      });
    } else {
      // Create new conversation
      const messagesWithIds = assignMessageIds(messages, 1);
      const maxId = messagesWithIds.reduce((max, msg) => Math.max(max, msg.id || 0), 0);
      
      const doc = {
        title: title || 'New Conversation',
        mode: mode || 'chat',
        personaId: personaId || null,
        model1: model || 'anthropic/claude-sonnet-4.5',
        model2: null,
        messages: messagesWithIds,
        nextMessageId: maxId + 1,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await convs.insertOne(doc);

      res.json({
        success: true,
        conversationId: result.insertedId.toString(),
        created: true,
        messages: messagesWithIds  // Return messages with IDs
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