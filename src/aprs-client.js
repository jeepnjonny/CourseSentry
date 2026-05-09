'use strict';

/**
 * APRS-IS client for receiving positions and sending beacons/messages.
 * Connects to APRS-IS server (rotate.aprs2.net) over TCP, parses position packets,
 * and bridges with MQTT infrastructure for unified tracker management.
 *
 * Position formats decoded: uncompressed, compressed (APRS spec §9), and Mic-E.
 * Supports location-based and callsign-based filtering to reduce network traffic.
 */

const net = require('net');
const db = require('./db');
const geo = require('./geo');
const logger = require('./logger');
const routeTable = require('./route-table');

// ── APRS callsign validation ──────────────────────────────────────────────────
// Matches bare callsign or callsign-SSID (1–6 alphanum chars, SSID 1–15)
const APRS_CALL_RE = /^[A-Z0-9]{1,6}(-(?:1[0-5]|[0-9]))?$/;

// ── Module state ──────────────────────────────────────────────────────────────
let socket = null;
let wsRef = null;
let currentConfig = null;
let lineBuffer = '';
let reconnectTimer = null;
let _connected = false;
let _messagingCallsign = null; // set to logged-in user's callsign when available
const _pendingAcks = new Map(); // key: "CALLSIGN:seqNum" → { messageId, timer }

// ── Byham APRS passcode algorithm ────────────────────────────────────────────
// Generates the 16-bit passcode required for authenticated APRS-IS connections
function generatePasscode(callsign) {
  const base = callsign.toUpperCase().split('-')[0];
  let hash = 0x73e2;
  for (let i = 0; i < base.length; i += 2) {
    hash ^= base.charCodeAt(i) << 8;
    if (i + 1 < base.length) hash ^= base.charCodeAt(i + 1);
  }
  return hash & 0x7fff;
}

// ── WebSocket and status management ──────────────────────────────────────────
function setWs(ws) {
  wsRef = ws;
}

function getStatus() {
  return {
    connected: _connected,
    enabled: !!(currentConfig),
    server: currentConfig?.server,
    filterType: currentConfig?.filterType,
    filterStr: currentConfig?.filterStr || '',
  };
}

function broadcast(type, data) {
  if (wsRef) {
    try {
      wsRef.broadcast({ type, data });
    } catch {}
  }
}

// ── Position parsing: uncompressed, compressed, Mic-E ─────────────────────────

function parseDM(dm, hemi) {
  const dot = dm.indexOf('.');
  if (dot < 2) return null;
  const deg = parseFloat(dm.slice(0, dot - 2));
  const min = parseFloat(dm.slice(dot - 2));
  if (isNaN(deg) || isNaN(min)) return null;
  let dd = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') dd = -dd;
  return dd;
}

// ── Compressed position (APRS spec §9) ───────────────────────────────────────
// Decode 4 consecutive Base-91 chars starting at index i
function base91_4(s, i) {
  return (s.charCodeAt(i)-33)*753571 + (s.charCodeAt(i+1)-33)*8281 +
         (s.charCodeAt(i+2)-33)*91   + (s.charCodeAt(i+3)-33);
}

// data = body after the data-type/timestamp byte(s), starting at the symbol-table char
// Layout: [sym_table][lat×4][sym_code][lon×4][c][s][t]
function parseCompressed(data) {
  if (data.length < 12) return null;
  // Symbol table must be / \ or an overlay letter (A-Z); digits indicate uncompressed
  const symTable = data.charCodeAt(0);
  if (symTable !== 0x2f && symTable !== 0x5c &&
      !(symTable >= 0x41 && symTable <= 0x5a)) return null;
  // Validate Base-91 range for lat (bytes 1-4) and lon (bytes 5-8)
  for (let i = 1; i <= 4; i++) { const c = data.charCodeAt(i); if (c < 33 || c > 124) return null; }
  for (let i = 5; i <= 8; i++) { const c = data.charCodeAt(i); if (c < 33 || c > 124) return null; }

  const lat = 90  - base91_4(data, 1) / 380926;
  const lon = -180 + base91_4(data, 5) / 190463;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const c = data.charCodeAt(10);
  const s = data.charCodeAt(11);
  const t = data.length > 12 ? data.charCodeAt(12) : 33;

  let speed = null, heading = null, altitude = null;
  if (c !== 0x20 && s !== 0x20) {
    if ((t & 0x18) === 0x10) {
      // cs bytes encode altitude (feet)
      altitude = Math.pow(1.002, (c - 33) * 91 + (s - 33)) * 0.3048;
    } else if (c !== 0x5f) {
      // cs bytes encode course + speed (knots via exponential scale)
      heading = (c - 33) * 4;
      speed   = (Math.pow(1.08, s - 33) - 1) * 0.514444; // knots → m/s
    }
  }
  return { lat, lon, speed, heading, altitude };
}

