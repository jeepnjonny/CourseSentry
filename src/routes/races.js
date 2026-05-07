'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const mqttClient = require('../mqtt-client');
const wsManager = require('../websocket');
const logger = require('../logger');
const router = express.Router();

const RACE_FIELDS = [
  'name','date','status','time_format','clock_seconds','geofence_radius','checkpoint_radius','off_course_distance',
  'stopped_time','missing_timer','alerts_enabled','messaging_enabled',
  'viewer_map_enabled','leaderboard_enabled','weather_enabled','course_id','race_format',
  'feat_missing','feat_auto_log','feat_auto_start','feat_off_course','feat_stopped',
  'start_time','start_clearance','mqtt_rf_tech','units','speed_display',
  'tactical_callsign',
];

const SPEED_UNITS = {
  us_pace: 'min_mile', us_speed: 'mph',
  metric_pace: 'min_km', metric_speed: 'kmh',
};

function applyDerivedFields(raceId) {
  const r = db.prepare('SELECT units, speed_display FROM races WHERE id=?').get(raceId);
  if (!r) return;
  const su = SPEED_UNITS[`${r.units || 'us'}_${r.speed_display || 'pace'}`] || 'min_mile';
  db.prepare('UPDATE races SET speed_units=? WHERE id=?').run(su, raceId);
}

