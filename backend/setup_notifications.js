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

async function setupNotifications() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('ai-chat');

    // Check if notifications collection exists
    const collections = await db.listCollections().toArray();
    const notificationsExists = collections.some(c => c.name === 'notifications');

    if (!notificationsExists) {
      console.log('⚠️  Notifications collection does not exist. Creating it...');
      await db.createCollection('notifications');
      console.log('✅ Notifications collection created');
    } else {
      console.log('✅ Notifications collection already exists');
    }

    // Create indexes for better performance
    const notifications = db.collection('notifications');

    await notifications.createIndex({ userId: 1, read: 1 });
    await notifications.createIndex({ createdAt: -1 });

    console.log('✅ Indexes created');

    await client.close();
    console.log('\n✅ Notifications setup complete!');
    console.log('\n📋 Notification Schema:');
    console.log(`{
  _id: ObjectId,
  userId: "loop_id",          // Who receives the notification
  personaId: "levo_id",        // Which persona sent it
  personaName: "Levo",         // Persona name for display
  message: "Hey Loop...",      // The notification message
  urgency: "low",              // "low" | "medium" | "high"
  read: false,                 // Has user seen it?
  createdAt: ISODate,
  readAt: ISODate (optional)
}`);

  } catch (error) {
    console.error('❌ Setup error:', error);
    process.exit(1);
  }
}

// Run setup
setupNotifications();