'use strict';

/**
 * WebSocket server for real-time dashboard and admin updates.
 * Authenticates users via session or race viewer tokens, broadcasts race state,
 * tracker positions, and system events to connected clients.
 *
 * Maintains separate role-based authorization (admin, operator, viewer).
 */

const WebSocket = require('ws');
const crypto    = require('crypto');
const db        = require('./db');

let wss = null;
const clients = new Set();
let _localTnc = null; // lazy to avoid circular dep
function _tnc() { if (!_localTnc) _localTnc = require('./local-tnc'); return _localTnc; }

// raceId → Set of ws objects for non-viewer authenticated users
const raceOnlineUsers = new Map();

function _resolveConnRaceId(user, reqUrl) {
  if (user.role === 'viewer') return user.raceId || null;
  const rParam = parseInt(new URL(reqUrl, 'http://localhost').searchParams.get('race') || '0') || null;
  if (rParam) return rParam;
  const active = db.prepare("SELECT id FROM races WHERE status='active' LIMIT 1").get();
  return active?.id ?? null;
}

function getOnlineUsers(raceId) {
  const set = raceOnlineUsers.get(raceId);
  if (!set) return [];
  const seen = new Set();
  const result = [];
  for (const ws of set) {
    if (ws.readyState !== 1) continue; // WebSocket.OPEN = 1
    const u = ws.user;
    if (!seen.has(u.username)) {
      seen.add(u.username);
      result.push({ username: u.username, role: u.role });
    }
  }
  return result;
}

function broadcastToRace(raceId, msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1 && ws.raceId === raceId) {
      try { ws.send(str); } catch (e) { clients.delete(ws); }
    }
  }
}

// ── WebSocket server initialization and connection handling ──────────────────
function init(server, sessionMiddleware) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Authenticate via session cookie
    sessionMiddleware(req, {}, () => {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token');
      let user = req.session?.user || null;

      // Viewer auth via race token
      if (!user && token) {
        const race = db.prepare('SELECT id, name FROM races WHERE viewer_token = ?').get(token);
        if (race) {
          user = { role: 'viewer', raceId: race.id };
        }
      }

      if (!user) {
        ws.close(4401, 'Unauthorized');
        return;
      }

      ws.id     = crypto.randomUUID();
      ws.user   = user;
      ws.raceId = _resolveConnRaceId(user, req.url);
      ws.tncActive = false;
      clients.add(ws);

      // Track online presence for authenticated (non-viewer) users
      if (user.role !== 'viewer' && ws.raceId) {
        if (!raceOnlineUsers.has(ws.raceId)) raceOnlineUsers.set(ws.raceId, new Set());
        raceOnlineUsers.get(ws.raceId).add(ws);
        broadcastToRace(ws.raceId, { type: 'users_online', data: getOnlineUsers(ws.raceId) });
      }

      // Send initial state (race data, participants, etc.)
      sendInit(ws, user, req.url);

      // ── Client → server messages ─────────────────────────────────────────
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const { type, data } = msg;

        if (type === 'tnc_connect') {
          // Browser has opened a TNC serial port for this race
          const raceRow = ws.raceId ? db.prepare('SELECT tnc_enabled FROM races WHERE id=?').get(ws.raceId) : null;
          if (!raceRow?.tnc_enabled) {
            require('./logger').log('tnc', 'warn', `TNC connect rejected: tnc_enabled=false for race ${ws.raceId}`);
            return;
          }
          _tnc().register(ws, ws.raceId);
        } else if (type === 'tnc_disconnect') {
          // Browser has closed its TNC serial port
          if (ws.tncActive) { _tnc().unregister(ws.id); ws.tncActive = false; }
        } else if (type === 'local_aprs_rx') {
          // Browser decoded an AX.25 frame from the TNC
          if (ws.tncActive && data) _tnc().handleIncomingFrame(ws, data);
        }
      });

      function cleanup() {
        if (ws.tncActive) { try { _tnc().unregister(ws.id); } catch {} }
        clients.delete(ws);
        if (user.role !== 'viewer' && ws.raceId) {
          const set = raceOnlineUsers.get(ws.raceId);
          if (set) { set.delete(ws); if (!set.size) raceOnlineUsers.delete(ws.raceId); }
          broadcastToRace(ws.raceId, { type: 'users_online', data: getOnlineUsers(ws.raceId) });
        }
      }
      ws.on('close', cleanup);
      ws.on('error', cleanup);
    });
  });

  return wss;
}

