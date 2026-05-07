'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const aprsClient = require('../aprs-client');
const router = express.Router({ mergeParams: true });

function csvParse(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const parseRow = line => {
    const cols = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { cols.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    cols.push(cur);
    return cols;
  };
  const headers = parseRow(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = parseRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
    return row;
  });
}

function fetchPersonnel(raceId) {
  return db.prepare(`
    SELECT p.*, s.name as station_name,
           r.last_lat, r.last_lon, r.last_seen
    FROM personnel p
    LEFT JOIN stations s ON p.station_id = s.id
    LEFT JOIN tracker_registry r ON p.tracker_id IS NOT NULL AND (
      r.node_id = p.tracker_id OR r.long_name = p.tracker_id OR r.short_name = p.tracker_id
    )
    WHERE p.race_id=? ORDER BY s.course_order, p.name
  `).all(raceId);
}

router.get('/', requireAuth, (req, res) => {
  res.json({ ok: true, data: fetchPersonnel(req.params.raceId) });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, station_id, tracker_id, phone, color, shape } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const result = db.prepare(
    'INSERT INTO personnel (race_id, station_id, name, tracker_id, phone, color, shape) VALUES (?,?,?,?,?,?,?)'
  ).run(req.params.raceId, station_id || null, name, tracker_id || null, phone || null,
        color || '#f5a623', shape || 'triangle');
  const person = db.prepare(`
    SELECT p.*, s.name as station_name FROM personnel p
    LEFT JOIN stations s ON p.station_id = s.id WHERE p.id=?
  `).get(result.lastInsertRowid);
  aprsClient.notifyRosterChange();
  res.json({ ok: true, data: person });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const p = db.prepare('SELECT * FROM personnel WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!p) return res.status(404).json({ ok: false, error: 'Personnel not found' });
  const { name, station_id, tracker_id, phone, color, shape } = req.body;
  db.prepare('UPDATE personnel SET name=?, station_id=?, tracker_id=?, phone=?, color=?, shape=? WHERE id=?')
    .run(name ?? p.name,
         station_id !== undefined ? station_id : p.station_id,
         tracker_id !== undefined ? tracker_id : p.tracker_id,
         phone !== undefined ? phone : p.phone,
         color ?? p.color,
         shape ?? p.shape,
         p.id);
  const updated = db.prepare(`
    SELECT p.*, s.name as station_name FROM personnel p
    LEFT JOIN stations s ON p.station_id = s.id WHERE p.id=?
  `).get(p.id);
  aprsClient.notifyRosterChange();
  res.json({ ok: true, data: updated });
});

router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  const result = db.prepare('DELETE FROM personnel WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'Personnel not found' });
  aprsClient.notifyRosterChange();
  res.json({ ok: true });
});

router.delete('/', requireRole('admin'), (req, res) => {
  try {
    const result = db.prepare('DELETE FROM personnel WHERE race_id=?').run(req.params.raceId);
    aprsClient.notifyRosterChange();
    res.json({ ok: true, deleted: result.changes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/import', requireRole('admin', 'operator'), (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ ok: false, error: 'csv body required' });
  try {
    const rows = csvParse(csv);
    const raceId = req.params.raceId;
    const tx = db.transaction(() => {
      for (const row of rows) {
        if (!row.name) continue;
        let stationId = null;
        if (row.station_name) {
          const s = db.prepare('SELECT id FROM stations WHERE race_id=? AND name=?').get(raceId, row.station_name.trim());
          if (s) stationId = s.id;
        }
        db.prepare('INSERT INTO personnel (race_id, station_id, name, tracker_id, phone) VALUES (?,?,?,?,?)')
          .run(raceId, stationId, row.name, row.tracker_id || null, row.phone || null);
      }
    });
    tx();
    aprsClient.notifyRosterChange();
    res.json({ ok: true, data: fetchPersonnel(raceId) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
