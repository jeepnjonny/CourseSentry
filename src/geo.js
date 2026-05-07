'use strict';

/**
 * Geographic calculations for route analysis and geofencing.
 * Provides haversine distance, point-to-segment projection, and geofence checking.
 */

const R = 6371000; // Earth radius in meters

/**
 * Convert degrees to radians.
 */
function toRad(deg) {
  return deg * Math.PI / 180;
}

/**
 * Haversine formula: great-circle distance between two points (meters).
 */
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Perpendicular distance from point P to line segment AB.
 * Returns { dist, t } where t is the parameter [0,1] along segment.
 */
function pointToSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
  const ax = toRad(aLon) * Math.cos(toRad(aLat));
  const ay = toRad(aLat);
  const bx = toRad(bLon) * Math.cos(toRad(aLat));
  const by = toRad(bLat);
  const px = toRad(pLon) * Math.cos(toRad(aLat));
  const py = toRad(pLat);

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  }
  const nx = ax + t * dx;
  const ny = ay + t * dy;
  const dist = Math.sqrt((px - nx) ** 2 + (py - ny) ** 2) * R;
  return { dist, t };
}

/**
 * Pre-compute cumulative distances along a track.
 * Returns { dists, total } where dists[i] is cumulative distance to point i.
 */
function buildTrackMeta(points) {
  const dists = [0];
  for (let i = 1; i < points.length; i++) {
    dists.push(dists[i - 1] + haversine(
      points[i - 1][0], points[i - 1][1],
      points[i][0], points[i][1]
    ));
  }
  return { dists, total: dists[dists.length - 1] };
}

/**
 * Find position of a lat/lon on a route (snapping to nearest point).
 * Returns distance from route, distance along route, and completion percentage.
 */
function findPositionOnRoute(lat, lon, points, meta) {
  if (!meta) meta = buildTrackMeta(points);
  let minDist = Infinity;
  let bestAlongRoute = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const [lat1, lon1] = points[i];
    const [lat2, lon2] = points[i + 1];
    const segLen = meta.dists[i + 1] - meta.dists[i];
    const { dist, t } = pointToSegment(lat, lon, lat1, lon1, lat2, lon2);

    if (dist < minDist) {
      minDist = dist;
      bestAlongRoute = meta.dists[i] + t * segLen;
    }
  }

  return {
    distanceFromRoute: minDist,
    distanceAlongRoute: bestAlongRoute,
    percentComplete: meta.total > 0 ? (bestAlongRoute / meta.total) * 100 : 0,
    totalDistance: meta.total,
  };
}

/**
 * Sort and assign course_order to stations by projecting each onto the route.
 */
function orderStationsByRoute(stations, points) {
  const meta = buildTrackMeta(points);
  return stations
    .map(s => ({
      ...s,
      _along: findPositionOnRoute(s.lat, s.lon, points, meta).distanceAlongRoute,
    }))
    .sort((a, b) => a._along - b._along)
    .map((s, i) => ({ ...s, course_order: i }));
}

/**
 * Check if a point is within radiusM of a target location.
 */
function inGeofence(lat, lon, targetLat, targetLon, radiusM) {
  return haversine(lat, lon, targetLat, targetLon) <= radiusM;
}

/**
 * Estimate ETA in seconds given distance remaining and current pace (m/s).
 */
function estimateETA(distRemaining, paceMs) {
  if (!paceMs || paceMs <= 0) return null;
  return Math.round(distRemaining / paceMs);
}

module.exports = {
  haversine,
  findPositionOnRoute,
  buildTrackMeta,
  orderStationsByRoute,
  inGeofence,
  estimateETA,
};
