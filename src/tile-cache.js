'use strict';

/**
 * Offline tile cache for USGS Topo and Satellite base layers.
 *
 * Downloads all tiles for a race bounding box with buffer (zoom 8–14) and stores them in
 * per-race SQLite databases under data/tiles/. Serves cached tiles directly
 * so the map works without an internet connection on race day.
 *
 * One DB per race per layer: data/tiles/{raceId}_topo.db, {raceId}_satellite.db
 *
 * Tile storage uses standard slippy-map (XYZ) coordinates — NOT TMS y-flip.
 * USGS tile URLs use /{z}/{y}/{x} order (y before x) but same XYZ values.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');
const db   = require('./db');

const TILES_DIR  = path.join(__dirname, '..', 'data', 'tiles');
const MIN_ZOOM    = 8;
const MAX_ZOOM    = 14;
const CONCURRENCY = 6;    // simultaneous USGS requests
const BBOX_MARGIN = 0.35; // 35% of bbox span added to each side
const BBOX_MIN_DEG = 0.15; // minimum absolute buffer in degrees (~11 km lat, ~8 km lon@45°N)

const LAYER_BASE_URLS = {
  topo:      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile',
  satellite: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile',
};

// Track which races are currently being downloaded
const _inProgress = new Map(); // raceId → true | 'cancel'

// Cached read connections — one per race+layer, kept open for fast tile serving
const _readConns = new Map();  // `${raceId}_${layer}` → Database
const _readStmts = new Map();  // same key → prepared SELECT statement

// ── SQLite helpers ────────────────────────────────────────────────────────────

function tileDbPath(raceId, layer) {
  return path.join(TILES_DIR, `${raceId}_${layer}.db`);
}

function openWriteDb(raceId, layer) {
  fs.mkdirSync(TILES_DIR, { recursive: true });
  const tdb = new Database(tileDbPath(raceId, layer));
  tdb.pragma('journal_mode = WAL');
  tdb.prepare(`
    CREATE TABLE IF NOT EXISTS tiles (
      z INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (z, x, y)
    )
  `).run();
  return tdb;
}

function invalidateReadConn(raceId, layer) {
  const key = `${raceId}_${layer}`;
  try { _readConns.get(key)?.close(); } catch {}
  _readConns.delete(key);
  _readStmts.delete(key);
}

function getReadConn(raceId, layer) {
  const key = `${raceId}_${layer}`;
  if (!_readConns.has(key)) {
    const p = tileDbPath(raceId, layer);
    if (!fs.existsSync(p)) return null;
    try {
      const conn = new Database(p, { readonly: true });
      _readConns.set(key, conn);
      _readStmts.set(key, conn.prepare('SELECT data FROM tiles WHERE z=? AND x=? AND y=?'));
    } catch { return null; }
  }
  return _readConns.get(key) || null;
}

// ── Public: serve a single tile ───────────────────────────────────────────────

function getTile(raceId, layer, z, x, y) {
  const conn = getReadConn(raceId, layer);
  if (!conn) return null;
  try {
    const row = _readStmts.get(`${raceId}_${layer}`)?.get(z, x, y);
    return row?.data || null;
  } catch { return null; }
}

// Auto-detect image content type from first two bytes (PNG vs JPEG)
function detectContentType(buf) {
  if (!buf || buf.length < 2) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  return 'image/png';
}

// ── Tile coordinate math ──────────────────────────────────────────────────────

function latLonToTile(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor(
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
  );
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

function tilesForBbox(minLat, maxLat, minLon, maxLon) {
  const tiles = [];
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    // NW corner → smallest x, smallest y
    const tl = latLonToTile(maxLat, minLon, z);
    // SE corner → largest x, largest y
    const br = latLonToTile(minLat, maxLon, z);
    for (let x = tl.x; x <= br.x; x++) {
      for (let y = tl.y; y <= br.y; y++) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

// ── HTTP fetch with retry ─────────────────────────────────────────────────────

function fetchTileData(layer, z, x, y) {
  return new Promise((resolve, reject) => {
    // USGS URL format: /{z}/{y}/{x}  (row/col order, not x/y)
    const url = `${LAYER_BASE_URLS[layer]}/${z}/${y}/${x}`;
    const opts = {
      headers: { 'User-Agent': 'RaceTracker/1.0 (self-hosted offline map cache; https://github.com/USGS)' },
      timeout: 15000,
    };
    https.get(url, opts, res => {
      if (res.statusCode === 404) { res.resume(); return resolve(null); } // empty/ocean tiles
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchWithRetry(layer, z, x, y, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fetchTileData(layer, z, x, y); }
    catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

// ── Status helpers ────────────────────────────────────────────────────────────

function setStatus(raceId, status) {
  db.prepare("UPDATE races SET offline_maps_status=? WHERE id=?").run(status, raceId);
  const updated = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
  if (updated) require('./websocket').broadcast({ type: 'race_update', data: updated });
}

function isDownloading(raceId) { return _inProgress.has(raceId); }

function cancelDownload(raceId) {
  if (_inProgress.has(raceId)) _inProgress.set(raceId, 'cancel');
}

// ── Main download engine ──────────────────────────────────────────────────────

/**
 * Download all Topo and Satellite tiles for the given race's course bounding box
 * (zoom 8–14) and store them locally. Runs entirely in the background.
 *
 * @param {number} raceId
 * @param {Array<[number,number]>} trackPoints  - [[lat,lon], ...]
 */
