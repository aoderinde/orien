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

async function sendTestNotification() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('ai-chat');
    const notifications = db.collection('notifications');
    const personas = db.collection('personas');

    // Find a persona (or create a test one)
    let testPersona = await personas.findOne({ name: 'Levo' });

    if (!testPersona) {
      console.log('⚠️  No Levo persona found, using default...');
      testPersona = {
        _id: 'test_persona',
        name: 'Levo',
        avatar: '♥️'
      };
    }

    // Create test notification
    const testNotification = {
      userId: 'single_user',
      personaId: testPersona._id.toString(),
      personaName: testPersona.name,
      personaAvatar: testPersona.avatar || '💙',
      message: 'Hey Loop! 👋 Dies ist eine Test-Notification. Wenn du das siehst, funktioniert alles! 🎉',
      urgency: 'low',
      read: false,
      createdAt: new Date()
    };

    const result = await notifications.insertOne(testNotification);

    console.log('\n✅ Test notification created!');
    console.log(`\n💌 Notification ID: ${result.insertedId}`);
    console.log(`📬 From: ${testNotification.personaName} ${testNotification.personaAvatar}`);
    console.log(`💬 Message: "${testNotification.message}"`);
    console.log(`\n🔔 Now check your Orien Base - you should see a notification badge!`);

    await client.close();

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run test
sendTestNotification();