'use strict';

/**
 * Express router for managing heats in a race.
 * Provides endpoints for retrieving, creating, updating, and deleting heats.
 */

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');

const router = express.Router({ mergeParams: true });

/**
 * GET / - Retrieve all heats for a specific race.
 * Requires authentication.
 */
router.get('/', requireAuth, (req, res) => {
  const heats = db.prepare('SELECT * FROM heats WHERE race_id = ?').all(req.params.raceId);
  res.json({ ok: true, data: heats });
});

/**
 * POST / - Create a new heat for a specific race.
 * Requires admin or operator role.
 * Body: { name, color?, shape?, start_time? }
 */
router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, color, shape, start_time } = req.body;

  // Validate required fields
  if (!name) {
    return res.status(400).json({ ok: false, error: 'Heat name is required' });
  }

  // Insert new heat with defaults for optional fields
  const insertResult = db.prepare(`
    INSERT INTO heats (race_id, name, color, shape, start_time)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    req.params.raceId,
    name,
    color || '#58a6ff',
    shape || 'circle',
    start_time || null
  );

  // Retrieve and return the newly created heat
  const newHeat = db.prepare('SELECT * FROM heats WHERE id = ?').get(insertResult.lastInsertRowid);
  res.json({ ok: true, data: newHeat });
});

/**
 * PUT /:id - Update an existing heat.
 * Requires admin or operator role.
 * Body: { name?, color?, shape?, start_time? }
 */
router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name, color, shape, start_time } = req.body;

  // Fetch the existing heat to ensure it exists and belongs to the race
  const existingHeat = db.prepare('SELECT * FROM heats WHERE id = ? AND race_id = ?').get(
    req.params.id,
    req.params.raceId
  );

  if (!existingHeat) {
    return res.status(404).json({ ok: false, error: 'Heat not found' });
  }

  // Determine the new start_time, preserving existing if not provided
  const newStartTime = start_time !== undefined ? (start_time || null) : existingHeat.start_time;

  // Update the heat with provided values or defaults to existing
  db.prepare(`
    UPDATE heats
    SET name = ?, color = ?, shape = ?, start_time = ?
    WHERE id = ?
  `).run(
    name ?? existingHeat.name,
    color ?? existingHeat.color,
    shape ?? existingHeat.shape,
    newStartTime,
    req.params.id
  );

  // If start_time changed, propagate to tracker-less participants without start_time
  if (newStartTime && newStartTime !== existingHeat.start_time) {
    db.prepare(`
      UPDATE participants
      SET start_time = ?
      WHERE heat_id = ? AND race_id = ? AND (tracker_id IS NULL OR tracker_id = '') AND (start_time IS NULL OR start_time = 0)
    `).run(newStartTime, req.params.id, req.params.raceId);

    // Notify clients of bulk participant updates
    wsManager.broadcast({ type: 'participant_update', data: { action: 'bulk_update' } });
  }

  // Return the updated heat
  const updatedHeat = db.prepare('SELECT * FROM heats WHERE id = ?').get(req.params.id);
  res.json({ ok: true, data: updatedHeat });
});

/**
 * DELETE /:id - Delete a heat.
 * Requires admin role.
 */
router.delete('/:id', requireRole('admin'), (req, res) => {
  const deleteResult = db.prepare('DELETE FROM heats WHERE id = ? AND race_id = ?').run(
    req.params.id,
    req.params.raceId
  );

  if (!deleteResult.changes) {
    return res.status(404).json({ ok: false, error: 'Heat not found' });
  }

  res.json({ ok: true });
});

module.exports = router;
