'use strict';

/**
 * Authentication routes.
 * Handles login, logout, and session user lookup.
 */
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const logger = require('../logger');
const aprsClient = require('../aprs-client');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    logger.log('system', 'warn', `Login failed — unknown user "${username}"`);
    return res.status(401).json({ ok: false, error: 'invalid credentials' });
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    logger.log('system', 'warn', `Login failed — invalid password for "${username}"`);
    return res.status(401).json({ ok: false, error: 'invalid credentials' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    callsign: user.callsign || null,
  };

  logger.log('system', 'info', `Login — ${user.username} (${user.role})${user.callsign ? ` callsign=${user.callsign}` : ''}`);
  aprsClient.setMessagingCallsign(user.callsign || null);
  aprsClient.connectFromSettings(db);

  res.json({ ok: true, data: { id: user.id, username: user.username, role: user.role, callsign: user.callsign || null } });
});

router.post('/logout', (req, res) => {
  const username = req.session?.user?.username;
  req.session.destroy(() => {
    if (username) logger.log('system', 'info', `Logout — ${username}`);
    aprsClient.setMessagingCallsign(null);
    aprsClient.connectFromSettings(db);
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ ok: false, error: 'not authenticated' });
  }
  res.json({ ok: true, data: req.session.user });
});

module.exports = router;
