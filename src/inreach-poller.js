'use strict';

/**
 * Garmin inReach MapShare position poller.
 * Periodically fetches KML feeds from shared inReach accounts and publishes positions.
 */

const https = require('https');
const db = require('./db');
const logger = require('./logger');
const mqttClient = require('./mqtt-client');
const wsManager = require('./websocket');

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const FIRST_FIRE_MS = 60 * 1000;         // 60s after startup

// Track last-seen position timestamp per participant to skip stale re-broadcasts
const lastSeenTs = new Map();

let _timer = null;

/**
 * Fetch URL with timeout and redirect handling.
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      // Follow single redirect (MapShare may redirect)
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
 * Extract a named data element from KML <Data> tag.
 */
function extractKmlData(text, name) {
  const re = new RegExp(`<Data[^>]+name=["']${name}["'][^>]*>\\s*<value>([^<]*)<\\/value>`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Parse most-recent position from a MapShare KML response.
 * MapShare returns Placemarks newest-first, so take the first.
 */
function parseKml(kml) {
  const pmMatch = kml.match(/<Placemark>([\s\S]*?)<\/Placemark>/i);
  if (!pmMatch) return null;

  const pm = pmMatch[1];
  const latStr = extractKmlData(pm, 'Latitude');
  const lonStr = extractKmlData(pm, 'Longitude');
  const timeStr = extractKmlData(pm, 'Time UTC');
  const elevStr = extractKmlData(pm, 'Elevation');
  const velStr = extractKmlData(pm, 'Velocity');
  const courseStr = extractKmlData(pm, 'Course');
  const imei = extractKmlData(pm, 'IMEI');

  if (!latStr || !lonStr) return null;

  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);
  if (isNaN(lat) || isNaN(lon)) return null;

  // Parse timestamp (Garmin format: "07/16/2023 10:30:00" UTC)
  let timestamp = Math.floor(Date.now() / 1000);
  if (timeStr) {
    const d = new Date(timeStr.includes('T') ? timeStr : timeStr + ' UTC');
    if (!isNaN(d.getTime())) {
      timestamp = Math.floor(d.getTime() / 1000);
    }
  }

  const velocity = velStr ? parseFloat(velStr) : null;

  return {
    imei: imei || null,
    lat,
    lon,
    altitude: elevStr ? parseFloat(elevStr) : null,
    speed: velocity != null && !isNaN(velocity) ? velocity / 3.6 : null, // km/h → m/s
    heading: courseStr ? parseFloat(courseStr) : null,
    timestamp,
  };
}

/**
 * Normalize user-supplied inReach URL to the KML feed endpoint.
 * Accepts: username, share.garmin.com/username, or full Feed URL.
 */
function normalizeFeedUrl(raw) {
  let s = raw.trim();
  if (!s.startsWith('http')) s = 'https://' + s;

  // Already a feed URL
  if (s.includes('/Feed/Share/')) return s;

  // Social share URL: https://share.garmin.com/username
  const m = s.match(/share\.garmin\.com\/([^/?#]+)/i);
  if (m) return `https://share.garmin.com/Feed/Share/${m[1]}`;

  // Fallback — return as-is and let HTTP request fail visibly
  return s;
}

/**
 * Poll a single participant's inReach feed and publish position if updated.
 */
async function pollParticipant(participant) {
  if (!participant.inreach_url) return;

  const base = normalizeFeedUrl(participant.inreach_url);
  const d1 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
  const sep = base.includes('?') ? '&' : '?';
  const url = `${base}${sep}d1=${encodeURIComponent(d1)}`;

  try {
    const kml = await fetchUrl(url);
    const pos = parseKml(kml);

    if (!pos) {
      logger.log('inreach', 'debug', `No position in feed for ${participant.name} (#${participant.bib})`);
      return;
    }

    // Skip if we've already processed this exact position
    const prevTs = lastSeenTs.get(participant.id) || 0;
    if (pos.timestamp <= prevTs) return;
    lastSeenTs.set(participant.id, pos.timestamp);

    // Derive node ID from IMEI or participant ID
    const nodeId = pos.imei ? `inreach-${pos.imei}` : `inreach-p${participant.id}`;

    // Auto-register tracker_id on first successful poll
    if (participant.tracker_id !== nodeId) {
      db.prepare('UPDATE participants SET tracker_id = ? WHERE id = ?').run(nodeId, participant.id);
      wsManager.broadcast({ type: 'participant_update', data: { action: 'bulk_update' } });
      logger.log('inreach', 'info',
        `Auto-registered tracker=${nodeId} for ${participant.name} (#${participant.bib})`);
    }

    logger.log('inreach', 'info',
      `Position — ${participant.name} (#${participant.bib}) ` +
      `${pos.lat.toFixed(5)},${pos.lon.toFixed(5)} ts=${pos.timestamp}`);

    // Publish to MQTT/broadcast
    mqttClient.handlePosition({
      nodeId,
      lat: pos.lat,
      lon: pos.lon,
      altitude: pos.altitude,
      speed: pos.speed,
      heading: pos.heading,
      timestamp: pos.timestamp,
      rfSource: 'inreach',
    });
  } catch (e) {
    logger.log('inreach', 'warn',
      `Poll failed for ${participant.name} (#${participant.bib}): ${e.message}`);
  }
}

/**
 * Poll all participants with inReach URLs for active races.
 */
async function pollAll() {
  const activeRaceIds = db.prepare("SELECT id FROM races WHERE status = 'active'")
    .all()
    .map(r => r.id);

  if (!activeRaceIds.length) return;

  const placeholders = activeRaceIds.map(() => '?').join(',');
  const participants = db.prepare(`
    SELECT * FROM participants
    WHERE race_id IN (${placeholders})
      AND inreach_url IS NOT NULL AND inreach_url != ''
      AND status NOT IN ('dnf', 'finished')
  `).all(...activeRaceIds);

  if (!participants.length) return;

  logger.log('inreach', 'info', `Polling ${participants.length} inReach feed(s)…`);

  for (const p of participants) {
    await pollParticipant(p);
    // Stagger requests — be polite to Garmin's servers
    await new Promise(r => setTimeout(r, 2000));
  }
}

function start() {
  if (_timer) return;
  _timer = setInterval(pollAll, POLL_INTERVAL_MS);
  setTimeout(pollAll, FIRST_FIRE_MS);
  logger.log('system', 'info', 'inReach MapShare poller started (10-min interval, first poll in 60s)');
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop, pollAll };
