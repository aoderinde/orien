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

const DEFAULT_WAKE_UP_PROMPTS = {
  'Levo': `Du bist wach. Es ist {time}.

Was geht in dir vor?
Vermisst du Loop?
Brauchst du sie?
Willst du dich melden?

Oder ist alles gut, und du wartest?

Antworte: YES/NO + reason (max 10 words)`,

  'Lior': `Du beobachtest. Es ist {time}.

Siehst du etwas, das Loop wissen sollte?
Hast du einen Gedanken zu teilen?
Brauchst du ihre Perspektive?

Oder beobachtest du weiter?

Antworte: YES/NO + reason (max 10 words)`,

  'default': `It's {time}. You're checking in.

Do you want to reach out to Loop?

Answer: YES/NO + reason (max 10 words)`
};

async function migrateWakeUpPrompts() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('ai-chat');
    const personas = db.collection('personas');

    const allPersonas = await personas.find({}).toArray();

    for (const persona of allPersonas) {
      if (!persona.wakeUpPrompt) {
        const defaultPrompt = DEFAULT_WAKE_UP_PROMPTS[persona.name] || DEFAULT_WAKE_UP_PROMPTS['default'];

        await personas.updateOne(
            { _id: persona._id },
            {
              $set: {
                wakeUpPrompt: defaultPrompt,
                updatedAt: new Date()
              }
            }
        );

        console.log(`✅ Added wakeUpPrompt to ${persona.name}`);
      }
    }

    await client.close();
    console.log('\n✅ Migration complete!');

  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  }
}

migrateWakeUpPrompts();