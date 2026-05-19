'use strict';

/**
 * Station routes for a race.
 * Includes creation, updating, deletion, and route-based ordering.
 */
const express = require('express');
const fs = require('fs');
const db = require('../db');
const geo = require('../geo');
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');

const router = express.Router({ mergeParams: true });

function readRace(raceId) {
  return db.prepare('SELECT * FROM races WHERE id = ?').get(raceId);
}

function loadCourseTrackPoints(race) {
  if (!race.course_id) return null;
  try {
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(race.course_id);
    if (!course) return null;

    const raw = fs.readFileSync(course.file_path, 'utf8');
    const { parseCourse } = require('./courses');
    const parsed = parseCourse(raw, course.file_path, course.path_index);
    return parsed.trackPoints || null;
  } catch (_error) {
    return null;
  }
}

function loadTrackFilePoints(race) {
  if (!race.track_file) return null;
  try {
    const raw = fs.readFileSync(race.track_file, 'utf8');
    const { parseTrack } = require('./tracks');
    return parseTrack(raw, race.track_file, race.track_path_index);
  } catch (_error) {
    return null;
  }
}

function getTrackPoints(raceId) {
  const race = readRace(raceId);
  if (!race) return null;
  return loadCourseTrackPoints(race) || loadTrackFilePoints(race);
}

function reorderStations(raceId) {
  const stations = db.prepare('SELECT * FROM stations WHERE race_id = ?').all(raceId);
  const trackPoints = getTrackPoints(raceId);
  if (!trackPoints || stations.length === 0) return;

  const orderedStations = geo.orderStationsByRoute(stations, trackPoints);
  const update = db.prepare('UPDATE stations SET course_order = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const station of orderedStations) {
      update.run(station.course_order, station.id);
    }
  });
  tx();
}

router.get('/', requireAuth, (req, res) => {
  const stations = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM personnel WHERE station_id = s.id) AS personnel_count
    FROM stations s
    WHERE s.race_id = ?
    ORDER BY s.course_order, s.id
  `).all(req.params.raceId);

  res.json({ ok: true, data: stations });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, lat, lon, type, cutoff_time } = req.body;
  const stationType = type || 'aid';
  const isRover = stationType === 'rover';
  if (!name || (!isRover && (lat === undefined || lon === undefined))) {
    return res.status(400).json({ ok: false, error: 'name, lat, lon are required' });
  }

  const result = db.prepare(
    'INSERT INTO stations (race_id, name, lat, lon, type, cutoff_time) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.params.raceId, name, isRover ? (lat ?? 0) : lat, isRover ? (lon ?? 0) : lon, stationType, cutoff_time || null);

  reorderStations(req.params.raceId);
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(result.lastInsertRowid);
  wsManager.broadcast({ type: 'station_update', data: { action: 'add', station } });

  res.json({ ok: true, data: station });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const existing = db.prepare('SELECT * FROM stations WHERE id = ? AND race_id = ?').get(req.params.id, req.params.raceId);
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'station not found' });
  }

  const { name, lat, lon, type, cutoff_time } = req.body;
  db.prepare('UPDATE stations SET name = ?, lat = ?, lon = ?, type = ?, cutoff_time = ? WHERE id = ?')
    .run(
      name ?? existing.name,
      lat ?? existing.lat,
      lon ?? existing.lon,
      type ?? existing.type,
      cutoff_time ?? existing.cutoff_time,
      existing.id
    );

  reorderStations(req.params.raceId);
  const updated = db.prepare('SELECT * FROM stations WHERE id = ?').get(existing.id);
  wsManager.broadcast({ type: 'station_update', data: { action: 'update', station: updated } });

  res.json({ ok: true, data: updated });
});

// Station users call this on login to register at their station for the session.
// Lookup priority: user_id match → callsign match → create new.
router.post('/:id/assign', requireAuth, (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ? AND race_id = ?')
    .get(req.params.id, req.params.raceId);
  if (!station) return res.status(404).json({ ok: false, error: 'station not found' });

  const user = req.session.user;
  const fullUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  req.session.stationId     = station.id;
  req.session.stationRaceId = parseInt(req.params.raceId, 10);

  let personnel = db.prepare(
    'SELECT * FROM personnel WHERE user_id = ? AND race_id = ?'
  ).get(user.id, req.params.raceId);

  if (personnel) {
    // Known user — update station and fill any gaps from user profile
    const updates = { station_id: station.id };
    if (!personnel.tracker_id && fullUser.callsign) updates.tracker_id = fullUser.callsign.toUpperCase();
    if (!personnel.phone && fullUser.phone) updates.phone = fullUser.phone;
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE personnel SET ${sets} WHERE id = ?`).run(...Object.values(updates), personnel.id);
    personnel = db.prepare('SELECT * FROM personnel WHERE id = ?').get(personnel.id);
  } else if (fullUser.callsign) {
    const cs = fullUser.callsign.toUpperCase();
    // Try callsign match anywhere in this race (user may have been pre-added)
    personnel = db.prepare(
      'SELECT * FROM personnel WHERE race_id = ? AND (UPPER(tracker_id) = ? OR UPPER(name) = ?)'
    ).get(req.params.raceId, cs, cs);

    if (personnel) {
      db.prepare(
        'UPDATE personnel SET user_id = ?, station_id = ?, tracker_id = COALESCE(tracker_id, ?) WHERE id = ?'
      ).run(user.id, station.id, cs, personnel.id);
      personnel = db.prepare('SELECT * FROM personnel WHERE id = ?').get(personnel.id);
    } else {
      const result = db.prepare(
        'INSERT INTO personnel (race_id, station_id, user_id, name, tracker_id, phone, color, shape) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.params.raceId, station.id, user.id,
        fullUser.callsign, cs,
        fullUser.phone || null,
        fullUser.color || '#f5a623',
        fullUser.shape || 'triangle');
      personnel = db.prepare('SELECT * FROM personnel WHERE id = ?').get(result.lastInsertRowid);
    }
  }

  res.json({ ok: true, data: { station, personnel } });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const station = db.prepare('SELECT id FROM stations WHERE id = ? AND race_id = ?').get(req.params.id, req.params.raceId);
  if (!station) {
    return res.status(404).json({ ok: false, error: 'station not found' });
  }

  db.prepare('UPDATE events SET station_id = NULL WHERE station_id = ?').run(req.params.id);
  db.prepare('DELETE FROM stations WHERE id = ?').run(req.params.id);
  wsManager.broadcast({ type: 'station_update', data: { action: 'delete', id: parseInt(req.params.id, 10) } });

  res.json({ ok: true });
});

router.post('/seed', requireRole('admin'), (req, res) => {
  const { waypoints } = req.body;
  if (!Array.isArray(waypoints) || waypoints.length === 0) {
    return res.status(400).json({ ok: false, error: 'waypoints array required' });
  }

  const insert = db.prepare('INSERT INTO stations (race_id, name, lat, lon, type) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction(() => {
    for (const waypoint of waypoints) {
      insert.run(req.params.raceId, waypoint.name, parseFloat(waypoint.lat), parseFloat(waypoint.lon), waypoint.type || 'aid');
    }
  });

  tx();
  reorderStations(req.params.raceId);
  const stations = db.prepare('SELECT * FROM stations WHERE race_id = ? ORDER BY course_order').all(req.params.raceId);
  res.json({ ok: true, data: stations });
});

module.exports = router;
