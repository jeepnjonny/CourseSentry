'use strict';
const db         = require('./db');
const logger     = require('./logger');
const aprsClient = require('./aprs-client');
const mqttClient = require('./mqtt-client');

const INTERVAL_MS   = 10 * 60 * 1000; // 10 minutes
const FIRST_FIRE_MS = 30 * 1000;       // 30s after startup to let connections settle

let _timer = null;

function sendBeacons() {
  const race = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
  if (!race) return;

  const name = (race.tactical_callsign || 'Net Control').trim();
  const stn = db.prepare(
    "SELECT lat, lon FROM stations WHERE race_id=? AND type='netcontrol' AND lat IS NOT NULL AND lon IS NOT NULL LIMIT 1"
  ).get(race.id);

  // APRS object beacon — requires a Net Control station with a location
  if (aprsClient.getStatus().connected) {
    if (stn) {
      aprsClient.sendObjectBeacon(stn.lat, stn.lon, name);
    } else {
      logger.log('system', 'info', 'Beacon: APRS connected but no Net Control station with location — skipping APRS beacon');
    }
  }

  // Meshtastic NodeInfo + position — derive a deterministic node ID from operator callsign
  if (mqttClient.getStatus().connected) {
    const callsign = aprsClient.getActiveCallsign() ||
      (db.prepare("SELECT value FROM settings WHERE key='aprs_callsign'").get() || {}).value ||
      'NETCTRL';
    const nodeId = mqttClient.callsignToNodeId(callsign);
    mqttClient.setGatewayNodeId(nodeId);
    mqttClient.sendNodeInfo(name, nodeId).catch(e =>
      logger.log('system', 'error', `NodeInfo beacon failed: ${e.message}`)
    );
    if (stn) {
      mqttClient.sendPositionBeacon(stn.lat, stn.lon, nodeId).catch(e =>
        logger.log('system', 'error', `Position beacon failed: ${e.message}`)
      );
    }
  }
}

function start() {
  if (_timer) return;
  _timer = setInterval(sendBeacons, INTERVAL_MS);
  setTimeout(sendBeacons, FIRST_FIRE_MS);
  logger.log('system', 'info', 'Beacon scheduler started (10-min interval, first fire in 30s)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop };
