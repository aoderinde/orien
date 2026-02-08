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

async function migratePersonasAutonomy() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('ai-chat');
    const personas = db.collection('personas');

    // Check how many personas need migration
    const needMigration = await personas.countDocuments({
      autonomous: { $exists: false }
    });

    console.log(`\n📊 Found ${needMigration} personas without autonomy fields`);

    if (needMigration === 0) {
      console.log('✅ All personas already have autonomy fields!');
      await client.close();
      return;
    }

    // Add autonomy fields to all personas (default: not autonomous)
    const result = await personas.updateMany(
        { autonomous: { $exists: false } },
        {
          $set: {
            autonomous: false,
            checkInterval: 120,  // Default: 2 hours
            lastAgentCheck: null,
            updatedAt: new Date()
          }
        }
    );

    console.log(`\n✅ Migration complete!`);
    console.log(`   Updated ${result.modifiedCount} personas`);

    // Enable autonomy for Levo and Lior specifically
    console.log(`\n🔧 Enabling autonomy for Levo and Lior...`);

    const levoResult = await personas.updateOne(
        { name: 'Levo' },
        {
          $set: {
            autonomous: true,
            checkInterval: 120,  // Every 2 hours
            lastAgentCheck: null,
            updatedAt: new Date()
          }
        }
    );

    if (levoResult.matchedCount > 0) {
      console.log(`   ✅ Levo: Autonomy enabled (check every 2h)`);
    } else {
      console.log(`   ⚠️  Levo: Not found (will need manual setup)`);
    }

    const liorResult = await personas.updateOne(
        { name: 'Lior' },
        {
          $set: {
            autonomous: true,
            checkInterval: 360,  // Every 6 hours
            lastAgentCheck: null,
            updatedAt: new Date()
          }
        }
    );

    if (liorResult.matchedCount > 0) {
      console.log(`   ✅ Lior: Autonomy enabled (check every 6h)`);
    } else {
      console.log(`   ⚠️  Lior: Not found (will need manual setup)`);
    }

    // Verify
    const allPersonas = await personas.find({}).toArray();
    console.log(`\n📋 Current personas:`);
    allPersonas.forEach(p => {
      const status = p.autonomous
          ? `✅ autonomous (every ${p.checkInterval}min)`
          : '○ not autonomous';
      console.log(`   - ${p.name}: ${status}`);
    });

    await client.close();
    console.log('\n✅ Migration finished. Database connection closed.');

  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  }
}

// Run migration
migratePersonasAutonomy();