async function downloadTiles(raceId, trackPoints) {
  if (!trackPoints?.length) return;
  if (isDownloading(raceId)) cancelDownload(raceId); // cancel any previous run

  // Small delay so cancel propagates before we re-set
  await new Promise(r => setTimeout(r, 100));
  _inProgress.set(raceId, true);

  try {
    // Compute bounding box with margin.
    // Use the larger of a percentage of the bbox span or a fixed minimum buffer,
    // so even narrow/linear courses get meaningful coverage at high zoom levels.
    const lats = trackPoints.map(p => p[0]);
    const lons = trackPoints.map(p => p[1]);
    const dLat = Math.max((Math.max(...lats) - Math.min(...lats)) * BBOX_MARGIN, BBOX_MIN_DEG);
    const dLon = Math.max((Math.max(...lons) - Math.min(...lons)) * BBOX_MARGIN, BBOX_MIN_DEG);
    const bbox = {
      minLat: Math.min(...lats) - dLat,  maxLat: Math.max(...lats) + dLat,
      minLon: Math.min(...lons) - dLon,  maxLon: Math.max(...lons) + dLon,
    };

    const tiles = tilesForBbox(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon);
    const layers = ['topo', 'satellite'];
    const totalTiles = tiles.length * layers.length;

    require('./logger').log('system', 'info',
      `[tiles] race ${raceId}: downloading ${totalTiles} tiles (${tiles.length} per layer, z${MIN_ZOOM}–${MAX_ZOOM})`
    );

    setStatus(raceId, 'downloading:0');
    let doneTotal = 0, lastPct = 0;

    for (const layer of layers) {
      if (_inProgress.get(raceId) === 'cancel') break;

      // Close any stale read connection before writing
      invalidateReadConn(raceId, layer);
      const tdb = openWriteDb(raceId, layer);
      const insertStmt = tdb.prepare('INSERT OR REPLACE INTO tiles (z,x,y,data) VALUES (?,?,?,?)');
      const insertBatch = tdb.transaction(rows => { for (const r of rows) insertStmt.run(r.z, r.x, r.y, r.data); });

      // Process tiles in concurrent batches
      for (let i = 0; i < tiles.length; i += CONCURRENCY) {
        if (_inProgress.get(raceId) === 'cancel') break;

        const batch = tiles.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async ({ z, x, y }) => {
            const data = await fetchWithRetry(layer, z, x, y);
            return data ? { z, x, y, data } : null;
          })
        );

        // Write successful tiles in a single transaction
        const toWrite = results.flatMap(r => (r.status === 'fulfilled' && r.value) ? [r.value] : []);
        if (toWrite.length) insertBatch(toWrite);

        doneTotal += batch.length;
        const pct = Math.floor(doneTotal / totalTiles * 100);
        if (pct >= lastPct + 5) {
          lastPct = pct;
          setStatus(raceId, `downloading:${pct}`);
        }
      }

      tdb.close();
      // Open a fresh read connection now that writes are complete
      if (_inProgress.get(raceId) !== 'cancel') getReadConn(raceId, layer);
    }

    const finalStatus = _inProgress.get(raceId) === 'cancel' ? 'error' : 'ready';
    setStatus(raceId, finalStatus);
    require('./logger').log('system', 'info', `[tiles] race ${raceId}: download ${finalStatus}`);
  } catch (e) {
    require('./logger').log('system', 'error', `[tiles] race ${raceId}: download failed — ${e.message}`);
    setStatus(raceId, 'error');
  } finally {
    _inProgress.delete(raceId);
  }
}

// ── Cache management ──────────────────────────────────────────────────────────

function deleteTileCache(raceId) {
  cancelDownload(raceId);
  for (const layer of ['topo', 'satellite']) {
    invalidateReadConn(raceId, layer);
    try { fs.unlinkSync(tileDbPath(raceId, layer)); } catch {}
  }
}

module.exports = { downloadTiles, getTile, detectContentType, isDownloading, cancelDownload, deleteTileCache };
