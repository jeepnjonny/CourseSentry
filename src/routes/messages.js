'use strict';

/**
 * Message Management Routes
 *
 * This module handles message-related operations for races, supporting both Meshtastic and APRS messaging.
 * It provides endpoints for retrieving messages, sending new messages to trackers or APRS callsigns,
 * and marking messages as read.
 *
 * Key Features:
 * - Message retrieval with filtering by node ID
 * - Sending messages via Meshtastic (to registered trackers) or APRS
 * - Node ID resolution from tracker registry (supports names and hex IDs)
 * - Real-time message broadcasting via WebSocket
 * - Message status tracking (queued, sent)
 */

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const wsManager  = require('../websocket');
const mqttClient = require('../mqtt-client');
const aprsClient = require('../aprs-client');
const localTnc   = require('../local-tnc');

const router = express.Router({ mergeParams: true });

// Regular expression for validating APRS callsigns
const APRS_CALL_RE = /^[A-Z0-9]{1,6}(-(?:1[0-5]|[0-9]))?$/i;

/**
 * Resolves a Meshtastic node ID from various input formats
 * Supports hex IDs (with or without ! prefix), long names, and short names from tracker registry
 * @param {string} rawId - Raw node ID input
 * @returns {string|null} Resolved node ID with ! prefix, or null if not found
 */
function resolveMeshtasticNodeId(rawId) {
  if (!rawId) return null;

  const value = String(rawId).trim();
  if (!value) return null;

  // Ensure hex IDs start with !
  const candidate = value.startsWith('!') ? value.toLowerCase() : `!${value.toLowerCase()}`;

  // Check if it's already a valid hex ID
  if (/^![0-9a-f]{8}$/.test(candidate)) return candidate;

  // Look up in tracker registry by node_id, long_name, or short_name
  const row = db.prepare(`
    SELECT node_id FROM tracker_registry
    WHERE node_id = ?
       OR upper(long_name) = upper(?)
       OR upper(short_name) = upper(?)
  `).get(candidate, value, value);

  if (row?.node_id) return row.node_id.startsWith('!') ? row.node_id : `!${row.node_id}`;
  return null;
}

/**
 * Builds a SQL query for retrieving messages with optional node filtering
 * @param {string} raceId - Race ID
 * @param {string} [nodeId] - Optional node ID to filter by
 * @param {number} [limit] - Optional limit for results
 * @returns {Object} Object containing SQL query and parameters
 */
