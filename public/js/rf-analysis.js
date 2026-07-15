'use strict';
const RF = (() => {

// ── State ──────────────────────────────────────────────────────────────────────
let leafletMap = null;
let currentBaseLayer = null;
let cellLayers      = {};   // src → L.layerGroup (grid squares)
let routeLayer      = null;
let stationLayer    = null;
let coverageLayers  = {};   // src → L.polygon
let gapLayers       = [];   // L.polyline instances for silence gaps

let races        = [];
let currentRaceId = null;
let allPositions  = [];   // raw from API [{node_id,lat,lon,snr,rssi,rf_source,timestamp}]
let nodeSummary   = [];   // from /nodes endpoint
let summary       = {};   // per-source stats (unfiltered)
let stationData   = [];
let routePoints   = [];
let trackMeta     = null; // pre-computed from routePoints via geoBuildTrackMeta

let segmentData       = null;  // computed lazily on SEGS tab, reset when source/time changes
let stationMatrixData = null;  // fetched lazily on STNS tab, reset on race change

let activeSources   = new Set();
let metric          = 'density';   // 'density' | 'snr' | 'rssi'
let heatOpacity     = 0.70;
let gridSizeM       = 50;   // grid cell edge in meters
let rightTab        = 'stats';
let timeWindowMode  = 'race';      // 'race' | 'all'
let raceWindowStart = null;        // computed unix ts
let raceWindowEnd   = null;        // computed unix ts (null = live/now)
let showCoverage    = false;
let showGaps        = false;
let gapMinutes      = 5;

// Replay: scrubs/animates through the current time window by capping
// filteredPositions() at a cursor timestamp. Bounds track raceWindowStart/End
// (or all-data min/max) and reset whenever the race or time-window mode changes.
let replayStart   = null;  // unix ts — slider min
let replayEnd     = null;  // unix ts — slider max
let replayCursor  = null;  // unix ts — current scrub position (null = no data loaded)
let replaySpeed   = 60;    // simulated seconds per real second
let replayTimer   = null;
const REPLAY_TICK_MS = 300;

// Source metadata
const SOURCE_META = {
  meshtastic: { color: '#58a6ff', label: 'MQTT/Meshtastic' },
  aprs:       { color: '#3fb950', label: 'APRS' },
  inreach:    { color: '#d2a679', label: 'InReach' },
  spot:       { color: '#f78166', label: 'Spot' },
};
function srcMeta(src) {
  return SOURCE_META[src] || { color: '#8b949e', label: src };
}

// Basemap tile sources — mirrors operator/viewer's BASE_LAYERS
const BASE_LAYERS = {
  topo:      { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 16, maxNativeZoom: 16, attribution: 'USGS' } },
  satellite: { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 16, maxNativeZoom: 16, attribution: 'USGS' } },
  osm:       { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxZoom: 19, attribution: '© OSM' } },
  dark:      { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', opts: { subdomains: 'abcd', maxZoom: 19, attribution: '© CartoDB' } },
};

// Signal quality gradient: weak (red) → strong (blue) — industry standard
const SIGNAL_GRADIENT = { 0.0: '#f85149', 0.35: '#ffa657', 0.55: '#fafa00', 0.75: '#3fb950', 1.0: '#58a6ff' };

// ── Ported geo helpers (mirrors src/geo.js — pure math, no dependencies) ──────
function geoToRad(d) { return d * Math.PI / 180; }
function geoHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = geoToRad(lat2 - lat1), dLon = geoToRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(geoToRad(lat1))*Math.cos(geoToRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function geoPointToSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
  const ax = geoToRad(aLon)*Math.cos(geoToRad(aLat)), ay = geoToRad(aLat);
  const bx = geoToRad(bLon)*Math.cos(geoToRad(aLat)), by = geoToRad(bLat);
  const px = geoToRad(pLon)*Math.cos(geoToRad(aLat)), py = geoToRad(pLat);
  const dx = bx-ax, dy = by-ay, lenSq = dx*dx+dy*dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/lenSq)) : 0;
  return { dist: Math.sqrt((px-ax-t*dx)**2+(py-ay-t*dy)**2)*6371000, t };
}
function geoBuildTrackMeta(points) {
  const dists = [0];
  for (let i = 1; i < points.length; i++)
    dists.push(dists[i-1] + geoHaversine(points[i-1][0], points[i-1][1], points[i][0], points[i][1]));
  return { dists, total: dists[dists.length-1] };
}
function geoDistAlongRoute(lat, lon, points, meta) {
  let minDist = Infinity, bestAlong = 0;
  for (let i = 0; i < points.length-1; i++) {
    const [lat1,lon1] = points[i], [lat2,lon2] = points[i+1];
    const { dist, t } = geoPointToSegment(lat, lon, lat1, lon1, lat2, lon2);
    if (dist < minDist) { minDist = dist; bestAlong = meta.dists[i] + t*(meta.dists[i+1]-meta.dists[i]); }
  }
  return bestAlong;
}

// ── Node display name helper ───────────────────────────────────────────────────
function getNodeDisplayName(nodeId) {
  const n = nodeSummary.find(x => x.node_id === nodeId);
  if (!n) return nodeId ? nodeId.slice(-8) : '?';
  if (n.participant_name) return `#${n.bib} ${n.participant_name}`;
  return n.long_name || n.short_name || (nodeId ? nodeId.slice(-8) : '?');
}

// ── Health scores (packet rate vs. fleet median) ───────────────────────────────
function computeHealthScores() {
  const rates = nodeSummary.map(n => {
    const elapsed = (n.last_seen || 0) - (n.first_seen || 0);
    return elapsed >= 120 ? n.packet_count / (elapsed / 3600) : null; // packets/hr
  });
  const valid = rates.filter(r => r !== null).sort((a, b) => a - b);
  if (!valid.length) return rates.map(() => null);
  const median = valid[Math.floor(valid.length / 2)];
  return rates.map(r => {
    if (r === null || median === 0) return null;
    const pct = r / median;
    return pct >= 0.75 ? '#3fb950' : pct >= 0.50 ? '#ffa657' : '#f85149';
  });
}

