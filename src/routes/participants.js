'use strict';
const express = require('express');
const db = require('../db');

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
  const rows = lines.slice(1).map(line => {
    const vals = parseRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
    return row;
  });
  return { headers, rows };
}
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');
const aprsClient = require('../aprs-client');
const mqttClient = require('../mqtt-client');
const logger = require('../logger');
const router = express.Router({ mergeParams: true });

// ── Heat start-time propagation ───────────────────────────────────────────────
function applyHeatStartTime(participantId) {
  // If participant has no tracker and no start_time, copy start_time from their heat
  const p = db.prepare('SELECT id, tracker_id, start_time, heat_id FROM participants WHERE id=?').get(participantId);
  if (!p || p.tracker_id || p.start_time) return;
  if (!p.heat_id) return;
  const heat = db.prepare('SELECT start_time FROM heats WHERE id=?').get(p.heat_id);
  if (heat?.start_time) {
    db.prepare('UPDATE participants SET start_time=? WHERE id=?').run(heat.start_time, participantId);
  }
}


const stmtHeat    = db.prepare('SELECT name, color, shape FROM heats WHERE id=?');
const stmtClass   = db.prepare('SELECT name FROM classes WHERE id=?');
const stmtReg     = db.prepare('SELECT last_lat, last_lon, battery_level, last_seen, snr, rssi FROM tracker_registry WHERE node_id=? OR long_name=? OR short_name=?');
const stmtTurnEvt = db.prepare(`
  SELECT 1 FROM events
  WHERE participant_id=? AND race_id=?
  AND station_id IN (SELECT id FROM stations WHERE race_id=? AND type='turnaround')
  LIMIT 1
`);

function enrichParticipant(p) {
  if (!p) return p;
  const heat = p.heat_id  ? stmtHeat.get(p.heat_id)   : null;
  const cls  = p.class_id ? stmtClass.get(p.class_id) : null;
  const reg  = p.tracker_id ? stmtReg.get(p.tracker_id, p.tracker_id, p.tracker_id) : null;
  const has_turnaround = !!(stmtTurnEvt.get(p.id, p.race_id, p.race_id));
  return { ...p, heat, class: cls, tracker: reg, has_turnaround };
}

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM participants WHERE race_id=? ORDER BY CAST(bib AS INTEGER), bib').all(req.params.raceId);
  res.json({ ok: true, data: rows.map(enrichParticipant) });
});

router.get('/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM participants WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!p) return res.status(404).json({ ok: false, error: 'Participant not found' });
  const events = db.prepare(`
    SELECT e.*, s.name as station_name FROM events e
    LEFT JOIN stations s ON e.station_id = s.id
    WHERE e.participant_id=? ORDER BY e.timestamp
  `).all(p.id);
  res.json({ ok: true, data: { ...enrichParticipant(p), events } });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { bib, name, tracker_id, heat_id, class_id, age, phone, emergency_contact, inreach_url,
          spot_feed_id, spot_feed_password } = req.body;
  if (!bib || !name) return res.status(400).json({ ok: false, error: 'bib and name required' });
  try {
    const result = db.prepare(`
      INSERT INTO participants (race_id, bib, name, tracker_id, heat_id, class_id, age, phone, emergency_contact, inreach_url, spot_feed_id, spot_feed_password)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(req.params.raceId, String(bib), name, tracker_id || null, heat_id || null,
           class_id || null, age || null, phone || null, emergency_contact || null, inreach_url || null,
           spot_feed_id || null, spot_feed_password || null);
    applyHeatStartTime(result.lastInsertRowid);
    const p = enrichParticipant(db.prepare('SELECT * FROM participants WHERE id=?').get(result.lastInsertRowid));
    wsManager.broadcast({ type: 'participant_update', data: { action: 'add', participant: p } });
    aprsClient.notifyRosterChange();
    logger.log('race', 'info', `Participant added — #${bib} ${name}`);
    res.json({ ok: true, data: p });
  } catch (e) {
    res.status(409).json({ ok: false, error: 'Bib number already exists in this race' });
  }
});