router.get('/', requireAuth, (req, res) => {
  const races = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM participants WHERE race_id=r.id) as participant_count
    FROM races r ORDER BY r.date DESC
  `).all();
  res.json({ ok: true, data: races });
});

router.get('/active', requireAuth, (req, res) => {
  const race = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
  res.json({ ok: true, data: race || null });
});

router.get('/:id', requireAuth, (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  res.json({ ok: true, data: race });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name, date } = req.body;
  if (!name || !date) return res.status(400).json({ ok: false, error: 'name and date required' });
  const result = db.prepare('INSERT INTO races (name, date) VALUES (?,?)').run(name, date);
  applyDerivedFields(result.lastInsertRowid);
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(result.lastInsertRowid);
  res.json({ ok: true, data: race });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const updates = {};
  for (const f of RACE_FIELDS) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  if (Object.keys(updates).length === 0) return res.json({ ok: true, data: race });

  const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE races SET ${sets} WHERE id=?`).run(...Object.values(updates), req.params.id);

  applyDerivedFields(parseInt(req.params.id));

  // Reconnect MQTT if race is active (settings may have changed)
  if (race.status === 'active') mqttClient.connectFromSettings(db);
  mqttClient.invalidateRouteCache(parseInt(req.params.id));

  res.json({ ok: true, data: db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id) });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  if (race.status === 'active') return res.status(400).json({ ok: false, error: 'Cannot delete active race. Set to past first.' });
  // Some FK references lack ON DELETE CASCADE — clear them manually before deleting
  db.transaction(() => {
    db.prepare('UPDATE races SET cloned_from=NULL WHERE cloned_from=?').run(req.params.id);
    db.prepare('DELETE FROM tracker_positions WHERE race_id=?').run(req.params.id);
    db.prepare('DELETE FROM races WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// Activate a race (multiple races can be active simultaneously)
router.post('/:id/activate', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  db.prepare("UPDATE races SET status='active' WHERE id=?").run(req.params.id);
  logger.log('race', 'info', `ACTIVATED — ${race.name} (${race.date})`);
  mqttClient.connectFromSettings(db);
  res.json({ ok: true, data: { id: race.id, status: 'active' } });
});

router.post('/:id/deactivate', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT name FROM races WHERE id=?').get(req.params.id);
  db.prepare("UPDATE races SET status='past' WHERE id=? AND status='active'").run(req.params.id);
  if (race) logger.log('race', 'info', `DEACTIVATED — ${race.name}`);
  // MQTT stays connected — handlePosition checks for active race before recording data
  const updated = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (updated) wsManager.broadcast({ type: 'race_update', data: updated });
  res.json({ ok: true });
});

// Start a race — stamps current time on all tracker-less participants not yet started/finished
router.post('/:id/start', requireRole('admin', 'operator'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(`
    UPDATE participants SET start_time=?, status='active'
    WHERE race_id=? AND (tracker_id IS NULL OR tracker_id='') AND status NOT IN ('dnf','finished')
  `).run(now, req.params.id);
  logger.log('race', 'info', `START RACE — ${info.changes} tracker-less participant(s) started at ${new Date(now*1000).toTimeString().slice(0,8)}`);
  wsManager.broadcast({ type: 'participant_update', data: { action: 'bulk_update' } });
  res.json({ ok: true, started: info.changes });
});

// End/stop a race (operator or admin) — marks as past, broadcasts race_update
router.post('/:id/end', requireRole('admin', 'operator'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  db.prepare("UPDATE races SET status='past' WHERE id=?").run(req.params.id);
  logger.log('race', 'info', `ENDED by operator — ${race.name}`);
  const updated = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  wsManager.broadcast({ type: 'race_update', data: updated });
  res.json({ ok: true, data: updated });
});

// Clone a race (copies settings, heats, classes, stations; NOT participants)
router.post('/:id/clone', requireRole('admin'), (req, res) => {
  const src = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!src) return res.status(404).json({ ok: false, error: 'Race not found' });

  const { name, date } = req.body;
  if (!name || !date) return res.status(400).json({ ok: false, error: 'name and date required for clone' });

  const newRace = db.prepare(`
    INSERT INTO races (name, date, status, time_format, clock_seconds, geofence_radius, off_course_distance,
      stopped_time, missing_timer, alerts_enabled, messaging_enabled, viewer_map_enabled,
      leaderboard_enabled, weather_enabled, course_id, race_format,
      feat_missing, feat_auto_log, feat_auto_start, feat_off_course, feat_stopped,
      start_clearance, cloned_from)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(name, date, 'upcoming',
    src.time_format, src.clock_seconds ?? 1, src.geofence_radius, src.off_course_distance,
    src.stopped_time, src.missing_timer, src.alerts_enabled, src.messaging_enabled,
    src.viewer_map_enabled, src.leaderboard_enabled, src.weather_enabled,
    src.course_id || null, src.race_format || 'point_to_point',
    src.feat_missing ?? 1, src.feat_auto_log ?? 1, src.feat_auto_start ?? 1,
    src.feat_off_course ?? 1, src.feat_stopped ?? 1,
    src.start_clearance ?? 400, src.id);

  const newId = newRace.lastInsertRowid;

  // Clone heats (mapping old→new ids)
  const heatMap = {};
  for (const h of db.prepare('SELECT * FROM heats WHERE race_id=?').all(src.id)) {
    const r = db.prepare('INSERT INTO heats (race_id, name, color, shape, start_time) VALUES (?,?,?,?,?)').run(newId, h.name, h.color, h.shape, h.start_time ?? null);
    heatMap[h.id] = r.lastInsertRowid;
  }
  // Clone classes
  const classMap = {};
  for (const c of db.prepare('SELECT * FROM classes WHERE race_id=?').all(src.id)) {
    const r = db.prepare('INSERT INTO classes (race_id, name) VALUES (?,?)').run(newId, c.name);
    classMap[c.id] = r.lastInsertRowid;
  }
  // Clone stations
  for (const s of db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY course_order').all(src.id)) {
    db.prepare('INSERT INTO stations (race_id, name, lat, lon, type, cutoff_time, course_order) VALUES (?,?,?,?,?,?,?)')
      .run(newId, s.name, s.lat, s.lon, s.type, s.cutoff_time, s.course_order);
  }
  // Clone personnel (without tracker IDs)
  for (const p of db.prepare('SELECT * FROM personnel WHERE race_id=?').all(src.id)) {
    db.prepare('INSERT INTO personnel (race_id, name, phone) VALUES (?,?,?)').run(newId, p.name, p.phone);
  }

  res.json({ ok: true, data: db.prepare('SELECT * FROM races WHERE id=?').get(newId) });
});

// Generate viewer token
router.post('/:id/viewer-token', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  const token = crypto.createHash('sha256')
    .update(`${race.name}-${race.date}-${Date.now()}`).digest('hex').substring(0, 16);
  db.prepare('UPDATE races SET viewer_token=? WHERE id=?').run(token, req.params.id);
  res.json({ ok: true, data: { token } });
});

router.delete('/:id/viewer-token', requireRole('admin'), (req, res) => {
  db.prepare('UPDATE races SET viewer_token=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Open or close the operator start window
router.post('/:id/start-window', requireRole('admin', 'operator'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  const open = req.body.action !== 'close';
  const now = Math.floor(Date.now() / 1000);
  if (open) {
    db.prepare('UPDATE races SET start_window_open=1, start_window_ts=? WHERE id=?').run(now, req.params.id);
    logger.log('race', 'info', `Start window OPENED by ${req.session.user.username}`);
  } else {
    db.prepare('UPDATE races SET start_window_open=0 WHERE id=?').run(req.params.id);
    logger.log('race', 'info', `Start window CLOSED by ${req.session.user.username}`);
  }
  const updated = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  wsManager.broadcast({ type: 'race_update', data: updated });
  res.json({ ok: true, data: updated });
});

module.exports = router;
