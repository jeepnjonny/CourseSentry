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
  return lines.slice(1).map(line => {
    const vals = parseRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
    return row;
  });
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

// ── Datasource auto-detection ─────────────────────────────────────────────────
function looksLikeMeshtastic(id) {
  // Meshtastic node IDs are 8 hex chars, optionally prefixed with !
  return /^!?[0-9a-f]{8}$/i.test((id || '').trim());
}

function looksLikeAprs(id) {
  const s = (id || '').trim();
  // Standard amateur callsign: 3-7 alphanumeric chars with at least one letter, optional -N SSID
  return /^[A-Z0-9]{3,7}(-\d{1,2})?$/i.test(s) && /[A-Z]/i.test(s) && !/^!/.test(s);
}

function autoDetectDatasources(raceId) {
  try {
    const ids = db.prepare('SELECT tracker_id FROM participants WHERE race_id=? AND tracker_id IS NOT NULL')
      .all(raceId).map(r => r.tracker_id);

    if (ids.some(looksLikeMeshtastic)) {
      const cur = db.prepare("SELECT value FROM settings WHERE key='mqtt_enabled'").get();
      if (cur?.value !== '1') {
        db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('mqtt_enabled','1')").run();
        mqttClient.connectFromSettings(db);
        logger.log('system', 'info', 'MQTT auto-enabled — Meshtastic tracker IDs detected');
      }
    }

    if (ids.some(looksLikeAprs)) {
      const cur = db.prepare("SELECT value FROM settings WHERE key='aprs_enabled'").get();
      if (cur?.value !== '1') {
        db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('aprs_enabled','1')").run();
        aprsClient.connectFromSettings(db);
        logger.log('system', 'info', 'APRS-IS auto-enabled — APRS callsign tracker IDs detected');
      }
    }
  } catch (e) {
    logger.log('system', 'warn', `autoDetectDatasources error: ${e.message}`);
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
  const { bib, name, tracker_id, heat_id, class_id, age, phone, emergency_contact, inreach_url } = req.body;
  if (!bib || !name) return res.status(400).json({ ok: false, error: 'bib and name required' });
  try {
    const result = db.prepare(`
      INSERT INTO participants (race_id, bib, name, tracker_id, heat_id, class_id, age, phone, emergency_contact, inreach_url)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(req.params.raceId, String(bib), name, tracker_id || null, heat_id || null,
           class_id || null, age || null, phone || null, emergency_contact || null, inreach_url || null);
    applyHeatStartTime(result.lastInsertRowid);
    const p = enrichParticipant(db.prepare('SELECT * FROM participants WHERE id=?').get(result.lastInsertRowid));
    wsManager.broadcast({ type: 'participant_update', data: { action: 'add', participant: p } });
    aprsClient.notifyRosterChange();
    if (tracker_id) autoDetectDatasources(req.params.raceId);
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

  const fields = ['bib','name','tracker_id','heat_id','class_id','age','phone','emergency_contact','status','start_time','finish_time','inreach_url'];
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
  if ('tracker_id' in updates) autoDetectDatasources(req.params.raceId);
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

// CSV import: bib, name, tracker_id, heat, class, age, phone, emergency_contact
const stmtUpsertParticipant = db.prepare(`
  INSERT INTO participants (race_id, bib, name, tracker_id, heat_id, class_id, age, phone, emergency_contact)
  VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(race_id, bib) DO UPDATE SET
    name=excluded.name, tracker_id=excluded.tracker_id, heat_id=excluded.heat_id,
    class_id=excluded.class_id, age=excluded.age, phone=excluded.phone,
    emergency_contact=excluded.emergency_contact
`);
const stmtFindHeat  = db.prepare('SELECT id FROM heats WHERE race_id=? AND name=?');
const stmtFindClass = db.prepare('SELECT id FROM classes WHERE race_id=? AND name=?');
const stmtAllParticipants = db.prepare('SELECT * FROM participants WHERE race_id=? ORDER BY CAST(bib AS INTEGER), bib');

router.post('/import', requireRole('admin', 'operator'), (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ ok: false, error: 'csv body required' });
  try {
    const t0 = Date.now();
    const rows = csvParse(csv);
    const raceId = req.params.raceId;
    const errors = [];

    const tx = db.transaction(() => {
      for (const row of rows) {
        if (!row.bib || !row.name) { errors.push(`Row skipped: bib and name required`); continue; }
        const heatId  = row.heat  ? (stmtFindHeat.get(raceId, row.heat.trim())?.id  ?? null) : null;
        const classId = row.class ? (stmtFindClass.get(raceId, row.class.trim())?.id ?? null) : null;
        try {
          stmtUpsertParticipant.run(
            raceId, String(row.bib), row.name,
            row.tracker_id || null, heatId, classId,
            row.age ? parseInt(row.age) : null,
            row.phone || null, row.emergency_contact || null
          );
        } catch (e) { errors.push(`Bib ${row.bib}: ${e.message}`); }
      }
    });
    tx();

    const participants = stmtAllParticipants.all(raceId);
    const ms = Date.now() - t0;
    logger.log('race', errors.length ? 'warn' : 'info',
      `CSV import — ${rows.length} rows → ${participants.length} participants${errors.length ? `, ${errors.length} error(s)` : ''} (${ms}ms)`);
    autoDetectDatasources(raceId);
    res.json({ ok: true, data: participants, errors });
  } catch (e) {
    logger.log('race', 'error', `CSV import failed: ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
