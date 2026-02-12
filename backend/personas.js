import express from 'express';
import {collections} from './db.js';

const router = express.Router();

// ========================================
// GET ALL PERSONAS
// ========================================
router.get('/', async (req, res) => {
  try {
    const personas = collections.personas();
    const allPersonas = await personas.find({}).sort({createdAt: -1}).toArray();
    res.json(allPersonas);
  } catch (error) {
    console.error('Error fetching personas:', error);
    res.status(500).json({error: error.message});
  }
});

// ========================================
// GET SINGLE PERSONA
// ========================================
router.get('/:id', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();

    const persona = await personas.findOne({_id: new ObjectId(req.params.id)});

    if (!persona) {
      return res.status(404).json({error: 'Persona not found'});
    }

    res.json(persona);
  } catch (error) {
    console.error('Error fetching persona:', error);
    res.status(500).json({error: error.message});
  }
});


// ========================================
// UPDATE PERSONA
// ========================================
router.patch('/:id', async (req, res) => {
  console.log('🔍 Backend received PATCH /api/personas/:id');
  console.log('   Body:', req.body);
  console.log('   checkInterval:', req.body.checkInterval);
  console.log('   autonomous:', req.body.autonomous);
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();
    const {
      name, model, avatar, systemPrompt, knowledgeIds, autonomous, checkInterval, lastAgentCheck, wakeUpPrompt
    } = req.body;

    const updateData = {
      updatedAt: new Date()
    };

    if (name) updateData.name = name.trim();
    if (model) updateData.model = model;
    if (avatar !== undefined) updateData.avatar = avatar;
    if (systemPrompt !== undefined) updateData.systemPrompt = systemPrompt;
    if (knowledgeIds !== undefined) updateData.knowledgeIds = knowledgeIds;
    if (autonomous !== undefined) updateData.autonomous = autonomous;
    if (checkInterval !== undefined) updateData.checkInterval = checkInterval;
    if (lastAgentCheck !== undefined) updateData.lastAgentCheck = lastAgentCheck;
    if (wakeUpPrompt !== undefined) updateData.wakeUpPrompt = wakeUpPrompt;

    const result = await personas.updateOne(
        {_id: new ObjectId(req.params.id)},
        {$set: updateData}
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({error: 'Persona not found'});
    }

    res.json({success: true, modified: result.modifiedCount});
  } catch (error) {
    console.error('Error updating persona:', error);
    res.status(500).json({error: error.message});
  }
});

// ========================================
// DELETE PERSONA
// ========================================
router.delete('/:id', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();

    const result = await personas.deleteOne({_id: new ObjectId(req.params.id)});

    if (result.deletedCount === 0) {
      return res.status(404).json({error: 'Persona not found'});
    }

    res.json({success: true});
  } catch (error) {
    console.error('Error deleting persona:', error);
    res.status(500).json({error: error.message});
  }
});

// ========================================
// MEMORY ENDPOINTS
// ========================================

// GET PERSONA'S MEMORY (all types)
router.get('/:id/memory', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();

    const persona = await personas.findOne({_id: new ObjectId(req.params.id)});

    if (!persona) {
      return res.status(404).json({error: 'Persona not found'});
    }

    // Return all memory types
    res.json({
      facts: persona.memory?.facts || [],
      summaries: persona.memory?.summaries || [],
      manualFacts: persona.memory?.manualFacts || [],
      autoFacts: persona.memory?.autoFacts || [],
      currentSummary: persona.memory?.currentSummary || null
    });
  } catch (error) {
    console.error('Error fetching memory:', error);
    res.status(500).json({error: error.message});
  }
});

// ADD FACT
router.post('/:id/memory/facts', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();
    const {fact} = req.body;

    if (!fact) {
      return res.status(400).json({error: 'Fact is required'});
    }

    const factEntry = {
      fact: fact.trim(),
      timestamp: new Date(),
      conversationId: null,
      source: 'manual'
    };

    const result = await personas.updateOne(
        {_id: new ObjectId(req.params.id)},
        {
          $push: {'memory.facts': factEntry},
          $set: {updatedAt: new Date()}
        }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({error: 'Persona not found'});
    }

    res.json({success: true, fact: factEntry});
  } catch (error) {
    console.error('Error adding fact:', error);
    res.status(500).json({error: error.message});
  }
});

// DELETE FACT
router.delete('/:id/memory/facts/:index', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();
    const index = parseInt(req.params.index);

    const persona = await personas.findOne({_id: new ObjectId(req.params.id)});

    if (!persona) {
      return res.status(404).json({error: 'Persona not found'});
    }

    if (persona.memory?.facts && persona.memory.facts[index] !== undefined) {
      persona.memory.facts.splice(index, 1);

      await personas.updateOne(
          {_id: new ObjectId(req.params.id)},
          {
            $set: {
              'memory.facts': persona.memory.facts,
              updatedAt: new Date()
            }
          }
      );
    }

    res.json({success: true});
  } catch (error) {
    console.error('Error removing fact:', error);
    res.status(500).json({error: error.message});
  }
});