// ── Mic-E position (APRS spec §10) ───────────────────────────────────────────
// Lookup table: ASCII char → Mic-E digit (0-9), 255 = invalid
const MICE_DIGIT = new Uint8Array(256).fill(255);
for (let i = 0; i <= 9; i++) MICE_DIGIT[0x30 + i] = i;   // '0'–'9'
for (let i = 0; i <= 9; i++) MICE_DIGIT[0x41 + i] = i;   // 'A'–'J'
for (let i = 0; i <= 9; i++) MICE_DIGIT[0x50 + i] = i;   // 'P'–'Y'
MICE_DIGIT[0x4b] = 0; MICE_DIGIT[0x4c] = 0; MICE_DIGIT[0x5a] = 0; // K, L, Z → 0

// dest = 6-char destination callsign (SSID stripped)
// body = raw information field
function parseMicE(dest, body) {
  if (!dest || dest.length < 6) return null;
  // Mic-E type indicators: ` (0x60), ' (0x27), 0x1c, 0x1d
  const tc = body.charCodeAt(0);
  if (tc !== 0x60 && tc !== 0x27 && tc !== 0x1c && tc !== 0x1d) return null;
  if (body.length < 8) return null;

  // Decode destination chars to latitude digits
  const d = new Array(6);
  for (let i = 0; i < 6; i++) {
    const v = MICE_DIGIT[dest.charCodeAt(i)];
    if (v === 255) return null;
    d[i] = v;
  }

  const latDeg = d[0] * 10 + d[1];
  const latMin = d[2] * 10 + d[3] + (d[4] * 10 + d[5]) / 100;
  let lat = latDeg + latMin / 60;
  if (dest.charCodeAt(3) < 80) lat = -lat; // D4 < 'P' → South

  const lonOffset = dest.charCodeAt(4) >= 80 ? 100 : 0; // D5 >= 'P' → +100°
  const lonWest   = dest.charCodeAt(5) >= 80;            // D6 >= 'P' → West

  // Longitude degrees from body byte 1
  let lonDeg = body.charCodeAt(1) - 28 + lonOffset;
  if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
  else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;

  // Longitude minutes from body bytes 2–3
  let lonMin = body.charCodeAt(2) - 28;
  if (lonMin >= 60) lonMin -= 60;
  const lonMinFrac = body.charCodeAt(3) - 28;

  let lon = lonDeg + (lonMin + lonMinFrac / 100) / 60;
  if (lonWest) lon = -lon;

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  // Speed (knots) and course from body bytes 4–6
  const sp = body.charCodeAt(4) - 28;
  const dc = body.charCodeAt(5) - 28;
  const se = body.charCodeAt(6) - 28;

  let speedKnots = sp * 10 + Math.floor(dc / 10);
  if (speedKnots >= 800) speedKnots -= 800;
  let course = (dc % 10) * 100 + se;
  if (course >= 400) course -= 400;

  return {
    lat, lon,
    speed:   speedKnots * 0.514444, // knots → m/s
    heading: course || null,        // 0 = unknown, treat as null
    altitude: null,
  };
}

