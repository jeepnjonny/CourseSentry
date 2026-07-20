'use strict';

/**
 * Blitzortung.org live lightning strike client.
 * Maintains a persistent outbound WebSocket connection to Blitzortung's public
 * real-time feed (the same network that powers blitzortung.org/lightningmaps.org),
 * decodes strikes, and rebroadcasts strikes near each active race to connected
 * browser clients over the app's own WebSocket (src/websocket.js).
 *
 * Wire protocol (reverse-engineered, verified live): connect, send {"a":111} to
 * subscribe, then each incoming text frame is an LZW-compressed JSON string where
 * codes < 256 are literal UTF-16 chars and codes >= 256 are dictionary back-refs.
 */

const WebSocket = require('ws');
const db = require('./db');
const logger = require('./logger');
const { resolveBbox } = require('./routes/wildfire');

// ws3-ws6 serve a TLS cert for maps.blitzortung.org / www.blitzortung.de instead of their
// own hostname (server-side misconfiguration, verified persistent) — connecting to them
// always fails with a cert hostname mismatch, so they're excluded from rotation.
const ENDPOINTS = ['wss://ws1.blitzortung.org/', 'wss://ws2.blitzortung.org/', 'wss://ws7.blitzortung.org/', 'wss://ws8.blitzortung.org/'];
const STRIKE_MAX_AGE_MS = 20 * 60 * 1000;
const IDLE_TIMEOUT_MS = 60 * 1000; // the feed is a firehose; silence this long means the connection is dead
// Wider than wildfire's default ~15mi bbox pad — lightning is a fast-moving hazard,
// so operators need strikes plotted well before a storm is directly overhead.
const LIGHTNING_BBOX_PAD = 0.5; // ~30-35mi at US latitudes

let socket = null;
let wsRef = null;
let reconnectTimer = null;
let idleTimer = null;
let endpointIdx = 0;
let _connected = false;
let recentStrikes = []; // ring buffer, oldest-first: {lat, lon, time}

function setWs(ws) {
  wsRef = ws;
}

function getStatus() {
  return { connected: _connected, endpoint: ENDPOINTS[endpointIdx], strikeCount: recentStrikes.length };
}

// Decodes Blitzortung's obfuscated (LZW-style) message text into plain JSON text.
function decodeLzw(str) {
  const dict = {};
  const data = Array.from(str);
  if (!data.length) return '';
  let currChar = data[0];
  let oldPhrase = currChar;
  const out = [currChar];
  let code = 256;
  for (let i = 1; i < data.length; i++) {
    const currCode = data[i].codePointAt(0);
    const phrase = currCode < 256 ? data[i] : (dict[currCode] !== undefined ? dict[currCode] : oldPhrase + currChar);
    out.push(phrase);
    currChar = phrase[0];
    dict[code] = oldPhrase + currChar;
    code++;
    oldPhrase = phrase;
  }
  return out.join('');
}

// Decodes a raw Blitzortung frame into { lat, lon, time } (time in ms since epoch), or null.
function decodeStrike(raw) {
  try {
    const parsed = JSON.parse(decodeLzw(raw));
    const { lat, lon, time } = parsed;
    if (typeof lat !== 'number' || typeof lon !== 'number' || typeof time !== 'number') return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon, time: Math.floor(time / 1e6) }; // Blitzortung sends nanoseconds
  } catch {
    return null;
  }
}

function pruneOldStrikes() {
  const cutoff = Date.now() - STRIKE_MAX_AGE_MS;
  const idx = recentStrikes.findIndex(s => s.time >= cutoff);
  if (idx > 0) recentStrikes = recentStrikes.slice(idx);
  else if (idx === -1) recentStrikes = [];
}
setInterval(pruneOldStrikes, 60000);

function strikeInBbox(strike, bbox) {
  return bbox && strike.lat >= bbox.minLat && strike.lat <= bbox.maxLat &&
    strike.lon >= bbox.minLon && strike.lon <= bbox.maxLon;
}

function handleStrike(strike) {
  recentStrikes.push(strike);
  if (!wsRef) return;
  // Scope to races someone currently has open (by ws.raceId), not races flagged
  // status='active' in the DB — an operator can be watching a race by direct URL
  // (e.g. ?race=2) without it ever being marked active, and would otherwise never
  // get live strikes.
  const raceIds = wsRef.getConnectedRaceIds();
  if (!raceIds.size) return;
  for (const raceId of raceIds) {
    const race = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
    if (!race) continue;
    const bbox = resolveBbox(race, LIGHTNING_BBOX_PAD);
    if (strikeInBbox(strike, bbox)) {
      wsRef.broadcastToRace(race.id, { type: 'lightning_strike', data: strike });
    }
  }
}

// Returns recent strikes near a race's course, for seeding newly-connected clients.
function getRecentStrikes(race) {
  const bbox = resolveBbox(race, LIGHTNING_BBOX_PAD);
  if (!bbox) return [];
  const cutoff = Date.now() - STRIKE_MAX_AGE_MS;
  return recentStrikes.filter(s => s.time >= cutoff && strikeInBbox(s, bbox));
}

function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    logger.log('system', 'warn', '[lightning] No data from Blitzortung for 60s, reconnecting');
    try { socket?.terminate(); } catch {}
  }, IDLE_TIMEOUT_MS);
}

function connect() {
  if (socket) return;
  const url = ENDPOINTS[endpointIdx % ENDPOINTS.length];
  logger.log('system', 'info', `[lightning] Connecting to ${url}`);
  socket = new WebSocket(url);

  socket.on('open', () => {
    _connected = true;
    socket.send(JSON.stringify({ a: 111 }));
    resetIdleTimer();
    logger.log('system', 'info', '[lightning] Connected to Blitzortung feed');
  });

  socket.on('message', (data) => {
    resetIdleTimer();
    const strike = decodeStrike(data.toString('utf8'));
    if (strike) handleStrike(strike);
  });

  socket.on('error', (err) => {
    logger.log('system', 'error', `[lightning] Socket error: ${err.message}`);
  });

  socket.on('close', () => {
    _connected = false;
    clearTimeout(idleTimer);
    socket = null;
    endpointIdx++;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 15000);
}

module.exports = { connect, setWs, getStatus, getRecentStrikes, decodeStrike };
