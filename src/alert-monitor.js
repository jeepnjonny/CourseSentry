'use strict';

/**
 * Periodic server-side sweep for missing/stopped trackers.
 *
 * Replaces the client-side checkMissing/checkStopped that used to run only in
 * operator.js (polling every 30s/60s against whichever operator happened to
 * have the tab open) — now every connected admin/operator/station session
 * sees the same alert at the same time, including one that loads the page
 * after the condition already tripped. Lives here rather than in
 * mqtt-client.js because staleness is tracker-source-agnostic: APRS, Spot,
 * InReach, and MQTT/Meshtastic trackers all update the same
 * tracker_registry.last_seen/last_speed columns this sweep reads.
 */
const db = require('./db');
const logger = require('./logger');

const SWEEP_INTERVAL_MS = 30000;

let wsRef = null;
function setWs(ws) { wsRef = ws; }
function broadcast(type, data) { if (wsRef) wsRef.broadcast({ type, data }); }

const _stmt = {
  activeRaces: db.prepare("SELECT * FROM races WHERE status='active'"),
  participants: db.prepare(`
    SELECT p.id, p.bib, p.name, p.status, p.tracker_id, tr.last_seen, tr.last_speed
    FROM participants p
    LEFT JOIN tracker_registry tr ON p.tracker_id = tr.node_id
       OR p.tracker_id = tr.long_name OR p.tracker_id = tr.short_name
    WHERE p.race_id = ?
  `),
};

// participantId-scoped key → the broadcast alert payload, kept so repeat
// sweeps don't re-broadcast every 30s AND so a client connecting after the
// alert already fired (e.g. via sendInit) can still learn about it — the old
// client-side checks recomputed from scratch on every tick so a fresh page
// load caught up within its own next cycle; a one-shot broadcast alone loses
// that. Cleared (with an alert_resolved broadcast) once the underlying
// condition resolves — mirrors the auto-clear behavior the old client-side
// checks had, which SOS/off-course/low-battery alerts don't (those only clear
// via a manual dismiss).
const missingAlerted = new Map();
const stoppedAlerted = new Map();

function resolve(map, key) {
  if (map.has(key)) {
    map.delete(key);
    broadcast('alert_resolved', { key });
  }
}

// Snapshot of every currently-open missing/stopped alert, for sendInit to
// hand to newly-connecting clients so they see ongoing conditions immediately
// instead of only ones that trip after they connect.
function getActiveAlerts() {
  return [...missingAlerted.values(), ...stoppedAlerted.values()];
}

function checkMissing(p, race, now) {
  const key = `missing_${p.id}`;
  if (!p.tracker_id) return resolve(missingAlerted, key); // no GPS signal to go missing
  const missingTimer = race.missing_timer || 3600;
  const lastSeen = p.last_seen || 0;
  if (lastSeen && (now - lastSeen) > missingTimer) {
    if (!missingAlerted.has(key)) {
      const alert = { type: 'missing', key, raceId: race.id, participantId: p.id, bib: p.bib, name: p.name, timestamp: now };
      missingAlerted.set(key, alert);
      logger.log('race', 'warn', `MISSING — ${p.name} (#${p.bib}) no signal for ${Math.floor((now - lastSeen) / 60)} min`);
      broadcast('alert', alert);
    }
  } else {
    resolve(missingAlerted, key);
  }
}

function checkStopped(p, race, now) {
  const key = `stopped_${p.id}`;
  const stoppedTime = race.stopped_time || 600;
  const lastSeen = p.last_seen || 0;
  const lastSpeed = p.last_speed ?? null;
  // Signal too old to judge motion — the missing check covers this case instead.
  if (!lastSeen || (now - lastSeen) > stoppedTime * 3) return resolve(stoppedAlerted, key);
  if (lastSpeed !== null && lastSpeed < 0.5 && (now - lastSeen) > stoppedTime) {
    if (!stoppedAlerted.has(key)) {
      const alert = { type: 'stopped', key, raceId: race.id, participantId: p.id, bib: p.bib, name: p.name, timestamp: now };
      stoppedAlerted.set(key, alert);
      logger.log('race', 'warn', `STOPPED — ${p.name} (#${p.bib}) stationary for ${Math.floor((now - lastSeen) / 60)} min`);
      broadcast('alert', alert);
    }
  } else {
    resolve(stoppedAlerted, key);
  }
}

// Note: unlike the retired client-side checks, this doesn't suppress alerts
// once a participant's route-percent reaches 100% — that needs the course
// track data mqtt-client.js caches per-race for off-course detection, which
// isn't worth importing here. In practice this rarely matters: finishing
// already flips status to 'finished' via the existing finish-geofence
// automation, and the `status !== 'active'` guard below covers that.
function sweep() {
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const race of _stmt.activeRaces.all()) {
      if (!race.feat_missing && !race.feat_stopped) continue;
      for (const p of _stmt.participants.all(race.id)) {
        if (p.status !== 'active') {
          resolve(missingAlerted, `missing_${p.id}`);
          resolve(stoppedAlerted, `stopped_${p.id}`);
          continue;
        }
        if (race.feat_missing) checkMissing(p, race, now);
        if (race.feat_stopped) checkStopped(p, race, now);
      }
    }
  } catch (e) {
    logger.log('system', 'warn', `[alert-monitor] sweep failed: ${e.message}`);
  }
}

// .unref() prevents the interval from keeping the process alive during tests
// or clean shutdowns when no other work is pending (mirrors mqtt-client.js's
// position-pruning timer).
function start() {
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}

module.exports = { start, setWs, getActiveAlerts };