// ── Interval sparkline (5 buckets: <1m, 1–3m, 3–5m, 5–10m, >10m) ─────────────
function computeNodeIntervals(nodeId) {
  const pts = allPositions.filter(p => p.node_id === nodeId).sort((a, b) => a.timestamp - b.timestamp);
  const buckets = [0, 0, 0, 0, 0];
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i].timestamp - pts[i-1].timestamp;
    if (g < 60) buckets[0]++;
    else if (g < 180) buckets[1]++;
    else if (g < 300) buckets[2]++;
    else if (g < 600) buckets[3]++;
    else buckets[4]++;
  }
  return buckets;
}
const SPARK_COLORS = ['#3fb950', '#58a6ff', '#fafa00', '#ffa657', '#f85149'];
const SPARK_LABELS = ['<1m', '1–3m', '3–5m', '5–10m', '>10m'];
function renderSparkline(buckets) {
  const max = Math.max(...buckets, 1);
  const tip = SPARK_LABELS.map((l, i) => `${l}:${buckets[i]}`).join(' ');
  const bars = buckets.map((v, i) => {
    const h = Math.max(1, Math.round((v / max) * 12));
    return `<span class="spark-bar" style="height:${h}px;background:${SPARK_COLORS[i]}"></span>`;
  }).join('');
  return `<span class="spark" title="Intervals — ${tip}">${bars}</span>`;
}

// ── Reception gap computation (client-side from allPositions) ─────────────────
function computeGaps() {
  const minSec = gapMinutes * 60;
  // Sort a filtered copy by node then time
  const pts = filteredPositions()
    .slice()
    .sort((a, b) => a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : a.timestamp - b.timestamp);

  const gaps = [];
  let prev = null;
  for (const p of pts) {
    if (prev && prev.node_id === p.node_id && p.timestamp - prev.timestamp >= minSec) {
      gaps.push({
        node_id: p.node_id,
        start_lat: prev.lat, start_lon: prev.lon,
        end_lat: p.lat,      end_lon: p.lon,
        duration_sec: p.timestamp - prev.timestamp,
      });
    }
    prev = p;
  }
  return gaps;
}

function clearGapLines() {
  for (const l of gapLayers) leafletMap.removeLayer(l);
  gapLayers = [];
  document.getElementById('gap-legend')?.classList.remove('visible');
}

function renderGapLines() {
  clearGapLines();
  if (!showGaps || !leafletMap) return;
  const gaps = computeGaps();
  for (const g of gaps) {
    const d = g.duration_sec;
    const color = d >= 1800 ? '#f85149' : d >= 900 ? '#ffa657' : '#fafa00';
    const mins  = Math.round(d / 60);
    const name  = getNodeDisplayName(g.node_id);
    const line  = L.polyline([[g.start_lat, g.start_lon], [g.end_lat, g.end_lon]], {
      color, weight: 2.5, dashArray: '7,5', opacity: 0.9,
    }).bindTooltip(`${name} — silent ${mins} min`).addTo(leafletMap);
    gapLayers.push(line);
  }
  if (gapLayers.length) document.getElementById('gap-legend')?.classList.add('visible');
}

function toggleGaps(checked) {
  showGaps = checked;
  if (checked) renderGapLines();
  else clearGapLines();
}

function setGapMin(val) {
  gapMinutes = parseInt(val);
  document.getElementById('lbl-gap-min').textContent = val + ' min';
  if (showGaps) renderGapLines();
}

// ── Segment peer comparison (computed client-side from allPositions + routePoints) ──
function computeSegmentData() {
  if (!routePoints.length || !trackMeta) return null;
  const SEGMENT_M = 1000;
  const pts = filteredPositions();
  if (!pts.length) return { segments: [], nodeIds: [], cells: [] };

  const nodeCells = {}; // node_id -> { seg_idx -> count }
  for (const pos of pts) {
    const along = geoDistAlongRoute(pos.lat, pos.lon, routePoints, trackMeta);
    const idx   = Math.floor(along / SEGMENT_M);
    if (!nodeCells[pos.node_id]) nodeCells[pos.node_id] = {};
    nodeCells[pos.node_id][idx] = (nodeCells[pos.node_id][idx] || 0) + 1;
  }

  const totalSegs = Math.ceil(trackMeta.total / SEGMENT_M);

  // Per-segment fleet median (only over nodes that reported in that segment)
  const segCounts = {};
  for (const segs of Object.values(nodeCells))
    for (const [idxStr, cnt] of Object.entries(segs)) {
      const i = parseInt(idxStr);
      if (!segCounts[i]) segCounts[i] = [];
      segCounts[i].push(cnt);
    }
  const segMedians = {};
  for (const [idxStr, cnts] of Object.entries(segCounts)) {
    const s = [...cnts].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    segMedians[parseInt(idxStr)] = s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
  }

  const nodeIds = Object.keys(nodeCells);
  const segments = Array.from({length: totalSegs}, (_, i) => ({
    idx: i, label: `${(i * SEGMENT_M / 1000).toFixed(1)}`, hasData: !!segCounts[i],
  }));
  const cells = [];
  for (const [nodeId, segs] of Object.entries(nodeCells))
    for (const [idxStr, cnt] of Object.entries(segs)) {
      const idx = parseInt(idxStr);
      const med = segMedians[idx] || 1;
      cells.push({ node_id: nodeId, segment_idx: idx, count: cnt, pct: Math.round((cnt/med)*100) });
    }

  return { segments, nodeIds, cells };
}