// ── Track point extraction and caching ────────────────────────────────────────
// Retrieve course track points for real-time race map visualization
function getTrackPointsForRace(race) {
  const fs = require('fs');
  try {
    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(race.course_id);
      if (course) {
        const text = fs.readFileSync(course.file_path, 'utf8');
        const { parseCourse } = require('./routes/courses');
        const { trackPoints } = parseCourse(text, course.file_path, course.path_index);
        if (trackPoints?.length) return trackPoints;
      }
    }
    if (race.track_file) {
      const text = fs.readFileSync(race.track_file, 'utf8');
      const { parseTrack } = require('./routes/tracks');
      return parseTrack(text, race.track_file, race.track_path_index) || null;
    }
  } catch {}
  return null;
}

// ── Initial state broadcast ───────────────────────────────────────────────────
// Sends complete race state to newly connected clients
function sendInit(ws, user, reqUrl) {
  try {
    const urlRaceId = reqUrl
      ? parseInt(new URL(reqUrl, 'http://localhost').searchParams.get('race') || '0') || null
      : null;

    let raceId, race;
    if (user.role === 'viewer') {
      raceId = user.raceId;
      race = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
    } else if (urlRaceId) {
      raceId = urlRaceId;
      race = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
    } else {
      race = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
      raceId = race?.id ?? null;
    }

    if (!race) {
      send(ws, 'init', { race: null });
      return;
    }

    const participants = db.prepare(`
      SELECT p.*, h.name as heat_name, h.color as heat_color, h.shape as heat_shape,
             c.name as class_name,
             tr.last_lat, tr.last_lon, tr.battery_level, tr.last_seen,
             EXISTS (
               SELECT 1 FROM events e
               JOIN stations s ON e.station_id = s.id
               WHERE e.participant_id = p.id AND e.race_id = p.race_id AND s.type = 'turnaround'
             ) as has_turnaround,
             (SELECT e.station_id FROM events e
              WHERE e.participant_id = p.id AND e.race_id = p.race_id
              AND e.station_id IS NOT NULL
              ORDER BY e.timestamp DESC LIMIT 1) as last_station_id,
             (SELECT e.timestamp FROM events e
              WHERE e.participant_id = p.id AND e.race_id = p.race_id
              AND e.station_id IS NOT NULL
              ORDER BY e.timestamp DESC LIMIT 1) as last_station_ts,
             (SELECT s.name FROM events e JOIN stations s ON e.station_id = s.id
              WHERE e.participant_id = p.id AND e.race_id = p.race_id
              AND e.event_type = 'aid_depart'
              ORDER BY e.timestamp DESC LIMIT 1) as last_station_name
      FROM participants p
      LEFT JOIN heats h ON p.heat_id = h.id
      LEFT JOIN classes c ON p.class_id = c.id
      LEFT JOIN tracker_registry tr ON p.tracker_id = tr.node_id
         OR p.tracker_id = tr.long_name OR p.tracker_id = tr.short_name
      WHERE p.race_id=?
    `).all(raceId);

    const stations = db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY course_order').all(raceId);
    const heats = db.prepare('SELECT * FROM heats WHERE race_id=?').all(raceId);
    const classes = db.prepare('SELECT * FROM classes WHERE race_id=?').all(raceId);
    const registry = db.prepare('SELECT * FROM tracker_registry').all();
    const mqttMod = require('./mqtt-client');
    const aprsMod = require('./aprs-client');
    const trackPoints = getTrackPointsForRace(race);
    const wxRow = db.prepare("SELECT value FROM settings WHERE key='weather_api_key'").get();

    send(ws, 'init', {
      race,
      participants,
      stations,
      heats,
      classes,
      registry,
      trackPoints,
      mqtt:        mqttMod.getStatus(),
      aprs:        aprsMod.getStatus(),
      inreach:     require('./inreach-poller').getStatus(),
      tnc:         (user.role !== 'viewer' && raceId) ? _tnc().getStatus(raceId) : null,
      weatherKey:  (user.role !== 'viewer' || race.weather_enabled) ? (wxRow?.value || null) : null,
      onlineUsers: (user.role !== 'viewer' && raceId) ? getOnlineUsers(raceId) : [],
    });
  } catch (e) {
    require('./logger').log('system', 'error', `WebSocket sendInit error: ${e.message}`);
  }
}

function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(str); } catch (e) { clients.delete(ws); }
    }
  }
}

function broadcastToRole(roles, msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && roles.includes(ws.user?.role)) {
      ws.send(str);
    }
  }
}

function getClientById(id) {
  for (const ws of clients) if (ws.id === id) return ws;
  return null;
}

module.exports = { init, broadcast, broadcastToRole, broadcastToRace, send, getOnlineUsers, getClientById };
