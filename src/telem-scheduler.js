'use strict';

/**
 * Periodic ?TELEM? query scheduler for APRS infrastructure nodes.
 * Sends are dithered across each race's configured interval so multiple
 * devices sharing one RF channel aren't queried in the same instant.
 * Mirrors src/beacon.js's shape: a single global tick that filters on
 * race.status='active' every pass, so no activate/deactivate hooks are needed.
 */
const db = require('./db');
const logger = require('./logger');
const aprsClient = require('./aprs-client');

const TICK_MS = 30 * 1000;
const JITTER_FRACTION = 0.05; // ±5% of interval, re-applied after each send
const NETWORK_APRS_CALL_RE = /^[A-Z0-9]{1,6}(-(?:1[0-5]|[0-9]))?$/i; // same test as admin.js's pingInfraNode

let _timer = null;
const _nextSend = new Map(); // infra_nodes.id → unix-seconds of next scheduled send

function _jitter(intervalSec) {
  return Math.round(intervalSec * JITTER_FRACTION * (Math.random() * 2 - 1));
}

function _dueNodes() {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    SELECT n.id, n.node_id, n.name, r.id AS race_id, r.tactical_callsign, r.telem_query_interval
    FROM infra_nodes n JOIN races r ON r.id = n.race_id
    WHERE r.status = 'active' AND r.telem_query_enabled = 1 AND n.node_id IS NOT NULL
  `).all()
    .filter(n => NETWORK_APRS_CALL_RE.test(n.node_id.trim()))
    .filter(n => {
      const interval = n.telem_query_interval || 3600;
      const next = _nextSend.get(n.id);
      if (next == null || now - next > interval) {
        // First time seen, or so overdue (feature just enabled, race just
        // reactivated, server was down) that firing immediately would recreate
        // the very collision dithering exists to prevent — re-roll a fresh
        // random offset instead of firing right away.
        _nextSend.set(n.id, now + Math.floor(Math.random() * interval));
        return false;
      }
      return now >= next;
    });
}

function _sendTelemQuery(node) {
  const ts = Math.floor(Date.now() / 1000);
  const from = (node.tactical_callsign || 'NETCTL').trim();
  const result = db.prepare(`
    INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, to_name, text, timestamp, status)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(node.race_id, 'out', from, from, node.node_id.trim(), node.name, '?TELEM?', ts, 'queued');
  const messageId = result.lastInsertRowid;
  aprsClient.sendMessage(node.node_id.trim(), '?TELEM?', messageId);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
  require('./websocket').broadcast({ type: 'message', data: msg });
  logger.log('aprs', 'info', `Auto TELEM query → ${node.node_id.trim()} (${node.name})`);
}

function tick() {
  const connected = aprsClient.isConnected();
  for (const node of _dueNodes()) {
    const interval = node.telem_query_interval || 3600;
    _nextSend.set(node.id, Math.floor(Date.now() / 1000) + interval + _jitter(interval));
    if (connected) _sendTelemQuery(node); // still advance the schedule when disconnected, to avoid a burst on reconnect
  }
}

function start() {
  if (_timer) return;
  _timer = setInterval(tick, TICK_MS);
  logger.log('system', 'info', 'TELEM query scheduler started (30s tick)');
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop };
