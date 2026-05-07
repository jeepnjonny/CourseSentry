'use strict';
const mqtt = require('mqtt');
const crypto = require('crypto');
const protobuf = require('protobufjs');
const path = require('path');
const db = require('./db');
const geo = require('./geo');
const logger = require('./logger');

let protoRoot = null;
let mqttClient = null;
let wsRef = null;
let currentConfig = null;
let _gatewayNodeId = 0; // set from callsignToNodeId() by beacon scheduler

// FNV-1a 32-bit — deterministic Meshtastic node ID derived from a callsign
function callsignToNodeId(callsign) {
  const s = (callsign || 'NETCTRL').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const id = h >>> 0; // unsigned 32-bit
  return (id === 0 || id === 0xffffffff) ? 0x00000001 : id;
}

function setGatewayNodeId(id) { _gatewayNodeId = id >>> 0; }

const PORTNUM = { TEXT: 1, POSITION: 3, NODEINFO: 4, ROUTING: 5, TELEMETRY: 67 };

// packetId → { messageId, timer } — tracks outbound messages waiting for a ROUTING ACK
const _pendingMqttAcks = new Map();

function updateMessageStatus(messageId, status) {
  db.prepare("UPDATE messages SET status=? WHERE id=?").run(status, messageId);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
  if (msg) broadcast('message', msg);
}

function trackMqttMessage(packetId, messageId) {
  const timer = setTimeout(() => {
    if (_pendingMqttAcks.delete(packetId)) {
      updateMessageStatus(messageId, 'timeout');
    }
  }, 60000);
  _pendingMqttAcks.set(packetId >>> 0, { messageId, timer });
}

async function loadProto() {
  if (protoRoot) return protoRoot;
  protoRoot = await protobuf.load(path.join(__dirname, 'proto', 'meshtastic.proto'));
  return protoRoot;
}

function nodeIdHex(num) {
  return '!' + (num >>> 0).toString(16).padStart(8, '0');
}

function normalizeMeshtasticNodeId(rawId) {
  if (!rawId) return null;
  const value = String(rawId).trim();
  if (!value) return null;
  const candidate = value.startsWith('!') ? value.toLowerCase() : `!${value.toLowerCase()}`;
  if (/^![0-9a-f]{8}$/.test(candidate)) return candidate;

  const row = db.prepare(
    `SELECT node_id FROM tracker_registry
     WHERE node_id = ?
       OR upper(long_name) = upper(?)
       OR upper(short_name) = upper(?)`
  ).get(candidate, value, value);

  if (row?.node_id) return row.node_id.startsWith('!') ? row.node_id : `!${row.node_id}`;
  return null;
}

// Meshtastic default channel key — the 8-bit sentinel AQ== (0x01) expands to this.
// Source: Meshtastic firmware channel.cpp defaultpsk[]
const MESH_DEFAULT_KEY = Buffer.from([
  0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59,
  0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x73,
]);

// Meshtastic channel hash: XOR of channel name bytes XOR'd with XOR of all PSK key bytes.
// Stored in MeshPacket.channel so firmware can identify which channel a packet belongs to
// without attempting decryption with every configured PSK.
// Source: Meshtastic firmware Channels::generateHash() in channel.cpp
function channelHash(channelName, pskB64) {
  let h = 0;
  for (const c of (channelName || '')) h ^= c.charCodeAt(0);
  const key = derivePskKey(pskB64);
  if (key) for (const b of key) h ^= b;
  return h & 0xFF;
}

// Returns an AES key Buffer, or null for no-encryption (empty/missing PSK).
// PSK sizes:
//   0-bit (empty)  → null  (no encryption, use decoded field)
//   8-bit (AQ==)   → 16-byte firmware default key
//   128-bit        → AES-128-CTR
//   256-bit        → AES-256-CTR
function derivePskKey(pskB64) {
  if (!pskB64) return null;
  const raw = Buffer.from(pskB64, 'base64');
  if (raw.length === 0) return null;
  if (raw.length === 1 && raw[0] === 1) return MESH_DEFAULT_KEY;
  const keyLen = raw.length >= 32 ? 32 : 16;
  const key = Buffer.alloc(keyLen, 0);
  raw.copy(key, 0, 0, Math.min(raw.length, keyLen));
  return key;
}

function _aesNonce(packetId, fromNode) {
  const nonce = Buffer.alloc(16, 0);
  nonce.writeUInt32LE(packetId >>> 0, 0);
  nonce.writeUInt32LE(fromNode  >>> 0, 8);
  return nonce;
}

// Decrypt Meshtastic encrypted payload. Returns null if no key or decryption fails.
function decryptPayload(encryptedBytes, packetId, fromNode, pskB64) {
  try {
    const key = derivePskKey(pskB64);
    if (!key) return null;
    const algo = key.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr';
    const decipher = crypto.createDecipheriv(algo, key, _aesNonce(packetId, fromNode));
    return Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);
  } catch (e) {
    return null;
  }
}

// Encrypt payload bytes with the current channel PSK. Returns null for no-encryption channels.
function encryptPayload(dataBytes, packetId, fromNode) {
  const key = derivePskKey(currentConfig?.psk ?? null);
  if (!key) return null;
  const algo = key.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr';
  const cipher = crypto.createCipheriv(algo, key, _aesNonce(packetId, fromNode));
  return Buffer.concat([cipher.update(dataBytes), cipher.final()]);
}

// Build a serialized ServiceEnvelope.
// Uses encrypted field when a PSK is configured; decoded field for no-encryption channels.
let _pktCounter = 0;
async function buildEnvelope(from, to, portnum, payloadBytes, opts = {}) {
  const root = await loadProto();
  const Data            = root.lookupType('meshtastic.Data');
  const MeshPacket      = root.lookupType('meshtastic.MeshPacket');
  const ServiceEnvelope = root.lookupType('meshtastic.ServiceEnvelope');

  const packetId = (opts.packetId != null ? opts.packetId : ((Math.floor(Date.now() / 1000) ^ (++_pktCounter & 0xffff)) & 0x7fffffff)) >>> 0;
  const dataMsg  = Data.create({ portnum, payload: payloadBytes });
  const encrypted = encryptPayload(Buffer.from(Data.encode(dataMsg).finish()), packetId, from);

  const hopLimit = opts.hopLimit ?? 3;
  const packet = MeshPacket.create({
    from, to, id: packetId,
    channel: channelHash(currentConfig?.channel ?? '', currentConfig?.psk ?? null), // name XOR + PSK XOR — firmware uses this to find matching channel before attempting decrypt
    ...(encrypted ? { encrypted } : { decoded: dataMsg }),
    wantAck:  opts.wantAck ?? false,
    hopLimit,
    hopStart: hopLimit,   // must equal hopLimit for fresh packets; 0 makes firmware think it's already been relayed
    viaMqtt:  true,
  });
  const envelope = ServiceEnvelope.create({
    packet,
    channelId: currentConfig.channel,
    gatewayId: nodeIdHex(from),
  });
  return Buffer.from(ServiceEnvelope.encode(envelope).finish());
}

