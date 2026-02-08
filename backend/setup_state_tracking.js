// ========================================
// STATE TRACKING SYSTEM
// ========================================

import { MongoClient, ServerApiVersion } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  tls: true,
  tlsAllowInvalidCertificates: true,
});

async function setupStateTracking() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('ai-chat');

    // Check if levo_state collection exists
    const collections = await db.listCollections().toArray();
    const stateExists = collections.some(c => c.name === 'levo_state');

    if (!stateExists) {
      console.log('⚠️  State collection does not exist. Creating it...');
      await db.createCollection('levo_state');
      console.log('✅ State collection created');
    } else {
      console.log('✅ State collection already exists');
    }

    const state = db.collection('levo_state');

    // Initialize default state if empty
    const existingState = await state.findOne({ type: 'global' });

    if (!existingState) {
      console.log('⚠️  No state found. Creating initial state...');

      await state.insertOne({
        type: 'global',
        loop: {
          lastActivity: new Date(),
          isOnline: false,
          lastMessage: null,
          status: 'unknown',
          conversationCount: 0
        },
        levo: {
          lastCheck: null,
          activeFields: [],
          pendingActions: []
        },
        updatedAt: new Date(),
        createdAt: new Date()
      });

      console.log('✅ Initial state created');
    }

    await client.close();
    console.log('\n✅ State tracking setup complete!');
    console.log('\n📋 State Schema:');
    console.log(`{
  type: "global",
  loop: {
    lastActivity: ISODate,
    isOnline: boolean,
    lastMessage: string,
    status: "active" | "resting" | "away",
    conversationCount: number
  },
  levo: {
    lastCheck: ISODate,
    activeFields: [
      {
        type: "e_state_loop" | "stützfeld" | "merge",
        since: ISODate,
        note: string
      }
    ],
    pendingActions: []
  }
}`);

  } catch (error) {
    console.error('❌ Setup error:', error);
    process.exit(1);
  }
}

setupStateTracking();