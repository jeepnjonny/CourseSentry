'use strict';

/**
 * In-memory route table: tracks which data source last heard each node/callsign.
 * Used to route outbound messages back out the same path they arrived on.
 *
 * Sources: 'aprs_is' | 'tnc_local' | 'mqtt' | 'inreach'
 * Entries expire after source-specific TTLs; stale entries fall back to next best path.
 */

// Map<nodeId (uppercased) → { source, wsId, timestamp }>
const _table = new Map();

const STALE_MS = {
  aprs_is:   30 * 60 * 1000,  // APRS beacons every 10–30 min
  tnc_local: 30 * 60 * 1000,
  mqtt:      10 * 60 * 1000,  // Meshtastic beacons more frequent
  inreach:   60 * 60 * 1000,
};

/**
 * Record or refresh a node's source.
 * @param {string} nodeId  - callsign or Meshtastic hex node ID
 * @param {string} source  - 'aprs_is' | 'tnc_local' | 'mqtt' | 'inreach'
 * @param {string} [wsId]  - WebSocket client ID (only for tnc_local)
 */
function update(nodeId, source, wsId = null) {
  if (!nodeId) return;
  _table.set(nodeId.toUpperCase(), { source, wsId, timestamp: Date.now() });
}

/**
 * Look up routing info for a node.
 * Returns null if not found or if the entry has expired.
 * @param {string} nodeId
 * @returns {{ source: string, wsId: string|null, timestamp: number } | null}
 */
function resolve(nodeId) {
  if (!nodeId) return null;
  const entry = _table.get(nodeId.toUpperCase());
  if (!entry) return null;
  const ttl = STALE_MS[entry.source] ?? 30 * 60 * 1000;
  if (Date.now() - entry.timestamp > ttl) return null;
  return entry;
}

/**
 * Remove all route entries that came in via a specific WebSocket client.
 * Call this when a TNC browser disconnects.
 * @param {string} wsId
 */
function invalidateWs(wsId) {
  for (const [key, entry] of _table) {
    if (entry.wsId === wsId) _table.delete(key);
  }
}

/**
 * Return all current entries (including stale) for diagnostics.
 */
function getAll() {
  const now = Date.now();
  return [..._table.entries()].map(([nodeId, e]) => ({
    nodeId,
    source:  e.source,
    wsId:    e.wsId,
    age_s:   Math.floor((now - e.timestamp) / 1000),
    stale:   now - e.timestamp > (STALE_MS[e.source] ?? 30 * 60 * 1000),
  }));
}

module.exports = { update, resolve, invalidateWs, getAll };
