'use strict';

/**
 * Shared course/track utilities.
 *
 * loadTrackPoints(race) — parse, downsample, and return [[lat,lon],...] for a race.
 * loadTrackData(race)   — same, plus pre-computed route metadata; cached per race.
 *
 * Both functions are intentionally synchronous (better-sqlite3 + fs.readFileSync)
 * because the rest of the server is synchronous SQLite.
 *
 * Downsampling rationale
 * ──────────────────────
 * A detailed GPX export from a GPS watch or mapping app can easily contain 5,000–
 * 15,000 coordinate pairs for a 50 km course.  geo.findPositionOnRoute() is O(n) in
 * the number of segments, so every MQTT position packet triggers that many distance
 * calculations.  For the purposes of geofencing (15–200 m radii) and off-course
 * detection, one point every TRACK_MIN_SPACING_M metres gives identical results with
 * typically 10–50× fewer points.
 */

const fs  = require('fs');
const db  = require('../db');
const geo = require('../geo');

// Minimum inter-point spacing kept after downsampling.  35 m is well below the
// smallest geofence radius used in the app (15 m start/finish) yet removes the
// GPS noise and high-density segments common in hand-drawn or watch-exported tracks.
const TRACK_MIN_SPACING_M = 35;

// ── Per-race track-data cache ─────────────────────────────────────────────────
// Invalidated explicitly via invalidateTrackCache(raceId) whenever a course is
// reassigned.  Means disk reads and downsampling happen at most once per race.
const _trackCache = new Map(); // raceId → { points, meta }

function invalidateTrackCache(raceId) {
  _trackCache.delete(raceId);
}

// ── Downsampling ──────────────────────────────────────────────────────────────

/**
 * Reduce a raw track to at most one point every minDistanceM metres using a
 * greedy forward walk.  Always retains the first and last points so the course
 * start and finish remain exact.
 *
 * This is O(n) in the original point count and produces stable, ordered output
 * suitable for the segment-projection math in geo.findPositionOnRoute().
 *
 * @param {Array<[number,number]>} points   - raw [[lat,lon],...] array
 * @param {number}                 minDistanceM - minimum spacing to enforce
 * @returns {Array<[number,number]>}
 */
function downsampleTrack(points, minDistanceM = TRACK_MIN_SPACING_M) {
  if (!points || points.length < 2) return points ?? [];

  const out = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    if (geo.haversine(prev[0], prev[1], points[i][0], points[i][1]) >= minDistanceM) {
      out.push(points[i]);
    }
  }

  // Always include the final point so the course end is never truncated.
  out.push(points[points.length - 1]);

  return out;
}

// ── File parsing ──────────────────────────────────────────────────────────────

/**
 * Parse raw KML/GPX text into [[lat,lon], ...] track points.
 * Delegates to the route-specific parsers; returns null on failure.
 *
 * @param {string} text      - raw file content
 * @param {string} filePath  - used to infer file type by extension
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
  // Legacy: routes/tracks parser (older upload path)
  const { parseTrack } = require('../routes/tracks');
  return parseTrack(text, filePath, pathIndex ?? 0) || null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load, parse, and downsample track points for a race.
 * Prefers the course table (race.course_id) over the legacy track_file column.
 * Returns null when no course is configured or the file cannot be read.
 *
 * @param {Object} race - race row from the database
 * @returns {Array<[number,number]>|null}
 */
function loadTrackPoints(race) {
  if (!race) return null;
  try {
    let raw = null;

    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const text = fs.readFileSync(course.file_path, 'utf8');
        raw = parseFile(text, course.file_path, course.path_index);
      }
    }

    if (!raw && race.track_file) {
      const text = fs.readFileSync(race.track_file, 'utf8');
      raw = parseFile(text, race.track_file, race.track_path_index);
    }

    if (!raw?.length) return null;

    const downsampled = downsampleTrack(raw);
    return downsampled.length >= 2 ? downsampled : null;
  } catch {
    /* file missing or parse error — caller receives null */
    return null;
  }
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

module.exports = { loadTrackPoints, loadTrackData, downsampleTrack, invalidateTrackCache, TRACK_MIN_SPACING_M };
