'use strict';

/**
 * In-memory event logger with per-channel circular buffers.
 * Broadcasts new entries to admin WebSocket clients.
 */

const CHANNELS = ['mqtt', 'aprs', 'tnc', 'race', 'system', 'console'];
const MAX_ENTRIES = 1000;

const CHANNEL_SOURCE = { aprs: 'APRS-IS', tnc: 'TNC', mqtt: 'MQTT', race: 'RACE', system: 'SYS', console: 'CON' };

const store = new Map(CHANNELS.map(c => [c, []]));
let _wsManager = null;
let _seq = 0;

/**
 * Register WebSocket manager for broadcasting log entries to admins.
 */
function setWs(ws) {
  _wsManager = ws;
}

/**
 * Log an event to a channel with a level (info, warn, error, debug).
 * Maintains circular buffer per channel (max 1000 entries).
 */
function log(channel, level, msg, source) {
  const ch = CHANNELS.includes(channel) ? channel : 'system';
  const entry = {
    id: ++_seq,
    ts: Math.floor(Date.now() / 1000),
    channel: ch,
    level,
    msg,
    source: source || CHANNEL_SOURCE[ch] || ch.toUpperCase(),
  };

  const arr = store.get(ch);
  arr.push(entry);

  // Trim to max entries (circular buffer)
  if (arr.length > MAX_ENTRIES) {
    arr.splice(0, arr.length - MAX_ENTRIES);
  }

  // Broadcast to admin websocket clients
  if (_wsManager) {
    try {
      _wsManager.broadcastToRole(['admin'], { type: 'log_entry', data: entry });
    } catch {}
  }

  return entry;
}

/**
 * Retrieve logs from a channel or all channels.
 * @param {string} channel - Channel name, or 'all' for merged logs
 * @param {number} limit - Maximum number of entries to return (default 200)
 */
function getLogs(channel, limit = 200) {
  if (!channel || channel === 'all') {
    const all = [];
    for (const arr of store.values()) {
      all.push(...arr);
    }
    all.sort((a, b) => a.id - b.id);
    return all.slice(-limit);
  }

  const arr = store.get(channel) || [];
  return arr.slice(-limit);
}

module.exports = { log, getLogs, setWs, CHANNELS };
