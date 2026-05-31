'use strict';

const express = require('express');
const https   = require('https');
const fs      = require('fs');
const db      = require('../db');
const { requireAuth } = require('../auth');
const { parseTrack }  = require('./tracks');

const router    = express.Router({ mergeParams: true });
const CACHE_TTL = 5 * 60 * 1000;
const BBOX_PAD  = 0.25;             // ~15 mi padding at US latitudes
const cache     = new Map();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const options = typeof url === 'string' ? { ...require('url').parse(url) } : url;
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(json.message || json.title || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    }).on('error', reject);
  });
}

function resolveBbox(race) {
  const lats = [], lons = [];
  try {
    let text = null, filePath = null, pathIndex = 0;
    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        text = fs.readFileSync(course.file_path, 'utf8');
        filePath = course.file_path;
        pathIndex = course.path_index || 0;
      }
    }
    if (!text && race.track_file) {
      text = fs.readFileSync(race.track_file, 'utf8');
      filePath = race.track_file;
      pathIndex = race.track_path_index || 0;
    }
    if (text) {
      const pts = parseTrack(text, filePath, pathIndex);
      if (pts?.length) pts.forEach(([lat, lon]) => { lats.push(lat); lons.push(lon); });
    }
  } catch (_) {}

  if (!lats.length) {
    db.prepare('SELECT lat, lon FROM stations WHERE race_id=?').all(race.id)
      .forEach(r => { lats.push(r.lat); lons.push(r.lon); });
  }

  if (!lats.length) return null;
  return {
    minLat: Math.min(...lats) - BBOX_PAD,
    maxLat: Math.max(...lats) + BBOX_PAD,
    minLon: Math.min(...lons) - BBOX_PAD,
    maxLon: Math.max(...lons) + BBOX_PAD,
  };
}

router.get('/perimeters', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const bbox = resolveBbox(race);
  if (!bbox) return res.status(400).json({ ok: false, error: 'No location for this race' });

  const cacheKey = `${race.id}:perimeters`;
  const hit = cache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) return res.json({ ok: true, data: hit.data, cached: true });

  const env = `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`;
  const params = new URLSearchParams({
    where: '1=1',
    geometry: env,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'IncidentName,GISAcres,PercentContained,CreateDate',
    f: 'geojson',
    outSR: '4326',
  });
  const url = `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_YearToDate/FeatureServer/0/query?${params}`;

  try {
    const data = await httpGet(url);
    cache.set(cacheKey, { data, ts: Date.now() });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: `NIFC API error: ${err.message}` });
  }
});

router.get('/hotspots', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const bbox = resolveBbox(race);
  if (!bbox) return res.status(400).json({ ok: false, error: 'No location for this race' });

  const cacheKey = `${race.id}:hotspots`;
  const hit = cache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) return res.json({ ok: true, data: hit.data, cached: true });

  const env = `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`;
  const params = new URLSearchParams({
    where: '1=1',
    geometry: env,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'LATITUDE,LONGITUDE,BRIGHTNESS,FRP,CONFIDENCE,ACQ_DATE',
    f: 'geojson',
    outSR: '4326',
  });
  const url = `https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/FIRMS_VIIRS_NOAA_20_NRT/FeatureServer/0/query?${params}`;

  try {
    const data = await httpGet(url);
    cache.set(cacheKey, { data, ts: Date.now() });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: `FIRMS API error: ${err.message}` });
  }
});

module.exports = router;