function setWs(ws) { wsRef = ws; }

function broadcast(type, data) {
  if (wsRef) wsRef.broadcast({ type, data });
}

// Persist position, update registry, check geofences & alerts
function handlePosition({ nodeId, lat, lon, altitude, speed, heading, snr, rssi, battery, timestamp, rfSource }) {
  if (!nodeId || isNaN(lat) || isNaN(lon)) return;

  // Update registry — battery_level uses COALESCE so a position without battery data
  // doesn't overwrite a previously stored value from a telemetry or position packet.
  db.prepare(`
    INSERT INTO tracker_registry (node_id, last_seen, last_lat, last_lon, last_altitude, last_speed, battery_level, snr, rssi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET
      last_seen=excluded.last_seen, last_lat=excluded.last_lat,
      last_lon=excluded.last_lon, last_altitude=excluded.last_altitude,
      last_speed=excluded.last_speed,
      battery_level=COALESCE(excluded.battery_level, battery_level),
      snr=excluded.snr, rssi=excluded.rssi
  `).run(nodeId, timestamp, lat, lon, altitude ?? null, speed ?? null, battery ?? null, snr ?? null, rssi ?? null);

  // Store position history and run automation for each active race
  const activeRaces = db.prepare("SELECT * FROM races WHERE status='active'").all();
  for (const activeRace of activeRaces) {
    const src = rfSource || activeRace.mqtt_rf_tech || 'meshtastic';
    db.prepare(`
      INSERT INTO tracker_positions (race_id, node_id, lat, lon, altitude, speed, heading, battery, snr, rssi, timestamp, rf_source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(activeRace.id, nodeId, lat, lon, altitude ?? null, speed ?? null, heading ?? null,
           battery ?? null, snr ?? null, rssi ?? null, timestamp, src);

    // Keep only last 500 positions per node per race
    db.prepare(`
      DELETE FROM tracker_positions WHERE id IN (
        SELECT id FROM tracker_positions WHERE race_id=? AND node_id=?
        ORDER BY timestamp DESC LIMIT -1 OFFSET 500
      )
    `).run(activeRace.id, nodeId);

    // Find matching participant
    const participant = findParticipant(nodeId, activeRace.id);
    if (participant) {
      checkGeofences(participant, activeRace, lat, lon, timestamp);
      checkOffCourse(participant, activeRace, lat, lon, timestamp);
      checkBetweenBeaconStations(participant, activeRace, lat, lon, timestamp);
    }

    const personnelMember = findPersonnel(nodeId, activeRace.id);
    if (personnelMember) checkPersonnelStation(personnelMember, activeRace, lat, lon);
  }

  broadcast('position', { nodeId, lat, lon, altitude, speed, heading, battery, snr, rssi, timestamp });
}

function handleTelemetry({ nodeId, battery, voltage, timestamp }) {
  if (!nodeId) return;
  const batteryPct = battery ?? voltageToPct(voltage);
  db.prepare(`
    INSERT INTO tracker_registry (node_id, battery_level, voltage, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET
      battery_level=COALESCE(excluded.battery_level, battery_level),
      voltage=COALESCE(excluded.voltage, voltage),
      last_seen=excluded.last_seen
  `).run(nodeId, batteryPct ?? null, voltage ?? null, timestamp);

  broadcast('tracker_info', { nodeId, battery: batteryPct, voltage, timestamp });

  if (batteryPct != null && batteryPct < 20) {
    const alertKey = nodeId + '_lowbatt';
    const last = lastLowBatteryAlert.get(alertKey) || 0;
    if (timestamp - last > 600) {
      lastLowBatteryAlert.set(alertKey, timestamp);
      const row = db.prepare(`
        SELECT p.id, p.bib, p.name FROM participants p
        WHERE p.tracker_id = ?
        AND p.race_id IN (SELECT id FROM races WHERE status='active')
        LIMIT 1
      `).get(nodeId);
      if (row) {
        logger.log('race', 'warn', `LOW BATTERY — ${row.name} (#${row.bib}) tracker ${nodeId} at ${batteryPct}%`);
        broadcast('alert', { type: 'low_battery', participantId: row.id, bib: row.bib, name: row.name, battery: batteryPct, nodeId, timestamp });
      }
    }
  } else if (batteryPct != null && batteryPct >= 20) {
    lastLowBatteryAlert.delete(nodeId + '_lowbatt');
  }
}

function handleNodeInfo({ nodeId, longName, shortName, hwModel, timestamp }) {
  if (!nodeId || (!longName && !shortName && !hwModel)) return;
  // COALESCE preserves existing names — a message without a field never blanks one out
  db.prepare(`
    INSERT INTO tracker_registry (node_id, long_name, short_name, hw_model, last_seen)
    VALUES (?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET
      long_name=COALESCE(excluded.long_name, long_name),
      short_name=COALESCE(excluded.short_name, short_name),
      hw_model=COALESCE(excluded.hw_model, hw_model),
      last_seen=excluded.last_seen
  `).run(nodeId, longName ?? null, shortName ?? null, hwModel ?? null, timestamp);

  const changed = longName || shortName;
  if (changed) {
    logger.log('mqtt', 'debug', `node info: ${nodeId} → long="${longName}" short="${shortName}"`);
    broadcast('tracker_info', { nodeId, longName, shortName, timestamp });
  }
}

function getDisplayName(nodeId) {
  const reg = db.prepare('SELECT long_name, short_name FROM tracker_registry WHERE node_id=?').get(nodeId);
  return reg ? (reg.long_name || reg.short_name || nodeId) : nodeId;
}

function handleTextMessage({ fromNodeId, toNodeId, text, timestamp }) {
  const activeRaces = db.prepare("SELECT id FROM races WHERE status='active'").all();
  if (!activeRaces.length) return;

  const reg = db.prepare('SELECT long_name, short_name FROM tracker_registry WHERE node_id=?').get(fromNodeId);
  const fromName = reg ? (reg.long_name || reg.short_name || fromNodeId) : fromNodeId;

  // Store message for each active race; use personnel name if sender belongs to that race
  for (const activeRace of activeRaces) {
    const personnel = db.prepare(
      'SELECT name FROM personnel WHERE race_id=? AND tracker_id=? LIMIT 1'
    ).get(activeRace.id, fromNodeId);

    db.prepare(`
      INSERT INTO messages (race_id, direction, from_node_id, to_node_id, from_name, to_name, text, timestamp)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(activeRace.id, 'in', fromNodeId, toNodeId,
           personnel ? personnel.name : fromName, null, text, timestamp);
  }

  broadcast('message', {
    direction: 'in',
    from_node_id: fromNodeId,
    from_name: fromName,
    text,
    timestamp,
  });
}

// Match nodeId (could be !hex, longname, or shortname) to a participant — case-insensitive
function findParticipant(nodeId, raceId) {
  const reg = db.prepare('SELECT long_name, short_name FROM tracker_registry WHERE node_id=?').get(nodeId);
  const ids = [nodeId, reg?.long_name, reg?.short_name].filter(Boolean);
  for (const id of ids) {
    const p = db.prepare(
      'SELECT * FROM participants WHERE race_id=? AND UPPER(tracker_id)=UPPER(?) LIMIT 1'
    ).get(raceId, id);
    if (p) return p;
  }
  return null;
}

function findPersonnel(nodeId, raceId) {
  const reg = db.prepare('SELECT long_name, short_name FROM tracker_registry WHERE node_id=?').get(nodeId);
  const ids = [nodeId, reg?.long_name, reg?.short_name].filter(Boolean);
  for (const id of ids) {
    const p = db.prepare(
      'SELECT * FROM personnel WHERE race_id=? AND UPPER(tracker_id)=UPPER(?) LIMIT 1'
    ).get(raceId, id);
    if (p) return p;
  }
  return null;
}

function checkPersonnelStation(person, race, lat, lon) {
  const radius = race.geofence_radius || 200;
  const stns = db.prepare(
    'SELECT * FROM stations WHERE race_id=? AND lat IS NOT NULL AND lon IS NOT NULL'
  ).all(race.id);
  for (const stn of stns) {
    if (geo.inGeofence(lat, lon, stn.lat, stn.lon, radius)) {
      if (person.station_id === stn.id) return; // already registered here
      db.prepare('UPDATE personnel SET station_id=? WHERE id=?').run(stn.id, person.id);
      const updated = db.prepare(
        'SELECT p.*, s.name as station_name FROM personnel p LEFT JOIN stations s ON p.station_id=s.id WHERE p.id=?'
      ).get(person.id);
      logger.log('system', 'info', `Personnel auto-assign: ${person.name} → ${stn.name}`);
      broadcast('personnel_update', { action: 'update', personnel: updated });
      return;
    }
  }
}

// Geofence check: auto-log station timing events
const recentGeofenceEvents = new Map(); // key: `${participantId}_${stationId}_arrive/depart`

// Insert event, read back full joined row, then broadcast with consistent snake_case schema.
function emitGeofenceEvent(raceId, participant, eventType, station, timestamp) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO events (race_id, participant_id, event_type, station_id, timestamp) VALUES (?,?,?,?,?)'
  ).run(raceId, participant.id, eventType, station.id, timestamp);

  const has_turnaround = !!(db.prepare(`
    SELECT 1 FROM events WHERE participant_id=? AND race_id=?
    AND station_id IN (SELECT id FROM stations WHERE race_id=? AND type='turnaround')
    LIMIT 1`).get(participant.id, raceId, raceId));

  const event = db.prepare(`
    SELECT e.*, p.bib, p.name as participant_name, s.name as station_name
    FROM events e
    LEFT JOIN participants p ON e.participant_id = p.id
    LEFT JOIN stations s ON e.station_id = s.id
    WHERE e.id=?`).get(lastInsertRowid);

  logger.log('race', 'info', `${eventType.toUpperCase()} — ${participant.name} (#${participant.bib}) at ${station.name}`);
  broadcast('event', { ...event, has_turnaround });

  // Trigger audit sweep when participant finishes so any missed stations get backfilled
  if (eventType === 'finish') {
    setImmediate(() => auditMissedStations(participant.id, raceId));
  }
}

function checkGeofences(participant, race, lat, lon, timestamp) {
  // Apply defaults before the guard so null columns (older races) behave the same as enabled.
  const autoStart = race.feat_auto_start ?? 1;
  const autoLog   = race.feat_auto_log   ?? 1;
  if (!autoLog && !autoStart) return;

  const stations = db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY course_order').all(race.id);
  if (!stations.length) return;

  // Pre-find start station so the finish guard can check whether the participant
  // has cleared it. Only applies to 'finish' stations (start_finish is already
  // protected by the turnaround requirement).
  const startStn = stations.find(s => (s.type === 'start' || s.type === 'start_finish') && s.lat && s.lon);
  const startRadius = race.geofence_radius || 15;

  for (const station of stations) {
    if (!station.lat || !station.lon) continue;
    const dist = geo.haversine(lat, lon, station.lat, station.lon);
    const radius = ['start', 'finish', 'start_finish'].includes(station.type)
      ? (race.geofence_radius || 15)
      : (race.checkpoint_radius || 50);
    const inside = dist <= radius;
    const arriveKey = `${participant.id}_${station.id}_arrive`;
    const departKey = `${participant.id}_${station.id}_depart`;

    if (inside && !recentGeofenceEvents.has(arriveKey)) {
      recentGeofenceEvents.set(arriveKey, timestamp);
      setTimeout(() => recentGeofenceEvents.delete(arriveKey), 30000);

      let eventType = null;
      let statusSql = null;
      let statusArgs = null;

      if (station.type === 'start' && participant.status === 'dns') {
        // start fires on depart, not arrive — arriveKey already set above
      } else if (station.type === 'finish' && participant.status === 'active' && autoStart) {
        const clearOfStart = !startStn || !participant.start_time ||
          (timestamp - participant.start_time >= 20 * 60) ||
          geo.haversine(lat, lon, startStn.lat, startStn.lon) > startRadius;
        if (clearOfStart) {
          eventType = 'finish';
          statusSql = "UPDATE participants SET status='finished', finish_time=? WHERE id=?";
          statusArgs = [timestamp, participant.id];
        }
      } else if (station.type === 'start_finish') {
        if (participant.status === 'dns') {
          // start fires on depart, not arrive — arriveKey already set above
        } else if (participant.status === 'active' && autoStart) {
          const hasTurnaround = db.prepare(`
            SELECT 1 FROM events
            WHERE participant_id=? AND race_id=?
            AND station_id IN (SELECT id FROM stations WHERE race_id=? AND type='turnaround')
            LIMIT 1
          `).get(participant.id, race.id, race.id);
          if (hasTurnaround) {
            eventType = 'finish';
            statusSql = "UPDATE participants SET status='finished', finish_time=? WHERE id=?";
            statusArgs = [timestamp, participant.id];
          }
        }
      } else if (autoLog && (station.type === 'turnaround' || station.type === 'aid' || station.type === 'checkpoint')) {
        eventType = 'aid_arrive';
      }
      // netcontrol and repeater: no geofencing

      if (eventType) {
        if (statusSql) db.prepare(statusSql).run(...statusArgs);
        emitGeofenceEvent(race.id, participant, eventType, station, timestamp);
      }

    } else if (!inside && recentGeofenceEvents.has(arriveKey) && !recentGeofenceEvents.has(departKey)) {
      recentGeofenceEvents.set(departKey, timestamp);
      setTimeout(() => recentGeofenceEvents.delete(departKey), 30000);

      const isStartStation = station.type === 'start' ||
        (station.type === 'start_finish' && participant.status === 'dns');

      if (isStartStation && participant.status === 'dns' && autoStart) {
        if (!resolveStartWindow(participant, race, timestamp)) continue;
        db.prepare("UPDATE participants SET status='active', start_time=? WHERE id=?").run(timestamp, participant.id);
        emitGeofenceEvent(race.id, participant, 'start', station, timestamp);
      } else if (!['start', 'finish', 'start_finish'].includes(station.type)) {
        emitGeofenceEvent(race.id, participant, 'aid_depart', station, timestamp);
      }
    }
  }
}

// Track route data in memory for alert calculations
const routeCache = new Map(); // raceId -> { points, meta }

function getRouteData(race) {
  if (routeCache.has(race.id)) return routeCache.get(race.id);
  try {
    const fs = require('fs');
    let trackPoints = null;
    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const raw = fs.readFileSync(course.file_path, 'utf8');
        const { parseCourse } = require('./routes/courses');
        const parsed = parseCourse(raw, course.file_path, course.path_index);
        trackPoints = parsed.trackPoints;
      }
    }
    if (!trackPoints && race.track_file) {
      const raw = fs.readFileSync(race.track_file, 'utf8');
      const { parseTrack } = require('./routes/tracks');
      trackPoints = parseTrack(raw, race.track_file, race.track_path_index);
    }
    if (!trackPoints) return null;
    const meta = geo.buildTrackMeta(trackPoints);
    const data = { points: trackPoints, meta };
    routeCache.set(race.id, data);
    return data;
  } catch { return null; }
}

// Tracks stations already backfilled this session; key = `${participantId}_${stationId}_${pass}`
// pass 1 = outbound, pass 2 = return (OAB only)
const backfilledStationEvents = new Set();
// Last known effective-along per participant: { eff, ts }
const participantPrevEff = new Map();

// Interpolate a timestamp linearly between two anchor points
function interpolateTs(ts0, eff0, ts1, eff1, targetEff) {
  if (eff1 <= eff0) return ts1;
  return Math.round(ts0 + (targetEff - eff0) / (eff1 - eff0) * (ts1 - ts0));
}

// Find surrounding anchors in a sorted [{eff,ts}] array and interpolate
function interpolateFromAnchors(anchors, targetEff) {
  let before = null, after = null;
  for (const a of anchors) {
    if (a.eff <= targetEff && (!before || a.eff > before.eff)) before = a;
    if (a.eff >= targetEff && (!after  || a.eff < after.eff))  after  = a;
  }
  if (!before && !after) return null;
  if (!before) return after.ts;
  if (!after)  return before.ts;
  if (before.eff === after.eff) return before.ts;
  return interpolateTs(before.ts, before.eff, after.ts, after.eff, targetEff);
}

// Insert a backfilled event, read it back, and broadcast
function emitBackfill(raceId, participant, eventType, station, timestamp, note, hasTurnaround) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO events (race_id, participant_id, event_type, station_id, timestamp, notes)
     VALUES (?,?,?,?,?,?)`
  ).run(raceId, participant.id, eventType, station.id, timestamp, note);
  const event = db.prepare(`
    SELECT e.*, p.bib, p.name as participant_name, s.name as station_name
    FROM events e
    LEFT JOIN participants p ON e.participant_id = p.id
    LEFT JOIN stations s ON e.station_id = s.id
    WHERE e.id=?`).get(lastInsertRowid);
  broadcast('event', { ...event, has_turnaround: hasTurnaround });
  return event;
}

// Determine whether auto-start is permitted for this participant right now.
// Priority: heat.start_time > race.start_time > operator start window (45-min auto-close).
// Returns false if nothing is configured — this blocks auto-start until an operator acts.
function resolveStartWindow(participant, race, timestamp) {
  if (participant.heat_id) {
    const heat = db.prepare('SELECT start_time FROM heats WHERE id=?').get(participant.heat_id);
    if (heat?.start_time) return timestamp >= heat.start_time;
  }
  if (race.start_time) return timestamp >= race.start_time;
  if (race.start_window_open && race.start_window_ts) {
    const age = timestamp - race.start_window_ts;
    return age >= 0 && age <= 45 * 60;
  }
  return false;
}

// ── Approach A: between-beacon interval sweep ──────────────────────────────────
// Called on every position update. Checks all stations whose effective along falls
// between the participant's previous beacon position and the current one. This
// naturally handles any speed or beacon rate — even a single beacon covering the
// entire course will catch all stations in the gap.
function checkBetweenBeaconStations(participant, race, lat, lon, timestamp) {
  if (!(race.feat_auto_log ?? 1)) return;

  const route = getRouteData(race);
  if (!route) return;

  const totalDist = route.meta.total;
  const { distanceAlongRoute: currAlong } = geo.findPositionOnRoute(lat, lon, route.points, route.meta);

  const isOAB = race.race_format === 'out_and_back';
  const hasTurnaround = isOAB && !!(db.prepare(`
    SELECT 1 FROM events WHERE participant_id=? AND race_id=?
    AND station_id IN (SELECT id FROM stations WHERE race_id=? AND type='turnaround')
    LIMIT 1
  `).get(participant.id, race.id, race.id));

  // Effective along always increases: 0→totalDist (outbound), totalDist→2*totalDist (return)
  const currEff = (isOAB && hasTurnaround) ? (2 * totalDist - currAlong) : currAlong;

  const prev = participantPrevEff.get(participant.id) || { eff: 0, ts: participant.start_time || timestamp };
  participantPrevEff.set(participant.id, { eff: currEff, ts: timestamp });

  if (currEff <= prev.eff) return; // moved backward or no progress

  // Clearance: don't fire while participant is still inside (or just exiting) a geofence.
  // For start stations a larger threshold (start_clearance) prevents staging-area false positives.
  const clearance      = race.checkpoint_radius || 50;
  const startClearance = race.start_clearance   || 400;

  const stations = db.prepare(
    `SELECT * FROM stations WHERE race_id=? AND type IN ('start','start_finish','aid','checkpoint','turnaround')
     AND lat IS NOT NULL AND lon IS NOT NULL`
  ).all(race.id);

  for (const station of stations) {
    const stationAlong = geo.findPositionOnRoute(
      station.lat, station.lon, route.points, route.meta
    ).distanceAlongRoute;

    const isStart = station.type === 'start' || station.type === 'start_finish';

    // Start stations are outbound-only; aid/checkpoint/turnaround check both legs on OAB
    const passes = (!isStart && isOAB && station.type !== 'turnaround')
      ? [{ eff: stationAlong, pass: 1 }, { eff: 2 * totalDist - stationAlong, pass: 2 }]
      : [{ eff: stationAlong, pass: 1 }];

    for (const { eff: stationEff, pass } of passes) {
      if (isStart) {
        // Start is at eff≈0 — skip the prev.eff guard (0 <= 0 always fails it).
        // Require clearance past the start line AND the start window to be open.
        if (stationEff + startClearance > currEff) continue;
        if (!resolveStartWindow(participant, race, timestamp)) continue;
      } else {
        // Must be in this beacon gap AND far enough past to clear the geofence
        if (stationEff <= prev.eff || stationEff + clearance > currEff) continue;
      }

      const key = `${participant.id}_${station.id}_${pass}`;
      if (backfilledStationEvents.has(key)) continue;
      backfilledStationEvents.add(key);

      if (isStart) {
        const hasStart = db.prepare(
          `SELECT 1 FROM events WHERE participant_id=? AND race_id=? AND event_type='start' LIMIT 1`
        ).get(participant.id, race.id);
        if (hasStart) continue;

        const startTs = participant.start_time
          || interpolateTs(prev.ts, prev.eff, timestamp, currEff, stationEff);
        db.prepare("UPDATE participants SET status='active', start_time=COALESCE(start_time,?) WHERE id=?")
          .run(startTs, participant.id);
        participant.status = 'active';
        if (!participant.start_time) participant.start_time = startTs;

        emitBackfill(race.id, participant, 'start', station, startTs, 'auto-backfilled', false);
        logger.log('race', 'info', `BACKFILL start — ${participant.name} (#${participant.bib})`);
      } else {
        const existingCount = db.prepare(
          `SELECT COUNT(*) as cnt FROM events
           WHERE participant_id=? AND station_id=? AND event_type='aid_depart'`
        ).get(participant.id, station.id).cnt;

        if (pass === 1 && existingCount >= 1) continue;
        if (pass === 2 && existingCount !== 1) continue;

        const stationTs = interpolateTs(prev.ts, prev.eff, timestamp, currEff, stationEff);
        const note = pass === 2 ? 'auto-backfilled (return)' : 'auto-backfilled';
        emitBackfill(race.id, participant, 'aid_depart', station, stationTs, note, hasTurnaround || pass === 2);
        logger.log('race', 'info',
          `BACKFILL depart — ${participant.name} (#${participant.bib}) at ${station.name} pass ${pass}`);
      }
    }
  }
}

