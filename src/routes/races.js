'use strict';

/**
 * Race Management Routes
 *
 * This module handles all HTTP routes related to race management in the RaceTracker application.
 * It provides CRUD operations for races, lifecycle management (activate/deactivate/start/end),
 * cloning functionality, and viewer token management.
 *
 * Key Features:
 * - Race CRUD with participant count aggregation
 * - Race activation/deactivation with MQTT reconnection
 * - Bulk start for tracker-less participants
 * - Race cloning (settings, heats, classes, stations, personnel)
 * - Viewer token generation for public access
 * - Start window management for operators
 */

const express = require('express');
const crypto = require('crypto');
const fs     = require('fs');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const mqttClient = require('../mqtt-client');
const wsManager = require('../websocket');
const logger = require('../logger');
const tileCache = require('../tile-cache');

const router = express.Router();

// ── Offline tile download trigger ─────────────────────────────────────────────

/**
 * Parse track points from a race's assigned course (or legacy track file).
 * Returns [[lat,lon], ...] or null.
 */
function _getTrackPoints(race) {
  try {
    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const text = fs.readFileSync(course.file_path, 'utf8');
        const { parseCourse } = require('./courses');
        const { trackPoints } = parseCourse(text, course.file_path, course.path_index);
        if (trackPoints?.length) return trackPoints;
      }
    }
    if (race.track_file) {
      const text = fs.readFileSync(race.track_file, 'utf8');
      const { parseTrack } = require('./tracks');
      return parseTrack(text, race.track_file, race.track_path_index) || null;
    }
  } catch (e) {
    logger.log('system', 'warn', `[tiles] could not parse course for race ${race.id}: ${e.message}`);
  }
  return null;
}

/**
 * Kick off a background tile download for the given race.
 * Fires-and-forgets; errors are logged inside tileCache.downloadTiles().
 */
function _triggerTileDownload(race) {
  const trackPoints = _getTrackPoints(race);
  if (!trackPoints?.length) {
    logger.log('system', 'warn', `[tiles] race ${race.id}: no track points found, skipping tile download`);
    return;
  }
  tileCache.downloadTiles(race.id, trackPoints).catch(() => {});
}

// Constants for race fields and speed units
const RACE_FIELDS = [
  'name', 'date', 'status', 'time_format', 'clock_seconds', 'geofence_radius', 'checkpoint_radius',
  'off_course_distance', 'stopped_time', 'missing_timer', 'alerts_enabled', 'messaging_enabled',
  'viewer_map_enabled', 'leaderboard_enabled', 'weather_enabled', 'course_id', 'race_format',
  'feat_missing', 'feat_auto_log', 'feat_auto_start', 'feat_off_course', 'feat_stopped',
  'start_time', 'start_clearance', 'mqtt_rf_tech', 'units', 'speed_display', 'tactical_callsign',
  'offline_maps', 'rf_path',
];

const SPEED_UNITS = {
  us_pace: 'min_mile',
  us_speed: 'mph',
  metric_pace: 'min_km',
  metric_speed: 'kmh'
};

/**
 * Fetches a race by ID from the database
 * @param {number} raceId - The race ID to fetch
 * @returns {Object|null} Race object or null if not found
 */
function fetchRace(raceId) {
  return db.prepare('SELECT * FROM races WHERE id = ?').get(raceId);
}

/**
 * Broadcasts a race update to all connected WebSocket clients
 * @param {number} raceId - The race ID that was updated
 * @returns {Object|null} The updated race object or null if not found
 */
function broadcastRaceUpdate(raceId) {
  const updated = fetchRace(raceId);
  if (updated) {
    wsManager.broadcast({ type: 'race_update', data: updated });
  }
  return updated;
}

/**
 * Applies derived fields to a race based on units and speed display settings
 * Calculates and sets the speed_units field for proper display formatting
 * @param {number} raceId - The race ID to update
 */
function applyDerivedFields(raceId) {
  const race = db.prepare('SELECT units, speed_display FROM races WHERE id = ?').get(raceId);
  if (!race) return;

  const key = `${race.units || 'us'}_${race.speed_display || 'pace'}`;
  const speedUnits = SPEED_UNITS[key] || 'min_mile';

  db.prepare('UPDATE races SET speed_units = ? WHERE id = ?').run(speedUnits, raceId);
}

/**
 * GET / - Retrieves all races with participant counts
 * Requires authentication
 * @returns {Object} JSON response with races array
 */