// Parse any APRS position format — uncompressed, compressed, or Mic-E.
// destCall is needed for Mic-E decoding; pass null/undefined when unavailable.
function parsePosition(body, destCall) {
  // 0. Object: ;OBJECTNAME*position_data
  const objMatch = /^;([^*]+)\*([\s\S]*)/.exec(body);
  if (objMatch) {
    const objectName = objMatch[1].toUpperCase().trim();
    const posData = objMatch[2];
    // Uncompressed object: DDMM.mmN[sym]DDDMM.mmE
    const plain = /^(\d{4}\.\d+)([NS])([\S]?)(\d{5}\.\d+)([EW])/.exec(posData);
    if (plain) {
      const lat = parseDM(plain[1], plain[2]);
      const lon = parseDM(plain[4], plain[5]);
      if (lat != null && lon != null) return { objectName, lat, lon, speed: null, heading: null, altitude: null };
    }
    // Compressed object: sym_table + lat×4 + sym + lon×4 + cs + t
    const cp = /^([\s\S]{11,})/.exec(posData);
    if (cp) {
      const pos = parseCompressed(cp[1]);
      if (pos) return { ...pos, objectName };
    }
    // Timestamped uncompressed object: \d{6}[z/h]DDMM.mmN[sym]DDDMM.mmE
    const tsu = /^\d{6}[zZhH\/](\d{4}\.\d+)([NS])([\S]?)(\d{5}\.\d+)([EW])/.exec(posData);
    if (tsu) {
      const lat = parseDM(tsu[1], tsu[2]);
      const lon = parseDM(tsu[4], tsu[5]);
      if (lat != null && lon != null) return { objectName, lat, lon, speed: null, heading: null, altitude: null };
    }
    // Timestamped compressed object: \d{6}[z/h] + compressed data
    const cpTs = /^\d{6}[zZhH\/]([\s\S]{11,})/.exec(posData);
    if (cpTs) {
      const pos = parseCompressed(cpTs[1]);
      if (pos) return { ...pos, objectName };
    }
    return null;
  }
  // 1. Uncompressed: [!=]DDMM.mmN[sym]DDDMM.mmE
  const plain = /[!=](\d{4}\.\d+)([NS])[\S](\d{5}\.\d+)([EW])/.exec(body);
  if (plain) {
    const lat = parseDM(plain[1], plain[2]);
    const lon = parseDM(plain[3], plain[4]);
    if (lat != null && lon != null) return { lat, lon, speed: null, heading: null, altitude: null };
  }
  // 2. Timestamped uncompressed: [/@]\d{6}[z/h]DDMM.mmN[sym]DDDMM.mmE
  const tsu = /[@\/]\d{6}[zZhH\/](\d{4}\.\d+)([NS])[\S](\d{5}\.\d+)([EW])/.exec(body);
  if (tsu) {
    const lat = parseDM(tsu[1], tsu[2]);
    const lon = parseDM(tsu[3], tsu[4]);
    if (lat != null && lon != null) return { lat, lon, speed: null, heading: null, altitude: null };
  }
  // 3. Compressed (direct): [!=] + sym_table + lat×4 + sym + lon×4 + cs + t
  const cpPlain = /^[!=]([\s\S]{11,})/.exec(body);
  if (cpPlain) {
    const pos = parseCompressed(cpPlain[1]);
    if (pos) return pos;
  }
  // 4. Compressed (timestamped): [/@]\d{6}[z/h] + compressed data
  const cpTs = /^[@\/]\d{6}[zZhH\/]([\s\S]{11,})/.exec(body);
  if (cpTs) {
    const pos = parseCompressed(cpTs[1]);
    if (pos) return pos;
  }
  // 5. Mic-E: body starts with ` ' 0x1c 0x1d; lat encoded in destination field
  if (destCall) {
    const pos = parseMicE(destCall, body);
    if (pos) return pos;
  }
  return null;
}

// Convert APRS A=XXXXXX altitude (feet per spec) to meters, with auto-detection
// for devices that incorrectly transmit in meters: if the raw value as meters is
// within 500 m of the node's last known GPS altitude, treat it as meters instead.
function inferAltitudeMeters(rawFt, nodeId) {
  const asMeters = rawFt * 0.3048;
  const valid = v => v >= -500 && v <= 8850; // surface to Everest summit
  if (!valid(asMeters)) {
    // Feet interpretation is physically impossible — try reading the raw value as meters
    return valid(rawFt) ? rawFt : null;
  }
  // Cross-check against last known GPS altitude for this node
  const reg = db.prepare('SELECT last_altitude FROM tracker_registry WHERE node_id=?').get(nodeId);
  if (reg?.last_altitude != null) {
    const errFt = Math.abs(asMeters - reg.last_altitude);
    const errM  = Math.abs(rawFt   - reg.last_altitude);
    if (errM < errFt && errM < 500) return rawFt; // raw value already in meters
  }
  return asMeters; // default: APRS spec (feet → meters)
}