function renderSegmentGrid() {
  const wrap = document.getElementById('seg-grid-wrap');
  if (!wrap) return;

  if (!routePoints.length) {
    wrap.innerHTML = '<span class="text-dim" style="font-size:13px">No route defined for this race</span>';
    return;
  }
  if (!allPositions.length) {
    wrap.innerHTML = '<span class="text-dim" style="font-size:13px">No position data</span>';
    return;
  }

  if (!segmentData) {
    wrap.innerHTML = '<span class="text-dim" style="font-size:13px">Computing…</span>';
    setTimeout(() => { segmentData = computeSegmentData(); renderSegmentGrid(); }, 10);
    return;
  }

  const { segments, nodeIds, cells } = segmentData;
  if (!nodeIds.length) {
    wrap.innerHTML = '<span class="text-dim" style="font-size:13px">No data</span>';
    return;
  }

  const activeSegs = segments.filter(s => s.hasData);
  const cellMap = {};
  for (const c of cells) cellMap[`${c.node_id}:${c.segment_idx}`] = c;

  const headerCells = nodeIds.map(nid => {
    const n = nodeSummary.find(x => x.node_id === nid);
    const short = n?.participant_name ? `#${n.bib}` : (n?.short_name || nid.slice(-4));
    const full  = n?.participant_name ? `#${n.bib} ${n.participant_name}` : (n?.long_name || n?.short_name || nid);
    return `<th title="${full}">${short}</th>`;
  }).join('');

  const bodyRows = activeSegs.map(seg => {
    const tds = nodeIds.map(nid => {
      const c = cellMap[`${nid}:${seg.idx}`];
      if (!c) return `<td class="seg-cell-none">—</td>`;
      const cls = c.pct >= 75 ? 'seg-cell-ok' : c.pct >= 50 ? 'seg-cell-warn' : 'seg-cell-bad';
      return `<td class="${cls}" title="${c.count} pkts (${c.pct}% of median)">${c.count}</td>`;
    }).join('');
    return `<tr><td>${seg.label} km</td>${tds}</tr>`;
  }).join('');

  wrap.innerHTML = `
    <table class="seg-grid">
      <thead><tr><th></th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

// ── Station reception matrix (lazy: fetches /station-matrix on first view) ────
async function renderStationMatrix() {
  const wrap = document.getElementById('station-matrix-wrap');
  if (!wrap) return;

  if (!stationMatrixData) {
    wrap.innerHTML = '<span class="text-dim" style="font-size:13px">Loading…</span>';
    const res = await RT.get(`/api/races/${currentRaceId}/rf-analysis/station-matrix`);
    if (!res.ok) {
      wrap.innerHTML = '<span class="text-dim" style="font-size:13px">Failed to load station data</span>';
      return;
    }
    stationMatrixData = res.data;
  }

  const { stations, participants, cells } = stationMatrixData;
  if (!cells.length) {
    wrap.innerHTML = '<span class="text-dim" style="font-size:13px">No confirmed station arrivals found — check that participants have trackers assigned and aid_arrive events exist</span>';
    return;
  }

  const cellMap = {};
  for (const c of cells) cellMap[`${c.participant_id}:${c.station_id}`] = c;

  const pIds = new Set(cells.map(c => c.participant_id));
  const sIds = new Set(cells.map(c => c.station_id));
  const activeParts = participants.filter(p => pIds.has(p.id));
  const activeStns  = stations.filter(s => sIds.has(s.id));

  const headerCells = activeParts.map(p =>
    `<th title="${p.name}" style="white-space:nowrap">#${p.bib}</th>`
  ).join('');

  const bodyRows = activeStns.map(s => {
    const tds = activeParts.map(p => {
      const c = cellMap[`${p.id}:${s.id}`];
      if (!c) return `<td class="stn-cell-na" title="${p.name} not confirmed at ${s.name}">·</td>`;
      return c.has_packet
        ? `<td class="stn-cell-ok"   title="${p.name} — packet received near ${s.name}">✓</td>`
        : `<td class="stn-cell-miss" title="${p.name} — no RF packet near ${s.name}">✗</td>`;
    }).join('');
    return `<tr><td>${s.name}</td>${tds}</tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="stn-matrix-inner">
      <table class="stn-matrix">
        <thead><tr><th>Station</th>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
}


// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  const user = await RT.requireLogin('admin');
  if (!user) return;

  initMap();

  const res = await RT.get('/api/races');
  if (!res.ok) { RT.toast('Failed to load races', 'warn'); return; }
  races = res.data;

  const sel = document.getElementById('race-sel');
  sel.innerHTML = races.map(r =>
    `<option value="${r.id}">${r.name} (${r.date})${r.status === 'active' ? ' ★' : ''}</option>`
  ).join('');

  // Honour ?race=ID from admin page, else active race
  const params  = new URLSearchParams(window.location.search);
  const urlRace = params.get('race') ? parseInt(params.get('race')) : null;
  const active  = races.find(r => r.status === 'active');
  const target  = urlRace ? races.find(r => r.id === urlRace) : active;

  if (target)        { sel.value = target.id;  await selectRace(target.id);  }
  else if (races.length) { sel.value = races[0].id; await selectRace(races[0].id); }
}

// ── Map ────────────────────────────────────────────────────────────────────────
function initMap() {
  leafletMap = L.map('map', { zoomControl: true, maxZoom: BASE_LAYERS.topo.opts.maxZoom });
  setBaseLayer('topo');
  leafletMap.setView([39.5, -98.5], 5);
}

// Swap the active tile layer and cap map zoom at that layer's own native max,
// so users can't zoom past the resolution the tile source actually provides.
function setBaseLayer(name) {
  const cfg = BASE_LAYERS[name] || BASE_LAYERS.topo;
  if (currentBaseLayer) leafletMap.removeLayer(currentBaseLayer);
  currentBaseLayer = L.tileLayer(cfg.url, cfg.opts).addTo(leafletMap);
  leafletMap.setMaxZoom(cfg.opts.maxZoom);
  // setMaxZoom() alone doesn't reliably pull an already-over-zoomed view back
  // down, so re-clamp explicitly. animate:false — an animated multi-level
  // zoom jump can silently fail to complete with many vector layers on screen.
  if (leafletMap.getZoom() > cfg.opts.maxZoom) leafletMap.setZoom(cfg.opts.maxZoom, { animate: false });
  const sel = document.getElementById('base-layer-sel');
  if (sel) sel.value = name;
}

// ── Race selection ─────────────────────────────────────────────────────────────
async function selectRace(raceId) {
  if (!raceId) return;
  currentRaceId = parseInt(raceId);
  showLoading(true);

  const [rfRes, nodeRes, stnRes, trackRes] = await Promise.all([
    RT.get(`/api/races/${raceId}/rf-analysis`),
    RT.get(`/api/races/${raceId}/rf-analysis/nodes`),
    RT.get(`/api/races/${raceId}/stations`),
    RT.get(`/api/races/${raceId}/tracks/parse`),
  ]);

  showLoading(false);
  if (!rfRes.ok) { RT.toast('Failed to load RF data', 'warn'); return; }

  allPositions = rfRes.data.positions || [];
  summary      = rfRes.data.summary   || {};
  nodeSummary  = nodeRes.ok ? nodeRes.data : [];
  stationData  = (stnRes.ok && stnRes.data?.length) ? stnRes.data : [];
  routePoints  = (trackRes.ok && trackRes.data?.trackPoints?.length)
    ? trackRes.data.trackPoints.map(([lat, lon]) => [lat, lon]) : [];

  // Pre-compute track metadata for client-side segment projection
  trackMeta = routePoints.length >= 2 ? geoBuildTrackMeta(routePoints) : null;

  // Reset lazy-computed data for the new race
  segmentData = null;
  stationMatrixData = null;
  clearGapLines();

  // Compute race time bounds before any rendering
  computeRaceBounds();
  resetReplay();

  // Build active sources from data
  const foundSources = new Set(allPositions.map(p => p.rf_source || 'meshtastic'));
  activeSources = new Set(foundSources);

  renderSourceList(foundSources);
  renderStats();
  renderNodeList();
  renderRawTable();
  renderGrid();
  renderCoveragePolygons();
  updateTimeWindowInfo();

  // Route overlay
  if (routeLayer) { leafletMap.removeLayer(routeLayer); routeLayer = null; }
  if (routePoints.length) {
    routeLayer = L.polyline(routePoints, { color: '#58a6ff', weight: 2, opacity: 0.5 }).addTo(leafletMap);
  }

  // Station markers
  if (stationLayer) { leafletMap.removeLayer(stationLayer); stationLayer = null; }
  if (stationData.length) {
    stationLayer = L.layerGroup().addTo(leafletMap);
    for (const s of stationData) {
      if (!s.lat || !s.lon) continue;
      const color  = s.type === 'start' ? '#3fb950' : s.type === 'finish' ? '#f78166' :
                     s.type === 'start_finish' ? '#a371f7' : s.type === 'turnaround' ? '#58a6ff' : '#d2a679';
      const letter = s.type === 'start' ? 'S' : s.type === 'finish' ? 'F' :
                     s.type === 'start_finish' ? '⇌' : s.type === 'turnaround' ? 'T' : s.name[0]?.toUpperCase() || 'A';
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #fff4;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;color:#000;font-family:'Courier New'">${letter}</div>`,
          className: '', iconAnchor: [11, 11],
        }),
      }).bindTooltip(s.name).addTo(stationLayer);
    }
  }

  fitMapToCourse();
}

