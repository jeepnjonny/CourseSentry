'use strict';

/**
 * Event history routes for race participants and stations.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');
const logger = require('../logger');
const mqttClient = require('../mqtt-client');

const router = express.Router({ mergeParams: true });

function buildEventQuery(filters) {
  const queryParts = [
    'SELECT e.*, p.bib, p.name AS participant_name, s.name AS station_name',
    'FROM events e',
    'LEFT JOIN participants p ON e.participant_id = p.id',
    'LEFT JOIN stations s ON e.station_id = s.id',
    'WHERE e.race_id = ?'
  ];
  const args = [filters.raceId];

  if (filters.participantId) {
    queryParts.push('AND e.participant_id = ?');
    args.push(filters.participantId);
  }
  if (filters.stationId) {
    queryParts.push('AND e.station_id = ?');
    args.push(filters.stationId);
  }

  queryParts.push('ORDER BY e.timestamp DESC');
  if (filters.limit) {
    queryParts.push('LIMIT ?');
    args.push(parseInt(filters.limit, 10));
  }

  return { sql: queryParts.join(' '), args };
}

function updateParticipantStatus(raceId, participantId, eventType, timestamp) {
  if (!participantId) return;

  if (eventType === 'start') {
    db.prepare("UPDATE participants SET status='active', start_time = ? WHERE id = ? AND race_id = ?")
      .run(timestamp, participantId, raceId);
    return;
  }

  if (eventType === 'finish') {
    db.prepare("UPDATE participants SET status='finished', finish_time = ? WHERE id = ? AND race_id = ?")
      .run(timestamp, participantId, raceId);
    setImmediate(() => mqttClient.auditMissedStations(parseInt(participantId, 10), parseInt(raceId, 10)));
    return;
  }

  if (eventType === 'dnf') {
    db.prepare("UPDATE participants SET status='dnf' WHERE id = ? AND race_id = ?")
      .run(participantId, raceId);
    setImmediate(() => mqttClient.auditMissedStations(parseInt(participantId, 10), parseInt(raceId, 10)));
    return;
  }

  if (eventType === 'dns') {
    db.prepare("UPDATE participants SET status='dns' WHERE id = ? AND race_id = ?")
      .run(participantId, raceId);
  }
}

router.get('/', requireAuth, (req, res) => {
  const { participant_id, station_id, limit } = req.query;
  const { sql, args } = buildEventQuery({
    raceId: req.params.raceId,
    participantId: participant_id,
    stationId: station_id,
    limit,
  });

  const events = db.prepare(sql).all(...args);
  res.json({ ok: true, data: events });
});

router.post('/', requireRole('admin', 'operator', 'station'), (req, res) => {
  const { participant_id, event_type, station_id, timestamp, notes } = req.body;
  if (!event_type) {
    return res.status(400).json({ ok: false, error: 'event_type is required' });
  }

  const ts = timestamp || Math.floor(Date.now() / 1000);
  const insertResult = db.prepare(`
    INSERT INTO events (race_id, participant_id, event_type, station_id, timestamp, notes, manual)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(req.params.raceId, participant_id || null, event_type, station_id || null, ts, notes || null);

  updateParticipantStatus(req.params.raceId, participant_id, event_type, ts);

  const readEvent = db.prepare(`
    SELECT e.*, p.bib, p.name AS participant_name, s.name AS station_name
    FROM events e
    LEFT JOIN participants p ON e.participant_id = p.id
    LEFT JOIN stations s ON e.station_id = s.id
    WHERE e.id = ?
  `);

  const event = readEvent.get(insertResult.lastInsertRowid);
  wsManager.broadcastToRace(event.race_id, { type: 'event', data: event });

  // Auto-synthesize a matching aid_arrive if none exists for this participant/station
  let arriveEvent = null;
  if (event_type === 'aid_depart' && participant_id && station_id) {
    const hasArrive = db.prepare(
      'SELECT id FROM events WHERE participant_id = ? AND station_id = ? AND event_type = ?'
    ).get(participant_id, station_id, 'aid_arrive');

    if (!hasArrive) {
      const arriveResult = db.prepare(
        'INSERT INTO events (race_id, participant_id, event_type, station_id, timestamp, notes, manual) VALUES (?, ?, ?, ?, ?, ?, 1)'
      ).run(req.params.raceId, participant_id, 'aid_arrive', station_id, ts, notes || null);
      arriveEvent = readEvent.get(arriveResult.lastInsertRowid);
      wsManager.broadcastToRace(arriveEvent.race_id, { type: 'event', data: arriveEvent });
    }
  }

  const actor = req.session.user?.username || 'unknown';
  const who = event.participant_name ? `#${event.bib} ${event.participant_name}` : '(no participant)';
  const where = event.station_name ? ` @ ${event.station_name}` : '';
  logger.log('race', 'info', `MANUAL ${event_type.toUpperCase()} — ${who}${where} by ${actor}${arriveEvent ? ' (arrive auto-added)' : ''}`);

  res.json({ ok: true, data: event });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND race_id = ?').get(req.params.id, req.params.raceId);
  if (!event) {
    return res.status(404).json({ ok: false, error: 'event not found' });
  }

  const { event_type, station_id, timestamp, notes } = req.body;
  db.prepare('UPDATE events SET event_type = ?, station_id = ?, timestamp = ?, notes = ? WHERE id = ?')
    .run(
      event_type ?? event.event_type,
      station_id !== undefined ? station_id : event.station_id,
      timestamp ?? event.timestamp,
      notes !== undefined ? notes : event.notes,
      event.id
    );

  const updated = db.prepare('SELECT * FROM events WHERE id = ?').get(event.id);
  wsManager.broadcastToRace(updated.race_id, { type: 'event', data: updated });
  res.json({ ok: true, data: updated });
});

router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  const result = db.prepare('DELETE FROM events WHERE id = ? AND race_id = ?').run(req.params.id, req.params.raceId);
  if (!result.changes) {
    return res.status(404).json({ ok: false, error: 'event not found' });
  }
  res.json({ ok: true });
});

module.exports = router;
