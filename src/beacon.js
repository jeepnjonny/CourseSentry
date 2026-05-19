'use strict';

/**
 * Periodic beacon scheduler.
 * Sends position and node info beacons to APRS and MQTT every 10 minutes.
 */
const db = require('./db');
const logger = require('./logger');
const aprsClient = require('./aprs-client');
const localTnc   = require('./local-tnc');
const mqttClient = require('./mqtt-client');

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const FIRST_FIRE_MS = 30 * 1000;   // 30s after startup to let connections settle

let _timer = null;

function getNetControlStation(raceId) {
  return db.prepare(`
    SELECT lat, lon FROM stations
    WHERE race_id = ? AND type = 'netcontrol'
    AND lat IS NOT NULL AND lon IS NOT NULL
    LIMIT 1
  `).get(raceId);
}

function sendBeacons() {
  const races = db.prepare("SELECT * FROM races WHERE status = 'active'").all();
  if (!races.length) return;

  const callsign = aprsClient.getActiveCallsign() ||
    (db.prepare("SELECT value FROM settings WHERE key = 'aprs_callsign'").get() || {}).value ||
    'NETCTRL';
  const nodeId = mqttClient.callsignToNodeId(callsign);
  mqttClient.setGatewayNodeId(nodeId);

  for (const race of races) {
    const name = (race.tactical_callsign || 'Net Control').trim();
    const station = getNetControlStation(race.id);

    // Send beacon via APRS-IS if connected
    if (aprsClient.getStatus().connected) {
      if (station) {
        aprsClient.sendObjectBeacon(station.lat, station.lon, name);
      } else {
        logger.log('system', 'info', `Beacon: APRS-IS connected but no Net Control station for "${race.name}" — skipping`);
      }
    }

    // Send beacon via this race's TNC primary (if connected)
    if (station) {
      localTnc.sendBeacon(race.id, station.lat, station.lon, name);
    }

    // Send MQTT beacons if connected
    if (mqttClient.getStatus().connected) {
      mqttClient.sendNodeInfo(name, nodeId).catch(e =>
        logger.log('system', 'error', `NodeInfo beacon failed: ${e.message}`)
      );
      if (station) {
        mqttClient.sendPositionBeacon(station.lat, station.lon, nodeId).catch(e =>
          logger.log('system', 'error', `Position beacon failed: ${e.message}`)
        );
      }
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
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop };
