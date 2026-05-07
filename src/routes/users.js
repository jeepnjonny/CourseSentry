'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { requireRole } = require('../auth');
const logger = require('../logger');
const router = express.Router();

router.get('/', requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, username, role, callsign, created_at FROM users').all();
  res.json({ ok: true, data: users });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { username, password, role, callsign } = req.body;
  if (!username || !password || !['admin', 'operator', 'station'].includes(role))
    return res.status(400).json({ ok: false, error: 'username, password, and role (admin|operator|station) required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, role, callsign) VALUES (?,?,?,?)').run(username, hash, role, callsign?.toUpperCase().trim() || null);
    logger.log('system', 'info', `User created — ${username} (${role}) by ${req.session.user.username}`);
    res.json({ ok: true, data: { id: result.lastInsertRowid, username, role, callsign: callsign || null } });
  } catch (e) {
    res.status(409).json({ ok: false, error: 'Username already exists' });
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  const { username, password, role, callsign } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

  const newUsername = username || user.username;
  const newRole     = role     || user.role;
  const newCallsign = callsign !== undefined ? (callsign?.toUpperCase().trim() || null) : user.callsign;
  const newHash     = password ? await bcrypt.hash(password, 10) : user.password_hash;

  db.prepare('UPDATE users SET username=?, password_hash=?, role=?, callsign=? WHERE id=?')
    .run(newUsername, newHash, newRole, newCallsign, req.params.id);
  const changes = [];
  if (newUsername !== user.username) changes.push(`username→${newUsername}`);
  if (newRole !== user.role) changes.push(`role→${newRole}`);
  if (newCallsign !== user.callsign) changes.push(`callsign→${newCallsign || 'cleared'}`);
  if (password) changes.push('password changed');
  logger.log('system', 'info', `User updated — ${newUsername}${changes.length ? ` (${changes.join(', ')})` : ''} by ${req.session.user.username}`);
  res.json({ ok: true, data: { id: user.id, username: newUsername, role: newRole, callsign: newCallsign } });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  // Prevent deleting own account
  if (parseInt(req.params.id) === req.session.user.id)
    return res.status(400).json({ ok: false, error: 'Cannot delete your own account' });
  const target = db.prepare('SELECT username, role FROM users WHERE id=?').get(req.params.id);
  const result = db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'User not found' });
  if (target) logger.log('system', 'warn', `User deleted — ${target.username} (${target.role}) by ${req.session.user.username}`);
  res.json({ ok: true });
});

module.exports = router;