function updateMessageStatus(messageId, status) {
  try {
    db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, messageId);
    broadcast('message_status', { id: messageId, status });
  } catch (e) {
    logger.log('aprs', 'error', `updateMessageStatus failed: ${e.message}`);
  }
}

// ── Message parsing and inbound handling ──────────────────────────────────────
// Parse APRS message body — body must start with ':' (message type indicator)
// Returns { addressee, text, seq } or null
function parseAprsMessage(body) {
  if (!body || body[0] !== ':') return null;
  const addrEnd = body.indexOf(':', 1);
  if (addrEnd < 0) return null;
  const addressee = body.slice(1, addrEnd).trim().toUpperCase();
  if (!addressee) return null;
  let text = body.slice(addrEnd + 1);
  let seq = null;
  const seqMatch = text.match(/\{([A-Za-z0-9]{1,5})\}?$/);
  if (seqMatch) { seq = seqMatch[1]; text = text.slice(0, seqMatch.index); }
  return { addressee, text: text.trim(), seq };
}

// ── Acknowledgments and message responses ─────────────────────────────────────
function sendAck(toCallsign, seq) {
  if (!socket || !_connected || !currentConfig) return;
  const from = currentConfig.callsign;
  const to = toCallsign.toUpperCase().trim().padEnd(9, ' ');
  try {
    socket.write(`${from}>APRS,TCPIP*,qAC,${from}::${to}:ack${seq}\r\n`);
    logger.log('aprs', 'info', `ACK→${toCallsign.trim()} seq=${seq}`);
  } catch (e) {
    logger.log('aprs', 'error', `sendAck failed: ${e.message}`);
  }
}

