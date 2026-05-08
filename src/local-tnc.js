'use strict';

/**
 * Server-side local TNC management.
 *
 * Manages browser WebSocket clients that have a KISS TNC connected via WebSerial.
 * Handles:
 *   - TNC client registration / TX-primary election
 *   - Incoming AX.25/APRS frame processing (via aprs-client parser)
 *   - Outbound APRS message sending to the TX-primary browser
 *   - ACK tracking (90-second timeout, matching seq numbers)
 *   - Deduplication (10-second window — multiple TNCs may hear the same packet)
 *   - Inbound messages addressed to the race tactical callsign
 */

const db         = require('./db');
const routeTable = require('./route-table');
const logger     = require('./logger');

// ── Module state ──────────────────────────────────────────────────────────────
// wsId → { ws, raceId, rxCount, txCount, connectedAt }
const _clients = new Map();
// raceId → ws   (TX-primary per race)
const _txPrimary = new Map();

let _wsRef = null;
let _aprsRef = null; // lazy-loaded to avoid circular dependency

function setWs(ws) { _wsRef = ws; }
function _aprs() {
  if (!_aprsRef) _aprsRef = require('./aprs-client');
  return _aprsRef;
}

// ── Pending outbound ACK tracking ─────────────────────────────────────────────
// key: "CALLSIGN:seq" → { messageId, timer }
const _pendingAcks = new Map();
let _msgSeq = 0;