// DELETE SUMMARY
router.delete('/:id/memory/summaries/:index', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();
    const index = parseInt(req.params.index);

    const persona = await personas.findOne({_id: new ObjectId(req.params.id)});

    if (!persona) {
      return res.status(404).json({error: 'Persona not found'});
    }

    if (persona.memory?.summaries && persona.memory.summaries[index] !== undefined) {
      persona.memory.summaries.splice(index, 1);

      await personas.updateOne(
          {_id: new ObjectId(req.params.id)},
          {
            $set: {
              'memory.summaries': persona.memory.summaries,
              updatedAt: new Date()
            }
          }
      );
    }

    res.json({success: true});
  } catch (error) {
    console.error('Error removing summary:', error);
    res.status(500).json({error: error.message});
  }
});

// ADD MANUAL MEMORY FACT (legacy)
router.post('/:id/memory/manual', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();
    const {fact} = req.body;

    if (!fact) {
      return res.status(400).json({error: 'Fact is required'});
    }

    const result = await personas.updateOne(
        {_id: new ObjectId(req.params.id)},
        {
          $push: {'memory.manualFacts': fact.trim()},
          $set: {updatedAt: new Date()}
        }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({error: 'Persona not found'});
    }

    res.json({success: true});
  } catch (error) {
    console.error('Error adding manual memory:', error);
    res.status(500).json({error: error.message});
  }
});

// ADD AUTO MEMORY FACT (called by AI)
router.post('/:id/memory/auto', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();
    const {fact, conversationId} = req.body;

    if (!fact) {
      return res.status(400).json({error: 'Fact is required'});
    }

    const autoFact = {
      fact: fact.trim(),
      timestamp: new Date(),
      conversationId: conversationId || null
    };

    const result = await personas.updateOne(
        {_id: new ObjectId(req.params.id)},
        {
          $push: {'memory.autoFacts': autoFact},
          $set: {updatedAt: new Date()}
        }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({error: 'Persona not found'});
    }

    res.json({success: true, fact: autoFact});
  } catch (error) {
    console.error('Error adding auto memory:', error);
    res.status(500).json({error: error.message});
  }
});

// REMOVE MANUAL MEMORY FACT
router.delete('/:id/memory/manual/:index', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();
    const index = parseInt(req.params.index);

    // First get the persona to access the array
    const persona = await personas.findOne({_id: new ObjectId(req.params.id)});

    if (!persona) {
      return res.status(404).json({error: 'Persona not found'});
    }

    // Remove the fact at index
    if (persona.memory && persona.memory.manualFacts && persona.memory.manualFacts[index] !== undefined) {
      persona.memory.manualFacts.splice(index, 1);

      await personas.updateOne(
          {_id: new ObjectId(req.params.id)},
          {
            $set: {
              'memory.manualFacts': persona.memory.manualFacts,
              updatedAt: new Date()
            }
          }
      );
    }

    res.json({success: true});
  } catch (error) {
    console.error('Error removing manual memory:', error);
    res.status(500).json({error: error.message});
  }
});

// REMOVE AUTO MEMORY FACT
router.delete('/:id/memory/auto/:index', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();
    const index = parseInt(req.params.index);

    const persona = await personas.findOne({_id: new ObjectId(req.params.id)});

    if (!persona) {
      return res.status(404).json({error: 'Persona not found'});
    }

    if (persona.memory && persona.memory.autoFacts && persona.memory.autoFacts[index] !== undefined) {
      persona.memory.autoFacts.splice(index, 1);

      await personas.updateOne(
          {_id: new ObjectId(req.params.id)},
          {
            $set: {
              'memory.autoFacts': persona.memory.autoFacts,
              updatedAt: new Date()
            }
          }
      );
    }

    res.json({success: true});
  } catch (error) {
    console.error('Error removing auto memory:', error);
    res.status(500).json({error: error.message});
  }
});

// ========================================
// KNOWLEDGE ENDPOINTS (unchanged)
// ========================================

router.get('/:id/knowledge', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();
    const kb = collections.knowledgeBase();

    const persona = await personas.findOne({_id: new ObjectId(req.params.id)});

    if (!persona) {
      return res.status(404).json({error: 'Persona not found'});
    }

    const knowledgeFiles = await kb.find({
      _id: {$in: persona.knowledgeIds.map(id => new ObjectId(id))}
    }).toArray();

    res.json(knowledgeFiles);
  } catch (error) {
    console.error('Error fetching persona knowledge:', error);
    res.status(500).json({error: error.message});
  }
});

router.post('/:id/knowledge', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();
    const {knowledgeId} = req.body;

    if (!knowledgeId) {
      return res.status(400).json({error: 'knowledgeId required'});
    }

    const result = await personas.updateOne(
        {_id: new ObjectId(req.params.id)},
        {
          $addToSet: {knowledgeIds: knowledgeId},
          $set: {updatedAt: new Date()}
        }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({error: 'Persona not found'});
    }

    res.json({success: true});
  } catch (error) {
    console.error('Error adding knowledge:', error);
    res.status(500).json({error: error.message});
  }
});

router.delete('/:id/knowledge/:knowledgeId', async (req, res) => {
  try {
    const {ObjectId} = await import('mongodb');
    const personas = collections.personas();

    const result = await personas.updateOne(
        {_id: new ObjectId(req.params.id)},
        {
          $pull: {knowledgeIds: req.params.knowledgeId},
          $set: {updatedAt: new Date()}
        }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({error: 'Persona not found'});
    }

    res.json({success: true});
  } catch (error) {
    console.error('Error removing knowledge:', error);
    res.status(500).json({error: error.message});
  }
});

export default router;