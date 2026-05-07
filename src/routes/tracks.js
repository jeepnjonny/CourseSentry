'use strict';

/**
 * Track Management Routes
 *
 * This module handles track file uploads and parsing for races. It supports KML and GPX file formats,
 * allowing administrators to upload course tracks and configure which path to use for routing.
 *
 * Key Features:
 * - Upload KML/GPX track files with validation
 * - Parse tracks into paths, points, and track points
 * - Support for multiple paths in a single file (path index selection)
 * - Integration with course library for global courses
 * - Automatic MQTT route cache invalidation on changes
 * - Distance calculation using geo utilities
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const geo = require('../geo');
const { requireRole } = require('../auth');
const mqttClient = require('../mqtt-client');

const router = express.Router({ mergeParams: true });

// Upload directory for track files
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'tracks');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `race_${req.params.raceId}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedExts = ['.kml', '.gpx'];
    const isAllowed = allowedExts.includes(path.extname(file.originalname).toLowerCase());
    cb(null, isAllowed);
  }
});

/**
 * Parses KML file content to extract paths and points
 * Uses regex-based parsing to avoid DOM dependencies
 * @param {string} text - KML file content
 * @returns {Object} Object with paths array and points array
 */
function parseKML(text) {
  const domParser = new (require('node:util').TextDecoder)();
  const paths = [];
  const points = [];

  // Regex to match Placemark elements
  const placemarkRe = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let placemarkMatch;

  while ((placemarkMatch = placemarkRe.exec(text)) !== null) {
    const block = placemarkMatch[1];

    // Extract name
    const nameMatch = block.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
    const name = nameMatch ? nameMatch[1].trim() : 'Unnamed';

    // Extract LineString coordinates for paths
    const lsMatch = block.match(/<LineString[\s\S]*?<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/i);
    if (lsMatch) {
      const coordinates = lsMatch[1].trim().split(/\s+/).map(coord => {
        const parts = coord.split(',');
        return parts.length >= 2 ? [parseFloat(parts[1]), parseFloat(parts[0])] : null; // [lat, lon]
      }).filter(point => point && !isNaN(point[0]) && !isNaN(point[1]));

      if (coordinates.length >= 2) {
        paths.push({ name, points: coordinates });
      }
    }

    // Extract Point coordinates
    const ptMatch = block.match(/<Point[\s\S]*?<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/i);
    if (ptMatch) {
      const parts = ptMatch[1].trim().split(',');
      if (parts.length >= 2) {
        points.push({
          name,
          lat: parseFloat(parts[1]),
          lon: parseFloat(parts[0])
        });
      }
    }
  }

  return { paths, points };
}

/**
 * Extracts a GPX point with elevation if available
 * @param {string} inner - Inner XML content of the point element
 * @param {string} lat - Latitude string
 * @param {string} lon - Longitude string
 * @returns {Array} [lat, lon] or [lat, lon, ele] array
 */
function extractGpxPt(inner, lat, lon) {
  const point = [parseFloat(lat), parseFloat(lon)];

  if (inner) {
    const eleMatch = inner.match(/<ele>([\d.+eE-]+)<\/ele>/);
    if (eleMatch) {
      point.push(parseFloat(eleMatch[1])); // Add elevation
    }
  }

  return point;
}

/**
 * Parses GPX file content to extract tracks or routes
 * Prefers tracks over routes if both are present
 * @param {string} text - GPX file content
 * @returns {Array} Array of path objects with name and points
 */
function parseGPX(text) {
  const tracks = [];

  // Parse track points (<trkpt>)
  const trkptRe = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
  let match;
  const trkPoints = [];

  while ((match = trkptRe.exec(text)) !== null) {
    trkPoints.push(extractGpxPt(match[3], match[1], match[2]));
  }

  if (trkPoints.length >= 2) {
    tracks.push({ name: 'GPX Track', points: trkPoints });
    return tracks;
  }

  // Fallback to route points (<rtept>) if no tracks found
  const rteptRe = /<rtept\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/rtept>/gi;
  const rtePoints = [];

  while ((match = rteptRe.exec(text)) !== null) {
    rtePoints.push(extractGpxPt(match[3], match[1], match[2]));
  }

  if (rtePoints.length >= 2) {
    tracks.push({ name: 'GPX Route', points: rtePoints });
  }

  return tracks;
}