function _updateMsgStatus(messageId, status) {
  try {
    db.prepare('UPDATE messages SET status=? WHERE id=?').run(status, messageId);
    if (_wsRef) _wsRef.broadcast({ type: 'message_status', data: { id: messageId, status } });
  } catch (e) {
    logger.log('tnc', 'error', `updateMsgStatus: ${e.message}`);
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────
const _dedupCache = new Map();
const DEDUP_WINDOW_MS = 10_000;

function _isDuplicate(from, text) {
  const key = `${from.toUpperCase()}|${text}`;
  const now = Date.now();
  if (_dedupCache.has(key) && now - _dedupCache.get(key) < DEDUP_WINDOW_MS) return true;
  _dedupCache.set(key, now);
  // Prune old entries to prevent unbounded growth
  if (_dedupCache.size > 500) {
    for (const [k, ts] of _dedupCache) {
      if (now - ts > DEDUP_WINDOW_MS * 3) _dedupCache.delete(k);
    }
  }
  return false;
}

// ── TNC status helpers ────────────────────────────────────────────────────────
function getStatus(raceId) {
  const primWs = _txPrimary.get(raceId);
  const active = [..._clients.values()].filter(c => c.raceId === raceId && c.ws.readyState === 1);
  return {
    count:     active.length,
    hasPrimary: !!(primWs && primWs.readyState === 1),
    primaryId:  primWs?.id ?? null,
    clients:    active.map(c => ({
      wsId:      c.ws.id,
      isPrimary: c.ws === primWs,
      rxCount:   c.rxCount,
      txCount:   c.txCount,
    })),
  };
}

function _broadcastStatus(raceId) {
  if (_wsRef) _wsRef.broadcastToRace(raceId, { type: 'tnc_status', data: getStatus(raceId) });
}

// ── Client registration ───────────────────────────────────────────────────────
function register(ws, raceId) {
  _clients.set(ws.id, { ws, raceId, rxCount: 0, txCount: 0, connectedAt: Date.now() });
  ws.tncActive  = true;
  ws.tncRaceId  = raceId;

  if (!_txPrimary.has(raceId)) {
    _txPrimary.set(raceId, ws);
    logger.log('tnc', 'info', `TX primary: ws=${ws.id} race=${raceId}`);
  }
  logger.log('tnc', 'info', `TNC registered: ws=${ws.id} race=${raceId}`);
  _broadcastStatus(raceId);
}

function unregister(wsId) {
  const client = _clients.get(wsId);
  if (!client) return;
  const { raceId } = client;
  _clients.delete(wsId);
  routeTable.invalidateWs(wsId);

  // Re-elect TX primary if this client was primary
  if (_txPrimary.get(raceId)?.id === wsId) {
    _txPrimary.delete(raceId);
    for (const [, c] of _clients) {
      if (c.raceId === raceId && c.ws.readyState === 1) {
        _txPrimary.set(raceId, c.ws);
        logger.log('tnc', 'info', `TX primary promoted: ws=${c.ws.id} race=${raceId}`);
        break;
      }
    }
  }
  logger.log('tnc', 'info', `TNC unregistered: ws=${wsId} race=${raceId}`);
  _broadcastStatus(raceId);
}

function getPrimary(raceId) {
  const ws = _txPrimary.get(raceId);
  if (ws && ws.readyState === 1) return ws;
  if (ws) { _txPrimary.delete(raceId); _broadcastStatus(raceId); }
  return null;
}

// ── Inbound message to our tactical callsign ──────────────────────────────────
function _handleInboundMessage(raceId, fromCall, text) {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
  if (!race?.messaging_enabled) return;
  const person = db.prepare(
    "SELECT * FROM personnel WHERE race_id=? AND UPPER(tracker_id)=? LIMIT 1"
  ).get(raceId, fromCall.toUpperCase());
  const ts = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, text, timestamp, status)
    VALUES (?,?,?,?,?,?,?,'delivered')
  `).run(raceId, 'in', fromCall, person?.name || fromCall, race.tactical_callsign, text, ts);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
  logger.log('tnc', 'info', `MSG in from ${fromCall}${person ? ' (' + person.name + ')' : ''}: ${text}`);
  if (_wsRef) _wsRef.broadcastToRace(raceId, { type: 'message', data: msg });
}

// Send an ACK back over RF to the same TNC the message arrived on
function _sendAckViaTnc(ws, raceId, toCallsign, seq) {
  const race = db.prepare('SELECT tactical_callsign, rf_path FROM races WHERE id=?').get(raceId);
  if (!race || ws.readyState !== 1) return;
  const paddedTo = toCallsign.toUpperCase().trim().padEnd(9, ' ');
  try {
    ws.send(JSON.stringify({
      type: 'tnc_tx',
      from: race.tactical_callsign,
      to:   'APRS',
      via:  (race.rf_path || 'WIDE1-1').split(',').map(s => s.trim()).filter(Boolean),
      text: `:${paddedTo}:ack${seq}`,
    }));
  } catch (e) {
    logger.log('tnc', 'error', `sendAck failed: ${e.message}`);
  }
}

// ── Incoming frame handler ────────────────────────────────────────────────────
function handleIncomingFrame(ws, { from, to, via, text }) {
  if (!from || !text) return;

  if (_isDuplicate(from, text)) return; // same packet heard by multiple TNCs

  const client = _clients.get(ws.id);
  if (client) client.rxCount++;

  // Always update route table — this callsign is reachable via this TNC
  routeTable.update(from, 'tnc_local', ws.id);

  // Check for APRS message packets (':ADDRESSEE:body{seq}')
  if (text[0] === ':') {
    const addrEnd = text.indexOf(':', 1);
    if (addrEnd > 0) {
      const addressee = text.slice(1, addrEnd).trim().toUpperCase();
      let body = text.slice(addrEnd + 1);
      let seq = null;
      const seqMatch = body.match(/\{([A-Za-z0-9]{1,5})\}?$/);
      if (seqMatch) { seq = seqMatch[1]; body = body.slice(0, seqMatch.index).trim(); }

      const raceRow = db.prepare('SELECT tactical_callsign FROM races WHERE id=?').get(ws.tncRaceId);
      const myCall = raceRow?.tactical_callsign?.toUpperCase().trim();

      if (myCall && addressee === myCall) {
        if (/^ack\d+$/i.test(body)) {
          // ACK for an outbound message we sent via TNC
          const ackSeq = parseInt(body.slice(3));
          const key = `${from.toUpperCase().trim()}:${ackSeq}`;
          const pending = _pendingAcks.get(key);
          if (pending) {
            clearTimeout(pending.timer);
            _pendingAcks.delete(key);
            _updateMsgStatus(pending.messageId, 'delivered');
            logger.log('tnc', 'info', `ACK from ${from} seq=${ackSeq}`);
          }
          return;
        }
        if (/^rej\d+$/i.test(body)) {
          const rejSeq = parseInt(body.slice(3));
          const key = `${from.toUpperCase().trim()}:${rejSeq}`;
          const pending = _pendingAcks.get(key);
          if (pending) {
            clearTimeout(pending.timer);
            _pendingAcks.delete(key);
            _updateMsgStatus(pending.messageId, 'error');
          }
          return;
        }
        // Inbound message to our tactical callsign
        _handleInboundMessage(ws.tncRaceId, from, body);
        if (seq) _sendAckViaTnc(ws, ws.tncRaceId, from, seq);
        return;
      }
    }
  }

  // Reconstruct APRS-IS format line and feed into the existing APRS parser
  // Format: FROM>TO,VIA1,VIA2:BODY
  const pathParts = [to, ...(via || [])].filter(Boolean).join(',');
  const line = `${from}>${pathParts}:${text}`;
  try {
    _aprs().processAprsLine(line);
  } catch (e) {
    logger.log('tnc', 'error', `processAprsLine: ${e.message}`);
  }
}

// ── Outbound message ──────────────────────────────────────────────────────────
function sendMessage(raceId, { toCallsign, text, messageId }) {
  const ws = getPrimary(raceId);
  if (!ws) {
    logger.log('tnc', 'warn', `sendMessage: no TNC primary for race ${raceId}`);
    return false;
  }

  const race = db.prepare('SELECT tactical_callsign, rf_path FROM races WHERE id=?').get(raceId);
  const from   = race?.tactical_callsign || 'NOCALL';
  const rfPath = race?.rf_path || 'WIDE1-1';

  _msgSeq = (_msgSeq % 999) + 1;
  const seqStr    = String(_msgSeq).padStart(3, '0');
  const paddedTo  = toCallsign.toUpperCase().trim().padEnd(9, ' ');
  const aprsText  = `:${paddedTo}:${text}{${seqStr}}`;

  try {
    ws.send(JSON.stringify({
      type: 'tnc_tx',
      from,
      to:   'APRS',
      via:  rfPath.split(',').map(s => s.trim()).filter(Boolean),
      text: aprsText,
    }));

    const client = _clients.get(ws.id);
    if (client) client.txCount++;
    _broadcastStatus(raceId);

    logger.log('tnc', 'info', `MSG→${toCallsign.trim()} seq=${seqStr}: ${text}`);
    _updateMsgStatus(messageId, 'enroute');

    // Track ACK (90-second timeout for RF delivery)
    const key = `${toCallsign.toUpperCase().trim()}:${_msgSeq}`;
    const timer = setTimeout(() => {
      if (_pendingAcks.delete(key)) _updateMsgStatus(messageId, 'error');
    }, 90_000);
    _pendingAcks.set(key, { messageId, timer });

    return true;
  } catch (e) {
    logger.log('tnc', 'error', `sendMessage failed: ${e.message}`);
    _updateMsgStatus(messageId, 'error');
    return false;
  }
}

module.exports = { setWs, register, unregister, getPrimary, getStatus, handleIncomingFrame, sendMessage };
