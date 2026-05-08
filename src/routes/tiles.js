'use strict';

/**
 * Offline Tile Serving Route
 *
 * Serves pre-downloaded USGS Topo and Satellite tiles from the local SQLite
 * cache. No authentication required (tiles are USGS public-domain data).
 *
 * Routes:
 *   GET /api/tiles/:raceId/:layer/:z/:x/:y  — serve a cached tile
 *   GET /api/tiles/:raceId/status           — download status for a race
 */

const express = require('express');
const db = require('../db');
const { getTile, detectContentType, isDownloading } = require('../tile-cache');

const router = express.Router();

// Status endpoint — checked by the admin UI to display progress
router.get('/:raceId/status', (req, res) => {
  const race = db.prepare('SELECT offline_maps, offline_maps_status FROM races WHERE id=?')
    .get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  res.json({
    ok: true,
    data: {
      offline_maps: race.offline_maps,
      status:       race.offline_maps_status || null,
      downloading:  isDownloading(parseInt(req.params.raceId)),
    },
  });
});

// Tile serving — Leaflet requests these as <img> src, so no session needed
router.get('/:raceId/:layer/:z/:x/:y', (req, res) => {
  const { layer, raceId } = req.params;
  if (!['topo', 'satellite'].includes(layer)) return res.status(400).end();

  const z = parseInt(req.params.z);
  const x = parseInt(req.params.x);
  const y = parseInt(req.params.y);
  if (isNaN(z) || isNaN(x) || isNaN(y)) return res.status(400).end();

  const data = getTile(parseInt(raceId), layer, z, x, y);
  if (!data) return res.status(404).end();

  res.set('Content-Type', detectContentType(data));
  res.set('Cache-Control', 'public, max-age=86400'); // 24h browser cache
  res.send(data);
});

module.exports = router;