/**
 * Parses track file content based on file extension
 * @param {string} text - File content
 * @param {string} filePath - Path to the file
 * @param {number} pathIndex - Index of the path to extract (for multi-path files)
 * @returns {Array|null} Array of [lat, lon] points or null if parsing failed
 */
function parseTrack(text, filePath, pathIndex) {
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === '.gpx' ? parseGPX(text) : parseKML(text).paths;

  if (!parsed || parsed.length === 0) return null;

  const selectedPath = parsed[pathIndex] || parsed[0];
  return selectedPath.points;
}

/**
 * GET /parse - Parses and returns track data for a race
 * Supports both race-specific tracks and global course library
 * @param {string} req.params.raceId - Race ID from URL
 * @returns {Object} JSON response with parsed track data including paths, points, and metadata
 */
router.get('/parse', requireRole('admin', 'operator'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) {
    return res.json({ ok: true, data: null });
  }

  try {
    let paths = [];
    let points = [];
    let trackPoints = null;
    let pathIndex = 0;

    // Prefer global course library if race has a course_id
    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const text = fs.readFileSync(course.file_path, 'utf8');
        const { parseCourse } = require('./courses');
        const courseData = parseCourse(text, course.file_path, course.path_index);
        const meta = courseData.trackPoints ? geo.buildTrackMeta(courseData.trackPoints) : null;

        return res.json({
          ok: true,
          data: {
            paths: courseData.paths,
            points: courseData.points,
            trackPoints: courseData.trackPoints,
            totalDistance: meta?.total,
            pathIndex: course.path_index
          }
        });
      }
    }

    // Fall back to race-specific track file
    if (!race.track_file) {
      return res.json({ ok: true, data: null });
    }

    const text = fs.readFileSync(race.track_file, 'utf8');
    const ext = path.extname(race.track_file).toLowerCase();

    if (ext === '.gpx') {
      paths = parseGPX(text);
      points = []; // GPX doesn't have separate points
    } else {
      const kmlData = parseKML(text);
      paths = kmlData.paths;
      points = kmlData.points;
    }

    trackPoints = parseTrack(text, race.track_file, race.track_path_index);
    const meta = trackPoints ? geo.buildTrackMeta(trackPoints) : null;
    pathIndex = race.track_path_index;

    res.json({
      ok: true,
      data: {
        paths,
        points,
        trackPoints,
        totalDistance: meta?.total,
        pathIndex
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /upload - Uploads a track file for a race
 * Accepts KML or GPX files, replaces existing track file
 * @param {string} req.params.raceId - Race ID from URL
 * @param {File} req.file - Uploaded track file
 * @returns {Object} JSON response with upload details and available paths
 */
router.post('/upload', requireRole('admin'), upload.single('track'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No file uploaded' });
  }

  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  // Remove old track file if it exists
  if (race.track_file && fs.existsSync(race.track_file)) {
    try {
      fs.unlinkSync(race.track_file);
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  const filePath = req.file.path;
  const text = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();

  // Parse to get available paths
  const paths = ext === '.gpx' ? parseGPX(text) : parseKML(text).paths;

  // Update race with new track file and reset path index
  db.prepare('UPDATE races SET track_file=?, track_path_index=0 WHERE id=?').run(filePath, req.params.raceId);
  mqttClient.invalidateRouteCache(parseInt(req.params.raceId));

  res.json({
    ok: true,
    data: {
      file: req.file.originalname,
      paths: paths.map((path, index) => ({
        index,
        name: path.name,
        pointCount: path.points.length
      }))
    }
  });
});

/**
 * PUT /path-index - Sets the active path index for multi-path track files
 * @param {string} req.params.raceId - Race ID from URL
 * @param {number} req.body.index - Path index to set (defaults to 0)
 * @returns {Object} JSON response confirming update
 */
router.put('/path-index', requireRole('admin'), (req, res) => {
  const { index } = req.body;
  db.prepare('UPDATE races SET track_path_index=? WHERE id=?').run(index ?? 0, req.params.raceId);
  mqttClient.invalidateRouteCache(parseInt(req.params.raceId));
  res.json({ ok: true });
});

module.exports = router;
module.exports.parseTrack = parseTrack;