// ── Approach B: finish-time audit sweep ───────────────────────────────────────
// Called when a participant finishes or is marked DNF. Uses event timestamps as
// interpolation anchors so missed stations get accurate estimated times even when
// beacon data was sparse. Handles OAB double-passes correctly.
function auditMissedStations(participantId, raceId) {
  if (!participantId) return;

  const participant = db.prepare('SELECT * FROM participants WHERE id=?').get(participantId);
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
  if (!participant || !race || !participant.start_time) return;

  const route = getRouteData(race);
  if (!route) return;

  const totalDist = route.meta.total;
  const isOAB = race.race_format === 'out_and_back';
  const startTs = participant.start_time;

  // Determine upper anchor (finish or last known position)
  let upperEff, upperTs;
  if (participant.finish_time) {
    upperEff = isOAB ? 2 * totalDist : totalDist;
    upperTs  = participant.finish_time;
  } else if (participant.tracker_id) {
    const reg = db.prepare('SELECT last_lat, last_lon, last_seen FROM tracker_registry WHERE node_id=?')
      .get(participant.tracker_id);
    if (!reg?.last_lat || !reg?.last_seen) return;
    const { distanceAlongRoute } = geo.findPositionOnRoute(reg.last_lat, reg.last_lon, route.points, route.meta);
    upperEff = distanceAlongRoute;
    upperTs  = reg.last_seen;
  } else {
    return;
  }

  // Find turnaround event for OAB
  let turnaroundTs = null;
  if (isOAB) {
    const tev = db.prepare(`
      SELECT e.timestamp FROM events e
      JOIN stations s ON e.station_id = s.id
      WHERE e.participant_id=? AND e.race_id=? AND s.type='turnaround'
      ORDER BY e.timestamp LIMIT 1
    `).get(participantId, raceId);
    turnaroundTs = tev?.timestamp ?? Math.round(startTs + (upperTs - startTs) / 2);
  }

  // Build sorted anchor arrays for outbound and (OAB) return legs
  const outboundAnchors = [{ eff: 0, ts: startTs }, ...(isOAB ? [{ eff: totalDist, ts: turnaroundTs }] : [{ eff: upperEff, ts: upperTs }])];
  const returnAnchors  = isOAB ? [{ eff: totalDist, ts: turnaroundTs }, { eff: upperEff, ts: upperTs }] : null;

  // Add existing depart events as interior anchors
  const existing = db.prepare(`
    SELECT e.timestamp, e.station_id, s.lat, s.lon
    FROM events e
    JOIN stations s ON e.station_id = s.id
    WHERE e.participant_id=? AND e.race_id=?
    AND e.event_type='aid_depart' AND s.lat IS NOT NULL
    ORDER BY e.timestamp
  `).all(participantId, raceId);

  for (const ev of existing) {
    const { distanceAlongRoute } = geo.findPositionOnRoute(ev.lat, ev.lon, route.points, route.meta);
    if (isOAB && ev.timestamp > turnaroundTs) {
      returnAnchors.push({ eff: 2 * totalDist - distanceAlongRoute, ts: ev.timestamp });
    } else {
      outboundAnchors.push({ eff: distanceAlongRoute, ts: ev.timestamp });
    }
  }

  outboundAnchors.sort((a, b) => a.eff - b.eff);
  if (returnAnchors) returnAnchors.sort((a, b) => a.eff - b.eff);

  const stations = db.prepare(
    `SELECT * FROM stations WHERE race_id=? AND type IN ('aid','checkpoint','turnaround')
     AND lat IS NOT NULL AND lon IS NOT NULL`
  ).all(raceId);

  for (const station of stations) {
    const stationAlong = geo.findPositionOnRoute(
      station.lat, station.lon, route.points, route.meta
    ).distanceAlongRoute;

    const checks = [{ eff: stationAlong, pass: 1, anchors: outboundAnchors }];
    if (isOAB && station.type !== 'turnaround' && returnAnchors) {
      const retEff = 2 * totalDist - stationAlong;
      if (retEff <= upperEff) checks.push({ eff: retEff, pass: 2, anchors: returnAnchors });
    }

    for (const { eff: stationEff, pass, anchors } of checks) {
      if (stationEff > upperEff) continue; // participant never reached this station

      const key = `${participantId}_${station.id}_${pass}`;
      if (backfilledStationEvents.has(key)) continue;
      backfilledStationEvents.add(key);

      const cnt = db.prepare(
        `SELECT COUNT(*) as cnt FROM events
         WHERE participant_id=? AND station_id=? AND event_type='aid_depart'`
      ).get(participantId, station.id).cnt;

      if (pass === 1 && cnt >= 1) continue;
      if (pass === 2 && cnt !== 1) continue;

      const stationTs = interpolateFromAnchors(anchors, stationEff)
        ?? interpolateTs(startTs, 0, upperTs, upperEff, stationEff);
      const note = pass === 2 ? 'audit-backfill (return)' : 'audit-backfill';

      emitBackfill(raceId, participant, 'aid_depart', station, stationTs, note, isOAB);
      logger.log('race', 'info',
        `AUDIT BACKFILL depart — ${participant.name} (#${participant.bib}) at ${station.name} pass ${pass}`);
    }
  }

  // Synthesize start event if start_time is set but no start event exists
  const hasStart = db.prepare(
    `SELECT 1 FROM events WHERE participant_id=? AND race_id=? AND event_type='start' LIMIT 1`
  ).get(participantId, raceId);
  if (!hasStart) {
    const startStn = db.prepare(
      `SELECT * FROM stations WHERE race_id=? AND type IN ('start','start_finish') AND lat IS NOT NULL LIMIT 1`
    ).get(raceId);
    if (startStn) {
      emitBackfill(raceId, participant, 'start', startStn, startTs, 'audit-backfill', false);
      logger.log('race', 'info', `AUDIT BACKFILL start — ${participant.name} (#${participant.bib})`);
    }
  }
}

