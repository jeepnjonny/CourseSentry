'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');
const mqttClient = require('../mqtt-client');
const aprsClient = require('../aprs-client');
const router = express.Router({ mergeParams: true });

const APRS_CALL_RE = /^[A-Z0-9]{1,6}(-(?:1[0-5]|[0-9]))?$/i;

function resolveMeshtasticNodeId(rawId) {
  if (!rawId) return null;
  const value = String(rawId).trim();
  if (!value) return null;
  const candidate = value.startsWith('!') ? value.toLowerCase() : `!${value.toLowerCase()}`;

  if (/^![0-9a-f]{8}$/.test(candidate)) return candidate;

  const row = db.prepare(
    `SELECT node_id FROM tracker_registry
     WHERE node_id = ?
       OR upper(long_name) = upper(?)
       OR upper(short_name) = upper(?)`
  ).get(candidate, value, value);

  if (row?.node_id) return row.node_id.startsWith('!') ? row.node_id : `!${row.node_id}`;
  return null;
}

router.get('/', requireAuth, (req, res) => {
  const { node_id, limit } = req.query;
  let sql = 'SELECT * FROM messages WHERE race_id=?';
  const args = [req.params.raceId];
  if (node_id) {
    // Resolve longname/shortname → hex node_id so messages stored as '!f6f90b74'
    // match participants whose tracker_id is set to a name like 'RaceFeeder01'
    const reg = db.prepare(
      `SELECT node_id FROM tracker_registry
       WHERE node_id=? OR upper(long_name)=upper(?) OR upper(short_name)=upper(?)`
    ).get(node_id, node_id, node_id);
    const hexId = reg?.node_id;
    const ids = hexId && hexId !== node_id ? [node_id, hexId] : [node_id];
    if (ids.length === 1) {
      sql += ' AND (from_node_id=? OR to_node_id=?)';
      args.push(ids[0], ids[0]);
    } else {
      sql += ' AND (from_node_id IN (?,?) OR to_node_id IN (?,?))';
      args.push(ids[0], ids[1], ids[0], ids[1]);
    }
  }
  sql += ' ORDER BY timestamp DESC';
  if (limit) { sql += ' LIMIT ?'; args.push(parseInt(limit)); }
  res.json({ ok: true, data: db.prepare(sql).all(...args) });
});

router.post('/', requireRole('admin', 'operator'), async (req, res) => {
  const { to_node_id, to_name, text } = req.body;
  if (!to_node_id || !text) return res.status(400).json({ ok: false, error: 'to_node_id and text required' });
  if (text.length > 67) return res.status(400).json({ ok: false, error: 'Message too long (max 67 chars)' });

  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const ts = Math.floor(Date.now() / 1000);
  const username = req.session?.user?.username || 'operator';

  let fromNodeId = null;
  const isAprs = APRS_CALL_RE.test(to_node_id.trim());
  let resolvedToNodeId = to_node_id;

  if (isAprs) {
    const aprsRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'aprs_%'").all();
    const s = Object.fromEntries(aprsRows.map(r => [r.key, r.value]));
    fromNodeId = s.aprs_callsign || null;
  } else {
    resolvedToNodeId = resolveMeshtasticNodeId(to_node_id);
    if (!resolvedToNodeId) {
      return res.status(400).json({ ok: false, error: 'Invalid Meshtastic node ID or unknown tracker name' });
    }
  }

  // Insert first (status=queued) so we have an ID for ACK tracking
  const result = db.prepare(`
    INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, to_name, text, timestamp, status)
    VALUES (?,?,?,?,?,?,?,?,'queued')
  `).run(req.params.raceId, 'out', fromNodeId, username, resolvedToNodeId, to_name || null, text, ts);
  const messageId = result.lastInsertRowid;

  let sent = false;
  if (isAprs) {
    sent = aprsClient.sendMessage(to_node_id.trim(), text, messageId) !== false;
  } else {
    sent = await mqttClient.publishMessage(resolvedToNodeId, text, messageId);
    if (sent) db.prepare("UPDATE messages SET status='sent' WHERE id=?").run(messageId);
  }

  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
  wsManager.broadcast({ type: 'message', data: msg });
  res.json({ ok: true, data: { ...msg, sent } });
});

router.put('/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE messages SET read=1 WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  res.json({ ok: true });
});

module.exports = router;
