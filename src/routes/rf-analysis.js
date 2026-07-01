'use strict';

/**
 * RF analysis routes.
 * Returns heatmap points and node summaries for a race.
 */
const express = require('express');
const db = require('../db');
const geo = require('../geo');
const { loadTrackData } = require('../utils/course');
const { requireAuth, requireRole } = require('../auth');
const logger = require('../logger');

const router = express.Router({ mergeParams: true });

function buildPositionQuery(raceId, sources) {
  let sql = `
    SELECT node_id, lat, lon, snr, rssi, rf_source, timestamp
    FROM tracker_positions
    WHERE race_id = ? AND lat IS NOT NULL AND lon IS NOT NULL
  `;
  const args = [raceId];

  if (sources) {
    const sourceList = sources.split(',').map(s => s.trim()).filter(Boolean);
    if (sourceList.length) {
      sql += ` AND rf_source IN (${sourceList.map(() => '?').join(',')})`;
      args.push(...sourceList);
    }
  }

  return { sql: `${sql} ORDER BY timestamp`, args };
}

function buildSummary(raceId) {
  const rows = db.prepare(`
    SELECT COALESCE(rf_source, 'meshtastic') AS src,
           COUNT(*) AS count,
           COUNT(DISTINCT node_id) AS node_count,
           AVG(snr) AS avg_snr,
           AVG(rssi) AS avg_rssi,
           MIN(timestamp) AS first_ts,
           MAX(timestamp) AS last_ts
    FROM tracker_positions
    WHERE race_id = ? AND lat IS NOT NULL
    GROUP BY src
  `).all(raceId);

  return rows.reduce((summary, row) => {
    summary[row.src] = {
      count: row.count,
      node_count: row.node_count,
      avg_snr: row.avg_snr != null ? Math.round(row.avg_snr * 10) / 10 : null,
      avg_rssi: row.avg_rssi != null ? Math.round(row.avg_rssi) : null,
      first_ts: row.first_ts,
      last_ts: row.last_ts,
    };
    return summary;
  }, {});
}

router.get('/', requireAuth, (req, res) => {
  const { sql, args } = buildPositionQuery(req.params.raceId, req.query.sources);
  const positions = db.prepare(sql).all(...args);
  const summary = buildSummary(req.params.raceId);

  res.json({ ok: true, data: { positions, summary } });
});

router.get('/nodes', requireAuth, (req, res) => {
  const nodes = db.prepare(`
    SELECT tp.node_id,
           COALESCE(tp.rf_source, 'meshtastic') AS rf_source,
           COUNT(*) AS packet_count,
           AVG(tp.snr) AS avg_snr,
           AVG(tp.rssi) AS avg_rssi,
           MIN(tp.timestamp) AS first_seen,
           MAX(tp.timestamp) AS last_seen,
           tr.long_name,
           tr.short_name,
           p.bib,
           p.name AS participant_name
    FROM tracker_positions tp
    LEFT JOIN tracker_registry tr ON tp.node_id = tr.node_id
    LEFT JOIN participants p ON p.race_id = tp.race_id AND (
      UPPER(p.tracker_id) = UPPER(tp.node_id) OR
      UPPER(p.tracker_id) = UPPER(COALESCE(tr.long_name, '')) OR
      UPPER(p.tracker_id) = UPPER(COALESCE(tr.short_name, ''))
    )
    WHERE tp.race_id = ? AND tp.lat IS NOT NULL
    GROUP BY tp.node_id, tp.rf_source
    ORDER BY packet_count DESC
  `).all(req.params.raceId);

  res.json({ ok: true, data: nodes });
});

// Silence gaps: consecutive positions per node with a gap >= minGapSec seconds
router.get('/gaps', requireAuth, (req, res) => {
  const minGapSec = Math.max(60, parseInt(req.query.minGapSec) || 300);
  const raceId    = req.params.raceId;

  let sql = `
    SELECT tp.node_id, tp.lat, tp.lon, tp.timestamp,
           COALESCE(tp.rf_source, 'meshtastic') AS rf_source,
           tr.long_name, tr.short_name,
           p.bib, p.name AS participant_name
    FROM tracker_positions tp
    LEFT JOIN tracker_registry tr ON tp.node_id = tr.node_id
    LEFT JOIN participants p ON p.race_id = tp.race_id AND (
      UPPER(p.tracker_id) = UPPER(tp.node_id) OR
      UPPER(p.tracker_id) = UPPER(COALESCE(tr.long_name, '')) OR
      UPPER(p.tracker_id) = UPPER(COALESCE(tr.short_name, ''))
    )
    WHERE tp.race_id = ? AND tp.lat IS NOT NULL AND tp.lon IS NOT NULL
  `;
  const args = [raceId];

  if (req.query.sources) {
    const sourceList = req.query.sources.split(',').map(s => s.trim()).filter(Boolean);
    if (sourceList.length) {
      sql += ` AND tp.rf_source IN (${sourceList.map(() => '?').join(',')})`;
      args.push(...sourceList);
    }
  }
  sql += ' ORDER BY tp.node_id, tp.timestamp';

  const positions = db.prepare(sql).all(...args);
  const gaps = [];
  let prev = null;

  for (const pos of positions) {
    if (prev && prev.node_id === pos.node_id) {
      const gapSec = pos.timestamp - prev.timestamp;
      if (gapSec >= minGapSec) {
        const displayName = pos.participant_name
          ? (pos.bib ? `#${pos.bib} ${pos.participant_name}` : pos.participant_name)
          : (pos.long_name || pos.short_name || pos.node_id);
        gaps.push({
          node_id:      pos.node_id,
          rf_source:    pos.rf_source,
          display_name: displayName,
          start_lat:    prev.lat,
          start_lon:    prev.lon,
          end_lat:      pos.lat,
          end_lon:      pos.lon,
          gap_sec:      gapSec,
          start_ts:     prev.timestamp,
          end_ts:       pos.timestamp,
        });
      }
    }
    prev = pos;
  }

  res.json({ ok: true, data: gaps });
});