router.get('/', requireAuth, (req, res) => {
  const races = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM participants WHERE race_id = r.id) AS participant_count
    FROM races r
    ORDER BY r.date DESC
  `).all();

  res.json({ ok: true, data: races });
});

/**
 * GET /active - Retrieves the currently active race
 * Requires authentication
 * @returns {Object} JSON response with active race or null
 */
router.get('/active', requireAuth, (req, res) => {
  const race = db.prepare("SELECT * FROM races WHERE status = 'active' LIMIT 1").get();
  res.json({ ok: true, data: race || null });
});

/**
 * GET /:id - Retrieves a specific race by ID
 * Requires authentication
 * @param {number} req.params.id - Race ID
 * @returns {Object} JSON response with race data or 404 error
 */
router.get('/:id', requireAuth, (req, res) => {
  const race = fetchRace(req.params.id);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }
  res.json({ ok: true, data: race });
});

/**
 * POST / - Creates a new race
 * Requires admin role
 * @param {string} req.body.name - Race name (required)
 * @param {string} req.body.date - Race date (required)
 * @returns {Object} JSON response with created race data
 */
router.post('/', requireRole('admin'), (req, res) => {
  const { name, date } = req.body;

  if (!name || !date) {
    return res.status(400).json({ ok: false, error: 'name and date required' });
  }

  const result = db.prepare('INSERT INTO races (name, date) VALUES (?, ?)').run(name, date);
  applyDerivedFields(result.lastInsertRowid);

  const race = db.prepare('SELECT * FROM races WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ok: true, data: race });
});

/**
 * PUT /:id - Updates a race with provided fields
 * Requires admin role
 * @param {number} req.params.id - Race ID
 * @param {Object} req.body - Fields to update (from RACE_FIELDS)
 * @returns {Object} JSON response with updated race data
 */
router.put('/:id', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id = ?').get(req.params.id);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  const updates = {};
  for (const field of RACE_FIELDS) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.json({ ok: true, data: race });
  }

  const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  db.prepare(`UPDATE races SET ${setClause} WHERE id = ?`).run(...Object.values(updates), req.params.id);

  applyDerivedFields(parseInt(req.params.id));

  // Reconnect MQTT if race is active (settings may have changed)
  if (race.status === 'active') {
    mqttClient.connectFromSettings(db);
  }
  mqttClient.invalidateRouteCache(parseInt(req.params.id));

  // Trigger offline tile download when:
  //  (a) offline_maps was just switched ON and a course is assigned, OR
  //  (b) a new course was assigned and offline_maps is already ON
  const updatedRace = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  const courseChanged = updates.course_id !== undefined && updates.course_id != race.course_id;
  const offlineMapsEnabled = updates.offline_maps === 1 && !race.offline_maps;
  if (updatedRace.offline_maps && updatedRace.course_id && (courseChanged || offlineMapsEnabled)) {
    _triggerTileDownload(updatedRace);
  }

  res.json({ ok: true, data: updatedRace });
});

/**
 * DELETE /:id - Deletes a race and cleans up related data
 * Requires admin role. Cannot delete active races.
 * @param {number} req.params.id - Race ID
 * @returns {Object} JSON response confirming deletion
 */
router.delete('/:id', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id = ?').get(req.params.id);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  if (race.status === 'active') {
    return res.status(400).json({ ok: false, error: 'Cannot delete active race. Set to past first.' });
  }

  // Clean up foreign key references manually (no CASCADE on some tables)
  db.transaction(() => {
    db.prepare('UPDATE races SET cloned_from = NULL WHERE cloned_from = ?').run(req.params.id);
    db.prepare('DELETE FROM tracker_positions WHERE race_id = ?').run(req.params.id);
    db.prepare('DELETE FROM races WHERE id = ?').run(req.params.id);
  })();

  res.json({ ok: true });
});

/**
 * POST /:id/activate - Activates a race
 * Requires admin role. Multiple races can be active simultaneously.
 * @param {number} req.params.id - Race ID
 * @returns {Object} JSON response with activation status
 */
router.post('/:id/activate', requireRole('admin'), (req, res) => {
  const race = fetchRace(req.params.id);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  db.prepare("UPDATE races SET status = 'active' WHERE id = ?").run(req.params.id);
  logger.log('race', 'info', `ACTIVATED — ${race.name} (${race.date})`);
  mqttClient.connectFromSettings(db);

  res.json({ ok: true, data: { id: race.id, status: 'active' } });
});

/**
 * POST /:id/deactivate - Deactivates a race (sets to past)
 * Requires admin role
 * @param {number} req.params.id - Race ID
 * @returns {Object} JSON response confirming deactivation
 */
router.post('/:id/deactivate', requireRole('admin'), (req, res) => {
  const race = fetchRace(req.params.id);
  db.prepare("UPDATE races SET status = 'past' WHERE id = ? AND status = 'active'").run(req.params.id);

  if (race) {
    logger.log('race', 'info', `DEACTIVATED — ${race.name}`);
  }

  broadcastRaceUpdate(req.params.id);
  res.json({ ok: true });
});

/**
 * POST /:id/start - Starts a race for tracker-less participants
 * Requires admin or operator role. Stamps current time on participants without trackers.
 * @param {number} req.params.id - Race ID
 * @returns {Object} JSON response with number of participants started
 */
router.post('/:id/start', requireRole('admin', 'operator'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id = ?').get(req.params.id);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE participants SET start_time = ?, status = 'active'
    WHERE race_id = ? AND (tracker_id IS NULL OR tracker_id = '') AND status NOT IN ('dnf', 'finished')
  `).run(now, req.params.id);

  logger.log('race', 'info', `START RACE — ${result.changes} tracker-less participant(s) started at ${new Date(now * 1000).toTimeString().slice(0, 8)}`);
  wsManager.broadcast({ type: 'participant_update', data: { action: 'bulk_update' } });

  res.json({ ok: true, started: result.changes });
});