const lastOffCourseAlert = new Map();
const lastLowBatteryAlert = new Map();

function voltageToPct(voltage) {
  if (voltage == null) return null;
  // 2S LiPo: 6.0–8.4V; 1S LiPo: 3.0–4.2V
  if (voltage > 4.5) return Math.round(Math.max(0, Math.min(100, (voltage - 6.0) / 2.4 * 100)));
  return Math.round(Math.max(0, Math.min(100, (voltage - 3.0) / 1.2 * 100)));
}

function checkOffCourse(participant, race, lat, lon, timestamp) {
  if (!race.feat_off_course || !race.off_course_distance) return;
  const route = getRouteData(race);
  if (!route) return;
  const { distanceFromRoute } = geo.findPositionOnRoute(lat, lon, route.points, route.meta);
  const alertKey = `${participant.id}_offcourse`;
  if (distanceFromRoute > race.off_course_distance) {
    const last = lastOffCourseAlert.get(alertKey) || 0;
    if (timestamp - last > 120) { // suppress repeat alerts for 2 min
      lastOffCourseAlert.set(alertKey, timestamp);
      logger.log('race', 'warn', `OFF COURSE — ${participant.name} (#${participant.bib}) ${Math.round(distanceFromRoute)}m from route`);
      broadcast('alert', {
        type: 'off_course',
        participantId: participant.id,
        bib: participant.bib,
        name: participant.name,
        distanceFromRoute: Math.round(distanceFromRoute),
        timestamp,
      });
    }
  } else {
    lastOffCourseAlert.delete(alertKey);
  }
}