router.put('/', requireRole('admin', 'operator'), (req, res) => {
  const { ids, field, value } = req.body;
  const allowed = ['heat_id', 'class_id', 'status'];
  if (!Array.isArray(ids) || !ids.length || !allowed.includes(field))
    return res.status(400).json({ ok: false, error: 'ids array and valid field required' });
  const stmt = db.prepare(`UPDATE participants SET ${field}=? WHERE id=? AND race_id=?`);
  const tx = db.transaction(() => { for (const id of ids) stmt.run(value ?? null, id, req.params.raceId); });
  tx();
  wsManager.broadcast({ type: 'participant_update', data: { action: 'bulk_update' } });
  if (field !== 'status') aprsClient.notifyRosterChange();
  logger.log('race', 'info', `Bulk update ${field} on ${ids.length} participant(s)`);
  res.json({ ok: true, updated: ids.length });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const p = db.prepare('SELECT * FROM participants WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!p) return res.status(404).json({ ok: false, error: 'Participant not found' });

  const fields = ['bib','name','tracker_id','heat_id','class_id','age','phone','emergency_contact','status','start_time','finish_time','inreach_url','spot_feed_id','spot_feed_password'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f] === '' ? null : req.body[f];
  }
  if (!Object.keys(updates).length) return res.json({ ok: true, data: enrichParticipant(p) });

  // If a past start_time is being set while status would remain 'dns', auto-activate.
  // This covers the common case of manually entering a start time after the fact.
  const raceId = parseInt(req.params.raceId);
  const now = Math.floor(Date.now() / 1000);
  const settingPastStart = updates.start_time && updates.start_time < now;
  const statusAfter = updates.status || p.status;
  if (settingPastStart && statusAfter === 'dns') {
    updates.status = 'active';
  }

  const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE participants SET ${sets} WHERE id=?`).run(...Object.values(updates), p.id);

  // Synthesize start event when activating without one
  if (updates.status === 'active' && p.status === 'dns') {
    const hasStart = db.prepare(
      `SELECT 1 FROM events WHERE participant_id=? AND race_id=? AND event_type='start' LIMIT 1`
    ).get(p.id, raceId);
    if (!hasStart) {
      const startStn = db.prepare(
        `SELECT * FROM stations WHERE race_id=? AND type IN ('start','start_finish') AND lat IS NOT NULL LIMIT 1`
      ).get(raceId);
      const startTs = updates.start_time || p.start_time || now;
      if (startStn) {
        db.prepare(`INSERT INTO events (race_id, participant_id, event_type, station_id, timestamp, notes, manual)
                    VALUES (?,?,?,?,?,?,1)`)
          .run(raceId, p.id, 'start', startStn.id, startTs, 'manually activated');
      }
    }
  }

  if ('tracker_id' in updates || 'heat_id' in updates) applyHeatStartTime(p.id);
  const updated = enrichParticipant(db.prepare('SELECT * FROM participants WHERE id=?').get(p.id));
  wsManager.broadcast({ type: 'participant_update', data: { action: 'update', participant: updated } });
  aprsClient.notifyRosterChange();
  if (updates.status && updates.status !== p.status) {
    logger.log('race', 'info', `Status change — #${updated.bib} ${updated.name}: ${p.status} → ${updates.status}`);
    if (updates.status === 'finished' || updates.status === 'dnf') {
      setImmediate(() => mqttClient.auditMissedStations(p.id, raceId));
    }
  }
  res.json({ ok: true, data: updated });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const result = db.prepare('DELETE FROM participants WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'Participant not found' });
  wsManager.broadcast({ type: 'participant_update', data: { action: 'delete', id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// Bulk delete all participants for a race
router.delete('/', requireRole('admin'), (req, res) => {
  // Log immediately — before any DB work — so we can tell if the handler is even reached
  logger.log('race', 'info', `CLEAR ALL requested — race ${req.params.raceId} by ${req.session.user.username}`);
  try {
    const t0 = Date.now();
    const pCount    = db.prepare('SELECT COUNT(*) as c FROM participants WHERE race_id=?').get(req.params.raceId)?.c || 0;
    const eventCount = db.prepare('SELECT COUNT(*) as c FROM events WHERE race_id=?').get(req.params.raceId)?.c || 0;
    const posCount  = db.prepare('SELECT COUNT(*) as c FROM tracker_positions WHERE race_id=?').get(req.params.raceId)?.c || 0;
    logger.log('race', 'info', `CLEAR ALL pre-counts — ${pCount} participants, ${eventCount} events, ${posCount} positions`);

    const result = db.prepare('DELETE FROM participants WHERE race_id=?').run(req.params.raceId);
    const ms = Date.now() - t0;
    logger.log('race', 'warn', `All participants deleted — race ${req.params.raceId} (${result.changes} removed, ${eventCount} events cascaded, ${ms}ms)`);
    wsManager.broadcast({ type: 'participant_update', data: { action: 'clear', raceId: req.params.raceId } });
    res.json({ ok: true, deleted: result.changes });
  } catch (e) {
    logger.log('race', 'error', `Bulk delete failed: ${e.message}\n${e.stack}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// CSV import: partial-merge keyed on (race_id, bib).
// Only the columns present in the uploaded CSV header are written, so a later
// `bib,tracker_id` file can pair trackers without wiping name/heat/class/etc.
// Each entry maps a CSV column → its DB column, how to read the row value, and
// the SET clause for each of the two write paths:
//   • `update` — the ON CONFLICT DO UPDATE clause used when the CSV has `name`
//     (so brand-new bibs can also be inserted).
//   • `set`    — a plain UPDATE clause used when the CSV omits `name`. We can't
//     INSERT without a name (NOT NULL), and SQLite evaluates that NOT NULL on the
//     phantom insert row even for rows destined for DO UPDATE — so a name-less
//     file must UPDATE existing bibs only, never upsert.
// SPOT feed columns use COALESCE so a blank cell never wipes a feed ID set
// earlier (in the modal or a prior import).
const IMPORT_COLS = [
  { csv: 'name',              col: 'name',              read: r => r.name || null,                                update: 'name=excluded.name',                                                            set: 'name=?' },
  { csv: 'tracker_id',        col: 'tracker_id',        read: r => r.tracker_id || null,                          update: 'tracker_id=excluded.tracker_id',                                                set: 'tracker_id=?' },
  { csv: 'heat',              col: 'heat_id',           read: (r, raceId) => r.heat  ? (stmtFindHeat.get(raceId, r.heat.trim())?.id   ?? null) : null, update: 'heat_id=excluded.heat_id',   set: 'heat_id=?' },
  { csv: 'class',             col: 'class_id',          read: (r, raceId) => r.class ? (stmtFindClass.get(raceId, r.class.trim())?.id ?? null) : null, update: 'class_id=excluded.class_id', set: 'class_id=?' },
  { csv: 'age',               col: 'age',               read: r => r.age ? parseInt(r.age) : null,                update: 'age=excluded.age',                                                              set: 'age=?' },
  { csv: 'phone',             col: 'phone',             read: r => r.phone || null,                               update: 'phone=excluded.phone',                                                          set: 'phone=?' },
  { csv: 'emergency_contact', col: 'emergency_contact', read: r => r.emergency_contact || null,                   update: 'emergency_contact=excluded.emergency_contact',                                   set: 'emergency_contact=?' },
  { csv: 'spot_feed_id',      col: 'spot_feed_id',      read: r => r.spot_feed_id || null,                        update: 'spot_feed_id=COALESCE(excluded.spot_feed_id, participants.spot_feed_id)',        set: 'spot_feed_id=COALESCE(?, spot_feed_id)' },
  { csv: 'spot_feed_password',col: 'spot_feed_password',read: r => r.spot_feed_password || null,                  update: 'spot_feed_password=COALESCE(excluded.spot_feed_password, participants.spot_feed_password)', set: 'spot_feed_password=COALESCE(?, spot_feed_password)' },
];
const stmtFindHeat  = db.prepare('SELECT id FROM heats WHERE race_id=? AND name=?');
const stmtFindClass = db.prepare('SELECT id FROM classes WHERE race_id=? AND name=?');
const stmtAllParticipants = db.prepare('SELECT * FROM participants WHERE race_id=? ORDER BY CAST(bib AS INTEGER), bib');

router.post('/import', requireRole('admin', 'operator'), (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ ok: false, error: 'csv body required' });
  try {
    const t0 = Date.now();
    const { headers, rows } = csvParse(csv);
    const raceId = req.params.raceId;
    const errors = [];

    // Only patch columns actually present in the CSV header (partial merge).
    const present = IMPORT_COLS.filter(c => headers.includes(c.csv));
    if (!present.length) return res.status(400).json({ ok: false, error: 'CSV has no updatable columns beyond bib' });

    // With a `name` column we can insert brand-new bibs, so use an upsert.
    // Without one we can only patch existing bibs (see IMPORT_COLS note) — a
    // plain UPDATE, and rows whose bib doesn't exist are reported as errors.
    const hasName = present.some(c => c.col === 'name');
    let runRow;
    if (hasName) {
      const insertCols = ['race_id', 'bib', ...present.map(c => c.col)];
      const stmtUpsert = db.prepare(`
        INSERT INTO participants (${insertCols.join(', ')})
        VALUES (${insertCols.map(() => '?').join(',')})
        ON CONFLICT(race_id, bib) DO UPDATE SET ${present.map(c => c.update).join(', ')}
      `);
      runRow = row => stmtUpsert.run(raceId, String(row.bib), ...present.map(c => c.read(row, raceId)));
    } else {
      const stmtUpdate = db.prepare(
        `UPDATE participants SET ${present.map(c => c.set).join(', ')} WHERE race_id=? AND bib=?`
      );
      runRow = row => {
        const info = stmtUpdate.run(...present.map(c => c.read(row, raceId)), raceId, String(row.bib));
        if (info.changes === 0) throw new Error('new participant requires name');
      };
    }

    const tx = db.transaction(() => {
      for (const row of rows) {
        if (!row.bib) { errors.push(`Row skipped: bib required`); continue; }
        try {
          runRow(row);
        } catch (e) { errors.push(`Bib ${row.bib}: ${e.message}`); }
      }
    });
    tx();

    const participants = stmtAllParticipants.all(raceId);
    const ms = Date.now() - t0;
    logger.log('race', errors.length ? 'warn' : 'info',
      `CSV import — ${rows.length} rows → ${participants.length} participants${errors.length ? `, ${errors.length} error(s)` : ''} (${ms}ms)`);
    res.json({ ok: true, data: participants, errors });
  } catch (e) {
    logger.log('race', 'error', `CSV import failed: ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