/**
 * POST /:id/end - Ends a race (sets to past)
 * Requires admin or operator role
 * @param {number} req.params.id - Race ID
 * @returns {Object} JSON response with updated race data
 */
router.post('/:id/end', requireRole('admin', 'operator'), (req, res) => {
  const race = fetchRace(req.params.id);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  db.prepare("UPDATE races SET status = 'past' WHERE id = ?").run(req.params.id);
  logger.log('race', 'info', `ENDED by operator — ${race.name}`);

  const updated = broadcastRaceUpdate(req.params.id);
  res.json({ ok: true, data: updated });
});

/**
 * Clones heats from source race to target race
 * @param {number} sourceRaceId - Source race ID
 * @param {number} targetRaceId - Target race ID
 * @returns {Object} Mapping of old heat IDs to new heat IDs
 */
function cloneHeats(sourceRaceId, targetRaceId) {
  const heatMap = {};
  const heats = db.prepare('SELECT * FROM heats WHERE race_id = ?').all(sourceRaceId);

  for (const heat of heats) {
    const result = db.prepare('INSERT INTO heats (race_id, name, color, shape, start_time) VALUES (?, ?, ?, ?, ?)').run(
      targetRaceId, heat.name, heat.color, heat.shape, heat.start_time ?? null
    );
    heatMap[heat.id] = result.lastInsertRowid;
  }

  return heatMap;
}

/**
 * Clones classes from source race to target race
 * @param {number} sourceRaceId - Source race ID
 * @param {number} targetRaceId - Target race ID
 * @returns {Object} Mapping of old class IDs to new class IDs
 */
function cloneClasses(sourceRaceId, targetRaceId) {
  const classMap = {};
  const classes = db.prepare('SELECT * FROM classes WHERE race_id = ?').all(sourceRaceId);

  for (const cls of classes) {
    const result = db.prepare('INSERT INTO classes (race_id, name) VALUES (?, ?)').run(targetRaceId, cls.name);
    classMap[cls.id] = result.lastInsertRowid;
  }

  return classMap;
}

/**
 * Clones stations from source race to target race
 * @param {number} sourceRaceId - Source race ID
 * @param {number} targetRaceId - Target race ID
 */
function cloneStations(sourceRaceId, targetRaceId) {
  const stations = db.prepare('SELECT * FROM stations WHERE race_id = ? ORDER BY course_order').all(sourceRaceId);

  for (const station of stations) {
    db.prepare('INSERT INTO stations (race_id, name, lat, lon, type, cutoff_time, course_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      targetRaceId, station.name, station.lat, station.lon, station.type, station.cutoff_time, station.course_order
    );
  }
}

/**
 * Clones personnel from source race to target race (without tracker IDs)
 * @param {number} sourceRaceId - Source race ID
 * @param {number} targetRaceId - Target race ID
 */
function clonePersonnel(sourceRaceId, targetRaceId) {
  const personnel = db.prepare('SELECT * FROM personnel WHERE race_id = ?').all(sourceRaceId);

  for (const person of personnel) {
    db.prepare('INSERT INTO personnel (race_id, name, phone) VALUES (?, ?, ?)').run(
      targetRaceId, person.name, person.phone
    );
  }
}