// Fit to route > stations > positions
function fitMapToCourse() {
  const latLngs = [];
  if (routePoints.length) {
    latLngs.push(...routePoints);
  } else {
    for (const s of stationData) { if (s.lat && s.lon) latLngs.push([s.lat, s.lon]); }
    const visible = filteredPositions();
    for (const p of visible)    { if (p.lat && p.lon) latLngs.push([p.lat, p.lon]); }
  }
  if (latLngs.length) leafletMap.fitBounds(L.latLngBounds(latLngs).pad(0.08));
}

// ── Time window ────────────────────────────────────────────────────────────────
function computeRaceBounds() {
  const race = races.find(r => r.id === currentRaceId);
  if (!race || !allPositions.length) { raceWindowStart = null; raceWindowEnd = null; return; }

  const posMin = Math.min(...allPositions.map(p => p.timestamp));
  const posMax = Math.max(...allPositions.map(p => p.timestamp));

  // Start: prefer race.start_time, fall back to earliest packet
  raceWindowStart = race.start_time || posMin;

  // End: live races use wall clock; completed/past use latest packet
  raceWindowEnd = race.status === 'active' ? null : posMax;
}

function setTimeWindow(val) {
  timeWindowMode = val;
  segmentData = null; // recompute segments with new time window
  resetReplay();
  renderGrid();
  renderCoveragePolygons();
  renderRawTable();
  renderStats();
  updateTimeWindowInfo();
  if (showGaps) renderGapLines();
  if (rightTab === 'segs') renderSegmentGrid();
}

function updateTimeWindowInfo() {
  const rangeEl = document.getElementById('time-window-range');
  const countEl = document.getElementById('time-window-info');
  if (!rangeEl || !countEl) return;

  if (!allPositions.length) { rangeEl.textContent = ''; countEl.textContent = ''; return; }

  if (timeWindowMode === 'race' && raceWindowStart != null) {
    const endTs  = raceWindowEnd ?? Math.floor(Date.now() / 1000);
    const fmt    = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const fmtDay = ts => new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const sameDay = fmtDay(raceWindowStart) === fmtDay(endTs);
    rangeEl.innerHTML = sameDay
      ? `${fmtDay(raceWindowStart)}&nbsp; ${fmt(raceWindowStart)} → ${fmt(endTs)}${raceWindowEnd == null ? ' <span style="color:var(--accent2)">● LIVE</span>' : ''}`
      : `${fmtDay(raceWindowStart)} ${fmt(raceWindowStart)} → ${fmtDay(endTs)} ${fmt(endTs)}`;
  } else {
    rangeEl.textContent = '';
  }

  const visible = filteredPositions();
  countEl.textContent = `${visible.length.toLocaleString()} of ${allPositions.length.toLocaleString()} packets`;
}