function buildMessageQuery(raceId, nodeId, limit) {
  let sql = 'SELECT * FROM messages WHERE race_id=?';
  const args = [raceId];

  if (nodeId) {
    // Resolve longname/shortname → hex node_id so messages stored as '!f6f90b74'
    // match participants whose tracker_id is set to a name like 'RaceFeeder01'
    const reg = db.prepare(
      `SELECT node_id FROM tracker_registry
       WHERE node_id=? OR upper(long_name)=upper(?) OR upper(short_name)=upper(?)`
    ).get(nodeId, nodeId, nodeId);
    const hexId = reg?.node_id;
    const ids = hexId && hexId !== nodeId ? [nodeId, hexId] : [nodeId];
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

  return { sql, args };
}

/**
 * Sends a message via Meshtastic MQTT
 * @param {string} toNodeId - Meshtastic node ID
 * @param {string} text - Message text
 * @param {number} messageId - Message ID for tracking
 * @returns {Promise<boolean>} True if sent successfully
 */
async function sendMeshtasticMessage(toNodeId, text, messageId) {
  const sent = await mqttClient.publishMessage(toNodeId, text, messageId);
  if (sent) db.prepare("UPDATE messages SET status='sent' WHERE id=?").run(messageId);
  return sent;
}

/**
 * GET / - Retrieves messages for a race
 * Supports filtering by node ID and limiting results
 * @param {string} req.params.raceId - Race ID from URL
 * @param {string} [req.query.node_id] - Optional node ID filter
 * @param {number} [req.query.limit] - Optional result limit
 * @returns {Object} JSON response with messages array
 */
router.get('/', requireAuth, (req, res) => {
  const { node_id, limit } = req.query;
  const { sql, args } = buildMessageQuery(req.params.raceId, node_id, limit);
  res.json({ ok: true, data: db.prepare(sql).all(...args) });
});

/**
 * POST / - Sends a new message
 * Supports both APRS callsigns and Meshtastic node IDs
 * @param {string} req.params.raceId - Race ID from URL
 * @param {string} req.body.to_node_id - Recipient node ID or APRS callsign (required)
 * @param {string} [req.body.to_name] - Optional recipient name
 * @param {string} req.body.text - Message text (required, max 67 chars)
 * @returns {Object} JSON response with message data and send status
 */
router.post('/', requireRole('admin', 'operator', 'station'), async (req, res) => {
  const { to_node_id, to_name, text } = req.body;
  if (!to_node_id || !text) return res.status(400).json({ ok: false, error: 'to_node_id and text required' });
  if (text.length > 67) return res.status(400).json({ ok: false, error: 'Message too long (max 67 chars)' });

  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const ts       = Math.floor(Date.now() / 1000);
  const username = req.session?.user?.username || 'operator';
  const isWeb    = to_node_id.startsWith('web:');

  if (isWeb) {
    // ── Web (browser-to-browser via WebSocket) ────────────────────────────
    const result = db.prepare(`
      INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, to_name, text, timestamp, status)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(race.id, 'out', `web:${username}`, username, to_node_id, to_name || null, text, ts, 'delivered');
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
    wsManager.broadcast({ type: 'message', data: msg });
    return res.json({ ok: true, data: { ...msg, sent: true, path: 'web' } });
  }

  if (APRS_CALL_RE.test(to_node_id.trim())) {
    // ── APRS: flood to APRS-IS and every connected TNC simultaneously ─────
    const aprsConnected = aprsClient.isConnected();
    const tncRaceIds    = localTnc.getConnectedRaceIds();

    if (!aprsConnected && tncRaceIds.length === 0) {
      return res.status(503).json({ ok: false, error: 'No APRS path available: APRS-IS not connected and no local TNCs active' });
    }

    const result = db.prepare(`
      INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, to_name, text, timestamp, status)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(race.id, 'out', race.tactical_callsign, username, to_node_id.trim(), to_name || null, text, ts, 'queued');
    const messageId = result.lastInsertRowid;

    const paths = [];
    if (aprsConnected) {
      aprsClient.sendMessage(to_node_id.trim(), text, messageId);
      paths.push('aprs_is');
    }
    for (const rId of tncRaceIds) {
      localTnc.sendMessage(rId, { toCallsign: to_node_id, text, messageId });
      paths.push(`tnc_${rId}`);
    }

    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    wsManager.broadcast({ type: 'message', data: msg });
    return res.json({ ok: true, data: { ...msg, sent: true, path: paths.join('+') } });
  }

  // ── Meshtastic via MQTT ───────────────────────────────────────────────────
  const resolvedToNodeId = resolveMeshtasticNodeId(to_node_id);
  if (!resolvedToNodeId) return res.status(400).json({ ok: false, error: 'Invalid node ID or unknown tracker name' });

  const result = db.prepare(`
    INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, to_name, text, timestamp, status)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(race.id, 'out', null, username, resolvedToNodeId, to_name || null, text, ts, 'queued');
  const messageId = result.lastInsertRowid;
  const sent = await sendMeshtasticMessage(resolvedToNodeId, text, messageId);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
  wsManager.broadcast({ type: 'message', data: msg });
  res.json({ ok: true, data: { ...msg, sent, path: 'mqtt' } });
});

router.put('/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE messages SET read=1 WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  res.json({ ok: true });
});

module.exports = router;