// Process a decoded JSON-style message object (from MQTT JSON format)
function processJsonMessage(msg) {
  const fromHex = typeof msg.from === 'number' ? nodeIdHex(msg.from) : (msg.sender || msg.from || '');
  if (!fromHex) return;
  const ts = msg.timestamp || Math.floor(Date.now() / 1000);

  // Opportunistically capture node identity from any message that carries it.
  // Meshtastic JSON uses camelCase-free keys: longname/shortname (no underscore).
  // Some firmware and map_report use long_name/short_name. Check both.
  const longName  = msg.long_name  ?? msg.longname
                 ?? msg.payload?.long_name ?? msg.payload?.longname  ?? null;
  const shortName = msg.short_name ?? msg.shortname
                 ?? msg.payload?.short_name ?? msg.payload?.shortname ?? null;
  const hwModel   = msg.hardware   ?? msg.payload?.hardware   ?? null;
  // Only opportunistically capture identity here for message types that don't have a
  // dedicated handleNodeInfo call below — otherwise nodeinfo/map_report would fire twice.
  if ((longName || shortName || hwModel) &&
      msg.type !== 'nodeinfo' && msg.type !== 'map_report') {
    handleNodeInfo({ nodeId: fromHex, longName, shortName, hwModel, timestamp: ts });
  }

  if (msg.type === 'position' && msg.payload) {
    const p = msg.payload;
    const actualNodeId = p.id != null ? (typeof p.id === 'number' ? nodeIdHex(p.id) : p.id) : fromHex;
    const trackerName = getDisplayName(actualNodeId);
    const feederName = getDisplayName(fromHex);
    const viaText = actualNodeId !== fromHex ? ` via ${feederName}` : '';
    logger.log('mqtt', 'info', `position from '${trackerName}'${viaText} on JSON`);
    handlePosition({
      nodeId: actualNodeId,
      lat: (p.latitude_i ?? p.latitude ?? 0) / (p.latitude_i !== undefined ? 1e7 : 1),
      lon: (p.longitude_i ?? p.longitude ?? 0) / (p.longitude_i !== undefined ? 1e7 : 1),
      altitude: p.altitude,
      speed: p.ground_speed,
      heading: p.ground_track,
      battery: p.battery_level ?? null,
      snr: msg.snr,
      rssi: msg.rssi,
      timestamp: ts,
    });
  } else if (msg.type === 'nodeinfo' && msg.payload) {
    const p = msg.payload;
    const actualNodeId = p.id != null ? (typeof p.id === 'number' ? nodeIdHex(p.id) : p.id) : fromHex;
    const displayName = p.longname ?? p.long_name ?? p.shortname ?? p.short_name ?? actualNodeId;
    logger.log('mqtt', 'info', `nodeinfo from '${displayName}' on JSON`);
    handleNodeInfo({ nodeId: actualNodeId,
      longName:  p.longname  ?? p.long_name  ?? null,
      shortName: p.shortname ?? p.short_name ?? null,
      hwModel: p.hardware, timestamp: ts });
  } else if (msg.type === 'map_report' && msg.payload) {
    const p = msg.payload;
    const actualNodeId = p.id != null ? (typeof p.id === 'number' ? nodeIdHex(p.id) : p.id) : fromHex;
    const displayName = p.longname ?? p.long_name ?? p.shortname ?? p.short_name ?? actualNodeId;
    logger.log('mqtt', 'info', `nodeinfo from '${displayName}' on JSON`);
    handleNodeInfo({ nodeId: actualNodeId,
      longName:  p.longname  ?? p.long_name  ?? null,
      shortName: p.shortname ?? p.short_name ?? null,
      hwModel: p.hardware ?? p.hw_model, timestamp: ts });
  } else if (msg.type === 'telemetry' && msg.payload) {
    const p = msg.payload;
    handleTelemetry({ nodeId: fromHex, battery: p.battery_level, voltage: p.voltage, timestamp: ts });
  } else if (msg.type === 'text') {
    const toHex = typeof msg.to === 'number' ? nodeIdHex(msg.to) : (msg.to || '');
    handleTextMessage({ fromNodeId: fromHex, toNodeId: toHex, text: msg.payload, timestamp: ts });
  }
}

