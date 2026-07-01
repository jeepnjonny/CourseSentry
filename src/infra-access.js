'use strict';

/**
 * Visibility rules for infrastructure network data as seen by 'station'-role
 * sessions. Admin/operator always get the full race list — this module only
 * resolves the narrower cases:
 *
 *   - Rover sessions (either personnel.is_rover=1, set via the admin Personnel
 *     UI, or the user is currently checked into a stations.type='rover'
 *     pseudo-station via the mobileop.js station picker) see every node.
 *   - Fixed-station sessions see only the node(s) assigned to their station.
 *
 * These two "rover" signals are independent and neither is authoritative on
 * its own, so access is granted if either is true. Always queried live (never
 * cached) so re-picking a station mid-session is reflected immediately.
 */

const db = require('./db');

function getStationRoleAccess(userId, raceId) {
  const personnel = db.prepare(
    'SELECT station_id, is_rover FROM personnel WHERE user_id = ? AND race_id = ?'
  ).get(userId, raceId);

  if (!personnel) return { full: false, stationId: null };
  if (personnel.is_rover) return { full: true, stationId: null };

  if (personnel.station_id) {
    const station = db.prepare('SELECT type FROM stations WHERE id = ?').get(personnel.station_id);
    if (station?.type === 'rover') return { full: true, stationId: null };
  }

  return { full: false, stationId: personnel.station_id || null };
}

module.exports = { getStationRoleAccess };