// Returns positions filtered by active sources, time window, AND replay cursor
function filteredPositions() {
  let pts = allPositions.filter(p => activeSources.has(p.rf_source || 'meshtastic'));
  if (timeWindowMode === 'race' && raceWindowStart != null) {
    const endTs = raceWindowEnd ?? Math.floor(Date.now() / 1000);
    pts = pts.filter(p => p.timestamp >= raceWindowStart && p.timestamp <= endTs);
  }
  if (replayCursor != null) {
    pts = pts.filter(p => p.timestamp <= replayCursor);
  }
  return pts;
}

// ── Replay (time slider + play/pause) ──────────────────────────────────────────
function computeReplayBounds() {
  if (!allPositions.length) return { start: null, end: null };
  if (timeWindowMode === 'race' && raceWindowStart != null) {
    return { start: raceWindowStart, end: raceWindowEnd ?? Math.floor(Date.now() / 1000) };
  }
  const posMin = Math.min(...allPositions.map(p => p.timestamp));
  const posMax = Math.max(...allPositions.map(p => p.timestamp));
  return { start: posMin, end: posMax };
}

// Re-derives replay bounds and snaps the cursor to the end (= show all data),
// matching the pre-replay default view. Call whenever the race or time-window
// mode changes.
function resetReplay() {
  pauseReplay();
  const { start, end } = computeReplayBounds();
  replayStart  = start;
  replayEnd    = end;
  replayCursor = end;
  renderReplayControls();
}

function renderReplayControls() {
  const slider = document.getElementById('replay-slider');
  const btn    = document.getElementById('replay-play-btn');
  if (!slider) return;

  const hasRange = replayStart != null && replayEnd != null && replayEnd > replayStart;
  slider.disabled = !hasRange;
  if (btn) btn.disabled = !hasRange;

  if (!hasRange) {
    slider.min = 0; slider.max = 1; slider.value = 1;
    document.getElementById('replay-label').textContent = '';
    return;
  }

  slider.min   = replayStart;
  slider.max   = replayEnd;
  slider.step  = 10;
  slider.value = replayCursor;
  updateReplayLabel();
}

function updateReplayLabel() {
  const label = document.getElementById('replay-label');
  if (!label) return;
  if (replayStart == null) { label.textContent = ''; return; }

  const fmt    = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtDur = s => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  };
  const elapsed = Math.max(0, replayCursor - replayStart);
  const total   = Math.max(0, replayEnd - replayStart);
  label.textContent = `${fmt(replayCursor)} — ${fmtDur(elapsed)} of ${fmtDur(total)}`;
}

function updatePlayButton() {
  const btn = document.getElementById('replay-play-btn');
  if (btn) btn.textContent = replayTimer ? '⏸' : '▶';
}

// Re-renders everything that depends on the replay-filtered position set.
// Mirrors toggleSource()'s conditional-by-tab pattern to keep animated
// playback cheap (raw table / segment grid only recompute when visible).
function onReplayChange() {
  renderGrid();
  renderCoveragePolygons();
  updateTimeWindowInfo();
  updateReplayLabel();
  if (showGaps) renderGapLines();
  if (rightTab === 'raw')   renderRawTable();
  if (rightTab === 'stats') renderStats();
  if (rightTab === 'segs')  { segmentData = null; renderSegmentGrid(); }
}

function playReplay() {
  if (replayTimer || replayStart == null) return;
  if (replayCursor >= replayEnd) replayCursor = replayStart; // restart from beginning if at end
  replayTimer = setInterval(() => {
    replayCursor = Math.min(replayEnd, replayCursor + replaySpeed * (REPLAY_TICK_MS / 1000));
    const slider = document.getElementById('replay-slider');
    if (slider) slider.value = replayCursor;
    onReplayChange();
    if (replayCursor >= replayEnd) pauseReplay();
  }, REPLAY_TICK_MS);
  updatePlayButton();
}

function pauseReplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  updatePlayButton();
}

function toggleReplayPlay() {
  if (replayTimer) pauseReplay(); else playReplay();
}

function scrubReplay(val) {
  pauseReplay();
  replayCursor = parseInt(val);
  onReplayChange();
}

function setReplaySpeed(val) {
  replaySpeed = parseInt(val);
}

// ── Source toggle list ─────────────────────────────────────────────────────────
function renderSourceList(foundSources) {
  const el = document.getElementById('src-list');
  if (!foundSources.size) {
    el.innerHTML = '<div class="text-dim" style="font-size:13px">No RF data for this race</div>';
    return;
  }
  el.innerHTML = [...foundSources].map(src => {
    const m = srcMeta(src);
    const s = summary[src] || {};
    return `
      <div class="src-row">
        <input type="checkbox" id="chk-${src}" checked onchange="RF.toggleSource('${src}', this.checked)">
        <span class="src-dot" style="background:${m.color}"></span>
        <label class="src-label" for="chk-${src}" style="font-size:14px">${m.label}</label>
        <span class="src-count">${(s.count || 0).toLocaleString()}</span>
      </div>`;
  }).join('');
}

