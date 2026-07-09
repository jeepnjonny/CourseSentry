'use strict';
const VW = (() => {
let race = null, participants = {}, stations = [], heats = {}, trackPoints = null;
let leafletMap, markerLayer, routeLayer, stationMarkers = {};
let sortBy = 'position', clockInterval;
let fmt24 = false;
let mapMode = true; // vs leaderboard on mobile
let viewerLayersControl = null, viewerBaseTiles = null, currentViewerBaseLayer = null, currentViewerBaseLayerName = 'Topo';
let viewerLegendControl = null, activeViewerOverlays = new Set(), viewerWeatherOpacity = 0.55;

const LAYER_LEGENDS = {
'Precipitation': { label:'PRECIP (mm/h)',    grad:'#c8e6fa,#64b4fa,#1464d2,#00be00,#fafa00,#fa8c32,#fa3232', ticks:['0.1','1','5','25','100','140'] },
  'Clouds':        { label:'CLOUD COVER',      grad:'rgba(255,255,255,0.15),#888888',                   ticks:['0%','50%','100%'] },
  'Wind Speed':    { label:'WIND (m/s)',        grad:'#ffffff,#64c8fa,#1464d2,#00be00,#fafa00,#fa6400,#fa0000', ticks:['0','5','15','25','50','200'] },
  'Temperature':   { label:'TEMPERATURE (°F)', grad:'#820eb4,#1464d2,#20e8e8,#28b428,#f0f032,#fa8c32,#fa3232', ticks:['-4','32','59','86','104'] },
  'Radar':         { label:'RADAR (dBZ)',      grad:'#00ccff,#0066ff,#00ff00,#ffff00,#ff6600,#ff0000,#8b0000', ticks:['-30','-10','10','30','50','70'] },
  'Lightning':     { label:'LIGHTNING STRIKES', grad:'#1a1a2e,#16213e,#0f3460,#e94560', ticks:['0','1h','6h','24h'] },
};

const BASE_LAYERS = {
  'Topo':      { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', opts:{ maxZoom:16, maxNativeZoom:16, attribution:'USGS' } },
  'Satellite': { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', opts:{ maxZoom:16, maxNativeZoom:16, attribution:'USGS' } },
  'Street':    { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opts:{ maxZoom:19, attribution:'© OSM' } },
  'Dark':      { url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', opts:{ subdomains:'abcd', maxZoom:19, attribution:'© CartoDB' } },
};

// Extract viewer token from URL: /view/:token
const token = location.pathname.split('/view/')[1]?.split('/')[0];

async function init() {
  if (!token) { document.body.innerHTML = '<div style="padding:40px;color:#f78166;font-family:monospace">Invalid viewer link.</div>'; return; }
  initMap();
  RT.connectWS(handleWS, token);
  startClock();
}

function initMap() {
  leafletMap = L.map('viewer-map', { zoomControl: true, maxZoom: 16 });
  markerLayer = L.layerGroup().addTo(leafletMap);
  viewerBaseTiles = {};
  for (const [name, cfg] of Object.entries(BASE_LAYERS)) {
    viewerBaseTiles[name] = L.tileLayer(cfg.url, cfg.opts);
  }
  setViewerBaseLayer('Topo');
  leafletMap.setView([39.5, -98.5], 5);
  leafletMap.on('overlayadd',    e => { activeViewerOverlays.add(e.name);    updateViewerLegend(); VW.setViewerWeatherOpacity(Math.round(viewerWeatherOpacity * 100)); });
  leafletMap.on('overlayremove', e => { activeViewerOverlays.delete(e.name); updateViewerLegend(); });
}

function updateBaseLayerSelector() {
  const sel = document.getElementById('vw-base-layer-sel');
  if (!sel) return;
  const offlineOnly = !!(race?.offline_maps && race?.offline_maps_status === 'ready');
  for (const opt of sel.options) {
    const capable = opt.value === 'Topo' || opt.value === 'Satellite';
    opt.hidden   = offlineOnly && !capable;
    opt.disabled = offlineOnly && !capable;
  }
  if (offlineOnly && sel.value !== 'Topo' && sel.value !== 'Satellite') {
    setViewerBaseLayer('Topo');
  }
}

function getSpeedDisplayLabel() {
  return race?.speed_display === 'speed' ? 'SPEED' : 'PACE';
}

function applySpeedDisplayLabels() {
  const headerLabel = document.querySelector('#viewer-lb-wrap .v-lb-head span:nth-child(5)');
  if (headerLabel) headerLabel.textContent = getSpeedDisplayLabel();
  const sortBtn = document.querySelector('#viewer-sort-bar .v-sort-btn[data-sort="pace"]');
  if (sortBtn) sortBtn.textContent = getSpeedDisplayLabel();
}

function setViewerBaseLayer(name) {
  if (currentViewerBaseLayer) leafletMap.removeLayer(currentViewerBaseLayer);
  currentViewerBaseLayerName = name;
  const layerKey = name.toLowerCase(); // 'Topo' → 'topo', 'Satellite' → 'satellite'
  const OFFLINE_CAPABLE = { topo: true, satellite: true };
  const useOffline = race?.offline_maps && race?.offline_maps_status === 'ready' && OFFLINE_CAPABLE[layerKey];
  if (useOffline) {
    currentViewerBaseLayer = L.tileLayer(
      `${RT.BASE}api/tiles/${race.id}/${layerKey}/{z}/{x}/{y}`,
      { maxZoom: 16, maxNativeZoom: 14, attribution: 'USGS (offline)' }
    );
  } else {
    currentViewerBaseLayer = viewerBaseTiles[name] || viewerBaseTiles['Topo'];
  }
  currentViewerBaseLayer.addTo(leafletMap);
  const sel = document.getElementById('vw-base-layer-sel');
  if (sel) sel.value = name;
}

async function setupWeatherLayers(owmKey) {
  if (viewerLayersControl) { leafletMap.removeControl(viewerLayersControl); viewerLayersControl = null; }
  if (viewerLegendControl) { leafletMap.removeControl(viewerLegendControl); viewerLegendControl = null; }
  activeViewerOverlays.clear();

  const overlays = {};
  if (owmKey) {
    const owm = (layer) => L.tileLayer(
      `https://tile.openweathermap.org/map/${layer}/{z}/{x}/{y}.png?appid=${owmKey}`,
      { opacity: viewerWeatherOpacity, attribution: '© OpenWeatherMap', maxZoom: 16, zIndex: 200 }
    );
    overlays['&#127783; Precipitation'] = owm('precipitation_new');
    overlays['&#9729; Clouds']          = owm('clouds_new');
    overlays['&#127790; Wind Speed']    = owm('wind_new');
    overlays['&#127777; Temperature']   = owm('temp_new');
    overlays['&#128205; Radar (NWS)'] = L.tileLayer(
      'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q/{z}/{x}/{y}.png',
      { opacity: viewerWeatherOpacity, attribution: '© Iowa Environmental Mesonet / NOAA', maxZoom: 16, zIndex: 200 }
    );
    overlays['⚡ Lightning'] = L.tileLayer(
      'https://maps.gnosis.cards/tilecache/tile.py/1.0.0/lightning-10m/{z}/{x}/{y}.png',
      { opacity: viewerWeatherOpacity, attribution: '© Blitzortung', maxZoom: 16, zIndex: 200 }
    );
  }
  if (Object.keys(overlays).length)
    viewerLayersControl = L.control.layers({}, overlays, { collapsed: true, position: 'topright' }).addTo(leafletMap);
  if (Object.keys(overlays).length) {
    viewerLegendControl = L.control({ position: 'bottomright' });
    viewerLegendControl.onAdd = () => {
      const div = L.DomUtil.create('div', '');
      div.id = 'vw-wx-legend';
      div.style.cssText = 'display:none;background:var(--surface,#161b22);border:1px solid var(--border,#30363d);border-radius:6px;padding:8px 10px;font-family:monospace;min-width:170px;pointer-events:auto';
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    viewerLegendControl.addTo(leafletMap);
  }
}

function updateViewerLegend() {
  const div = document.getElementById('vw-wx-legend');
  if (!div) return;
  if (activeViewerOverlays.size === 0) { div.style.display = 'none'; return; }
  const name = [...activeViewerOverlays].at(-1);
  const key = Object.keys(LAYER_LEGENDS).find(k => name.includes(k));
  if (!key) { div.style.display = 'none'; return; }
  const spec = LAYER_LEGENDS[key];
  div.style.display = '';
  div.innerHTML = `
    <div style="font-size:10px;letter-spacing:1px;color:var(--text3,#7d8590);margin-bottom:4px">${spec.label}</div>
    <div style="height:8px;width:150px;border-radius:3px;background:linear-gradient(to right,${spec.grad});margin-bottom:3px"></div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text2,#8b949e);margin-bottom:6px">${spec.ticks.map(t=>`<span>${t}</span>`).join('')}</div>
    <div style="display:flex;align-items:center;gap:6px">
      <span style="font-size:10px;color:var(--text3,#7d8590)">Opacity:</span>
      <input type="range" min="10" max="100" value="${Math.round(viewerWeatherOpacity * 100)}" style="flex:1" oninput="VW.setViewerWeatherOpacity(this.value)">
      <span id="vw-wx-opacity-lbl" style="font-size:10px;color:var(--text2,#8b949e);min-width:30px">${Math.round(viewerWeatherOpacity * 100)}%</span>
    </div>`;
}

function setViewerWeatherOpacity(val) {
  viewerWeatherOpacity = val / 100;
  document.getElementById('vw-wx-opacity-lbl').textContent = val + '%';
  // Update opacity of all active weather overlays
  leafletMap.eachLayer(layer => {
    if (layer.options && layer.options.attribution === '© OpenWeatherMap') {
      layer.setOpacity(viewerWeatherOpacity);
    }
  });
}

function handleWS(msg) {
  const { type, data } = msg;
  if (type === 'init') handleInit(data);
  else if (type === 'position') handlePosition(data);
  else if (type === 'event') handleEvent(data);
  else if (type === 'participant_update') handleParticipantUpdate(data);
  else if (type === 'race_update') {
    if (race && data.id === race.id) {
      const wasOfflineReady = race.offline_maps_status === 'ready';
      const prevNametags = race.viewer_nametags;
      const prevShowNames = race.viewer_show_names;
      race = data;
      applySpeedDisplayLabels();
      if (!wasOfflineReady && race.offline_maps_status === 'ready') setViewerBaseLayer(currentViewerBaseLayerName);
      updateBaseLayerSelector();
      document.getElementById('viewer-lb-wrap')?.classList.toggle('names-hidden', !(race.viewer_show_names ?? 1));
      if (race.viewer_nametags !== prevNametags || race.viewer_show_names !== prevShowNames) renderAllMarkers();
    }
  }
}

function handleInit(data) {
  if (!data.race) {
    document.getElementById('vw-race-pill').textContent = 'NO ACTIVE RACE';
    return;
  }
  race = data.race;
  fmt24 = race.time_format === '24h';
  applySpeedDisplayLabels();
  document.getElementById('vw-race-pill').className = 'pill pill-ok';
  document.getElementById('vw-race-pill').textContent = race.name.toUpperCase();
  document.getElementById('viewer-lb-wrap')?.classList.toggle('names-hidden', !(race.viewer_show_names ?? 1));

  heats = {}; (data.heats || []).forEach(h => heats[h.id] = h);
  stations = data.stations || [];
  participants = {};
  (data.participants || []).forEach(p => {
    participants[p.id] = enrichParticipant(p, data.registry || []);
  });

  if (data.trackPoints?.length) { trackPoints = data.trackPoints; _cachedDists = null; _total = null; _stationAlongCache = null; }
  renderRoute();
  renderStationMarkers();
  renderAllMarkers();
  renderLeaderboard();
  if (race.weather_enabled) setupWeatherLayers(data.weatherKey);
  // Restrict selector and switch to offline URLs if already ready
  updateBaseLayerSelector();
  if (race.offline_maps && race.offline_maps_status === 'ready') setViewerBaseLayer(currentViewerBaseLayerName);
}

function enrichParticipant(p, registry) {
  const heat = p.heat_id ? heats[p.heat_id] : null;
  const reg = registry ? registry.find(r => r.node_id === p.tracker_id || r.long_name === p.tracker_id) : null;
  return { ...p, heat, registry: reg, _lastStation: p.last_station_name || null };
}

function renderRoute() {
  if (routeLayer) { leafletMap.removeLayer(routeLayer); routeLayer = null; }
  if (!trackPoints || trackPoints.length < 2) return;
  routeLayer = L.polyline(trackPoints, { color: '#f5a623', weight: 5, opacity: 0.85 }).addTo(leafletMap);
  leafletMap.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
}

function renderStationMarkers() {
  Object.values(stationMarkers).forEach(m => leafletMap.removeLayer(m));
  stationMarkers = {};
  for (const s of stations) {
    if (s.type === 'netcontrol' || s.type === 'repeater') continue;
    const color = s.type === 'start' ? '#3fb950' : s.type === 'finish' ? '#f78166' :
                  s.type === 'start_finish' ? '#a371f7' : s.type === 'turnaround' ? '#58a6ff' :
                  s.type === 'netcontrol' ? '#d2993a' : s.type === 'repeater' ? '#6e7681' : '#d2a679';
    const letter = s.type === 'start' ? 'S' : s.type === 'finish' ? 'F' :
                   s.type === 'start_finish' ? '⇌' : s.type === 'turnaround' ? 'T' :
                   s.type === 'netcontrol' ? 'N' : s.type === 'repeater' ? 'R' : s.name[0]?.toUpperCase() || 'A';
    const icon = L.divIcon({
      html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2px solid #fff4;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;color:#000">${letter}</div>`,
      className: '', iconAnchor: [10, 10],
    });
    const m = L.marker([s.lat, s.lon], { icon }).bindTooltip(s.name).addTo(leafletMap);
    stationMarkers[s.id] = m;
  }
}

function renderAllMarkers() {
  markerLayer.clearLayers();
  for (const p of Object.values(participants)) {
    if (p.last_lat && p.last_lon) createMarker(p);
  }
  // Auto-fit map to markers
  const pts = Object.values(participants).filter(p => p.last_lat);
  if (pts.length >= 2) {
    const bounds = L.latLngBounds(pts.map(p => [p.last_lat, p.last_lon]));
    leafletMap.fitBounds(bounds, { padding: [30, 30] });
  } else if (pts.length === 1) {
    leafletMap.setView([pts[0].last_lat, pts[0].last_lon], 14);
  }
}

function createMarker(p) {
  const label = RT.fmtLabel(p.name);
  const heat = p.heat_id ? heats[p.heat_id] : null;
  const { svg } = RT.trackerIcon(heat, false, false);
  const nametags = !!(race?.viewer_nametags);
  const showNames = !!(race?.viewer_show_names ?? 1);
  const tooltipText = showNames ? `#${p.bib} ${label}` : `#${p.bib}`;
  const icon = L.divIcon({ html: `<div>${svg}</div>`, className: 'leaflet-div-icon', iconAnchor: [10, 10] });
  const m = L.marker([p.last_lat, p.last_lon], { icon });
  m._pid = p.id;
  m.bindTooltip(tooltipText, {
    permanent: nametags, direction: 'top', offset: [0, -6], className: 'map-nametag',
  });
  m.addTo(markerLayer);
}

function handlePosition(data) {
  const { nodeId, lat, lon, timestamp } = data;
  const p = Object.values(participants).find(x => x.tracker_id === nodeId ||
    (x.registry && (x.registry.long_name === nodeId || x.registry.short_name === nodeId)));
  if (!p) return;
  p.last_lat = lat; p.last_lon = lon;
  if (!p.registry) p.registry = {};
  p.registry.last_seen = timestamp;
  // Update marker
  const existing = markerLayer.getLayers().find(m => m._pid === p.id);
  if (existing) existing.setLatLng([lat, lon]);
  else createMarker(p);
  renderLeaderboard();
}

function handleEvent(data) {
  const p = participants[data.participant_id];
  if (!p) return;
  if (data.event_type === 'start')  { p.status = 'active';   p.start_time = data.timestamp; }
  if (data.event_type === 'finish') p.status = 'finished';
  if (data.event_type === 'dnf')    p.status = 'dnf';
  if (data.has_turnaround && !p.has_turnaround) {
    p.has_turnaround = true;
    const td = _total || computeTotal();
    if (td) { p._lastAlong = td; p._lastAlongTs = data.timestamp; }
  }
  if (data.station_id && !p.has_turnaround) {
    const along = getStationAlongMap().get(data.station_id);
    if (along != null) p._stationFloor = Math.max(p._stationFloor ?? 0, along);
    p.last_station_id = data.station_id;
    p.last_station_ts = data.timestamp;
  }
  if (data.event_type === 'aid_depart' && data.station_name)
    p._lastStation = data.station_name;
  renderLeaderboard();
}

function handleParticipantUpdate(data) {
  if (data.action === 'delete') { delete participants[data.id]; renderLeaderboard(); return; }
  if (data.action === 'clear') { participants = {}; renderLeaderboard(); return; }
  if (!data.participant) return;
  participants[data.participant.id] = enrichParticipant(data.participant, []);
  renderLeaderboard();
}

function fmtParticipantName(name) {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function renderLeaderboard() {
  const el = document.getElementById('viewer-lb-body');
  if (!el) return;
  const list = Object.values(participants).filter(p => race?.leaderboard_enabled !== 0);
  list.forEach(p => { p._pct = computePct(p); p._pace = computePace(p); });

  list.sort((a, b) => {
    if (sortBy === 'position') return (b._pct || 0) - (a._pct || 0);
    if (sortBy === 'bib') return String(a.bib).localeCompare(String(b.bib), undefined, { numeric: true });
    if (sortBy === 'pace') return (a._pace || Infinity) - (b._pace || Infinity);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'heat') return (a.heat?.name || '').localeCompare(b.heat?.name || '');
    return 0;
  });

  const STATUS_COLORS = { dns:'#8b949e', active:'#58a6ff', dnf:'#f78166', finished:'#3fb950' };

  el.innerHTML = list.map((p, i) => {
    const sc = STATUS_COLORS[p.status] || '#8b949e';
    const heat = p.heat_id ? heats[p.heat_id] : null;
    const dot = heat ? `<span class="dot" style="background:${heat.color}"></span>` : '';
    const pct = p._pct != null ? `${p._pct.toFixed(0)}%` : '--';
    const finished = p.status === 'finished';
    const lastAid = p._lastStation || '--';
    const escAttr = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const dispName = fmtParticipantName(p.name);
    return `<div class="v-lb-row v-lb-cols ${finished ? 'text-ok' : ''}">
      <span style="color:var(--text2)">${i+1}</span>
      <span style="color:${sc};font-weight:bold">${p.bib}</span>
      <span title="${escAttr(dispName)}">${dot} ${dispName}</span>
      <span style="color:var(--accent)">${pct}</span>
      <span style="color:var(--text);font-size:13px">${p._pct && p.start_time ? RT.fmtSpeed(p._pace, race?.speed_units || 'min_mile') : '--'}</span>
      <span style="color:var(--text2);font-size:13px" title="${escAttr(lastAid)}">${lastAid}</span>
    </div>`;
  }).join('');
}

function computePct(p) {
  if (p.status === 'finished') return 100;
  if (p.status === 'dns') return null;
  if (!p.last_lat || !trackPoints || !trackPoints.length) {
    if (p.last_station_id && trackPoints?.length) {
      ensureDistCache();
      if (!_total) return null;
      const along = getStationAlongMap().get(p.last_station_id);
      if (along == null) return null;
      if (race?.race_format === 'out_and_back') {
        if (p.has_turnaround) return Math.min(100, (2 * _total - along) / (2 * _total) * 100);
        return Math.min(50, along / (2 * _total) * 100);
      }
      return Math.min(100, along / _total * 100);
    }
    return null;
  }
  ensureDistCache();
  const totalDist = _total;
  if (!totalDist) return 0;

  // Option B: constrain search to reachable window given max race speed
  const now = Math.floor(Date.now() / 1000);
  const lastAlong = p._lastAlong ?? 0;
  const lastTs = p._lastAlongTs ?? (p.start_time || now);
  const travelDist = Math.max(0, now - lastTs) * MAX_RACE_SPEED + BACK_MARGIN;
  const windowMin = Math.max(0, lastAlong - travelDist);
  const windowMax = Math.min(totalDist, lastAlong + travelDist);

  let minD = Infinity, bestAlong = lastAlong;
  for (let i = 0; i < trackPoints.length - 1; i++) {
    if (_cachedDists[i+1] < windowMin || _cachedDists[i] > windowMax) continue;
    const [lat1,lon1] = trackPoints[i], [lat2,lon2] = trackPoints[i+1];
    const segLen = _cachedDists[i+1] - _cachedDists[i];
    const ax = p.last_lat - lat1, ay = p.last_lon - lon1, bx = lat2-lat1, by = lon2-lon1;
    const t = Math.max(0, Math.min(1, (ax*bx+ay*by)/Math.max(1e-10, bx*bx+by*by)));
    const d = haversine(p.last_lat, p.last_lon, lat1+t*bx, lon1+t*by);
    if (d < minD) { minD = d; bestAlong = _cachedDists[i] + t * segLen; }
  }

  // Option C: checkpoint floor (outbound leg only)
  if (!(race?.race_format === 'out_and_back' && p.has_turnaround))
    bestAlong = Math.max(bestAlong, p._stationFloor ?? 0);

  p._lastAlong = bestAlong;
  p._lastAlongTs = p.registry?.last_seen || now;

  if (race?.race_format === 'out_and_back') {
    if (p.has_turnaround) return Math.min(100, (2 * totalDist - bestAlong) / (2 * totalDist) * 100);
    return Math.min(50, bestAlong / (2 * totalDist) * 100);
  }
  return Math.min(100, bestAlong / totalDist * 100);
}

// Returns pace/speed in m/s, or null. Rendered via RT.fmtSpeed with race units.
function computePace(p) {
  if (!p.start_time || !p._pct) return null;
  const total = computeTotal();
  if (!total) return null;
  if (!p.last_lat && p.last_station_id && p.last_station_ts) {
    const along = getStationAlongMap().get(p.last_station_id);
    if (along == null || along <= 0) return null;
    const stationElapsed = p.last_station_ts - p.start_time;
    if (stationElapsed <= 0) return null;
    const distCovered = (race?.race_format === 'out_and_back' && p.has_turnaround)
      ? 2 * total - along : along;
    return distCovered / stationElapsed;
  }
  const dist = race?.race_format === 'out_and_back' ? total * 2 : total;
  // Finished: full course distance over actual elapsed time.
  if (p.status === 'finished' && p.finish_time) {
    const elapsed = p.finish_time - p.start_time;
    if (elapsed <= 0) return null;
    return dist / elapsed;
  }
  // In progress (GPS): distance covered so far (from _pct) over elapsed time.
  const elapsed = Math.floor(Date.now()/1000) - p.start_time;
  if (elapsed <= 0) return null;
  return (p._pct / 100 * dist) / elapsed;
}

let _total = null, _cachedDists = null, _stationAlongCache = null;
const MAX_RACE_SPEED = 8, BACK_MARGIN = 100;

function computeTotal() {
  ensureDistCache();
  return _total || 0;
}

function ensureDistCache() {
  if (_cachedDists || !trackPoints || trackPoints.length < 2) return;
  _cachedDists = [0];
  for (let i = 1; i < trackPoints.length; i++)
    _cachedDists.push(_cachedDists[i-1] + haversine(
      trackPoints[i-1][0], trackPoints[i-1][1], trackPoints[i][0], trackPoints[i][1]));
  _total = _cachedDists[_cachedDists.length - 1];
}

function getStationAlongMap() {
  if (_stationAlongCache) return _stationAlongCache;
  if (!trackPoints || trackPoints.length < 2) return new Map();
  ensureDistCache();
  _stationAlongCache = new Map();
  for (const s of stations) {
    if (!s.lat || !s.lon) continue;
    let minD = Infinity, best = 0;
    for (let i = 0; i < trackPoints.length - 1; i++) {
      const [lat1,lon1] = trackPoints[i], [lat2,lon2] = trackPoints[i+1];
      const ax = s.lat - lat1, ay = s.lon - lon1, bx = lat2-lat1, by = lon2-lon1;
      const t = Math.max(0, Math.min(1, (ax*bx+ay*by)/Math.max(1e-10, bx*bx+by*by)));
      const d = haversine(s.lat, s.lon, lat1+t*bx, lon1+t*by);
      if (d < minD) { minD = d; best = _cachedDists[i] + t*(_cachedDists[i+1]-_cachedDists[i]); }
    }
    _stationAlongCache.set(s.id, best);
  }
  return _stationAlongCache;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function setSort(key) {
  sortBy = key;
  document.querySelectorAll('.v-sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
  renderLeaderboard();
}

function switchTab(name) {
  mapMode = name === 'map';
  document.body.classList.toggle('lb-mode', !mapMode);
  document.querySelectorAll('.rt-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  if (mapMode) setTimeout(() => leafletMap?.invalidateSize(), 50);
}

function startClock() {
  clockInterval = setInterval(() => {
    if (!race) return;
    const active = Object.values(participants).find(p => p.status === 'active' && p.start_time);
    if (!active) return;
    const elapsed = Math.floor(Date.now()/1000) - active.start_time;
    document.getElementById('vw-clock').textContent = RT.fmtElapsed(elapsed > 0 ? elapsed : 0, race?.clock_seconds !== 0);
  }, 1000);
}

init();
return { setSort, switchTab, setViewerBaseLayer, setViewerWeatherOpacity };
})();