// Process decoded protobuf Data object
async function processProtoData(data, fromNode, toNode, snr, rssi) {
  const root = await loadProto();
  const ts = Math.floor(Date.now() / 1000);
  const fromHex = nodeIdHex(fromNode);
  const toHex   = (toNode && toNode !== 0xffffffff) ? nodeIdHex(toNode) : '';

  if (data.portnum === PORTNUM.POSITION) {
    const Position = root.lookupType('meshtastic.Position');
    const pos = Position.decode(data.payload);
    const trackerReg = db.prepare('SELECT long_name, short_name FROM tracker_registry WHERE node_id=?').get(fromHex);
    const trackerName = trackerReg ? (trackerReg.long_name || trackerReg.short_name || fromHex) : fromHex;
    logger.log('mqtt', 'info', `position from '${trackerName}' on protobuf`);
    handlePosition({
      nodeId: fromHex,
      lat: pos.latitudeI / 1e7,
      lon: pos.longitudeI / 1e7,
      altitude: pos.altitude,
      speed: pos.groundSpeed,
      heading: pos.groundTrack,
      snr, rssi, timestamp: pos.time || ts,
    });
  } else if (data.portnum === PORTNUM.TELEMETRY) {
    const Telemetry = root.lookupType('meshtastic.Telemetry');
    const tel = Telemetry.decode(data.payload);
    if (tel.deviceMetrics) {
      handleTelemetry({ nodeId: fromHex, battery: tel.deviceMetrics.batteryLevel, voltage: tel.deviceMetrics.voltage, timestamp: ts });
    }
  } else if (data.portnum === PORTNUM.NODEINFO) {
    const User = root.lookupType('meshtastic.User');
    const user = User.decode(data.payload);
    const trackerReg = db.prepare('SELECT long_name, short_name FROM tracker_registry WHERE node_id=?').get(fromHex);
    const trackerName = trackerReg ? (trackerReg.long_name || trackerReg.short_name || fromHex) : fromHex;
    logger.log('mqtt', 'info', `nodeinfo from '${trackerName}' on protobuf`);
    handleNodeInfo({ nodeId: fromHex, longName: user.longName, shortName: user.shortName, hwModel: user.hwModel, timestamp: ts });
  } else if (data.portnum === PORTNUM.TEXT) {
    handleTextMessage({ fromNodeId: fromHex, toNodeId: toHex, text: data.payload.toString('utf8'), timestamp: ts });
  } else if (data.portnum === PORTNUM.ROUTING) {
    if (data.payload?.length && data.replyId) {
      const replyId = data.replyId >>> 0;
      const pending = _pendingMqttAcks.get(replyId);
      if (pending) {
        clearTimeout(pending.timer);
        _pendingMqttAcks.delete(replyId);
        const Routing = root.lookupType('meshtastic.Routing');
        let errReason = 0;
        try { errReason = Routing.decode(data.payload).errorReason ?? 0; } catch (_) {}
        const newStatus = errReason === 0 ? 'delivered' : 'failed';
        logger.log('mqtt', 'info', `ACK from=${fromHex} replyId=${replyId} err=${errReason} → ${newStatus}`);
        updateMessageStatus(pending.messageId, newStatus);
      }
    }
  }
}