// ── Summary stats ──────────────────────────────────────────────────────────────
function renderStats() {
  const el = document.getElementById('stats-body');
  const visible = filteredPositions();

  if (!Object.keys(summary).length) {
    el.innerHTML = '<span class="text-dim" style="font-size:13px">No data</span>';
    return;
  }

  // Recompute totals over visible (time-filtered) positions
  const totalVisible = visible.length;
  const uniqueNodes  = new Set(visible.map(p => p.node_id)).size;

  let html = `
    <div class="ctrl-block">
      <div class="ctrl-title">Overall</div>
      <div class="stat-row"><span>Packets (window)</span><span class="stat-val">${totalVisible.toLocaleString()}</span></div>
      <div class="stat-row"><span>Unique nodes</span><span class="stat-val">${uniqueNodes}</span></div>
    </div>`;

  // Per-source breakdown — recompute over visible window
  const srcGroups = {};
  for (const p of visible) {
    const s = p.rf_source || 'meshtastic';
    if (!srcGroups[s]) srcGroups[s] = { count: 0, snrs: [], rssis: [], nodes: new Set(), first_ts: p.timestamp, last_ts: p.timestamp };
    srcGroups[s].count++;
    srcGroups[s].nodes.add(p.node_id);
    if (p.snr  != null) srcGroups[s].snrs.push(p.snr);
    if (p.rssi != null) srcGroups[s].rssis.push(p.rssi);
    if (p.timestamp < srcGroups[s].first_ts) srcGroups[s].first_ts = p.timestamp;
    if (p.timestamp > srcGroups[s].last_ts)  srcGroups[s].last_ts  = p.timestamp;
  }

  for (const [src, sg] of Object.entries(srcGroups)) {
    const m     = srcMeta(src);
    const avgSnr  = sg.snrs.length  ? sg.snrs.reduce((a, b) => a + b, 0)  / sg.snrs.length  : null;
    const avgRssi = sg.rssis.length ? sg.rssis.reduce((a, b) => a + b, 0) / sg.rssis.length : null;
    const dur     = sg.last_ts - sg.first_ts;
    const h = Math.floor(dur / 3600), mn = Math.floor((dur % 3600) / 60);
    const timeStr = dur > 60 ? (h ? `${h}h ${mn}m` : `${mn}m`) : '';
    const snrColor  = snrQualityColor(avgSnr);
    html += `
      <div class="ctrl-block">
        <div class="ctrl-title" style="color:${m.color}">${m.label}</div>
        <div class="stat-row"><span>Packets</span><span class="stat-val">${sg.count.toLocaleString()}</span></div>
        <div class="stat-row"><span>Nodes</span><span class="stat-val">${sg.nodes.size}</span></div>
        ${avgSnr  != null ? `<div class="stat-row"><span>Avg SNR</span><span class="stat-val" style="color:${snrColor}">${avgSnr.toFixed(1)} dB</span></div>` : ''}
        ${avgRssi != null ? `<div class="stat-row"><span>Avg RSSI</span><span class="stat-val" style="color:${rssiQualityColor(avgRssi)}">${Math.round(avgRssi)} dBm</span></div>` : ''}
        ${timeStr ? `<div class="stat-row"><span>Duration</span><span class="stat-val">${timeStr}</span></div>` : ''}
        ${avgSnr != null ? renderSignalBar(avgSnr, 'snr') : ''}
      </div>`;
  }
  el.innerHTML = html;
}

// Signal quality color helpers
function snrQualityColor(snr) {
  if (snr == null) return 'var(--text3)';
  if (snr >= 5)   return '#58a6ff';
  if (snr >= 0)   return '#3fb950';
  if (snr >= -10) return '#fafa00';
  if (snr >= -15) return '#ffa657';
  return '#f85149';
}
function rssiQualityColor(rssi) {
  if (rssi == null) return 'var(--text3)';
  if (rssi >= -80)  return '#58a6ff';
  if (rssi >= -100) return '#3fb950';
  if (rssi >= -115) return '#fafa00';
  if (rssi >= -125) return '#ffa657';
  return '#f85149';
}
function renderSignalBar(snr, type) {
  const norm = type === 'snr'
    ? Math.max(0, Math.min(1, (snr + 20) / 30))
    : Math.max(0, Math.min(1, (snr + 140) / 80));
  const pct = Math.round(norm * 100);
  return `
    <div style="margin-top:6px">
      <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden">
        <div style="height:100%;width:${pct}%;background:linear-gradient(to right,#f85149,#fafa00,#3fb950,#58a6ff);border-radius:3px"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-top:2px">
        <span>Weak</span><span>Strong</span>
      </div>
    </div>`;
}

// ── Node list ──────────────────────────────────────────────────────────────────
function renderNodeList() {
  const el = document.getElementById('node-list');
  if (!nodeSummary.length) {
    el.innerHTML = '<span class="text-dim" style="font-size:13px">No data</span>';
    return;
  }

  const healthColors = computeHealthScores();

  el.innerHTML = nodeSummary.map((n, i) => {
    const m = srcMeta(n.rf_source);
    const displayName = n.participant_name
      ? `#${n.bib} ${n.participant_name}`
      : (n.long_name || n.short_name || n.node_id);
    const hColor  = healthColors[i];
    const hDot    = hColor ? `<span class="health-dot" style="background:${hColor}" title="Packet rate health"></span>` : '';
    const intervals = computeNodeIntervals(n.node_id);
    const spark   = intervals.some(v => v > 0) ? renderSparkline(intervals) : '';
    const snrStr  = n.avg_snr  != null ? `SNR ${Math.round(n.avg_snr)} dB`   : '';
    const rssiStr = n.avg_rssi != null ? `RSSI ${Math.round(n.avg_rssi)} dBm` : '';
    const sigStr  = [snrStr, rssiStr].filter(Boolean).join('  ');
    return `
      <div class="node-row" title="${n.node_id}">
        ${hDot}
        <span class="src-dot" style="background:${m.color}"></span>
        <span class="node-name">${displayName}</span>
        <span class="node-pkt">${n.packet_count.toLocaleString()}${spark}</span>
      </div>
      ${sigStr ? `<div style="font-size:11px;color:${snrQualityColor(n.avg_snr)};padding:0 4px 4px 22px">${sigStr}</div>` : ''}`;
  }).join('');
}