// Course-segment peer comparison: packet counts per segment vs. fleet median
router.get('/segments', requireAuth, (req, res) => {
  const segmentM = Math.max(250, Math.min(5000, parseInt(req.query.segmentM) || 1000));
  const raceId   = req.params.raceId;

  const race = db.prepare('SELECT * FROM races WHERE id = ?').get(raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const track = loadTrackData(race);
  if (!track) return res.json({ ok: true, data: { no_track: true } });

  const { points, meta } = track;
  const numSegments = Math.max(1, Math.ceil(meta.total / segmentM));

  let sql = `
    SELECT tp.node_id, tp.lat, tp.lon, tp.snr, tp.rssi,
           COALESCE(tp.rf_source, 'meshtastic') AS rf_source,
           tr.long_name, tr.short_name,
           p.bib, p.name AS participant_name
    FROM tracker_positions tp
    LEFT JOIN tracker_registry tr ON tp.node_id = tr.node_id
    LEFT JOIN participants p ON p.race_id = tp.race_id AND (
      UPPER(p.tracker_id) = UPPER(tp.node_id) OR
      UPPER(p.tracker_id) = UPPER(COALESCE(tr.long_name, '')) OR
      UPPER(p.tracker_id) = UPPER(COALESCE(tr.short_name, ''))
    )
    WHERE tp.race_id = ? AND tp.lat IS NOT NULL AND tp.lon IS NOT NULL
  `;
  const args = [raceId];

  if (req.query.sources) {
    const sourceList = req.query.sources.split(',').map(s => s.trim()).filter(Boolean);
    if (sourceList.length) {
      sql += ` AND tp.rf_source IN (${sourceList.map(() => '?').join(',')})`;
      args.push(...sourceList);
    }
  }

  const positions = db.prepare(sql).all(...args);
  const cells    = {};   // node_id → segIdx → { count, snrSum, snrCnt, rssiSum, rssiCnt }
  const nodeInfo = {};

  for (const pos of positions) {
    const { distanceAlongRoute } = geo.findPositionOnRoute(pos.lat, pos.lon, points, meta);
    const segIdx = Math.min(Math.floor(distanceAlongRoute / segmentM), numSegments - 1);

    if (!cells[pos.node_id]) cells[pos.node_id] = {};
    const seg = cells[pos.node_id][segIdx] ??
      { count: 0, snrSum: 0, snrCnt: 0, rssiSum: 0, rssiCnt: 0 };
    seg.count++;
    if (pos.snr  != null) { seg.snrSum  += pos.snr;  seg.snrCnt++;  }
    if (pos.rssi != null) { seg.rssiSum += pos.rssi; seg.rssiCnt++; }
    cells[pos.node_id][segIdx] = seg;

    if (!nodeInfo[pos.node_id]) {
      nodeInfo[pos.node_id] = {
        node_id:      pos.node_id,
        rf_source:    pos.rf_source,
        display_name: pos.participant_name
          ? (pos.bib ? `#${pos.bib} ${pos.participant_name}` : pos.participant_name)
          : (pos.long_name || pos.short_name || pos.node_id),
      };
    }
  }

  // Per-segment fleet medians
  const segBuckets = Array.from({ length: numSegments }, () => []);
  for (const segs of Object.values(cells)) {
    for (const [si, d] of Object.entries(segs)) {
      segBuckets[parseInt(si)].push(d.count);
    }
  }
  const segMedians = segBuckets.map(counts => {
    if (!counts.length) return 0;
    const s = [...counts].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  });

  const cellArray = [];
  for (const [nodeId, segs] of Object.entries(cells)) {
    for (const [si, d] of Object.entries(segs)) {
      const segIdx = parseInt(si);
      const median = segMedians[segIdx];
      cellArray.push({
        node_id:       nodeId,
        segment_idx:   segIdx,
        count:         d.count,
        avg_snr:       d.snrCnt  > 0 ? Math.round(d.snrSum  / d.snrCnt  * 10) / 10 : null,
        avg_rssi:      d.rssiCnt > 0 ? Math.round(d.rssiSum / d.rssiCnt)           : null,
        pct_of_median: median > 0 ? Math.round((d.count / median) * 100) : 100,
      });
    }
  }

  const totalKm  = meta.total / 1000;
  const segments = Array.from({ length: numSegments }, (_, i) => ({
    idx:      i,
    start_km: +(i * segmentM / 1000).toFixed(1),
    end_km:   +(Math.min((i + 1) * segmentM / 1000, totalKm)).toFixed(1),
    median:   Math.round(segMedians[i] * 10) / 10,
  }));

  res.json({
    ok: true,
    data: {
      segments,
      nodes:     Object.values(nodeInfo),
      cells:     cellArray,
      segment_m: segmentM,
      total_km:  +totalKm.toFixed(1),
    },
  });
});

// Station reception matrix — which participants had position packets near each confirmed aid station
router.get('/station-matrix', requireAuth, (req, res) => {
  const raceId = parseInt(req.params.raceId);
  const PROXIMITY_M = 500; // generous radius: captures beacons transmitted just before/after station crossing

  const stations = db.prepare(`
    SELECT id, name, type, lat, lon, course_order
    FROM stations
    WHERE race_id = ? AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY course_order
  `).all(raceId);

  if (!stations.length) {
    return res.json({ ok: true, data: { stations: [], participants: [], cells: [] } });
  }

  // Pre-compute lat/lon bounding boxes to avoid haversine on every (pos, station) pair
  const stationBoxes = stations.map(s => {
    const latD = PROXIMITY_M / 111320;
    const lonD = PROXIMITY_M / (111320 * Math.cos(s.lat * Math.PI / 180));
    return { ...s, minLat: s.lat - latD, maxLat: s.lat + latD, minLon: s.lon - lonD, maxLon: s.lon + lonD };
  });

  // Participants (non-DNS) with resolved node_id via tracker_registry
  const participants = db.prepare(`
    SELECT p.id, p.name, p.bib, p.tracker_id, p.status,
           COALESCE(tr.node_id, p.tracker_id) AS node_id
    FROM participants p
    LEFT JOIN tracker_registry tr ON (
      UPPER(p.tracker_id) = UPPER(tr.node_id) OR
      UPPER(p.tracker_id) = UPPER(COALESCE(tr.long_name, '')) OR
      UPPER(p.tracker_id) = UPPER(COALESCE(tr.short_name, ''))
    )
    WHERE p.race_id = ? AND p.status NOT IN ('dns') AND p.tracker_id IS NOT NULL
    ORDER BY CAST(p.bib AS INTEGER), p.bib
  `).all(raceId);

  // Confirmed station arrivals
  const arriveEvents = db.prepare(`
    SELECT participant_id, station_id FROM events
    WHERE race_id = ? AND type = 'aid_arrive'
  `).all(raceId);
  const confirmedSet = new Set(arriveEvents.map(e => `${e.participant_id}:${e.station_id}`));

  // All race positions (capped by auto-pruner at 500/node, ~10k total for large races — fast enough)
  const positions = db.prepare(`
    SELECT node_id, lat, lon FROM tracker_positions
    WHERE race_id = ? AND lat IS NOT NULL AND lon IS NOT NULL
  `).all(raceId);

  // coverage: node_id -> Set<station_id> where a packet was received within PROXIMITY_M
  const coverage = new Map();
  for (const pos of positions) {
    for (const sb of stationBoxes) {
      if (pos.lat < sb.minLat || pos.lat > sb.maxLat ||
          pos.lon < sb.minLon || pos.lon > sb.maxLon) continue;
      if (geo.haversine(pos.lat, pos.lon, sb.lat, sb.lon) <= PROXIMITY_M) {
        if (!coverage.has(pos.node_id)) coverage.set(pos.node_id, new Set());
        coverage.get(pos.node_id).add(sb.id);
      }
    }
  }

  // Cells for (participant, station) pairs where arrival was confirmed
  const cells = [];
  for (const p of participants) {
    for (const s of stations) {
      if (!confirmedSet.has(`${p.id}:${s.id}`)) continue;
      const hasPacket = p.node_id ? (coverage.get(p.node_id)?.has(s.id) ?? false) : null;
      cells.push({ participant_id: p.id, station_id: s.id, has_packet: hasPacket, has_tracker: true });
    }
  }

  res.json({ ok: true, data: { stations, participants, cells } });
});

router.delete('/', requireRole('admin', 'operator'), (req, res) => {
  const info = db.prepare('DELETE FROM tracker_positions WHERE race_id = ?').run(req.params.raceId);
  logger.log('race', 'info', `RF data cleared for race ${req.params.raceId}: ${info.changes} records deleted by ${req.session.user.username}`);
  res.json({ ok: true, deleted: info.changes });
});

module.exports = router;