/**
 * POST /:id/clone - Clones a race with all settings, heats, classes, stations, and personnel
 * Requires admin role. Does NOT clone participants.
 * @param {number} req.params.id - Source race ID
 * @param {string} req.body.name - New race name (required)
 * @param {string} req.body.date - New race date (required)
 * @returns {Object} JSON response with cloned race data
 */
router.post('/:id/clone', requireRole('admin'), (req, res) => {
  const sourceRace = db.prepare('SELECT * FROM races WHERE id = ?').get(req.params.id);
  if (!sourceRace) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  const { name, date } = req.body;
  if (!name || !date) {
    return res.status(400).json({ ok: false, error: 'name and date required for clone' });
  }

  // Insert new race with copied settings
  const result = db.prepare(`
    INSERT INTO races (
      name, date, status, time_format, clock_seconds, geofence_radius, off_course_distance,
      stopped_time, missing_timer, alerts_enabled, messaging_enabled, viewer_map_enabled,
      leaderboard_enabled, weather_enabled, course_id, race_format,
      feat_missing, feat_auto_log, feat_auto_start, feat_off_course, feat_stopped,
      start_clearance, cloned_from
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, date, 'upcoming',
    sourceRace.time_format, sourceRace.clock_seconds ?? 1, sourceRace.geofence_radius,
    sourceRace.off_course_distance, sourceRace.stopped_time, sourceRace.missing_timer,
    sourceRace.alerts_enabled, sourceRace.messaging_enabled, sourceRace.viewer_map_enabled,
    sourceRace.leaderboard_enabled, sourceRace.weather_enabled,
    sourceRace.course_id || null, sourceRace.race_format || 'point_to_point',
    sourceRace.feat_missing ?? 1, sourceRace.feat_auto_log ?? 1, sourceRace.feat_auto_start ?? 1,
    sourceRace.feat_off_course ?? 1, sourceRace.feat_stopped ?? 1,
    sourceRace.start_clearance ?? 400, sourceRace.id
  );

  const newRaceId = result.lastInsertRowid;

  // Clone related entities
  cloneHeats(req.params.id, newRaceId);
  cloneClasses(req.params.id, newRaceId);
  cloneStations(req.params.id, newRaceId);
  clonePersonnel(req.params.id, newRaceId);

  const newRace = db.prepare('SELECT * FROM races WHERE id = ?').get(newRaceId);
  res.json({ ok: true, data: newRace });
});

/**
 * POST /:id/viewer-token - Generates a viewer token for public access
 * Requires admin role
 * @param {number} req.params.id - Race ID
 * @returns {Object} JSON response with generated token
 */
router.post('/:id/viewer-token', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id = ?').get(req.params.id);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  const token = crypto.createHash('sha256')
    .update(`${race.name}-${race.date}-${Date.now()}`)
    .digest('hex')
    .substring(0, 16);

  db.prepare('UPDATE races SET viewer_token = ? WHERE id = ?').run(token, req.params.id);
  res.json({ ok: true, data: { token } });
});

/**
 * DELETE /:id/viewer-token - Removes the viewer token
 * Requires admin role
 * @param {number} req.params.id - Race ID
 * @returns {Object} JSON response confirming removal
 */
router.delete('/:id/viewer-token', requireRole('admin'), (req, res) => {
  db.prepare('UPDATE races SET viewer_token = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/**
 * POST /:id/start-window - Opens or closes the operator start window
 * Requires admin or operator role
 * @param {number} req.params.id - Race ID
 * @param {string} req.body.action - 'open' or 'close'
 * @returns {Object} JSON response with updated race data
 */
router.post('/:id/start-window', requireRole('admin', 'operator'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id = ?').get(req.params.id);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  const open = req.body.action !== 'close';
  const now = Math.floor(Date.now() / 1000);

  if (open) {
    db.prepare('UPDATE races SET start_window_open = 1, start_window_ts = ? WHERE id = ?').run(now, req.params.id);
    logger.log('race', 'info', `Start window OPENED by ${req.session.user.username}`);
  } else {
    db.prepare('UPDATE races SET start_window_open = 0 WHERE id = ?').run(req.params.id);
    logger.log('race', 'info', `Start window CLOSED by ${req.session.user.username}`);
  }

  const updated = broadcastRaceUpdate(req.params.id);
  res.json({ ok: true, data: updated });
});

module.exports = router;
