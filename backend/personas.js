import express from 'express';
import { collections } from './db.js';

const router = express.Router();

// ========================================
// GET ALL PERSONAS
// ========================================
router.get('/', async (req, res) => {
  try {
    const personas = collections.personas();
    const allPersonas = await personas.find({}).sort({ createdAt: -1 }).toArray();
    res.json(allPersonas);
  } catch (error) {
    console.error('Error fetching personas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// GET SINGLE PERSONA
// ========================================
router.get('/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const personas = collections.personas();

    const persona = await personas.findOne({ _id: new ObjectId(req.params.id) });

    if (!persona) {
      return res.status(404).json({ error: 'Persona not found' });
    }

    res.json(persona);
  } catch (error) {
    console.error('Error fetching persona:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// CREATE PERSONA
// ========================================
router.post('/', async (req, res) => {
  try {
    const personas = collections.personas();
    const { name, model, avatar, systemPrompt, knowledgeIds } = req.body;

    // Validation
    if (!name || !model) {
      return res.status(400).json({ error: 'Name and model are required' });
    }

    const persona = {
      name: name.trim(),
      model,
      avatar: avatar || '🤖',
      systemPrompt: systemPrompt || '',
      knowledgeIds: knowledgeIds || [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await personas.insertOne(persona);

    res.json({
      success: true,
      personaId: result.insertedId,
      persona: { ...persona, _id: result.insertedId }
    });
  } catch (error) {
    console.error('Error creating persona:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// UPDATE PERSONA
// ========================================
router.patch('/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const personas = collections.personas();
    const { name, model, avatar, systemPrompt, knowledgeIds } = req.body;

    const updateData = {
      updatedAt: new Date()
    };

    if (name) updateData.name = name.trim();
    if (model) updateData.model = model;
    if (avatar !== undefined) updateData.avatar = avatar;
    if (systemPrompt !== undefined) updateData.systemPrompt = systemPrompt;
    if (knowledgeIds !== undefined) updateData.knowledgeIds = knowledgeIds;

    const result = await personas.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Persona not found' });
    }

    res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    console.error('Error updating persona:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// DELETE PERSONA
// ========================================
router.delete('/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const personas = collections.personas();

    const result = await personas.deleteOne({ _id: new ObjectId(req.params.id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Persona not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting persona:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// GET PERSONA'S KNOWLEDGE
// ========================================
router.get('/:id/knowledge', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const personas = collections.personas();
    const kb = collections.knowledgeBase();

    const persona = await personas.findOne({ _id: new ObjectId(req.params.id) });

    if (!persona) {
      return res.status(404).json({ error: 'Persona not found' });
    }

    // Get all knowledge files for this persona
    const knowledgeFiles = await kb.find({
      _id: { $in: persona.knowledgeIds.map(id => new ObjectId(id)) }
    }).toArray();

    res.json(knowledgeFiles);
  } catch (error) {
    console.error('Error fetching persona knowledge:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// ADD KNOWLEDGE TO PERSONA
// ========================================
router.post('/:id/knowledge', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const personas = collections.personas();
    const { knowledgeId } = req.body;

    if (!knowledgeId) {
      return res.status(400).json({ error: 'knowledgeId required' });
    }

    const result = await personas.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $addToSet: { knowledgeIds: knowledgeId },
          $set: { updatedAt: new Date() }
        }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Persona not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error adding knowledge:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// REMOVE KNOWLEDGE FROM PERSONA
// ========================================
router.delete('/:id/knowledge/:knowledgeId', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const personas = collections.personas();

    const result = await personas.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $pull: { knowledgeIds: req.params.knowledgeId },
          $set: { updatedAt: new Date() }
        }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Persona not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing knowledge:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;