'use strict';

const db = require('./db');

function _validateSessionToken(req, res) {
  const user = req.session?.user;
  if (!user) {
    res.status(401).json({ ok: false, error: 'Not authenticated' });
    return false;
  }
  const row = db.prepare('SELECT active_session_token FROM users WHERE id = ?').get(user.id);
  if (!row || row.active_session_token !== user.sessionToken) {
    req.session.destroy(() => {});
    res.status(401).json({ ok: false, error: 'Not authenticated' });
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  if (_validateSessionToken(req, res)) next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!_validateSessionToken(req, res)) return;
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
