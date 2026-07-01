'use strict';

/**
 * Infrastructure network routes.
 * Tracks digipeaters, iGates, repeaters, and standalone beacons for a race —
 * parallel to personnel.js, but for radio infrastructure rather than staff.
 * Nodes can be pre-registered (station + type) before they've ever beaconed,
 * so a fully-silent node is visible as "never seen" rather than invisible.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');
const { getStationRoleAccess } = require('../infra-access');

const router = express.Router({ mergeParams: true });

const NODE_TYPES = ['digipeater', 'igate', 'repeater', 'beacon', 'other'];

// Resolves each node's live location (own GPS if it has beaconed, else its
// assigned station's fixed location) and health (ok / stale / never_seen)
// against the race's missing_timer — the same staleness threshold already
// used elsewhere for personnel/participant trackers, per project convention.
function fetchInfra(raceId, onlyStationId) {
  const race = db.prepare('SELECT missing_timer FROM races WHERE id = ?').get(raceId);
  const missingTimer = race?.missing_timer || 3600;
  const now = Math.floor(Date.now() / 1000);

  let sql = `
    SELECT n.*,
           s.name AS station_name, s.type AS station_type,
           r.long_name, r.short_name, r.battery_level, r.voltage, r.last_seen,
           r.last_lat, r.last_lon, r.rf_tech,
           COALESCE(r.last_lat, s.lat) AS resolved_lat,
           COALESCE(r.last_lon, s.lon) AS resolved_lon,
           CASE WHEN r.last_lat IS NOT NULL THEN 'gps'
                WHEN s.lat IS NOT NULL THEN 'station'
                ELSE NULL END AS location_source
    FROM infra_nodes n
    LEFT JOIN stations s ON n.station_id = s.id
    LEFT JOIN tracker_registry r ON n.node_id IS NOT NULL AND (
      r.node_id = n.node_id OR r.long_name = n.node_id OR r.short_name = n.node_id
    )
    WHERE n.race_id = ?`;
  const params = [raceId];
  if (onlyStationId) {
    sql += ' AND n.station_id = ?';
    params.push(onlyStationId);
  }
  sql += ' ORDER BY n.name';

  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    health: !row.last_seen ? 'never_seen' : (now - row.last_seen > missingTimer ? 'stale' : 'ok'),
  }));
}

router.get('/', requireAuth, (req, res) => {
  const { role, id: userId } = req.session.user;
  const raceId = req.params.raceId;

  if (role === 'admin' || role === 'operator') {
    return res.json({ ok: true, data: fetchInfra(raceId) });
  }

  if (role === 'station') {
    const access = getStationRoleAccess(userId, raceId);
    if (access.full) return res.json({ ok: true, data: fetchInfra(raceId) });
    if (!access.stationId) return res.json({ ok: true, data: [] });
    return res.json({ ok: true, data: fetchInfra(raceId, access.stationId) });
  }

  return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, node_type, node_id, station_id, notes } = req.body;
  if (!name) {
    return res.status(400).json({ ok: false, error: 'name is required' });
  }
  const type = NODE_TYPES.includes(node_type) ? node_type : 'repeater';

  const result = db.prepare(
    'INSERT INTO infra_nodes (race_id, name, node_type, node_id, station_id, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.params.raceId, name, type, node_id || null, station_id || null, notes || null);

  const node = fetchInfra(req.params.raceId).find(n => n.id === result.lastInsertRowid);
  wsManager.broadcastInfra(req.params.raceId, { action: 'add', node });
  res.json({ ok: true, data: node });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const existing = db.prepare('SELECT * FROM infra_nodes WHERE id = ? AND race_id = ?').get(req.params.id, req.params.raceId);
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'infrastructure node not found' });
  }

  const { name, node_type, node_id, station_id, notes } = req.body;
  const type = node_type !== undefined && NODE_TYPES.includes(node_type) ? node_type : existing.node_type;
  db.prepare('UPDATE infra_nodes SET name = ?, node_type = ?, node_id = ?, station_id = ?, notes = ? WHERE id = ?')
    .run(
      name ?? existing.name,
      type,
      node_id !== undefined ? (node_id || null) : existing.node_id,
      station_id !== undefined ? (station_id || null) : existing.station_id,
      notes !== undefined ? notes : existing.notes,
      existing.id
    );

  const node = fetchInfra(req.params.raceId).find(n => n.id === existing.id);
  wsManager.broadcastInfra(req.params.raceId, { action: 'update', node });
  res.json({ ok: true, data: node });
});

router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  const result = db.prepare('DELETE FROM infra_nodes WHERE id = ? AND race_id = ?').run(req.params.id, req.params.raceId);
  if (!result.changes) {
    return res.status(404).json({ ok: false, error: 'infrastructure node not found' });
  }
  wsManager.broadcastInfra(req.params.raceId, { action: 'delete', id: parseInt(req.params.id, 10) });
  res.json({ ok: true });
});

module.exports = router;
