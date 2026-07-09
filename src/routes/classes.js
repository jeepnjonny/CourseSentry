'use strict';

/**
 * Routes for managing race classes.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router({ mergeParams: true });

function getClassById(classId, raceId) {
  return db.prepare('SELECT * FROM classes WHERE id = ? AND race_id = ?').get(classId, raceId);
}

router.get('/', requireAuth, (req, res) => {
  const classes = db.prepare('SELECT * FROM classes WHERE race_id = ?').all(req.params.raceId);
  res.json({ ok: true, data: classes });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, color, shape } = req.body;
  if (!name) {
    return res.status(400).json({ ok: false, error: 'class name is required' });
  }

  const result = db.prepare('INSERT INTO classes (race_id, name, color, shape) VALUES (?, ?, ?, ?)').run(
    req.params.raceId,
    name,
    color || '#58a6ff',
    shape || 'circle'
  );
  const createdClass = db.prepare('SELECT * FROM classes WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ok: true, data: createdClass });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const existingClass = getClassById(req.params.id, req.params.raceId);
  if (!existingClass) {
    return res.status(404).json({ ok: false, error: 'class not found' });
  }

  const name = req.body.name ?? existingClass.name;
  const color = req.body.color ?? existingClass.color;
  const shape = req.body.shape ?? existingClass.shape;
  db.prepare('UPDATE classes SET name = ?, color = ?, shape = ? WHERE id = ?').run(name, color, shape, existingClass.id);
  res.json({ ok: true, data: { ...existingClass, name, color, shape } });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const result = db.prepare('DELETE FROM classes WHERE id = ? AND race_id = ?').run(req.params.id, req.params.raceId);
  if (!result.changes) {
    return res.status(404).json({ ok: false, error: 'class not found' });
  }
  res.json({ ok: true });
});

module.exports = router;