// ── Inbound message handling ──────────────────────────────────────────────────
function handleInboundMessage(fromCall, text) {
  const race = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
  if (!race) return;
  const person = db.prepare(
    "SELECT * FROM personnel WHERE race_id=? AND UPPER(tracker_id)=? LIMIT 1"
  ).get(race.id, fromCall.toUpperCase());
  const ts = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, text, timestamp)
    VALUES (?,?,?,?,?,?,?)
  `).run(race.id, 'in', fromCall, person?.name || fromCall, currentConfig?.callsign || null, text, ts);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
  logger.log('aprs', 'info', `MSG from ${fromCall}${person ? ' (' + person.name + ')' : ''}: ${text}`);
  broadcast('message', msg);
}

// ── Main packet processing loop ───────────────────────────────────────────────
// Parses APRS packet header and body, routes to appropriate handlers
function processLine(line) {
  if (!line) return;
  if (line.startsWith('#')) {
    // Skip periodic server heartbeat banners (# aprsc ...) — only log meaningful server responses
    if (/^# aprsc\b/.test(line)) return;
    logger.log('aprs', 'info', line);
    return;
  }

  const ci = line.indexOf(':');
  if (ci < 0) return;
  const header = line.slice(0, ci);
  const body   = line.slice(ci + 1);

  const gi = header.indexOf('>');
  if (gi < 0) return;
  const fromCall = header.slice(0, gi).toUpperCase().trim();
  if (!fromCall) return;

  // Extract destination callsign (needed for Mic-E decoding)
  const pathStart = header.indexOf(',', gi);
  const destRaw   = header.slice(gi + 1, pathStart > 0 ? pathStart : undefined).toUpperCase().trim();
  const destSsid  = destRaw.indexOf('-');
  const destCall  = (destSsid > 0 ? destRaw.slice(0, destSsid) : destRaw);

  // APRS message packet — check before position parsing
  const aprsMsg = parseAprsMessage(body);
  if (aprsMsg) {
    const myCall = currentConfig?.callsign?.toUpperCase();
    if (myCall && aprsMsg.addressee === myCall) {
      if (/^(ack|rej)\d+$/i.test(aprsMsg.text)) {
        const ackType = aprsMsg.text.slice(0, 3).toUpperCase();
        const ackSeq  = parseInt(aprsMsg.text.slice(3));
        logger.log('aprs', 'info', `${ackType} from ${fromCall}: seq=${ackSeq}`);
        const key = `${fromCall.toUpperCase().trim()}:${ackSeq}`;
        const pending = _pendingAcks.get(key);
        if (pending) {
          clearTimeout(pending.timer);
          _pendingAcks.delete(key);
          updateMessageStatus(pending.messageId, ackType === 'ACK' ? 'delivered' : 'error');
        }
      } else {
        handleInboundMessage(fromCall, aprsMsg.text);
        if (aprsMsg.seq) sendAck(fromCall, aprsMsg.seq);
      }
    }
    return; // message packets never carry position data
  }

  const pos = parsePosition(body, destCall);
  if (!pos) return;

  const nodeId = pos.objectName || fromCall;

  // Record that this callsign was last heard via APRS-IS
  routeTable.update(nodeId, 'aprs_is');

  // Altitude: prefer value decoded from compressed/Mic-E; fall back to A=XXXXXX comment field
  const altMatch = /\bA=(\d{1,6})\b/.exec(body);
  const altitude = pos.altitude ?? (altMatch ? inferAltitudeMeters(parseInt(altMatch[1]), nodeId) : null);

  // Battery voltage: patterns like 3.7V, 12.5V, 4.18V in the comment/status text
  const voltMatch = /\b(\d{1,2}\.\d{1,2})V\b/i.exec(body);
  const voltage = voltMatch ? parseFloat(voltMatch[1]) : null;

  logger.log('aprs', 'info',
    `position from ${nodeId} (${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)})` +
    (pos.speed   != null ? ` spd=${(pos.speed * 1.944).toFixed(1)}kt` : '') +
    (pos.heading != null ? ` hdg=${pos.heading}°` : '') +
    (altitude    != null ? ` alt=${Math.round(altitude)}m` : '') +
    (voltage     != null ? ` batt=${voltage}V` : ''));

  const ts = Math.floor(Date.now() / 1000);
  try {
    const mqttClient = require('./mqtt-client');
    // Store callsign as long_name so it appears in infrastructure and triggers tracker_info broadcast
    mqttClient.handleNodeInfo({ nodeId, longName: nodeId, shortName: null, hwModel: 'APRS', timestamp: ts });
    mqttClient.handlePosition({
      nodeId,
      lat: pos.lat,
      lon: pos.lon,
      altitude,
      speed:   pos.speed,
      heading: pos.heading,
      battery: null,
      snr: null,
      rssi: null,
      timestamp: ts,
      rfSource: 'aprs',
    });
    if (voltage != null) {
      mqttClient.handleTelemetry({ nodeId, battery: null, voltage, timestamp: ts });
    }
  } catch (e) {
    logger.log('aprs', 'error', `handlePosition: ${e.message}`);
  }
}

// ── Filter builders: geographic and callsign-based filtering ──────────────────
// Filters reduce network traffic by requesting only relevant positions from APRS-IS

function buildLocationFilter() {
  const race = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
  if (!race) return '';

  let points = [];
  try {
    const fs = require('fs');
    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const raw = fs.readFileSync(course.file_path, 'utf8');
        const { parseCourse } = require('./routes/courses');
        const { trackPoints } = parseCourse(raw, course.file_path, course.path_index);
        if (trackPoints?.length) points = trackPoints;
      }
    }
    if (!points.length && race.track_file) {
      const raw = fs.readFileSync(race.track_file, 'utf8');
      const { parseTrack } = require('./routes/tracks');
      const tp = parseTrack(raw, race.track_file, race.track_path_index);
      if (tp?.length) points = tp;
    }
  } catch {}

  if (!points.length) {
    const stns = db.prepare('SELECT lat, lon FROM stations WHERE race_id=? AND lat IS NOT NULL AND lon IS NOT NULL').all(race.id);
    points = stns.map(s => [s.lat, s.lon]);
  }

  if (!points.length) return '';

  let sumLat = 0, sumLon = 0;
  for (const [lat, lon] of points) { sumLat += lat; sumLon += lon; }
  const cLat = sumLat / points.length;
  const cLon = sumLon / points.length;

  let maxDist = 0;
  for (const [lat, lon] of points) {
    const d = geo.haversine(cLat, cLon, lat, lon) / 1000; // km
    if (d > maxDist) maxDist = d;
  }
  const radius = Math.max(5, Math.ceil(maxDist * 1.5));

  return `r/${cLat.toFixed(4)}/${cLon.toFixed(4)}/${radius}`;
}

function buildCallsignFilter(raceId) {
  const race = raceId
    ? db.prepare('SELECT id FROM races WHERE id=?').get(raceId)
    : db.prepare("SELECT id FROM races WHERE status='active' LIMIT 1").get();
  if (!race) return '';

  const calls = new Set();
  const addId = raw => {
    const id = (raw || '').trim().toUpperCase();
    if (APRS_CALL_RE.test(id)) calls.add(id);
  };

  db.prepare('SELECT tracker_id FROM participants WHERE race_id=? AND tracker_id IS NOT NULL').all(race.id)
    .forEach(p => addId(p.tracker_id));
  db.prepare('SELECT tracker_id FROM personnel WHERE race_id=? AND tracker_id IS NOT NULL').all(race.id)
    .forEach(p => addId(p.tracker_id));

  return calls.size ? 'b/' + [...calls].join('/') + ' o/' + [...calls].join('/') : '';
}

function buildFilter(filterType) {
  return filterType === 'location' ? buildLocationFilter() : buildCallsignFilter();
}

// ── Connection management ─────────────────────────────────────────────────────
// Establishes/maintains persistent TCP connection to APRS-IS server

function connect(config) {
  disconnect();
  currentConfig = { ...config };
  const filterStr = buildFilter(config.filterType);
  currentConfig.filterStr = filterStr;

  const loginLine = `user ${config.callsign} pass ${config.passcode} vers RaceTracker 1.0${filterStr ? ' filter ' + filterStr : ''}\r\n`;

  logger.log('aprs', 'info', `Connecting to ${config.server}:${config.port} as ${config.callsign}`);
  if (filterStr) logger.log('aprs', 'info', `Filter: ${filterStr}`);

  socket = new net.Socket();
  socket.setEncoding('utf8');
  socket.setTimeout(120000); // 2-min idle keepalive

  socket.connect(config.port, config.server, () => {
    _connected = true;
    socket.write(loginLine);
    logger.log('aprs', 'info', `Connected — login sent`);
    broadcast('aprs_status', getStatus());
  });

  socket.on('data', chunk => {
    lineBuffer += chunk;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop();
    for (const line of lines) processLine(line.trim());
  });

  socket.on('timeout', () => {
    logger.log('aprs', 'warn', 'Keepalive ping');
    try { socket.write('#keepalive\r\n'); } catch {}
  });

  socket.on('error', err => {
    _connected = false;
    logger.log('aprs', 'error', `Socket error: ${err.message}`);
    broadcast('aprs_status', { connected: false, error: err.message });
    scheduleReconnect();
  });

  socket.on('close', () => {
    _connected = false;
    logger.log('aprs', 'info', 'Socket closed');
    broadcast('aprs_status', { connected: false });
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (!currentConfig?.enabled || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (currentConfig?.enabled) {
      logger.log('aprs', 'info', 'Reconnecting...');
      connect(currentConfig);
    }
  }, 15000);
}

// ── Disconnection and settings-based connection ───────────────────────────────
function disconnect() {
  _connected = false;
  currentConfig = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.removeAllListeners();
    try {
      socket.destroy();
    } catch {}
    socket = null;
  }
  lineBuffer = '';
}

// Load APRS settings from database and auto-connect if enabled
function connectFromSettings(dbArg) {
  const _db = dbArg || db;
  const rows = _db.prepare("SELECT key, value FROM settings WHERE key LIKE 'aprs_%'").all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (s.aprs_enabled !== '1' || !s.aprs_callsign) return false;

  // Default: global callsign with configured or read-only passcode
  let callsign = s.aprs_callsign.toUpperCase().trim();
  let passcode = s.aprs_passcode || '-1';

  // If messaging is enabled and a user is logged in with a callsign, use it (allows sending)
  const activeRace = _db.prepare("SELECT messaging_enabled FROM races WHERE status='active' LIMIT 1").get();
  if (activeRace?.messaging_enabled && _messagingCallsign) {
    callsign = _messagingCallsign;
    passcode = String(generatePasscode(callsign));
    logger.log('aprs', 'info', `Using user callsign ${callsign} (passcode auto-computed) for messaging`);
  }

  connect({
    enabled: true,
    callsign,
    passcode,
    server: s.aprs_server || 'rotate.aprs2.net',
    port: parseInt(s.aprs_port) || 14580,
    filterType: s.aprs_filter_type || 'location',
  });
  return true;
}

// ── Outbound beacons ──────────────────────────────────────────────────────────
// Send APRS object beacons for net control stations and course waypoints

function _toAprsLat(deg) {
  const abs = Math.abs(deg), d = Math.floor(abs), m = (abs - d) * 60;
  return `${String(d).padStart(2,'0')}${m.toFixed(2).padStart(5,'0')}${deg >= 0 ? 'N' : 'S'}`;
}
function _toAprsLon(deg) {
  const abs = Math.abs(deg), d = Math.floor(abs), m = (abs - d) * 60;
  return `${String(d).padStart(3,'0')}${m.toFixed(2).padStart(5,'0')}${deg >= 0 ? 'E' : 'W'}`;
}

function sendObjectBeacon(lat, lon, name) {
  if (!socket || !_connected || !currentConfig) return false;
  const from    = currentConfig.callsign;
  const objName = name.slice(0, 9).padEnd(9, ' ');
  const now     = new Date();
  const ts      = String(now.getUTCDate()).padStart(2,'0') +
                  String(now.getUTCHours()).padStart(2,'0') +
                  String(now.getUTCMinutes()).padStart(2,'0') + 'z';
  const packet  = `${from}>APRS,TCPIP*,qAC,${from}:;${objName}*${ts}${_toAprsLat(lat)}/${_toAprsLon(lon)}o${name}\r\n`;
  try {
    socket.write(packet);
    logger.log('aprs', 'info', `Beacon: "${name.trim()}" @ ${lat.toFixed(5)},${lon.toFixed(5)}`);
    return true;
  } catch (e) {
    logger.log('aprs', 'error', `sendObjectBeacon failed: ${e.message}`);
    return false;
  }
}

// ── Outbound messaging ────────────────────────────────────────────────────────
// Send APRS text messages with sequence number ACK tracking

let _msgSeq = 0;

function sendMessage(toCallsign, text, messageId) {
  if (!socket || !_connected) return false;
  _msgSeq = (_msgSeq % 999) + 1;
  const seq = String(_msgSeq).padStart(3, '0');
  const from = currentConfig.callsign;
  const to   = toCallsign.toUpperCase().trim().padEnd(9, ' ');
  const packet = `${from}>APRS,TCPIP*,qAC,${from}::${to}:${text}{${seq}\r\n`;
  try {
    socket.write(packet);
    logger.log('aprs', 'info', `MSG→${toCallsign.trim()}: ${text}`);
    if (messageId) {
      updateMessageStatus(messageId, 'enroute');
      const key = `${toCallsign.toUpperCase().trim()}:${parseInt(seq)}`;
      const timer = setTimeout(() => {
        _pendingAcks.delete(key);
        updateMessageStatus(messageId, 'error');
      }, 60000);
      _pendingAcks.set(key, { messageId, timer });
    }
    return seq;
  } catch (e) {
    logger.log('aprs', 'error', `sendMessage failed: ${e.message}`);
    if (messageId) updateMessageStatus(messageId, 'error');
    return false;
  }
}

// ── State and utility functions ───────────────────────────────────────────────
// Dynamic callsign filter updates, messaging context, filter preview

// Called after participants/personnel roster changes to refresh callsign filter live
function notifyRosterChange() {
  if (!socket || !_connected || !currentConfig) return;
  if (currentConfig.filterType !== 'callsign') return;
  const filterStr = buildCallsignFilter();
  currentConfig.filterStr = filterStr;
  if (filterStr) {
    logger.log('aprs', 'info', `Sending filter update: ${filterStr}`);
    try { socket.write(`#filter ${filterStr}\r\n`); } catch {}
  }
}

// Called on login/logout to set the callsign used for authenticated messaging
function setMessagingCallsign(callsign) {
  _messagingCallsign = callsign ? callsign.toUpperCase().trim() : null;
}

function getActiveCallsign() {
  return currentConfig?.callsign || null;
}

// Compute the preview filter string without connecting (for the admin UI)
function previewFilter(filterType) {
  return buildFilter(filterType);
}

function isConnected() { return _connected; }

module.exports = { connect, connectFromSettings, disconnect, getStatus, isConnected, setWs, notifyRosterChange, previewFilter, sendMessage, sendObjectBeacon, generatePasscode, setMessagingCallsign, getActiveCallsign, processAprsLine: processLine };
