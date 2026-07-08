'use strict';

/**
 * SPOT Trace / Globalstar position poller.
 *
 * Periodically fetches the public Shared Page JSON feed for each active race and
 * publishes positions. A single SPOT Shared Page can carry many devices, so one
 * feed is polled per race and messages are split by device ESN (messengerId).
 *
 * Feed endpoint (JSON):
 *   https://api.findmespot.com/spot-main-web/consumer/rest-api/2.0/public/feed/{FEED_ID}/message.json
 *
 * SPOT rate limits: allow >= 2.5 min between calls to the SAME feed (repeated
 * hits get the IP blocked) and >= 2 s between DIFFERENT feeds. A 5-minute poll
 * interval with a 2.5 s stagger between race feeds stays well within those.
 *
 * The public feed exposes lat/lon/time/messageType/messengerId only — no
 * battery, altitude, speed, or heading — so those map to null in the fix model.
 */

const https = require('https');
const db = require('./db');
const logger = require('./logger');
const mqttClient = require('./mqtt-client');
const wsManager = require('./websocket');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (>= 2.5 min per-feed limit)
const FIRST_FIRE_MS    = 90 * 1000;     // 90s after startup
const FEED_STAGGER_MS  = 2500;          // >= 2s between different feeds

const API_BASE = 'https://api.findmespot.com/spot-main-web/consumer/rest-api/2.0/public/feed';

// Track last-seen position timestamp per device nodeId to skip stale re-broadcasts
const lastSeenTs = new Map();

let _timer         = null;
let _lastPollTime  = null;  // unix seconds of most recent pollAll() start
let _lastFeedCount = 0;     // number of SPOT feeds found at last poll

/**
 * Fetch URL with timeout and single-redirect handling.
 * (Same shape as inreach-poller.fetchUrl.)
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        res.resume();
        if (loc) return fetchUrl(loc).then(resolve).catch(reject);
        return reject(new Error('Redirect with no Location header'));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Extract the bare SPOT feed ID (glId) from whatever the admin pasted:
 * a full Shared Page URL, a full API URL, or the raw ID itself.
 */
function normalizeFeedId(raw) {
  const s = (raw || '').trim();
  if (!s) return null;

  // Shared Page URL: ...viewspots.jsp?glId=FEED_ID
  const gl = s.match(/[?&]glId=([^&#]+)/i);
  if (gl) return gl[1];

  // Full API URL: .../public/feed/FEED_ID/message.json
  const api = s.match(/\/feed\/([^/]+)\/(?:message|latest)/i);
  if (api) return api[1];

  // Otherwise assume it's already the bare ID
  return s;
}

/**
 * Build the message.json endpoint for a feed ID (+ optional password).
 */
function buildFeedUrl(feedId, password) {
  let url = `${API_BASE}/${encodeURIComponent(feedId)}/message.json`;
  if (password) url += `?feedPassword=${encodeURIComponent(password)}`;
  return url;
}

/**
 * Parse the SPOT feed response into an array of raw message objects.
 * The wrapper is response.feedMessageResponse.messages.message; a single
 * message comes back as an object rather than an array. An error response
 * (response.errors) yields an empty list.
 */
function parseFeed(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }

  const resp = json && json.response;
  if (!resp) return [];
  if (resp.errors) return []; // e.g. "no messages in past 7 days" — not an error we act on

  const msgs = resp.feedMessageResponse && resp.feedMessageResponse.messages;
  const raw = msgs && msgs.message;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Reduce a feed's messages to the newest fix per device (keyed by messengerId).
 */
function newestPerDevice(messages) {
  const byDevice = new Map();
  for (const m of messages) {
    const id = m.messengerId != null ? String(m.messengerId) : null;
    const lat = parseFloat(m.latitude);
    const lon = parseFloat(m.longitude);
    const ts = parseInt(m.unixTime, 10);
    if (!id || isNaN(lat) || isNaN(lon) || isNaN(ts)) continue;

    const prev = byDevice.get(id);
    if (!prev || ts > prev.timestamp) {
      byDevice.set(id, {
        messengerId: id,
        name: m.messengerName || null,
        lat,
        lon,
        timestamp: ts,
        messageType: m.messageType || null,
      });
    }
  }
  return [...byDevice.values()];
}

/**
 * Poll a single race's SPOT feed and publish any updated device positions.
 */
async function pollRaceFeed(race) {
  const feedId = normalizeFeedId(race.spot_feed_id);
  if (!feedId) return;

  const url = buildFeedUrl(feedId, race.spot_feed_password);

  try {
    const body = await fetchUrl(url);
    const devices = newestPerDevice(parseFeed(body));

    if (!devices.length) {
      logger.log('spot', 'debug', `No messages in feed for race "${race.name}"`);
      return;
    }

    for (const dev of devices) {
      const nodeId = `spot-${dev.messengerId}`;

      // Skip if we've already processed this exact position
      const prevTs = lastSeenTs.get(nodeId) || 0;
      if (dev.timestamp <= prevTs) continue;
      lastSeenTs.set(nodeId, dev.timestamp);

      // Register a display name so the device is assignable in the operator UI
      if (dev.name) {
        mqttClient.handleNodeInfo({ nodeId, longName: dev.name, timestamp: dev.timestamp });
      }

      logger.log('spot', 'info',
        `Position — ${dev.name || nodeId} (${dev.messageType || 'TRACK'}) ` +
        `${dev.lat.toFixed(5)},${dev.lon.toFixed(5)} ts=${dev.timestamp}`);

      // SPOT feed exposes no battery/altitude/speed/heading — leave them null
      mqttClient.handlePosition({
        nodeId,
        lat: dev.lat,
        lon: dev.lon,
        altitude: null,
        speed: null,
        heading: null,
        battery: null,
        timestamp: dev.timestamp,
        rfSource: 'spot',
      });
    }
  } catch (e) {
    logger.log('spot', 'warn', `Poll failed for race "${race.name}": ${e.message}`);
  }
}

/**
 * Poll all active races that have a SPOT feed configured.
 */
async function pollAll() {
  const races = db.prepare(`
    SELECT id, name, spot_feed_id, spot_feed_password
    FROM races
    WHERE status = 'active'
      AND spot_feed_id IS NOT NULL AND spot_feed_id != ''
  `).all();

  _lastPollTime  = Math.floor(Date.now() / 1000);
  _lastFeedCount = races.length;
  wsManager.broadcast({ type: 'spot_status', data: getStatus() });

  if (!races.length) return;

  logger.log('spot', 'info', `Polling ${races.length} SPOT feed(s)…`);

  for (const race of races) {
    await pollRaceFeed(race);
    // Stagger requests — SPOT requires >= 2s between different feeds
    await new Promise(r => setTimeout(r, FEED_STAGGER_MS));
  }
}

function getStatus() {
  return {
    active:   !!_timer,
    count:    _lastFeedCount,
    lastPoll: _lastPollTime,
  };
}

function start() {
  if (_timer) return;
  _timer = setInterval(pollAll, POLL_INTERVAL_MS);
  setTimeout(pollAll, FIRST_FIRE_MS);
  logger.log('system', 'info', 'SPOT poller started (5-min interval, first poll in 90s)');
  wsManager.broadcast({ type: 'spot_status', data: getStatus() });
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  wsManager.broadcast({ type: 'spot_status', data: getStatus() });
}

module.exports = { start, stop, pollAll, getStatus };

// Exposed for unit testing (pure helpers, no side effects)
module.exports._internal = { normalizeFeedId, buildFeedUrl, parseFeed, newestPerDevice };