// ── Raw data table ─────────────────────────────────────────────────────────────
function renderRawTable() {
  const tbody = document.getElementById('raw-tbody');
  const visible = filteredPositions();
  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text3);padding:10px;text-align:center">No data</td></tr>';
    return;
  }
  const rows = [...visible].slice(-500).reverse();
  tbody.innerHTML = rows.map(p => {
    const src  = p.rf_source || 'meshtastic';
    const m    = srcMeta(src);
    const time = p.timestamp
      ? new Date(p.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';
    const snrC = p.snr  != null ? `style="color:${snrQualityColor(p.snr)}"` : '';
    const rsiC = p.rssi != null ? `style="color:${rssiQualityColor(p.rssi)}"` : '';
    const node = p.node_id ? p.node_id.slice(-6) : '—';
    return `<tr>
      <td>${time}</td>
      <td><span style="color:${m.color}">${m.label.slice(0, 4)}</span></td>
      <td title="${p.node_id || ''}">${node}</td>
      <td>${p.lat?.toFixed(5) ?? '—'}</td>
      <td>${p.lon?.toFixed(5) ?? '—'}</td>
      <td ${snrC}>${p.snr  != null ? p.snr  + ' dB'  : '—'}</td>
      <td ${rsiC}>${p.rssi != null ? p.rssi + ' dBm' : '—'}</td>
    </tr>`;
  }).join('');
}

// ── Coverage polygon (convex hull per source) ──────────────────────────────────
// Approach adapted from trackdirect: convex hull of received positions, drawn as
// a filled polygon to show the geographic extent of RF coverage per technology.
function toggleCoverage(checked) {
  showCoverage = checked;
  renderCoveragePolygons();
}

function renderCoveragePolygons() {
  // Remove existing coverage layers
  for (const lyr of Object.values(coverageLayers)) {
    if (lyr) leafletMap.removeLayer(lyr);
  }
  coverageLayers = {};
  if (!showCoverage) return;

  const visible = filteredPositions();
  if (!visible.length) return;

  // Group by source
  const bySource = {};
  for (const p of visible) {
    const src = p.rf_source || 'meshtastic';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push([p.lat, p.lon]);
  }

  for (const [src, pts] of Object.entries(bySource)) {
    if (!activeSources.has(src)) continue;
    const hull = convexHull(pts);
    if (hull.length < 3) continue;
    const m = srcMeta(src);
    coverageLayers[src] = L.polygon(hull, {
      color:       m.color,
      weight:      1.5,
      opacity:     0.7,
      fillColor:   m.color,
      fillOpacity: 0.10,
      dashArray:   '5,4',
    }).bindTooltip(`${m.label} coverage area — ${pts.length.toLocaleString()} packets`).addTo(leafletMap);
  }
}

// Gift-wrapping (Jarvis march) convex hull — O(nh), fine for ≤10k points
function convexHull(points) {
  const n = points.length;
  if (n < 3) return points;

  // Find leftmost point (min longitude)
  let l = 0;
  for (let i = 1; i < n; i++) {
    if (points[i][1] < points[l][1]) l = i;
  }

  const hull = [];
  let p = l;
  do {
    hull.push(points[p]);
    let q = (p + 1) % n;
    for (let i = 0; i < n; i++) {
      if (ccw(points[p], points[i], points[q]) > 0) q = i;
    }
    p = q;
    if (hull.length > n) break; // safety
  } while (p !== l);

  return hull;
}

