'use strict';

/**
 * RF analysis routes.
 * Returns heatmap points and node summaries for a race.
 */
const express = require('express');
const db = require('../db');
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

router.delete('/', requireRole('admin', 'operator'), (req, res) => {
  const info = db.prepare('DELETE FROM tracker_positions WHERE race_id = ?').run(req.params.raceId);
  logger.log('race', 'info', `RF data cleared for race ${req.params.raceId}: ${info.changes} records deleted by ${req.session.user.username}`);
  res.json({ ok: true, deleted: info.changes });
});

module.exports = router;
