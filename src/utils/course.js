'use strict';

/**
 * Shared course/track utilities.
 *
 * loadTrackPoints(race) — parse the track points [[lat,lon],...] for a race.
 * Handles both the newer course_id reference and the legacy track_file field.
 * Returns null when no course is configured or the file cannot be read.
 *
 * loadTrackData(race) — same as above but also computes route metadata via
 * geo.buildTrackMeta and returns { points, meta }.  Used by the MQTT alert
 * engine which needs both values together.
 *
 * Both functions are intentionally synchronous (better-sqlite3 and fs.readFileSync)
 * because the rest of the server is synchronous SQLite.
 */

const fs   = require('fs');
const db   = require('../db');
const geo  = require('../geo');

// ── Per-race track-data cache ─────────────────────────────────────────────────
// Invalidated explicitly via invalidateTrackCache(raceId) whenever a course is
// reassigned.  Using a Map avoids repeated disk reads for sendInit and alert checks.
const _trackCache = new Map(); // raceId → { points, meta }

function invalidateTrackCache(raceId) {
  _trackCache.delete(raceId);
}

/**
 * Parse raw KML/GPX text into [[lat,lon], ...] track points.
 * Delegates to the existing parsers in routes/courses and routes/tracks.
 *
 * @param {string} text  - raw file content
 * @param {string} filePath - path (used to infer file type)
 * @param {number} pathIndex - which path to extract (multi-path GPX/KML)
 * @returns {Array<[number,number]>|null}
 */
function parseFile(text, filePath, pathIndex) {
  const ext = filePath.split('.').pop().toLowerCase();
  if (ext === 'kml' || ext === 'gpx') {
    // parseCourse handles both kml and gpx and returns { trackPoints, ... }
    const { parseCourse } = require('../routes/courses');
    const result = parseCourse(text, filePath, pathIndex ?? 0);
    return result?.trackPoints?.length ? result.trackPoints : null;
  }
  // Legacy: routes/tracks parser (older KML/GPX)
  const { parseTrack } = require('../routes/tracks');
  return parseTrack(text, filePath, pathIndex ?? 0) || null;
}

/**
 * Load track points [[lat,lon],...] for a race.
 * Prefers the course table (race.course_id) over the legacy track_file column.
 *
 * @param {Object} race - race row from the database
 * @returns {Array<[number,number]>|null}
 */
function loadTrackPoints(race) {
  if (!race) return null;
  try {
    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const text = fs.readFileSync(course.file_path, 'utf8');
        const pts  = parseFile(text, course.file_path, course.path_index);
        if (pts?.length) return pts;
      }
    }
    if (race.track_file) {
      const text = fs.readFileSync(race.track_file, 'utf8');
      return parseFile(text, race.track_file, race.track_path_index) || null;
    }
  } catch { /* file missing or parse error — caller gets null */ }
  return null;
}

/**
 * Load track points AND pre-computed route metadata for a race.
 * Result is cached per raceId; call invalidateTrackCache(raceId) on course change.
 *
 * @param {Object} race - race row from the database
 * @returns {{ points: Array<[number,number]>, meta: Object }|null}
 */
function loadTrackData(race) {
  if (!race) return null;
  if (_trackCache.has(race.id)) return _trackCache.get(race.id);

  const points = loadTrackPoints(race);
  if (!points) return null;

  const data = { points, meta: geo.buildTrackMeta(points) };
  _trackCache.set(race.id, data);
  return data;
}

module.exports = { loadTrackPoints, loadTrackData, invalidateTrackCache };