async function handleProtoMessage(payload, psk) {
  const diag = currentConfig?.diagnostic;
  try {
    const root = await loadProto();
    const ServiceEnvelope = root.lookupType('meshtastic.ServiceEnvelope');
    const Data = root.lookupType('meshtastic.Data');
    const envelope = ServiceEnvelope.decode(payload);
    const packet = envelope.packet;
    if (!packet) {
      if (diag) logger.log('mqtt', 'warn', 'proto: no packet in envelope');
      return;
    }

    const fromHex = nodeIdHex(packet.from >>> 0);
    if (diag) logger.log('mqtt', 'debug',
      `proto pkt from=${fromHex} id=${packet.id} decoded=${!!packet.decoded} encLen=${packet.encrypted?.length ?? 0}`);

    // Skip our own echoed transmissions — broker reflects them back on the same topic
    if (_gatewayNodeId && (packet.from >>> 0) === (_gatewayNodeId >>> 0)) return;

    let data;
    // decoded is a message field → null when absent; encrypted is bytes → Uint8Array(0) when absent
    if (packet.decoded && packet.decoded.portnum != null) {
      data = packet.decoded;
    } else if (packet.encrypted && packet.encrypted.length > 0) {
      const decrypted = decryptPayload(Buffer.from(packet.encrypted), packet.id, packet.from, psk);
      if (!decrypted) {
        if (diag) logger.log('mqtt', 'warn', `proto: decrypt failed from=${fromHex} id=${packet.id} psk=${psk}`);
        return;
      }
      try {
        data = Data.decode(decrypted);
      } catch (e) {
        if (diag) logger.log('mqtt', 'warn', `proto: Data.decode failed from=${fromHex}: ${e.message}`);
        return;
      }
    } else {
      if (diag) logger.log('mqtt', 'warn', `proto: packet has neither decoded nor encrypted from=${fromHex}`);
      return;
    }

    if (diag) logger.log('mqtt', 'debug', `proto: portnum=${data.portnum} payloadLen=${data.payload?.length ?? 0} from=${fromHex}`);
    await processProtoData(data, packet.from, packet.to, packet.rxSnr, packet.rxRssi);
  } catch (e) {
    if (diag) logger.log('mqtt', 'warn', `proto: unhandled error: ${e.message}`);
  }
}

function connectFromSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'mqtt_%' OR key='aprs_callsign'").all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!s.mqtt_host) return false;
  // mqtt_enabled defaults to '1' if never set (backward compat)
  if (s.mqtt_enabled === '0') { disconnect(); return false; }
  const protocol = s.mqtt_protocol || 'tcp';
  const defaultPort = protocol === 'ws' ? 9001 : 1883;

  // Derive gateway node ID from the APRS callsign so outbound packets have a valid from address
  // even before the beacon fires. The beacon will call setGatewayNodeId again with the live callsign.
  if (s.aprs_callsign && !_gatewayNodeId) {
    _gatewayNodeId = callsignToNodeId(s.aprs_callsign);
    logger.log('mqtt', 'info', `Gateway node ID: ${nodeIdHex(_gatewayNodeId)} (from callsign ${s.aprs_callsign})`);
  }

  connect({
    host: s.mqtt_host,
    port: parseInt(s.mqtt_port || s.mqtt_port_ws) || defaultPort,
    protocol,
    user: s.mqtt_user || '',
    pass: s.mqtt_pass || '',
    region: s.mqtt_region || 'US',
    channel: s.mqtt_channel || 'LongFast',
    format: s.mqtt_format || 'json',
    psk: s.mqtt_psk ?? 'AQ==',
    diagnostic: s.mqtt_diagnostic === '1',
  });
  return true;
}