// Cross product z-component — positive = counter-clockwise
function ccw(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

// ── Grid square rendering ──────────────────────────────────────────────────────
function densityOpacity(count) {
  if (count >= 31) return 0.82;
  if (count >= 12) return 0.65;
  if (count >=  5) return 0.48;
  if (count >=  2) return 0.28;
  return 0.12;
}

function gridCellBounds(lat, lon, dLat, dLon) {
  return [[lat - dLat, lon - dLon], [lat + dLat, lon + dLon]];
}

function buildGridCells(source) {
  const positions = filteredPositions().filter(p => (p.rf_source || 'meshtastic') === source);
  if (!positions.length) return [];

  const midLat     = positions.reduce((s, p) => s + p.lat, 0) / positions.length;
  const dLat       = (gridSizeM / 111320) / 2;
  const dLon       = (gridSizeM / (111320 * Math.cos(midLat * Math.PI / 180))) / 2;
  const cellDeg    = dLat * 2;
  const cellLonDeg = dLon * 2;

  const cells = new Map();
  for (const p of positions) {
    const clat = Math.round(p.lat / cellDeg)    * cellDeg;
    const clon = Math.round(p.lon / cellLonDeg) * cellLonDeg;
    const key  = `${clat},${clon}`;
    if (!cells.has(key)) cells.set(key, { lat: clat, lon: clon, count: 0, snrSum: 0, rssiSum: 0, snrN: 0, rssiN: 0 });
    const c = cells.get(key);
    c.count++;
    if (p.snr  != null) { c.snrSum  += p.snr;  c.snrN++;  }
    if (p.rssi != null) { c.rssiSum += p.rssi; c.rssiN++; }
  }
  return [...cells.values()].map(c => ({
    ...c,
    avgSnr:  c.snrN  ? c.snrSum  / c.snrN  : null,
    avgRssi: c.rssiN ? c.rssiSum / c.rssiN : null,
    dLat, dLon,
  }));
}

// Shared canvas renderer for all grid cells — reusing one avoids Leaflet
// registering a separate canvas layer per rectangle, which gets expensive
// fast at small cell sizes (thousands of cells for a busy race).
let gridRenderer = null;

function renderGrid() {
  for (const lg of Object.values(cellLayers)) leafletMap.removeLayer(lg);
  cellLayers = {};
  if (!gridRenderer) gridRenderer = L.canvas();

  let totalCells = 0;
  for (const source of activeSources) {
    const cells = buildGridCells(source);
    if (!cells.length) continue;
    totalCells += cells.length;

    const srcColor = srcMeta(source).color;
    const rects = cells.map(c => {
      let fillColor, fillOpacity;
      if (metric === 'snr') {
        fillColor   = snrQualityColor(c.avgSnr);
        fillOpacity = c.avgSnr != null ? 0.65 : 0;
      } else if (metric === 'rssi') {
        fillColor   = rssiQualityColor(c.avgRssi);
        fillOpacity = c.avgRssi != null ? 0.65 : 0;
      } else {
        fillColor   = srcColor;
        fillOpacity = densityOpacity(c.count);
      }
      const tip = `${srcMeta(source).label}: ${c.count} packet${c.count !== 1 ? 's' : ''}`
                + (c.avgSnr  != null ? ` · SNR ${c.avgSnr.toFixed(1)} dB`    : '')
                + (c.avgRssi != null ? ` · RSSI ${c.avgRssi.toFixed(0)} dBm` : '');
      return L.rectangle(
        gridCellBounds(c.lat, c.lon, c.dLat, c.dLon),
        {
          color:       srcColor,
          weight:      0.5,
          opacity:     0.5,
          fillColor,
          fillOpacity: fillOpacity * heatOpacity,
          renderer:    gridRenderer,
        }
      ).bindTooltip(tip);
    });
    cellLayers[source] = L.layerGroup(rects).addTo(leafletMap);
  }
  renderLegend(totalCells > 0);
}

function renderLegend(hasCells) {
  const legend = document.getElementById('signal-legend');
  if (!hasCells) { legend.classList.remove('visible'); return; }
  legend.classList.add('visible');

  if (metric === 'density') {
    const firstSrc = [...activeSources][0];
    const color    = firstSrc ? srcMeta(firstSrc).color : '#8b949e';
    const levels   = [
      { label: '1',     op: 0.12 },
      { label: '2–4',   op: 0.28 },
      { label: '5–11',  op: 0.48 },
      { label: '12–30', op: 0.65 },
      { label: '31+',   op: 0.82 },
    ];
    legend.innerHTML = `
      <div style="font-size:11px;letter-spacing:1px;color:var(--text3);margin-bottom:5px">PACKETS / CELL</div>
      <div style="display:flex;gap:6px;align-items:flex-end">
        ${levels.map(l => `
          <div style="text-align:center">
            <div style="width:22px;height:22px;background:${color};opacity:${l.op};border:1px solid ${color};border-radius:2px;margin:0 auto 2px"></div>
            <div style="font-size:9px;color:var(--text3)">${l.label}</div>
          </div>`).join('')}
      </div>`;
  } else if (metric === 'snr') {
    legend.innerHTML = `
      <div style="font-size:11px;letter-spacing:1px;color:var(--text3);margin-bottom:5px">SNR</div>
      <div style="display:flex;gap:3px;align-items:flex-end">
        ${[['#f85149','&lt;−15'],['#ffa657','−15→−10'],['#fafa00','−10→0'],['#3fb950','0→5'],['#58a6ff','&gt;5 dB']].map(([c, l]) => `
          <div style="text-align:center">
            <div style="width:28px;height:22px;background:${c};border-radius:2px;margin:0 auto 2px;opacity:0.85"></div>
            <div style="font-size:9px;color:var(--text3);white-space:nowrap">${l}</div>
          </div>`).join('')}
      </div>`;
  } else {
    legend.innerHTML = `
      <div style="font-size:11px;letter-spacing:1px;color:var(--text3);margin-bottom:5px">RSSI</div>
      <div style="display:flex;gap:3px;align-items:flex-end">
        ${[['#f85149','&lt;−125'],['#ffa657','−125→−115'],['#fafa00','−115→−100'],['#3fb950','−100→−80'],['#58a6ff','&gt;−80 dBm']].map(([c, l]) => `
          <div style="text-align:center">
            <div style="width:28px;height:22px;background:${c};border-radius:2px;margin:0 auto 2px;opacity:0.85"></div>
            <div style="font-size:9px;color:var(--text3);white-space:nowrap">${l}</div>
          </div>`).join('')}
      </div>`;
  }
}

// ── Right panel tabs ───────────────────────────────────────────────────────────
function switchTab(id) {
  rightTab = id;
  ['stats', 'nodes', 'segs', 'stns', 'raw'].forEach(t => {
    document.getElementById(`rp-tab-${t}`)?.classList.toggle('active', t === id);
    const el = document.getElementById(`rp-${t}`);
    if (el) el.style.display = t === id ? '' : 'none';
  });
  if (id === 'raw')  renderRawTable();
  if (id === 'segs') renderSegmentGrid();
  if (id === 'stns') renderStationMatrix();
}

// ── Controls ───────────────────────────────────────────────────────────────────
function toggleSource(src, checked) {
  if (checked) activeSources.add(src);
  else         activeSources.delete(src);
  segmentData = null; // recompute segments with new source filter
  renderGrid();
  renderCoveragePolygons();
  updateTimeWindowInfo();
  if (showGaps) renderGapLines();
  if (rightTab === 'raw')  renderRawTable();
  if (rightTab === 'stats') renderStats();
  if (rightTab === 'segs')  renderSegmentGrid();
}

function setMetric(m) {
  metric = m;
  ['density', 'snr', 'rssi'].forEach(id => {
    document.getElementById('btn-' + id)?.classList.toggle('active', id === m);
  });
  renderGrid();
}

function setOpacity(val) {
  heatOpacity = val / 100;
  document.getElementById('lbl-opacity').textContent = val + '%';
  renderGrid();
}

function setGridSize(val) {
  gridSizeM = parseInt(val);
  renderGrid();
}

async function clearData() {
  if (!currentRaceId) return;
  const race = races.find(r => r.id === currentRaceId);
  if (!confirm(`Clear ALL RF position data for "${race?.name || currentRaceId}"?\n\nThis permanently deletes all stored tracker packets for this race. Participant results and events are not affected.`)) return;
  const res = await RT.del(`/api/races/${currentRaceId}/rf-analysis`);
  if (!res.ok) { RT.toast('Failed to clear data', 'warn'); return; }
  RT.toast(`Cleared ${res.data?.deleted ?? 0} records`, 'ok');
  await selectRace(currentRaceId);
}

function showLoading(on) {
  document.getElementById('loading-overlay').style.display = on ? 'flex' : 'none';
}

init();

return { selectRace, toggleSource, setMetric, setOpacity, setGridSize,
         clearData, switchTab, setTimeWindow, toggleCoverage,
         toggleGaps, setGapMin, setBaseLayer,
         toggleReplayPlay, scrubReplay, setReplaySpeed };
})();
