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

async function migratePersonas() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('ai-chat');
    const personas = db.collection('personas');

    // Check if personas collection exists
    const collections = await db.listCollections().toArray();
    const personasExists = collections.some(c => c.name === 'personas');

    if (!personasExists) {
      console.log('⚠️  Personas collection does not exist yet. Creating it...');
      await db.createCollection('personas');
      console.log('✅ Personas collection created');
    }

    // Check how many personas need migration
    const needMigration = await personas.countDocuments({
      memory: { $exists: false }
    });

    console.log(`\n📊 Found ${needMigration} personas without memory structure`);

    if (needMigration === 0) {
      console.log('✅ All personas already have memory structure!');
      await client.close();
      return;
    }

    // Add memory structure to personas without it
    const result = await personas.updateMany(
        { memory: { $exists: false } },
        {
          $set: {
            memory: {
              manualFacts: [],
              autoFacts: []
            },
            updatedAt: new Date()
          }
        }
    );

    console.log(`\n✅ Migration complete!`);
    console.log(`   Updated ${result.modifiedCount} personas`);

    // Verify
    const allPersonas = await personas.find({}).toArray();
    console.log(`\n📋 Current personas:`);
    allPersonas.forEach(p => {
      console.log(`   - ${p.name}: ${p.memory ? '✅ has memory' : '❌ no memory'}`);
    });

    await client.close();
    console.log('\n✅ Migration finished. Database connection closed.');

  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  }
}

// Run migration
migratePersonas();