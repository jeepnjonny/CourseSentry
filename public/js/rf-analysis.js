'use strict';
const RF = (() => {

// ── State ──────────────────────────────────────────────────────────────────────
let leafletMap = null;
let cellLayers      = {};   // src → L.layerGroup (grid squares)
let routeLayer      = null;
let stationLayer    = null;
let coverageLayers  = {};   // src → L.polygon

let races        = [];
let currentRaceId = null;
let allPositions  = [];   // raw from API [{node_id,lat,lon,snr,rssi,rf_source,timestamp}]
let nodeSummary   = [];   // from /nodes endpoint
let summary       = {};   // per-source stats (unfiltered)
let stationData   = [];
let routePoints   = [];

let activeSources   = new Set();
let metric          = 'density';   // 'density' | 'snr' | 'rssi'
let heatOpacity     = 0.70;
let gridSizeM       = 250;  // grid cell edge in meters
let rightTab        = 'stats';
let timeWindowMode  = 'race';      // 'race' | 'all'
let raceWindowStart = null;        // computed unix ts
let raceWindowEnd   = null;        // computed unix ts (null = live/now)
let showCoverage    = false;

// Source metadata
const SOURCE_META = {
  meshtastic: { color: '#58a6ff', label: 'Meshtastic', freq: '915 MHz LoRa' },
  aprs:       { color: '#3fb950', label: 'APRS',        freq: '144.390 MHz'  },
  lora_aprs:  { color: '#d2a679', label: 'LoRa APRS',   freq: '915 MHz LoRa' },
};
function srcMeta(src) {
  return SOURCE_META[src] || { color: '#8b949e', label: src, freq: '' };
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
  leafletMap = L.map('map', { zoomControl: true, maxZoom: 18 });
  L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, maxNativeZoom: 16, attribution: 'USGS',
  }).addTo(leafletMap);
  leafletMap.setView([39.5, -98.5], 5);
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

  // Compute race time bounds before any rendering
  computeRaceBounds();

  // Build active sources from data
  const foundSources = new Set(allPositions.map(p => p.rf_source || 'meshtastic'));
  activeSources = new Set(foundSources);

  renderSourceList(foundSources);
  renderStats();
  renderNodeList();
  renderRawTable();
  renderHeatmap();
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
  renderGrid();
  renderCoveragePolygons();
  renderRawTable();
  renderStats();
  updateTimeWindowInfo();
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

// Returns positions filtered by active sources AND time window
function filteredPositions() {
  let pts = allPositions.filter(p => activeSources.has(p.rf_source || 'meshtastic'));
  if (timeWindowMode === 'race' && raceWindowStart != null) {
    const endTs = raceWindowEnd ?? Math.floor(Date.now() / 1000);
    pts = pts.filter(p => p.timestamp >= raceWindowStart && p.timestamp <= endTs);
  }
  return pts;
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
        <label class="src-label" for="chk-${src}">
          <div style="font-size:14px">${m.label}</div>
          <div style="font-size:12px;color:var(--text3)">${m.freq}</div>
        </label>
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
  el.innerHTML = nodeSummary.map(n => {
    const m = srcMeta(n.rf_source);
    const displayName = n.participant_name
      ? `#${n.bib} ${n.participant_name}`
      : (n.long_name || n.short_name || n.node_id);
    const snrStr  = n.avg_snr  != null ? `SNR ${Math.round(n.avg_snr)} dB`   : '';
    const rssiStr = n.avg_rssi != null ? `RSSI ${Math.round(n.avg_rssi)} dBm` : '';
    const sigStr  = [snrStr, rssiStr].filter(Boolean).join('  ');
    return `
      <div class="node-row" title="${n.node_id}">
        <span class="src-dot" style="background:${m.color}"></span>
        <span class="node-name">${displayName}</span>
        <span class="node-pkt">${n.packet_count.toLocaleString()}</span>
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

function renderGrid() {
  for (const lg of Object.values(cellLayers)) leafletMap.removeLayer(lg);
  cellLayers = {};

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
          renderer:    L.canvas(),
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
  ['stats', 'nodes', 'raw'].forEach(t => {
    document.getElementById(`rp-tab-${t}`)?.classList.toggle('active', t === id);
    const el = document.getElementById(`rp-${t}`);
    if (el) el.style.display = t === id ? '' : 'none';
  });
  if (id === 'raw') renderRawTable();
}

// ── Controls ───────────────────────────────────────────────────────────────────
function toggleSource(src, checked) {
  if (checked) activeSources.add(src);
  else         activeSources.delete(src);
  renderGrid();
  renderCoveragePolygons();
  updateTimeWindowInfo();
  if (rightTab === 'raw') renderRawTable();
  if (rightTab === 'stats') renderStats();
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
         clearData, switchTab, setTimeWindow, toggleCoverage };
})();
