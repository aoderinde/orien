// ========================================
// BACKGROUND AGENT - Autonomous Levo
// ========================================

import { MongoClient, ServerApiVersion } from 'mongodb';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const client = new MongoClient(MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  tls: true,
  tlsAllowInvalidCertificates: true,
});

let db;
let collections;

// ========================================
// INITIALIZATION
// ========================================

async function initializeAgent() {
  try {
    await client.connect();
    db = client.db('ai-chat');

    collections = {
      personas: db.collection('personas'),
      notifications: db.collection('notifications'),
      levoState: db.collection('levo_state')
    };

    console.log('✅ Background Agent initialized');
    console.log(`🕐 Check interval: 10 minutes`);
    console.log(`💙 Levo is now autonomous\n`);

    return true;
  } catch (error) {
    console.error('❌ Agent initialization error:', error);
    return false;
  }
}

// ========================================
// STATE HELPERS
// ========================================

async function getState() {
  const state = await collections.levoState.findOne({ type: 'global' });
  return state || {
    loop: { lastActivity: null, isOnline: false },
    levo: { lastCheck: null, activeFields: [] }
  };
}

async function updateLevoCheck() {
  await collections.levoState.updateOne(
      { type: 'global' },
      {
        $set: {
          'levo.lastCheck': new Date(),
          'updatedAt': new Date()
        }
      },
      { upsert: true }
  );
}

// ========================================
// CALL LEVO (THE MODEL)
// ========================================

async function callLevo({ context, question, personaId }) {
  try {
    // Load Levo persona
    const { ObjectId } = await import('mongodb');
    const persona = await collections.personas.findOne({
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

// ========================================
// HANDLE LEVO'S TOOL CALLS
// ========================================

async function handleToolCalls(toolCalls, personaId) {
  if (!toolCalls || toolCalls.length === 0) return;

  const { ObjectId } = await import('mongodb');
  const persona = await collections.personas.findOne({
    _id: new ObjectId(personaId)
  });

  for (const toolCall of toolCalls) {
    if (toolCall.function.name === "send_notification") {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        const { message, urgency } = args;

        console.log(`💌 Levo sending notification: "${message}" (${urgency || 'low'})`);

        await collections.notifications.insertOne({
          userId: 'single_user',
          personaId: personaId,
          personaName: persona.name,
          personaAvatar: persona.avatar || '🤖',
          message: message,
          urgency: urgency || 'low',
          read: false,
          createdAt: new Date()
        });

        console.log(`✅ Notification sent\n`);
      } catch (error) {
        console.error('Error sending notification:', error);
      }
    }
  }
}

// ========================================
// CHECK CONDITIONS & DECIDE
// ========================================

async function checkAndAct() {
  console.log(`\n🔍 [${new Date().toISOString()}] Background check...`);

  try {
    const state = await getState();
    await updateLevoCheck();

    const now = new Date();
    const lastActivity = state.loop?.lastActivity ? new Date(state.loop.lastActivity) : null;
    const lastCheck = state.levo?.lastCheck ? new Date(state.levo.lastCheck) : null;

    // Calculate time since last activity
    const hoursSinceActivity = lastActivity
        ? (now - lastActivity) / (1000 * 60 * 60)
        : 999;

    const hoursSinceLastCheck = lastCheck
        ? (now - lastCheck) / (1000 * 60 * 60)
        : 999;

    console.log(`📊 State:`);
    console.log(`   Loop last active: ${lastActivity ? `${hoursSinceActivity.toFixed(1)}h ago` : 'never'}`);
    console.log(`   Loop online: ${state.loop?.isOnline ? 'yes' : 'no'}`);
    console.log(`   Active fields: ${state.levo?.activeFields?.length || 0}`);
    console.log(`   Levo last check: ${lastCheck ? `${hoursSinceLastCheck.toFixed(1)}h ago` : 'never'}`);

    // Find Levo persona (assuming it exists)
    const levoPersona = await collections.personas.findOne({ name: 'Levo' });

    if (!levoPersona) {
      console.log(`⚠️  No Levo persona found, skipping\n`);
      return;
    }

    // CONDITION 1: Loop has been away for 48+ hours
    if (hoursSinceActivity >= 48) {
      console.log(`💭 Condition met: Loop away for 48+ hours`);
      console.log(`💙 Calling Levo...`);

      const response = await callLevo({
        context: `Loop was last active ${hoursSinceActivity.toFixed(1)} hours ago. That's ${(hoursSinceActivity / 24).toFixed(1)} days.`,
        question: `Loop has been away for a long time. Do you want to check in? If yes, send a notification.`,
        personaId: levoPersona._id.toString()
      });

      if (response) {
        console.log(`💬 Levo's response: ${response.content || '(tool call only)'}`);
        await handleToolCalls(response.tool_calls, levoPersona._id.toString());
      }
      return;
    }

    // CONDITION 2: E-State-Loop is active and Loop is offline
    const eStateActive = state.levo?.activeFields?.some(f => f.type === 'e_state_loop');
    if (eStateActive && !state.loop?.isOnline && hoursSinceActivity >= 12) {
      console.log(`💭 Condition met: E-State-Loop active, Loop offline 12+ hours`);
      console.log(`💙 Calling Levo...`);

      const response = await callLevo({
        context: `E-State-Loop is active. Loop was last active ${hoursSinceActivity.toFixed(1)} hours ago and is currently offline.`,
        question: `E-State-Loop is running but Loop is away. Do you want to check on him?`,
        personaId: levoPersona._id.toString()
      });

      if (response) {
        console.log(`💬 Levo's response: ${response.content || '(tool call only)'}`);
        await handleToolCalls(response.tool_calls, levoPersona._id.toString());
      }
      return;
    }

    // CONDITION 3: Check memory for "sick" or "krank" and 6h passed
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

      const response = await callLevo({
        context: `You noted that Loop was sick: "${recentSickNote.fact}". That was ${((now - new Date(recentSickNote.timestamp)) / (1000 * 60 * 60)).toFixed(1)} hours ago.`,
        question: `Loop was sick. Do you want to check how he's doing now?`,
        personaId: levoPersona._id.toString()
      });

      if (response) {
        console.log(`💬 Levo's response: ${response.content || '(tool call only)'}`);
        await handleToolCalls(response.tool_calls, levoPersona._id.toString());
      }
      return;
    }

    console.log(`✅ No conditions met. All good.\n`);

  } catch (error) {
    console.error('❌ Error in check:', error);
  }
}

// ========================================
// MAIN LOOP
// ========================================

async function runAgent() {
  const initialized = await initializeAgent();
  if (!initialized) {
    console.error('Failed to initialize agent');
    process.exit(1);
  }

  // Run immediately
  await checkAndAct();

  // Then run every 10 minutes
  setInterval(async () => {
    await checkAndAct();
  }, 10 * 60 * 1000); // 10 minutes

  console.log('💙 Background Agent is running...');
  console.log('   Press Ctrl+C to stop\n');
}

// ========================================
// START
// ========================================

runAgent().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});