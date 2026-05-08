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
const routeTable = require('../route-table');

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
 * Sends a message via APRS
 * @param {string} toCallsign - APRS callsign to send to
 * @param {string} text - Message text
 * @param {number} messageId - Message ID for tracking
 * @returns {boolean} True if sent successfully
 */
function sendAprsMessage(toCallsign, text, messageId) {
  return aprsClient.sendMessage(toCallsign.trim(), text, messageId) !== false;
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

  // ── Route table lookup ────────────────────────────────────────────────────
  // Determines which path to use based on how we last heard this node.
  // Falls back to heuristic (APRS callsign regex / Meshtastic hex) if unknown.
  const route = !isWeb ? routeTable.resolve(to_node_id.trim()) : null;

  let fromNodeId       = null;
  let resolvedToNodeId = to_node_id;
  let initialStatus    = 'queued';
  let sent             = false;
  let dispatchPath     = 'none';

  if (isWeb) {
    // ── Web (browser-to-browser via WebSocket) ────────────────────────────
    fromNodeId    = `web:${username}`;
    initialStatus = 'delivered';
    sent          = true;
    dispatchPath  = 'web';

  } else if (route?.source === 'tnc_local') {
    // ── Local TNC (RF via operator's serial KISS TNC) ─────────────────────
    fromNodeId   = race.tactical_callsign;
    dispatchPath = 'tnc_local';
    const result = db.prepare(`
      INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, to_name, text, timestamp, status)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(race.id, 'out', fromNodeId, username, to_node_id, to_name || null, text, ts, 'queued');
    const messageId = result.lastInsertRowid;
    sent = localTnc.sendMessage(race.id, { toCallsign: to_node_id, text, messageId });
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    wsManager.broadcast({ type: 'message', data: msg });
    return res.json({ ok: true, data: { ...msg, sent, path: dispatchPath } });

  } else if (route?.source === 'mqtt') {
    // ── Meshtastic via MQTT ───────────────────────────────────────────────
    resolvedToNodeId = resolveMeshtasticNodeId(to_node_id);
    if (!resolvedToNodeId) return res.status(400).json({ ok: false, error: 'Invalid Meshtastic node ID' });
    dispatchPath = 'mqtt';

  } else {
    // ── No route or stale — heuristic fallback ────────────────────────────
    const isAprs = APRS_CALL_RE.test(to_node_id.trim());
    if (isAprs) {
      // Try APRS-IS if connected, otherwise no path
      if (!aprsClient.isConnected()) {
        return res.status(503).json({ ok: false, error: 'No path to recipient: APRS-IS not connected and no local TNC has heard this station' });
      }
      const aprsRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'aprs_%'").all();
      const s = Object.fromEntries(aprsRows.map(r => [r.key, r.value]));
      fromNodeId   = s.aprs_callsign || null;
      dispatchPath = 'aprs_is';
    } else {
      // Try Meshtastic
      resolvedToNodeId = resolveMeshtasticNodeId(to_node_id);
      if (!resolvedToNodeId) return res.status(400).json({ ok: false, error: 'Invalid node ID or unknown tracker name' });
      dispatchPath = 'mqtt';
    }
  }

  // ── Insert message row and dispatch ───────────────────────────────────────
  const result = db.prepare(`
    INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, to_name, text, timestamp, status)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(race.id, 'out', fromNodeId, username, resolvedToNodeId, to_name || null, text, ts, initialStatus);
  const messageId = result.lastInsertRowid;

  if (dispatchPath === 'aprs_is') {
    sent = sendAprsMessage(to_node_id, text, messageId);
  } else if (dispatchPath === 'mqtt') {
    sent = await sendMeshtasticMessage(resolvedToNodeId, text, messageId);
  } else if (dispatchPath === 'web') {
    sent = true; // delivered via WS broadcast below
  }

  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
  wsManager.broadcast({ type: 'message', data: msg });
  res.json({ ok: true, data: { ...msg, sent, path: dispatchPath } });
});

router.put('/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE messages SET read=1 WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  res.json({ ok: true });
});

module.exports = router;
