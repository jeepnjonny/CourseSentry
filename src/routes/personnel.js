'use strict';

/**
 * Personnel management routes.
 * Tracks race staff assignments and active devices.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const aprsClient = require('../aprs-client');

const router = express.Router({ mergeParams: true });

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];

  const parseRow = line => {
    const columns = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"' && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          current += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        columns.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    columns.push(current);
    return columns;
  };

  const headers = parseRow(lines[0]).map(header => header.trim());
  return lines.slice(1).map(line => {
    const values = parseRow(line);
    return headers.reduce((row, header, index) => {
      row[header] = (values[index] ?? '').trim();
      return row;
    }, {});
  });
}

function fetchPersonnel(raceId) {
  return db.prepare(`
    SELECT p.*, s.name AS station_name,
           r.last_lat, r.last_lon, r.last_seen,
           u.username AS linked_username
    FROM personnel p
    LEFT JOIN stations s ON p.station_id = s.id
    LEFT JOIN tracker_registry r ON p.tracker_id IS NOT NULL AND (
      r.node_id = p.tracker_id OR r.long_name = p.tracker_id OR r.short_name = p.tracker_id
    )
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.race_id = ?
    ORDER BY s.course_order, p.name
  `).all(raceId);
}

router.get('/', requireAuth, (req, res) => {
  res.json({ ok: true, data: fetchPersonnel(req.params.raceId) });
});

// Called on operator/station page load to auto-link or create this user's personnel record.
// Lookup priority: user_id match → callsign match → create (if callsign set).
router.post('/link-me', requireAuth, (req, res) => {
  const user = req.session.user;
  const fullUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const raceId = req.params.raceId;

  let personnel = db.prepare(
    'SELECT * FROM personnel WHERE user_id = ? AND race_id = ?'
  ).get(user.id, raceId);

  if (personnel) {
    // Fill any gaps from user profile without overwriting existing data
    const updates = {};
    if (!personnel.tracker_id && fullUser.callsign) updates.tracker_id = fullUser.callsign.toUpperCase();
    if (!personnel.phone && fullUser.phone) updates.phone = fullUser.phone;
    if (Object.keys(updates).length) {
      const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE personnel SET ${sets} WHERE id = ?`).run(...Object.values(updates), personnel.id);
      personnel = db.prepare('SELECT * FROM personnel WHERE id = ?').get(personnel.id);
    }
    return res.json({ ok: true, data: personnel });
  }

  if (fullUser.callsign) {
    const cs = fullUser.callsign.toUpperCase();
    personnel = db.prepare(
      'SELECT * FROM personnel WHERE race_id = ? AND (UPPER(tracker_id) = ? OR UPPER(name) = ?)'
    ).get(raceId, cs, cs);

    if (personnel) {
      db.prepare(
        'UPDATE personnel SET user_id = ?, tracker_id = COALESCE(tracker_id, ?), phone = COALESCE(phone, ?) WHERE id = ?'
      ).run(user.id, cs, fullUser.phone || null, personnel.id);
      personnel = db.prepare('SELECT * FROM personnel WHERE id = ?').get(personnel.id);
      return res.json({ ok: true, data: personnel });
    }

    // No match — create a record with no station (operator/rover use case)
    const result = db.prepare(
      'INSERT INTO personnel (race_id, user_id, name, tracker_id, phone, color, shape) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(raceId, user.id, fullUser.callsign, cs,
      fullUser.phone || null, fullUser.color || '#f5a623', fullUser.shape || 'triangle');
    personnel = db.prepare('SELECT * FROM personnel WHERE id = ?').get(result.lastInsertRowid);
    aprsClient.notifyRosterChange();
    return res.json({ ok: true, data: personnel });
  }

  // No callsign — nothing to link
  res.json({ ok: true, data: null });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, station_id, tracker_id, phone, color, shape, is_rover } = req.body;
  if (!name) {
    return res.status(400).json({ ok: false, error: 'name is required' });
  }

  const result = db.prepare(
    'INSERT INTO personnel (race_id, station_id, name, tracker_id, phone, color, shape, is_rover) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    req.params.raceId,
    is_rover ? null : (station_id || null),
    name,
    tracker_id || null,
    phone || null,
    color || '#f5a623',
    shape || 'triangle',
    is_rover ? 1 : 0
  );

  const person = db.prepare(`
    SELECT p.*, s.name AS station_name FROM personnel p
    LEFT JOIN stations s ON p.station_id = s.id WHERE p.id = ?
  `).get(result.lastInsertRowid);

  aprsClient.notifyRosterChange();
  res.json({ ok: true, data: person });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const existing = db.prepare('SELECT * FROM personnel WHERE id = ? AND race_id = ?').get(req.params.id, req.params.raceId);
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'personnel not found' });
  }

  const { name, station_id, tracker_id, phone, color, shape, is_rover } = req.body;
  const roverVal = is_rover !== undefined ? (is_rover ? 1 : 0) : existing.is_rover;
  db.prepare('UPDATE personnel SET name = ?, station_id = ?, tracker_id = ?, phone = ?, color = ?, shape = ?, is_rover = ? WHERE id = ?')
    .run(
      name ?? existing.name,
      roverVal ? null : (station_id !== undefined ? station_id : existing.station_id),
      tracker_id !== undefined ? tracker_id : existing.tracker_id,
      phone !== undefined ? phone : existing.phone,
      color ?? existing.color,
      shape ?? existing.shape,
      roverVal,
      existing.id
    );

  const updated = db.prepare(`
    SELECT p.*, s.name AS station_name FROM personnel p
    LEFT JOIN stations s ON p.station_id = s.id WHERE p.id = ?
  `).get(existing.id);

  aprsClient.notifyRosterChange();
  res.json({ ok: true, data: updated });
});

router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  const result = db.prepare('DELETE FROM personnel WHERE id = ? AND race_id = ?').run(req.params.id, req.params.raceId);
  if (!result.changes) {
    return res.status(404).json({ ok: false, error: 'personnel not found' });
  }
  aprsClient.notifyRosterChange();
  res.json({ ok: true });
});

router.delete('/', requireRole('admin'), (req, res) => {
  try {
    const result = db.prepare('DELETE FROM personnel WHERE race_id = ?').run(req.params.raceId);
    aprsClient.notifyRosterChange();
    res.json({ ok: true, deleted: result.changes });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/import', requireRole('admin', 'operator'), (req, res) => {
  const { csv } = req.body;
  if (!csv) {
    return res.status(400).json({ ok: false, error: 'csv body required' });
  }

  try {
    const rows = parseCsv(csv);
    const raceId = req.params.raceId;
    const insert = db.prepare('INSERT INTO personnel (race_id, station_id, name, tracker_id, phone) VALUES (?, ?, ?, ?, ?)');

    const tx = db.transaction(() => {
      for (const row of rows) {
        if (!row.name) continue;

        let stationId = null;
        if (row.station_name) {
          const station = db.prepare('SELECT id FROM stations WHERE race_id = ? AND name = ?').get(raceId, row.station_name.trim());
          if (station) stationId = station.id;
        }

        insert.run(raceId, stationId, row.name, row.tracker_id || null, row.phone || null);
      }
    });

    tx();
    aprsClient.notifyRosterChange();
    res.json({ ok: true, data: fetchPersonnel(raceId) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

module.exports = router;
