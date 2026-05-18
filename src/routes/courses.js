'use strict';

/**
 * Course upload and parsing routes.
 * Handles imports from KML/GPX and extracts path metadata.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const geo = require('../geo');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'courses');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `course_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['.kml', '.gpx'].includes(path.extname(file.originalname).toLowerCase())),
});

function parseKML(text) {
  const paths = [];
  const points = [];
  const placemarkRe = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let match;

  while ((match = placemarkRe.exec(text)) !== null) {
    const block = match[1];
    const nameMatch = block.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
    const name = nameMatch ? nameMatch[1].trim() : 'Unnamed';

    const lineStringMatch = block.match(/<LineString[\s\S]*?<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/i);
    if (lineStringMatch) {
      const coordinates = lineStringMatch[1].trim().split(/\s+/).map(pair => {
        const parts = pair.split(',');
        return parts.length >= 2 ? [parseFloat(parts[1]), parseFloat(parts[0])] : null;
      }).filter(point => point && !isNaN(point[0]) && !isNaN(point[1]));

      if (coordinates.length >= 2) paths.push({ name, points: coordinates });
    }

    const pointMatch = block.match(/<Point[\s\S]*?<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/i);
    if (pointMatch) {
      const parts = pointMatch[1].trim().split(',');
      if (parts.length >= 2) points.push({ name, lat: parseFloat(parts[1]), lon: parseFloat(parts[0]) });
    }
  }

  return { paths, points };
}

function extractGpxPt(inner, lat, lon) {
  const elevationMatch = inner && inner.match(/<ele>([\d.+eE-]+)<\/ele>/);
  const point = [parseFloat(lat), parseFloat(lon)];
  if (elevationMatch) point.push(parseFloat(elevationMatch[1]));
  return point;
}

function parseGPX(text) {
  const paths = [];
  const trkPoints = [];
  const trkptRe = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
  let match;

  while ((match = trkptRe.exec(text)) !== null) {
    trkPoints.push(extractGpxPt(match[3], match[1], match[2]));
  }

  if (trkPoints.length >= 2) {
    paths.push({ name: 'GPX Track', points: trkPoints });
  } else {
    const routePoints = [];
    const rteptRe = /<rtept\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/rtept>/gi;
    while ((match = rteptRe.exec(text)) !== null) {
      routePoints.push(extractGpxPt(match[3], match[1], match[2]));
    }
    if (routePoints.length >= 2) paths.push({ name: 'GPX Route', points: routePoints });
  }

  const waypoints = [];
  const wptRe = /<wpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/wpt>/gi;
  while ((match = wptRe.exec(text)) !== null) {
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const inner = match[3];
    const nameMatch = inner.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
    const name = nameMatch ? nameMatch[1].trim() : `WP${waypoints.length + 1}`;
    waypoints.push({ name, lat, lon });
  }

  return { paths, points: waypoints };
}

function parseCourse(text, filePath, pathIndex) {
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === '.gpx' ? parseGPX(text) : parseKML(text);
  const paths = parsed.paths || [];
  const index = Math.min(pathIndex || 0, Math.max(0, paths.length - 1));

  return {
    paths,
    points: parsed.points || [],
    trackPoints: paths.length ? paths[index].points : null,
  };
}

router.get('/', requireAuth, (req, res) => {
  const courses = db.prepare('SELECT * FROM courses ORDER BY created_at DESC').all();
  res.json({ ok: true, data: courses });
});

router.post('/upload', requireRole('admin'), upload.single('course'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'no file uploaded' });
  }

  const extension = path.extname(req.file.originalname).toLowerCase().replace('.', '');
  const name = path.basename(req.file.originalname, path.extname(req.file.originalname));
  const result = db.prepare('INSERT INTO courses (name, file_path, file_type) VALUES (?, ?, ?)')
    .run(name, req.file.path, extension);

  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ok: true, data: course });
});

router.get('/:id/parse', requireAuth, (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) {
    return res.status(404).json({ ok: false, error: 'course not found' });
  }

  try {
    const text = fs.readFileSync(course.file_path, 'utf8');
    const { paths, points, trackPoints } = parseCourse(text, course.file_path, course.path_index);
    const meta = trackPoints ? geo.buildTrackMeta(trackPoints) : null;

    res.json({ ok: true, data: {
      paths: paths.map((p, i) => ({ index: i, name: p.name, pointCount: p.points.length })),
      points,
      trackPoints,
      totalDistance: meta?.total,
      pathIndex: course.path_index,
    }});
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) {
    return res.status(404).json({ ok: false, error: 'course not found' });
  }

  const name = req.body.name ?? course.name;
  const path_index = req.body.path_index ?? course.path_index;
  db.prepare('UPDATE courses SET name = ?, path_index = ? WHERE id = ?').run(name, path_index, req.params.id);

  res.json({ ok: true, data: db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id) });
});

router.put('/:id/geometry', requireRole('admin'), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ ok: false, error: 'course not found' });

  const activeRace = db.prepare(
    "SELECT id FROM races WHERE course_id = ? AND status = 'active' LIMIT 1"
  ).get(req.params.id);
  if (activeRace) {
    return res.status(409).json({ ok: false, error: 'Cannot edit a course assigned to an active race' });
  }

  const { trackPoints, waypoints } = req.body;
  if (!Array.isArray(trackPoints) || trackPoints.length < 2) {
    return res.status(400).json({ ok: false, error: 'trackPoints must be an array with at least 2 points' });
  }

  const trkptXml = trackPoints.map(([lat, lon, ele]) => {
    const eleTag = (ele != null && !isNaN(ele)) ? `\n      <ele>${ele}</ele>` : '';
    return `    <trkpt lat="${lat}" lon="${lon}">${eleTag}\n    </trkpt>`;
  }).join('\n');

  const wptXml = (waypoints || []).map(({ name, lat, lon }) =>
    `  <wpt lat="${lat}" lon="${lon}">\n    <name>${(name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</name>\n  </wpt>`
  ).join('\n');

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="CourseSentry" xmlns="http://www.topografix.com/GPX/1/1">
${wptXml ? wptXml + '\n' : ''}<trk>
  <name>${(course.name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</name>
  <trkseg>
${trkptXml}
  </trkseg>
</trk>
</gpx>`;

  // Determine save path — always write as .gpx
  const oldPath = course.file_path;
  const newPath = oldPath.replace(/\.(kml|gpx)$/i, '.gpx');
  try {
    fs.writeFileSync(newPath, gpx, 'utf8');
    if (newPath !== oldPath) {
      try { fs.unlinkSync(oldPath); } catch (_) {}
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }

  db.prepare('UPDATE courses SET file_path = ?, file_type = ? WHERE id = ?')
    .run(newPath, 'gpx', req.params.id);

  // Invalidate track cache for any race that uses this course
  const { invalidateTrackCache } = require('../utils/course');
  const affectedRaces = db.prepare('SELECT id FROM races WHERE course_id = ?').all(req.params.id);
  for (const r of affectedRaces) invalidateTrackCache(r.id);

  res.json({ ok: true, data: db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) {
    return res.status(404).json({ ok: false, error: 'course not found' });
  }

  db.prepare('UPDATE races SET course_id = NULL WHERE course_id = ?').run(req.params.id);
  try { fs.unlinkSync(course.file_path); } catch (_error) {}
  db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

module.exports = router;
module.exports.parseCourse = parseCourse;
module.exports.parseKML = parseKML;
module.exports.parseGPX = parseGPX;
