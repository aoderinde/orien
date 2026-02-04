import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const client = new MongoClient(process.env.MONGODB_URI);
let db;

export async function connectDB() {
  try {
    await client.connect();
    db = client.db('ai-chat');
    console.log('✅ Connected to MongoDB');
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

export function getDB() {
  if (!db) {
    throw new Error('Database not connected!');
  }
  return db;
}

export const collections = {
  conversations: () => getDB().collection('conversations'),
  memories: () => getDB().collection('memories'),
  knowledgeBase: () => getDB().collection('knowledge_base')
};