function connect(config) {
  disconnect();
  currentConfig = config;
  const proto = config.protocol === 'ws' ? 'ws' : 'mqtt';
  const url = `${proto}://${config.host}:${config.port}`;
  const opts = {
    username: config.user || undefined,
    password: config.pass || undefined,
    reconnectPeriod: 5000,
  };
  const mqttLog = (level, msg) => { console.log(`[mqtt] ${msg}`); logger.log('mqtt', level, msg); };
  mqttLog('info', `Connecting to ${url} as ${config.user || '(anonymous)'}`);
  mqttClient = mqtt.connect(url, opts);

  mqttClient.on('connect', () => {
    mqttLog('info', `Connected to ${url}`);
    // Subscribe to both JSON and encrypted protobuf topic patterns simultaneously
    const jsonTopic = `msh/${config.region}/2/json/${config.channel}/#`;
    const encTopic  = `msh/${config.region}/2/e/${config.channel}/#`;
    [jsonTopic, encTopic].forEach(t => {
      mqttClient.subscribe(t, err => {
        if (err) mqttLog('error', `Subscribe error ${t}: ${err.message}`);
        else mqttLog('info', `Subscribed to ${t}`);
      });
    });
    // Diagnostic catch-all: log every topic for 60s to help identify traffic
    if (config.diagnostic) {
      mqttClient.subscribe('#', err => {
        if (!err) mqttLog('info', 'Diagnostic: subscribed to # (all topics for 60s)');
      });
      setTimeout(() => {
        if (mqttClient?.connected) {
          mqttClient.unsubscribe('#');
          mqttLog('info', 'Diagnostic: unsubscribed from #');
        }
      }, 60000);
    }
    broadcast('mqtt_status', { connected: true, host: config.host, topics: [jsonTopic, encTopic] });
  });

  mqttClient.on('message', async (topic, payload) => {
    if (config.diagnostic) {
      const preview = payload.slice(0, 120).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
      mqttLog('debug', `topic=${topic} len=${payload.length} data=${preview}`);
    }
    try {
      // Detect format from topic path — /2/e/ = encrypted protobuf, /2/json/ = JSON
      if (/\/2\/e\//.test(topic)) {
        await handleProtoMessage(payload, config.psk);
      } else {
        const msg = JSON.parse(payload.toString());
        processJsonMessage(msg);
      }
      broadcast('mqtt_raw', { topic, ts: Date.now() });
    } catch (e) {
      if (config.diagnostic) mqttLog('warn', `Parse error on ${topic}: ${e.message}`);
    }
  });

  mqttClient.on('error', err => {
    mqttLog('error', `Error: ${err.message}`);
    broadcast('mqtt_status', { connected: false, error: err.message });
  });

  mqttClient.on('close', () => {
    mqttLog('info', 'Connection closed');
    broadcast('mqtt_status', { connected: false });
  });
}

function disconnect() {
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }
  currentConfig = null;
  broadcast('mqtt_status', { connected: false, enabled: false });
}

function getStatus() {
  const enabled = !!(currentConfig);
  return { connected: !!(mqttClient && mqttClient.connected), enabled, host: currentConfig?.host || null };
}

// Publish an outbound text message to the channel (broadcast).
// MT firmware 2.5+ rejects channel-PSK unicast DMs received via MQTT ("legacy DM" check) —
// unicast requires Curve25519 PKI encryption which we don't implement. Broadcast bypasses
// the check and is appropriate for race Net Control communications.
async function publishMessage(toNodeId, text, messageId) {
  if (!mqttClient || !mqttClient.connected || !currentConfig) return false;
  const normalized = normalizeMeshtasticNodeId(toNodeId);
  if (!normalized) {
    logger.log('mqtt', 'warn', `publishMessage: invalid Meshtastic node ID "${toNodeId}"`);
    return false;
  }
  const from     = (_gatewayNodeId || 0) >>> 0;
  const to       = 0xffffffff; // broadcast — unicast DMs rejected by MT firmware 2.5+ legacy DM check
  const packetId = ((Math.floor(Date.now() / 1000) ^ (++_pktCounter & 0xffff)) & 0x7fffffff) >>> 0;
  const topic    = `msh/${currentConfig.region}/2/e/${currentConfig.channel}/${nodeIdHex(from)}`;
  try {
    const buf = await buildEnvelope(from, to, PORTNUM.TEXT, Buffer.from(text, 'utf8'), { wantAck: false, packetId });
    mqttClient.publish(topic, buf);
    logger.log('mqtt', 'info', `MSG→${toNodeId} (broadcast) pkt=${packetId}: ${text}`);
    return true;
  } catch (e) {
    logger.log('mqtt', 'error', `publishMessage failed: ${e.message}`);
    return false;
  }
}

async function sendNodeInfo(tacticalCallsign, nodeId) {
  if (!mqttClient || !mqttClient.connected || !currentConfig) return false;
  const from  = (nodeId || _gatewayNodeId || 0) >>> 0;
  const topic = `msh/${currentConfig.region}/2/e/${currentConfig.channel}/${nodeIdHex(from)}`;
  try {
    const root = await loadProto();
    const User = root.lookupType('meshtastic.User');
    const userBytes = User.encode(User.create({
      id: nodeIdHex(from), longName: tacticalCallsign, shortName: 'NC',
      hwModel: 255,  // PRIVATE_HW — required; hw=0 (UNSET) causes firmware to discard the node
    })).finish();
    const buf = await buildEnvelope(from, 0xffffffff, PORTNUM.NODEINFO, Buffer.from(userBytes));
    mqttClient.publish(topic, buf);
    logger.log('mqtt', 'info', `NodeInfo beacon: "${tacticalCallsign}" from ${nodeIdHex(from)}`);
    return true;
  } catch (e) {
    logger.log('mqtt', 'error', `sendNodeInfo failed: ${e.message}`);
    return false;
  }
}

async function sendPositionBeacon(lat, lon, nodeId) {
  if (!mqttClient || !mqttClient.connected || !currentConfig) return false;
  const from  = (nodeId || _gatewayNodeId || 0) >>> 0;
  const topic = `msh/${currentConfig.region}/2/e/${currentConfig.channel}/${nodeIdHex(from)}`;
  const ts    = Math.floor(Date.now() / 1000);
  try {
    const root = await loadProto();
    const Position = root.lookupType('meshtastic.Position');
    const posBytes = Position.encode(Position.create({
      latitudeI: Math.round(lat * 1e7), longitudeI: Math.round(lon * 1e7), time: ts,
    })).finish();
    const buf = await buildEnvelope(from, 0xffffffff, PORTNUM.POSITION, Buffer.from(posBytes));
    mqttClient.publish(topic, buf);
    logger.log('mqtt', 'info', `Position beacon from ${nodeIdHex(from)}: ${lat.toFixed(5)},${lon.toFixed(5)}`);
    return true;
  } catch (e) {
    logger.log('mqtt', 'error', `sendPositionBeacon failed: ${e.message}`);
    return false;
  }
}

function invalidateRouteCache(raceId) {
  routeCache.delete(raceId);
  backfilledStationEvents.clear();
  participantPrevEff.clear();
}

module.exports = { connect, connectFromSettings, disconnect, getStatus, setWs, publishMessage, sendNodeInfo, sendPositionBeacon, callsignToNodeId, setGatewayNodeId, invalidateRouteCache, handlePosition, handleTelemetry, auditMissedStations };
