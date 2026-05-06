'use strict';
const OP = (() => {
// ── State ─────────────────────────────────────────────────────────────────────
let race = null, participants = {}, stations = [], heats = {}, classes = {};
let personnel = [], messages = [];
let markerLayer = null, routeLayer = null, stationMarkers = {}, trackPoints = null;
let leafletMap = null, currentBaseLayer = null, weatherLayersControl = null, weatherLegendControl = null;
let activeWeatherOverlays = new Set(), wxPoller = null;
let weatherOpacity = 0.55;
let wxData = null, wxError = null, wxDataTs = 0, wxForecast = null, wxAlerts = [];
let wxAlertPoller = null;
let owmKey = null;
let wxSetupInProgress = false;
let sortBy = 'position', selectedPId = null, selectedStationId = null;
let alerts = [], rightTab = 'info', leftTab = 'participants';
let batchStationId = null;

const LAYER_LEGENDS = {
'Precipitation': { label:'PRECIP (mm/h)',    grad:'#c8e6fa,#64b4fa,#1464d2,#00be00,#fafa00,#fa8c32,#fa3232', ticks:['0.1','1','5','25','100','140'] },
  'Clouds':        { label:'CLOUD COVER',      grad:'rgba(255,255,255,0.15),#888888',                   ticks:['0%','50%','100%'] },
  'Wind Speed':    { label:'WIND (m/s)',        grad:'#ffffff,#64c8fa,#1464d2,#00be00,#fafa00,#fa6400,#fa0000', ticks:['0','5','15','25','50','200'] },
  'Temperature':   { label:'TEMPERATURE (°F)', grad:'#820eb4,#1464d2,#20e8e8,#28b428,#f0f032,#fa8c32,#fa3232', ticks:['-4','32','59','86','104'] },
};
let clockInterval = null, missingCheckInterval = null, stoppedCheckInterval = null, lastSeenInterval = null;
let fmt24 = false;
let editingPId = null;

const BASE_LAYERS = {
  topo:      { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', opts:{ maxZoom:16, maxNativeZoom:16, attribution:'USGS' } },
  satellite: { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', opts:{ maxZoom:16, maxNativeZoom:16, attribution:'USGS' } },
  osm:       { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opts:{ maxZoom:19, attribution:'© OSM' } },
  dark:      { url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', opts:{ subdomains:'abcd', maxZoom:19, attribution:'© CartoDB' } },
};

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const user = await RT.requireLogin('operator');
  if (!user) return;
  if (user.role === 'admin') {
    document.getElementById('admin-btn').classList.remove('hidden');
    document.getElementById('no-race-admin-btn').classList.remove('hidden');
  }
  fmt24 = false;

  initMap();
  RT.connectWS(handleWS);
  await loadInitialData();
  startClock();
  missingCheckInterval = setInterval(checkMissing, 30000);
  stoppedCheckInterval = setInterval(checkStopped, 60000);
  startWxPoller();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function handleWS(msg) {
  const { type, data } = msg;
  if (type === 'init') handleInit(data);
  else if (type === 'position') handlePosition(data);
  else if (type === 'event') handleEvent(data);
  else if (type === 'alert') handleAlert(data);
  else if (type === 'message') handleMessage(data);
  else if (type === 'message_status') handleMessageStatus(data);
  else if (type === 'participant_update') handleParticipantUpdate(data);
  else if (type === 'station_update') handleStationUpdate(data);
  else if (type === 'personnel_update') handlePersonnelUpdate(data);
  else if (type === 'mqtt_status') updateMqttPill(data);
  else if (type === 'aprs_status') updateAprsPill(data);
  else if (type === 'tracker_info') handleTrackerInfo(data);
  else if (type === 'race_update') handleRaceUpdate(data);
}

function handleRaceUpdate(data) {
  if (!race || data.id !== race.id) return;
  race = data;
  updateStartWindowBtn();
  updateEndRaceBtn();
  updateStartRaceBtn();
  tickClock(); // re-evaluate freeze immediately
}

function updateEndRaceBtn() {
  const btn = document.getElementById('end-race-btn');
  if (!btn) return;
  btn.classList.toggle('hidden', !(race && race.status === 'active'));
}

function updateStartRaceBtn() {
  const btn = document.getElementById('start-race-btn');
  if (!btn) return;
  const hasUnstarted = Object.values(participants).some(p =>
    (!p.tracker_id) && !p.start_time && p.status !== 'dnf' && p.status !== 'finished'
  );
  btn.classList.toggle('hidden', !(race && race.status === 'active' && hasUnstarted));
}

async function startRace() {
  if (!race) return;
  const count = Object.values(participants).filter(p =>
    (!p.tracker_id) && p.status !== 'dnf' && p.status !== 'finished'
  ).length;
  if (!confirm(`Set start time to NOW for ${count} tracker-less participant${count !== 1 ? 's' : ''}?`)) return;
  const res = await RT.post(`/api/races/${race.id}/start`, {});
  if (!res.ok) { RT.toast('Failed to start race', 'warn'); return; }
  RT.toast(`Started ${res.started} participant${res.started !== 1 ? 's' : ''}`, 'ok');
}

function applyMessagingFlag() {
  const panel = document.getElementById('msg-panel');
  if (!panel) return;
  panel.style.display = race?.messaging_enabled ? 'flex' : 'none';
}

function applyWeatherFlag() {
  const btn = document.getElementById('wx-tab-btn');
  if (!btn) return;
  const enabled = race?.weather_enabled;
  btn.style.display = enabled ? '' : 'none';
  if (!enabled && rightTab === 'weather') switchRightTab('info');
}

function handleInit(data) {
  if (!data.race) { updateRacePill(null); return; }
  race = data.race;
  fmt24 = race.time_format === '24h';
  updateRacePill(race);
  updateMqttPill(data.mqtt);
  if (data.aprs) updateAprsPill(data.aprs);
  applyMessagingFlag();
  applyWeatherFlag();
  updateStartWindowBtn();
  updateEndRaceBtn();
  updateStartRaceBtn();

  heats = {}; (data.heats || []).forEach(h => heats[h.id] = h);
  classes = {}; (data.classes || []).forEach(c => classes[c.id] = c);
  stations = data.stations || [];

  participants = {};
  (data.participants || []).forEach(p => {
    participants[p.id] = enrichParticipant(p, data.registry || []);
  });

  if (data.trackPoints?.length) { trackPoints = data.trackPoints; _cachedDists = null; _cachedTotalDist = null; _stationAlongCache = null; }
  renderRoute();
  renderStationMarkers();
  renderStationList();
  renderAllMarkers();
  renderLeaderboard();
  renderPersonnelRecipients();
  updateStats();
  checkStationWarnings();
  if (!trackPoints) loadTrackData(); // fallback API fetch if WS didn't include track
  setupWeatherLayers(data.weatherKey);
}

async function loadInitialData() {
  const res = await RT.get('/api/races/active');
  if (!res.ok || !res.data) { updateRacePill(null); return; }
  race = res.data;
  fmt24 = race.time_format === '24h';
  updateRacePill(race);
  applyMessagingFlag();
  applyWeatherFlag();
  updateEndRaceBtn();
  updateStartRaceBtn();

  const [pr, sr, hr, cr, personnelR, msgR] = await Promise.all([
    RT.get(`/api/races/${race.id}/participants`),
    RT.get(`/api/races/${race.id}/stations`),
    RT.get(`/api/races/${race.id}/heats`),
    RT.get(`/api/races/${race.id}/classes`),
    RT.get(`/api/races/${race.id}/personnel`),
    RT.get(`/api/races/${race.id}/messages?limit=100`),
  ]);

  heats = {}; (hr.data || []).forEach(h => heats[h.id] = h);
  classes = {}; (cr.data || []).forEach(c => classes[c.id] = c);
  stations = sr.data || [];
  personnel = personnelR.data || [];
  messages = msgR.data || [];

  participants = {};
  (pr.data || []).forEach(p => { participants[p.id] = p; });

  renderRoute();
  renderStationMarkers();
  renderStationList();
  renderAllMarkers();
  renderLeaderboard();
  renderPersonnelRecipients();
  updateStats();
  checkStationWarnings();
  loadTrackData();
}

async function loadTrackData() {
  if (!race) return;
  const res = await RT.get(`/api/races/${race.id}/tracks/parse`);
  if (res.ok && res.data?.trackPoints) {
    trackPoints = res.data.trackPoints;
    _cachedDists = null; _cachedTotalDist = null; _stationAlongCache = null;
    document.getElementById('stat-dist').textContent = RT.fmtDist(res.data.totalDistance, race?.units);
    renderRoute();
  }
}

// ── Map ───────────────────────────────────────────────────────────────────────
function initMap() {
  leafletMap = L.map('map', { zoomControl: true, maxZoom: 16 });
  markerLayer = L.layerGroup().addTo(leafletMap);
  setBaseLayer('topo');
  leafletMap.setView([39.5, -98.5], 5);
  leafletMap.on('click', onMapClick);
  leafletMap.on('overlayadd',    e => { activeWeatherOverlays.add(e.name);    updateWeatherLegend(); setWeatherOpacity(Math.round(weatherOpacity * 100)); });
  leafletMap.on('overlayremove', e => { activeWeatherOverlays.delete(e.name); updateWeatherLegend(); });
}

function setBaseLayer(name) {
  if (currentBaseLayer) leafletMap.removeLayer(currentBaseLayer);
  const cfg = BASE_LAYERS[name] || BASE_LAYERS.topo;
  currentBaseLayer = L.tileLayer(cfg.url, cfg.opts).addTo(leafletMap);
  document.getElementById('base-layer-sel').value = name;
}

async function setupWeatherLayers(key) {
  if (wxSetupInProgress) return;
  wxSetupInProgress = true;
  owmKey = key;
  if (weatherLayersControl) { leafletMap.removeControl(weatherLayersControl); weatherLayersControl = null; }
  if (weatherLegendControl) { leafletMap.removeControl(weatherLegendControl); weatherLegendControl = null; }
  activeWeatherOverlays.clear();

  const overlays = {};
  if (owmKey && race?.weather_enabled) {
    const owm = (layer) => L.tileLayer(
      `https://tile.openweathermap.org/map/${layer}/{z}/{x}/{y}.png?appid=${owmKey}`,
      { opacity: weatherOpacity, attribution: '© OpenWeatherMap', maxZoom: 16, zIndex: 200 }
    );
    overlays['&#9730; Precipitation'] = owm('precipitation_new');
    overlays['&#9729; Clouds']        = owm('clouds_new');
    overlays['&#127790; Wind Speed']  = owm('wind_new');
    overlays['&#127777; Temperature'] = owm('temp_new');
  }
  if (Object.keys(overlays).length) {
    weatherLayersControl = L.control.layers({}, overlays, { collapsed: true, position: 'bottomleft' }).addTo(leafletMap);
    weatherLegendControl = createWeatherLegendControl();
    weatherLegendControl.addTo(leafletMap);
  }
  wxSetupInProgress = false;
}

function createWeatherLegendControl() {
  const ctrl = L.control({ position: 'bottomright' });
  ctrl.onAdd = () => {
    const div = L.DomUtil.create('div', '');
    div.id = 'wx-legend';
    div.style.cssText = 'display:none;background:var(--surface,#161b22);border:1px solid var(--border,#30363d);border-radius:6px;padding:8px 10px;font-family:monospace;min-width:170px;pointer-events:auto';
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  return ctrl;
}

function setWeatherOpacity(val) {
  weatherOpacity = val / 100;
  document.getElementById('wx-opacity-lbl').textContent = val + '%';
  // Update opacity of all active weather overlays
  leafletMap.eachLayer(layer => {
    if (layer.options && layer.options.attribution === '© OpenWeatherMap') {
      layer.setOpacity(weatherOpacity);
    }
  });
}

function updateWeatherLegend() {
  const div = document.getElementById('wx-legend');
  if (!div) return;
  if (activeWeatherOverlays.size === 0) { div.style.display = 'none'; return; }
  const name = [...activeWeatherOverlays].at(-1);
  const key = Object.keys(LAYER_LEGENDS).find(k => name.includes(k));
  if (!key) { div.style.display = 'none'; return; }
  const spec = LAYER_LEGENDS[key];
  const tickHtml = spec.ticks.map(t => `<span>${t}</span>`).join('');
  div.style.display = '';
  div.innerHTML = `
    <div style="font-size:10px;letter-spacing:1px;color:var(--text3,#7d8590);margin-bottom:4px">${spec.label}</div>
    <div style="height:8px;width:150px;border-radius:3px;background:linear-gradient(to right,${spec.grad});margin-bottom:3px"></div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text2,#8b949e);margin-bottom:6px">${tickHtml}</div>
    <div style="display:flex;align-items:center;gap:6px">
      <span style="font-size:10px;color:var(--text3,#7d8590)">Opacity:</span>
      <input type="range" min="10" max="100" value="${Math.round(weatherOpacity * 100)}" style="flex:1" oninput="OP.setWeatherOpacity(this.value)">
      <span id="wx-opacity-lbl" style="font-size:10px;color:var(--text2,#8b949e);min-width:30px">${Math.round(weatherOpacity * 100)}%</span>
    </div>`;
}

function onMapClick(e) {
  // Allow admin to add stations by clicking the map (if shift-held)
  selectedPId = null;
  selectedStationId = null;
  renderLeaderboard();
}

function renderRoute() {
  if (routeLayer) { leafletMap.removeLayer(routeLayer); routeLayer = null; }
  if (!trackPoints || trackPoints.length < 2) return;
  routeLayer = L.polyline(trackPoints, { color: '#f5a623', weight: 5, opacity: 0.85 }).addTo(leafletMap);
  if (!selectedPId) leafletMap.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
}

function renderStationMarkers() {
  Object.values(stationMarkers).forEach(m => leafletMap.removeLayer(m));
  stationMarkers = {};
  for (const s of stations) {
    const color = s.type === 'start' ? '#3fb950' : s.type === 'finish' ? '#f78166' :
                  s.type === 'start_finish' ? '#a371f7' : s.type === 'turnaround' ? '#58a6ff' :
                  s.type === 'netcontrol' ? '#d2993a' : s.type === 'repeater' ? '#6e7681' : '#d2a679';
    const letter = s.type === 'start' ? 'S' : s.type === 'finish' ? 'F' :
                   s.type === 'start_finish' ? '⇌' : s.type === 'turnaround' ? 'T' :
                   s.type === 'netcontrol' ? 'N' : s.type === 'repeater' ? 'R' : s.name[0]?.toUpperCase() || 'A';
    const icon = L.divIcon({
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #fff4;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:bold;color:#000;font-family:'Courier New'">${letter}</div>`,
      className: '', iconAnchor: [11, 11],
    });
    const marker = L.marker([s.lat, s.lon], { icon })
      .addTo(leafletMap)
      .bindTooltip(s.name, { permanent: false, direction: 'top' });
    marker.on('click', () => selectStation(s.id));
    stationMarkers[s.id] = marker;
  }
}

// ── Participants / Markers ────────────────────────────────────────────────────
function enrichParticipant(p, registry) {
  const heat = p.heat_id ? heats[p.heat_id] : null;
  const cls  = p.class_id ? classes[p.class_id] : null;
  const reg  = registry ? registry.find(r => r.node_id === p.tracker_id || r.long_name === p.tracker_id || r.short_name === p.tracker_id) : null;
  return { ...p, heat, class: cls, registry: reg };
}

function renderAllMarkers() {
  markerLayer.clearLayers();
  for (const p of Object.values(participants)) {
    updateOrCreateMarker(p); // handles both GPS and manual-station fallback internally
  }
}

function updateOrCreateMarker(p) {
  // Prefer live GPS; fall back to last confirmed station location
  let lat = p.last_lat, lon = p.last_lon;
  let isManual = false;
  if (!lat || !lon) {
    const fix = getManualFix(p);
    if (!fix?.lat || !fix?.lon) return;
    lat = fix.lat; lon = fix.lon;
    isManual = true;
  }

  const now = Math.floor(Date.now() / 1000);
  const missingTimer = race?.missing_timer || 3600;
  // For manual markers, age is from last station timestamp; no blinking unless stale
  const lastSeen = isManual ? (p.last_station_ts || 0) : (p.registry?.last_seen || p.last_seen || 0);
  const missing = !isManual && lastSeen && (now - lastSeen) > missingTimer;
  const alerting = alerts.some(a => a.participantId === p.id);
  const heat = p.heat_id ? heats[p.heat_id] : null;
  const { svg, cls } = RT.trackerIcon(heat, alerting, missing);

  // Manual markers rendered with reduced opacity and a dashed ring to signal "last known"
  const wrapStyle = isManual ? 'opacity:0.65;filter:grayscale(30%)' : '';
  const icon = L.divIcon({
    html: `<div class="${cls}" style="${wrapStyle}" title="Bib ${p.bib}: ${p.name} (last known station)">${svg}</div>`,
    className: 'leaflet-div-icon', iconAnchor: [10, 10],
  });

  const existing = markerLayer.getLayers().find(m => m._pid === p.id);
  if (existing) {
    existing.setLatLng([lat, lon]);
    existing.setIcon(icon);
  } else {
    const m = L.marker([lat, lon], { icon });
    m._pid = p.id;
    m.bindTooltip(`#${p.bib} ${p.name}${isManual ? ' (last station)' : ''}`, { permanent: false });
    m.on('click', () => showParticipantInfo(p.id));
    m.addTo(markerLayer);
  }
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function renderLeaderboard() {
  const el = document.getElementById('leaderboard-body');
  if (!el) return;
  const list = Object.values(participants);
  list.forEach(p => {
    p._pct = computePercent(p);
    p._pace = computePace(p);
  });

  list.sort((a, b) => {
    if (sortBy === 'position') return (b._pct || 0) - (a._pct || 0);
    if (sortBy === 'bib') return String(a.bib).localeCompare(String(b.bib), undefined, { numeric: true });
    if (sortBy === 'pace') return (a._pace || Infinity) - (b._pace || Infinity);
    if (sortBy === 'eta') return (a._eta || Infinity) - (b._eta || Infinity);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'heat') return (a.heat?.name || '').localeCompare(b.heat?.name || '');
    return 0;
  });

  el.innerHTML = list.map((p, i) => {
    const now = Math.floor(Date.now() / 1000);
    const missingTimer = race?.missing_timer || 3600;
    const lastSeen = p.registry?.last_seen || p.last_seen || 0;
    const missing = lastSeen && (now - lastSeen) > missingTimer;
    const alerting = alerts.some(a => a.participantId === p.id);
    const heat = p.heat_id ? heats[p.heat_id] : null;
    const dot = heat ? `<span class="dot" style="background:${heat.color}"></span>` : '<span class="dot" style="background:var(--text3)"></span>';
    const sc = STATUS_COLORS[p.status] || 'var(--text3)';
    const pct = p._pct != null ? `${p._pct.toFixed(0)}%` : '--';
    const pace = p._pace ? RT.fmtSpeed(p._pace, race?.speed_units || 'min_mile') : '--';
    const bat = p.registry?.battery_level != null ? `${p.registry.battery_level}%` : '--';
    const rowCls = (alerting ? 'alert-row' : '') + (missing ? ' missing-row' : '') + (p.id === selectedPId ? ' selected' : '');
    return `<div class="lb-row ${rowCls}" onclick="OP.selectParticipant(${p.id})">
      <span style="color:var(--text3)">${i + 1}</span>
      <span style="color:${sc};font-weight:bold">${p.bib}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${dot} ${p.name}</span>
      <span style="color:var(--accent)">${pct}</span>
      <span style="color:var(--text2)">${pace}</span>
      <span style="color:var(--text3);font-size:13px">${bat}</span>
    </div>`;
  }).join('');

  updateStats(list);
}

const STATUS_COLORS = { dns: '#484f58', active: '#58a6ff', dnf: '#f78166', finished: '#3fb950' };

function computePercent(p) {
  if (p.status === 'finished') return 100;
  if (p.status === 'dns') return null;

  // Manual-entry fallback: no GPS but last station known
  if (!p.last_lat || !p.last_lon) {
    if (!trackPoints || !trackPoints.length) return null;
    const fix = getManualFix(p);
    if (!fix) return null;
    ensureDistCache();
    const totalDist = _cachedTotalDist;
    if (!totalDist) return null;
    const isOAB = race?.race_format === 'out_and_back';
    // Set _lastAlong so computeETAs can use it
    p._lastAlong    = fix.along;
    p._lastAlongTs  = fix.ts;
    if (isOAB) {
      if (p.has_turnaround) return Math.min(100, (2 * totalDist - fix.along) / (2 * totalDist) * 100);
      return Math.min(50, fix.along / (2 * totalDist) * 100);
    }
    return Math.min(100, fix.along / totalDist * 100);
  }

  if (!trackPoints || !trackPoints.length) return null;
  ensureDistCache();
  const totalDist = _cachedTotalDist;
  if (totalDist === 0) return 0;

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
    const [lat1, lon1] = trackPoints[i], [lat2, lon2] = trackPoints[i+1];
    const segLen = _cachedDists[i+1] - _cachedDists[i];
    const ax = p.last_lat - lat1, ay = p.last_lon - lon1, bx = lat2-lat1, by = lon2-lon1;
    const t = clamp01((ax*bx+ay*by)/Math.max(1e-10, bx*bx+by*by));
    const d = haversine(p.last_lat, p.last_lon, lat1+t*bx, lon1+t*by);
    if (d < minD) { minD = d; bestAlong = _cachedDists[i] + t * segLen; }
  }

  // Option C: checkpoint floor prevents backwards jump (outbound leg only)
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

// Returns the last manually-confirmed station fix for a participant, or null.
// Resolves station → {along, lat, lon, ts} lazily (needs trackPoints + stations ready).
function getManualFix(p) {
  if (!p.last_station_id || !p.last_station_ts) return null;
  const along = getStationAlongMap().get(p.last_station_id);
  if (along == null) return null;
  const stn = stations.find(s => s.id === p.last_station_id);
  return { along, ts: p.last_station_ts, lat: stn?.lat, lon: stn?.lon, station: stn };
}

function computePace(p) {
  if (!p.start_time) return null;

  if (p.last_lat) {
    // GPS path
    const pct = p._pct;
    if (pct == null || !trackPoints) return null;
    const elapsed = Math.floor(Date.now() / 1000) - p.start_time;
    if (elapsed <= 0) return null;
    let totalDist = computeTotalDist();
    if (!totalDist) return null;
    if (race?.race_format === 'out_and_back') totalDist *= 2;
    return (pct / 100 * totalDist) / elapsed; // m/s
  }

  // Manual-entry fallback: pace from start_time to last confirmed station
  const fix = getManualFix(p);
  if (!fix || fix.along <= 0) return null;
  const elapsed = fix.ts - p.start_time;
  if (elapsed <= 0) return null;
  const isOAB = race?.race_format === 'out_and_back';
  const totalDist = computeTotalDist();
  if (!totalDist) return null;
  // Distance covered: on return leg account for the turnaround leg too
  const distCovered = (isOAB && p.has_turnaround)
    ? 2 * totalDist - fix.along
    : fix.along;
  return distCovered / elapsed; // m/s
}

let _cachedTotalDist = null, _cachedDists = null, _stationAlongCache = null;
const MAX_RACE_SPEED = 8, BACK_MARGIN = 100;

function computeTotalDist() {
  ensureDistCache();
  return _cachedTotalDist || 0;
}

function ensureDistCache() {
  if (_cachedDists || !trackPoints || trackPoints.length < 2) return;
  _cachedDists = [0];
  for (let i = 1; i < trackPoints.length; i++)
    _cachedDists.push(_cachedDists[i-1] + haversine(
      trackPoints[i-1][0], trackPoints[i-1][1], trackPoints[i][0], trackPoints[i][1]));
  _cachedTotalDist = _cachedDists[_cachedDists.length - 1];
}

function getStationElevation(station) {
  if (!trackPoints || !station.lat || !station.lon) return null;
  let minD = Infinity, bestEle = null;
  for (const pt of trackPoints) {
    if (pt[2] == null) continue;
    const d = haversine(station.lat, station.lon, pt[0], pt[1]);
    if (d < minD) { minD = d; bestEle = pt[2]; }
  }
  return bestEle;
}

function fmtElevation(meters) {
  if (meters == null) return null;
  return race?.units === 'metric'
    ? `${Math.round(meters)} m`
    : `${Math.round(meters * 3.28084).toLocaleString()} ft`;
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
      const [lat1, lon1] = trackPoints[i], [lat2, lon2] = trackPoints[i+1];
      const ax = s.lat - lat1, ay = s.lon - lon1, bx = lat2-lat1, by = lon2-lon1;
      const t = clamp01((ax*bx+ay*by)/Math.max(1e-10, bx*bx+by*by));
      const d = haversine(s.lat, s.lon, lat1+t*bx, lon1+t*by);
      if (d < minD) { minD = d; best = _cachedDists[i] + t*(_cachedDists[i+1]-_cachedDists[i]); }
    }
    _stationAlongCache.set(s.id, best);
  }
  return _stationAlongCache;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function dot2(ax, ay, bx, by) { return ax*bx + ay*by; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function updateStats(list) {
  const ps = list || Object.values(participants);
  document.getElementById('stat-active').textContent   = ps.filter(p=>p.status==='active').length;
  document.getElementById('stat-finished').textContent = ps.filter(p=>p.status==='finished').length;
  document.getElementById('stat-dnf').textContent      = ps.filter(p=>p.status==='dnf').length;
  document.getElementById('stat-dns').textContent      = ps.filter(p=>p.status==='dns').length;
}

function setSort(key) {
  sortBy = key;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
  renderLeaderboard();
}

// ── Left panel tabs ───────────────────────────────────────────────────────────
function switchLeftTab(tab) {
  leftTab = tab;
  document.getElementById('lp-tab-participants')?.classList.toggle('active', tab === 'participants');
  document.getElementById('lp-tab-stations')?.classList.toggle('active', tab === 'stations');
  document.getElementById('lp-participants').style.display = tab === 'participants' ? 'flex' : 'none';
  document.getElementById('lp-stations').style.display    = tab === 'stations'     ? ''     : 'none';
}

// ── Station list (left panel) ─────────────────────────────────────────────────
const STN_COLORS = {
  start:'#3fb950', finish:'#f78166', start_finish:'#a371f7',
  turnaround:'#58a6ff', netcontrol:'#d2993a', repeater:'#6e7681',
};
function stnColor(type) { return STN_COLORS[type] || '#d2a679'; }
function stnLabel(type) {
  return { start:'Start', finish:'Finish', start_finish:'Start/Finish',
           turnaround:'Turnaround', netcontrol:'Net Control', repeater:'Repeater',
           aid:'Aid' }[type] || type;
}

function renderStationList() {
  const el = document.getElementById('station-list-body');
  if (!el) return;
  if (!stations.length) {
    el.innerHTML = '<div class="text-dim" style="padding:12px;font-size:14px">No stations configured.</div>';
    return;
  }
  el.innerHTML = stations
    .filter(s => s.lat && s.lon)
    .map(s => {
      const color = stnColor(s.type);
      const stPersonnel = personnel.filter(p => p.station_id === s.id);
      const sel = s.id === selectedStationId ? ' selected' : '';
      return `<div class="stn-list-row${sel}" id="stn-row-${s.id}" onclick="OP.selectStation(${s.id})">
        <span class="stn-type-dot" style="background:${color}"></span>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</div>
          <div style="font-size:12px;color:var(--text3)">${stnLabel(s.type)}${stPersonnel.length ? ` · ${stPersonnel.length} staff` : ''}</div>
        </div>
      </div>`;
    }).join('');
}

function selectStation(id) {
  selectedStationId = id;
  selectedPId = null;
  switchLeftTab('stations');
  renderLeaderboard(); // clear participant highlight
  showStationInfo(id);
  switchRightTab('info');
  // Pan map to station
  const s = stations.find(x => x.id === id);
  if (s?.lat && s?.lon) leafletMap.panTo([s.lat, s.lon]);
}

// ── Station event edit / delete ───────────────────────────────────────────────
let editingEventId = null, editingEventStationId = null;

function openEditEvent(eventId, stationId) {
  editingEventId = eventId;
  editingEventStationId = stationId;
  // Fetch the event to pre-populate fields
  RT.get(`/api/races/${race.id}/events?station_id=${stationId}&limit=200`).then(res => {
    const e = res.ok ? res.data.find(x => x.id === eventId) : null;
    if (!e) { RT.toast('Event not found', 'warn'); return; }
    document.getElementById('ee-event-type').value = e.event_type || 'aid_depart';
    document.getElementById('ee-time').value        = e.timestamp
      ? new Date(e.timestamp * 1000).toTimeString().slice(0, 8) : '';
    document.getElementById('ee-notes').value       = e.notes || '';
    document.getElementById('edit-event-modal').classList.remove('hidden');
  });
}

async function saveEditEvent() {
  if (!editingEventId || !race) return;
  const eventType = document.getElementById('ee-event-type').value;
  const timeStr   = document.getElementById('ee-time').value.trim();
  const notes     = document.getElementById('ee-notes').value.trim();
  const ts = timeStr ? parseTimeToUnix(timeStr, race.date) : null;
  const body = { event_type: eventType, notes: notes || null };
  if (ts) body.timestamp = ts;
  const res = await RT.put(`/api/races/${race.id}/events/${editingEventId}`, body);
  if (!res.ok) { RT.toast('Failed to save', 'warn'); return; }
  document.getElementById('edit-event-modal').classList.add('hidden');
  RT.toast('Event updated', 'ok');
  showStationInfo(editingEventStationId);
}

async function deleteStationEvent(eventId, stationId) {
  const res = await RT.del(`/api/races/${race.id}/events/${eventId}`);
  if (!res.ok) { RT.toast('Failed to delete', 'warn'); return; }
  RT.toast('Deleted', 'ok');
  showStationInfo(stationId);
}

// ── Batch check-in modal ──────────────────────────────────────────────────────
function openBatchCheckIn(stationId) {
  batchStationId = stationId;
  const s = stations.find(x => x.id === stationId);
  document.getElementById('bc-station-name').textContent = s?.name || '';

  // Sensible default event type by station type
  const defaults = { start: 'start', start_finish: 'start', finish: 'finish', turnaround: 'aid_depart' };
  document.getElementById('bc-event-type').value = defaults[s?.type] || 'aid_depart';

  // Pre-fill default time with current HH:MM:SS
  const now = new Date();
  document.getElementById('bc-default-time').value =
    [now.getHours(), now.getMinutes(), now.getSeconds()].map(v => String(v).padStart(2,'0')).join(':');

  // Start with one blank row
  document.getElementById('bc-rows').innerHTML = '';
  document.getElementById('bc-status').textContent = '';
  addBatchRow();

  document.getElementById('batch-checkin-modal').classList.remove('hidden');
  // Focus the first bib field
  setTimeout(() => document.querySelector('#bc-rows .bc-bib')?.focus(), 50);
}

function closeBatchCheckIn() {
  document.getElementById('batch-checkin-modal').classList.add('hidden');
  batchStationId = null;
}

function addBatchRow(bibVal = '', timeVal = '', focusBib = false) {
  const container = document.getElementById('bc-rows');
  const div = document.createElement('div');
  div.className = 'bc-row';
  div.innerHTML = `
    <div>
      <input class="bc-bib" placeholder="BIB" style="width:100%" value="${bibVal}"
        onblur="OP.resolveBib(this)" onkeydown="OP.bibKeydown(event,this)">
    </div>
    <div>
      <div class="bc-bib-name text-dim">—</div>
    </div>
    <div>
      <input class="bc-time-override" placeholder="HH:MM:SS" style="width:100%" value="${timeVal}"
        onkeydown="OP.timeKeydown(event,this)">
    </div>
    <div>
      <button onclick="OP.removeBatchRow(this)" style="padding:2px 6px;color:var(--accent3)">✕</button>
    </div>`;
  container.appendChild(div);
  const bibInput = div.querySelector('.bc-bib');
  if (bibVal) resolveBib(bibInput);
  if (focusBib) bibInput.focus();
  return bibInput;
}

function removeBatchRow(btn) {
  const row = btn.closest('.bc-row');
  const container = document.getElementById('bc-rows');
  if (container.children.length > 1) row.remove();
  else { // keep at least one row; just clear it
    row.querySelector('.bc-bib').value = '';
    row.querySelector('.bc-bib-name').textContent = '—';
    row.querySelector('.bc-bib-name').style.color = '';
    row.querySelector('.bc-time-override').value = '';
  }
}

function bibKeydown(e, input) {
  if (e.key === 'Enter') {
    e.preventDefault();
    resolveBib(input);
    const rows = [...document.querySelectorAll('#bc-rows .bc-bib')];
    const idx = rows.indexOf(input);
    if (idx === rows.length - 1) addBatchRow('', '', true);
    else rows[idx + 1]?.focus();
  }
}

function timeKeydown(e, input) {
  if (e.key === 'Tab' && !e.shiftKey) {
    const rows = [...document.querySelectorAll('#bc-rows .bc-time-override')];
    const idx = rows.indexOf(input);
    if (idx === rows.length - 1) {
      e.preventDefault();
      addBatchRow('', '', true);
    }
    // if not the last row, let Tab fall through naturally to next row's bib
  }
}

function resolveBib(input) {
  const bib = input.value.trim();
  const nameEl = input.closest('.bc-row')?.querySelector('.bc-bib-name');
  if (!nameEl) return;
  if (!bib) { nameEl.textContent = '—'; nameEl.style.color = ''; return; }
  // Match by bib number OR partial name
  const match = Object.values(participants).find(
    p => String(p.bib).toLowerCase() === bib.toLowerCase() ||
         p.name?.toLowerCase().includes(bib.toLowerCase())
  );
  if (match) {
    input.value = match.bib; // normalise to bib number
    nameEl.textContent = match.name;
    nameEl.style.color = 'var(--accent2)';
  } else {
    nameEl.textContent = 'Not found';
    nameEl.style.color = 'var(--accent3)';
  }
}

async function submitBatchCheckIn() {
  if (!batchStationId || !race) return;
  const eventType = document.getElementById('bc-event-type').value;
  const defaultTimeStr = document.getElementById('bc-default-time').value.trim();
  const defaultTs = defaultTimeStr
    ? parseTimeToUnix(defaultTimeStr, race.date)
    : Math.floor(Date.now() / 1000);

  const rows = document.querySelectorAll('#bc-rows .bc-row');
  const entries = [];
  for (const row of rows) {
    const bib = row.querySelector('.bc-bib').value.trim();
    if (!bib) continue;
    const overrideStr = row.querySelector('.bc-time-override').value.trim();
    const ts = overrideStr ? (parseTimeToUnix(overrideStr, race.date) || defaultTs) : defaultTs;
    const p = Object.values(participants).find(x => String(x.bib).toLowerCase() === bib.toLowerCase());
    entries.push({ bib, participantId: p?.id || null, ts });
  }

  if (!entries.length) { RT.toast('No entries to submit', 'warn'); return; }

  const statusEl = document.getElementById('bc-status');
  statusEl.textContent = `Submitting ${entries.length} entries…`;

  let ok = 0, fail = 0;
  for (const e of entries) {
    if (!e.participantId) { fail++; continue; }
    const res = await RT.post(`/api/races/${race.id}/events`, {
      participant_id: e.participantId,
      event_type: eventType,
      station_id: batchStationId,
      timestamp: e.ts,
    });
    if (res.ok) ok++; else fail++;
  }

  const msg = `${ok} logged${fail ? `, ${fail} failed` : ''}`;
  statusEl.textContent = msg;
  RT.toast(msg, fail ? 'warn' : 'ok');

  if (ok > 0) {
    // Refresh station info log
    showStationInfo(batchStationId);
    setTimeout(() => closeBatchCheckIn(), 800);
  }
}

// ── Participant selection / info ──────────────────────────────────────────────
function selectParticipant(id) {
  selectedPId = id;
  selectedStationId = null;
  renderLeaderboard();
  showParticipantInfo(id);
  switchRightTab('info');
  // Pan map to marker — GPS first, then last known station
  const p = participants[id];
  if (p?.last_lat && p?.last_lon) {
    leafletMap.panTo([p.last_lat, p.last_lon]);
  } else {
    const fix = getManualFix(p);
    if (fix?.lat && fix?.lon) leafletMap.panTo([fix.lat, fix.lon]);
  }
}

function computeETAs(pid) {
  const lp = participants[pid];
  if (!lp || !lp._pace || lp._pace <= 0 || lp._lastAlong == null) return null;
  if (lp.status === 'finished' || lp.status === 'dnf' || lp.status === 'dns') return null;
  const now = Math.floor(Date.now() / 1000);
  const totalDist = computeTotalDist();
  if (!totalDist) return null;
  const isOAB = race?.race_format === 'out_and_back';
  const fullDist = isOAB ? totalDist * 2 : totalDist;
  const currentAlong = lp._lastAlong;
  const remaining = Math.max(0, fullDist - currentAlong);
  const secsToFinish = remaining / lp._pace;

  const stationMap = getStationAlongMap();
  let nextStation = null, nextEffAlong = Infinity;
  for (const s of stations) {
    if (!s.lat || !s.lon || s.type === 'start') continue;
    const along = stationMap.get(s.id);
    if (along == null) continue;
    const effAlong = (isOAB && lp.has_turnaround) ? (2 * totalDist - along) : along;
    if (effAlong > currentAlong && effAlong < nextEffAlong) {
      nextEffAlong = effAlong;
      nextStation = s;
    }
  }

  let etaNext = null, distToNext = null;
  if (nextStation) {
    distToNext = nextEffAlong - currentAlong;
    etaNext = now + distToNext / lp._pace;
  }
  return { etaFinish: now + secsToFinish, secsToFinish, etaNext, distToNext, nextStation };
}

function fmtEtaDelta(secs) {
  if (secs < 0) return 'overdue';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtEtaDist(meters) {
  return race?.units === 'metric'
    ? (meters / 1000).toFixed(1) + ' km'
    : (meters / 1609.34).toFixed(1) + ' mi';
}

async function showParticipantInfo(id) {
  selectedPId = id;
  const res = await RT.get(`/api/races/${race.id}/participants/${id}`);
  if (!res.ok) return;
  const p = res.data;
  const heat = p.heat_id ? heats[p.heat_id] : null;
  const cls  = p.class_id ? classes[p.class_id] : null;
  const reg  = p.tracker ? p.tracker : null;
  const sc = STATUS_COLORS[p.status] || 'var(--text3)';
  const pct = participants[id]?._pct;

  const el = document.getElementById('info-panel');
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      ${heat ? RT.SHAPES[heat.shape]?.(heat.color, 20) || '' : ''}
      <span style="font-size:20px;font-weight:bold">#${p.bib} ${p.name}</span>
      <span class="badge" style="background:${sc}22;color:${sc}">${p.status?.toUpperCase()}</span>
      <button style="margin-left:auto;font-size:13px;padding:2px 8px" onclick="OP.openEditModal(${id})">EDIT</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <div class="info-field"><span class="lbl">HEAT</span><span class="val">${heat?.name||'—'}</span></div>
      <div class="info-field"><span class="lbl">CLASS</span><span class="val">${cls?.name||'—'}</span></div>
      <div class="info-field"><span class="lbl">START</span><span class="val">${RT.fmtTime(p.start_time, fmt24)}</span></div>
      <div class="info-field"><span class="lbl">FINISH</span><span class="val">${RT.fmtTime(p.finish_time, fmt24)}</span></div>
      <div class="info-field"><span class="lbl">PROGRESS</span><span class="val text-accent">${pct != null ? pct.toFixed(1)+'%' : '—'}</span></div>
      <div class="info-field"><span class="lbl">BATTERY</span><span class="val">${reg?.battery_level != null ? reg.battery_level+'%' : '—'}</span></div>
      <div class="info-field"><span class="lbl">LAST SEEN</span><span class="val" id="info-last-seen" data-ts="${reg?.last_seen || 0}">${RT.timeAgo(reg?.last_seen)}</span></div>
      <div class="info-field"><span class="lbl">TRACKER</span><span class="val text-dim" style="font-size:13px">${p.tracker_id||'—'}</span></div>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:8px;margin-bottom:8px">
      <div class="info-field"><span class="lbl">PHONE</span><span class="val">${p.phone||'—'}</span></div>
      <div class="info-field"><span class="lbl">EMERGENCY</span><span class="val">${p.emergency_contact||'—'}</span></div>
      ${p.age ? `<div class="info-field"><span class="lbl">AGE</span><span class="val">${p.age}</span></div>` : ''}
    </div>
    ${(() => {
      const eta = computeETAs(id);
      if (!eta) return '';
      const now = Math.floor(Date.now() / 1000);
      const nextHtml = eta.nextStation
        ? `<div class="info-field" style="margin-bottom:4px">
            <span class="lbl">NEXT: ${eta.nextStation.name.toUpperCase()}</span>
            <span class="val text-accent">${RT.fmtTime(eta.etaNext, fmt24)} <span style="color:var(--text3);font-size:13px">(in ${fmtEtaDelta(eta.etaNext - now)}, ${fmtEtaDist(eta.distToNext)})</span></span>
           </div>`
        : '';
      return `<div style="border-top:1px solid var(--border);padding-top:8px;margin-bottom:8px">
        <div style="font-size:13px;letter-spacing:2px;color:var(--text3);margin-bottom:6px">ETA</div>
        ${nextHtml}
        <div class="info-field">
          <span class="lbl">FINISH</span>
          <span class="val text-accent">${RT.fmtTime(eta.etaFinish, fmt24)} <span style="color:var(--text3);font-size:13px">(in ${fmtEtaDelta(eta.secsToFinish)})</span></span>
        </div>
      </div>`;
    })()}
    <div style="border-top:1px solid var(--border);padding-top:8px">
      <div style="font-size:13px;letter-spacing:2px;color:var(--text3);margin-bottom:6px">EVENT LOG</div>
      ${(p.events||[]).length === 0 ? '<div class="text-dim" style="font-size:14px">No events yet.</div>' :
        p.events.map(e => `
          <div class="log-entry">
            <span class="log-time">${RT.fmtTime(e.timestamp, fmt24)}</span>
            <span class="log-msg ${e.event_type==='finish'?'log-ok':e.event_type==='dnf'||e.event_type==='off_course'?'log-warn':''}">
              ${formatEventType(e.event_type)}${e.station_name ? ' @ ' + e.station_name : ''}
              ${e.notes ? ' — ' + e.notes : ''}
              ${e.manual ? ' <span class="text-dim">(manual)</span>' : ''}
            </span>
          </div>`).join('')}
    </div>`;

  clearInterval(lastSeenInterval);
  lastSeenInterval = setInterval(() => {
    const span = document.getElementById('info-last-seen');
    if (!span) { clearInterval(lastSeenInterval); return; }
    span.textContent = RT.timeAgo(+span.dataset.ts);
  }, 1000);
}

function formatEventType(t) {
  return { start:'START', aid_arrive:'ARRIVE', aid_depart:'DEPART', finish:'FINISH',
           dnf:'DNF', dns:'DNS', off_course:'OFF COURSE', stopped:'STOPPED', manual:'NOTE' }[t] || t;
}

// ── Personnel Modal ───────────────────────────────────────────────────────────
let personnelStationId = null;

function openPersonnelModal(stationId) {
  personnelStationId = stationId;
  const s = stations.find(x => x.id === stationId);
  document.getElementById('pm-station-name').textContent = s?.name || '';
  document.getElementById('pm-new-name').value = '';
  document.getElementById('pm-new-phone').value = '';
  document.getElementById('pm-new-tracker').value = '';
  document.getElementById('pm-status').textContent = '';
  renderPersonnelTable();
  document.getElementById('personnel-modal').classList.remove('hidden');
}

function populateAssignDropdown() {
  const sel = document.getElementById('pm-assign-sel');
  if (!sel) return;
  const others = personnel.filter(p => p.station_id !== personnelStationId);
  if (!others.length) {
    sel.innerHTML = '<option value="">— No other personnel —</option>';
    return;
  }
  sel.innerHTML = others.map(p => {
    const stn = stations.find(s => s.id === p.station_id);
    const assignment = stn ? stn.name : 'Unassigned';
    return `<option value="${p.id}">${p.name} (${assignment})</option>`;
  }).join('');
}

async function assignPersonnel() {
  const sel = document.getElementById('pm-assign-sel');
  const id = parseInt(sel?.value);
  if (!id) return;
  const res = await RT.put(`/api/races/${race.id}/personnel/${id}`, { station_id: personnelStationId });
  if (!res.ok) { RT.toast('Failed to assign', 'warn'); return; }
  const idx = personnel.findIndex(x => x.id === id);
  if (idx !== -1) personnel[idx] = res.data;
  renderPersonnelTable();
  populateAssignDropdown();
  renderStationList();
}

function renderPersonnelTable() {
  populateAssignDropdown();
  const stPersonnel = personnel.filter(p => p.station_id === personnelStationId);
  const body = document.getElementById('pm-body');
  if (!body) return;
  if (!stPersonnel.length) {
    body.innerHTML = `<tr><td colspan="4" style="padding:10px 6px;color:var(--text3);text-align:center;font-size:14px">No personnel assigned to this station.</td></tr>`;
    return;
  }
  body.innerHTML = stPersonnel.map(p => `
    <tr id="pm-row-${p.id}" style="border-bottom:1px solid var(--border)">
      <td style="padding:5px 6px">${p.name}</td>
      <td style="padding:5px 6px;color:var(--text3)">${p.phone || '—'}</td>
      <td style="padding:5px 6px;color:var(--text3)">${p.tracker_id || '—'}</td>
      <td style="padding:5px 6px;white-space:nowrap">
        <button style="font-size:11px;padding:1px 6px" onclick="OP.editPersonnelRow(${p.id})">EDIT</button>
        <button style="font-size:11px;padding:1px 6px;color:var(--accent3);border-color:var(--accent3);margin-left:4px" onclick="OP.deletePersonnel(${p.id})">DEL</button>
      </td>
    </tr>`).join('');
}

function editPersonnelRow(id) {
  const p = personnel.find(x => x.id === id);
  if (!p) return;
  const row = document.getElementById(`pm-row-${id}`);
  if (!row) return;
  row.innerHTML = `
    <td style="padding:4px 4px"><input id="pm-edit-name-${id}" value="${p.name}" style="width:100%"></td>
    <td style="padding:4px 4px"><input id="pm-edit-phone-${id}" value="${p.phone || ''}" placeholder="Phone" style="width:100%"></td>
    <td style="padding:4px 4px"><input id="pm-edit-tracker-${id}" value="${p.tracker_id || ''}" placeholder="Tracker ID" style="width:100%"></td>
    <td style="padding:4px 4px;white-space:nowrap">
      <button class="primary" style="font-size:11px;padding:1px 6px" onclick="OP.savePersonnelRow(${id})">SAVE</button>
      <button style="font-size:11px;padding:1px 6px;margin-left:4px" onclick="OP.renderPersonnelTable()">✕</button>
    </td>`;
  document.getElementById(`pm-edit-name-${id}`)?.focus();
}

async function savePersonnelRow(id) {
  const name = document.getElementById(`pm-edit-name-${id}`)?.value?.trim();
  const phone = document.getElementById(`pm-edit-phone-${id}`)?.value?.trim() || null;
  const tracker_id = document.getElementById(`pm-edit-tracker-${id}`)?.value?.trim() || null;
  if (!name) { RT.toast('Name required', 'warn'); return; }
  const res = await RT.put(`/api/races/${race.id}/personnel/${id}`, { name, phone, tracker_id });
  if (!res.ok) { RT.toast('Failed to save', 'warn'); return; }
  const idx = personnel.findIndex(x => x.id === id);
  if (idx >= 0) personnel[idx] = { ...personnel[idx], name, phone, tracker_id };
  renderPersonnelTable();
  renderStationList();
  if (selectedStationId === personnelStationId) showStationInfo(personnelStationId);
}

async function addPersonnel() {
  const name = document.getElementById('pm-new-name')?.value?.trim();
  const phone = document.getElementById('pm-new-phone')?.value?.trim() || null;
  const tracker_id = document.getElementById('pm-new-tracker')?.value?.trim() || null;
  const status = document.getElementById('pm-status');
  if (!name) { if (status) status.textContent = 'Name is required.'; return; }
  if (status) status.textContent = '';
  const res = await RT.post(`/api/races/${race.id}/personnel`, {
    name, phone, tracker_id, station_id: personnelStationId
  });
  if (!res.ok) { if (status) status.textContent = 'Failed to add: ' + (res.error || 'unknown error'); return; }
  personnel.push(res.data);
  document.getElementById('pm-new-name').value = '';
  document.getElementById('pm-new-phone').value = '';
  document.getElementById('pm-new-tracker').value = '';
  document.getElementById('pm-new-name').focus();
  renderPersonnelTable();
  renderStationList();
  if (selectedStationId === personnelStationId) showStationInfo(personnelStationId);
}

async function deletePersonnel(id) {
  const res = await RT.del(`/api/races/${race.id}/personnel/${id}`);
  if (!res.ok) { RT.toast('Failed to delete', 'warn'); return; }
  personnel = personnel.filter(x => x.id !== id);
  renderPersonnelTable();
  renderStationList();
  if (selectedStationId === personnelStationId) showStationInfo(personnelStationId);
}

function showStationInfo(id) {
  clearInterval(lastSeenInterval);
  selectedStationId = id;
  selectedPId = null;
  const s = stations.find(x => x.id === id);
  if (!s) return;
  switchRightTab('info');
  renderStationList(); // update selection highlight

  RT.get(`/api/races/${race.id}/events?station_id=${id}&limit=50`).then(res => {
    const events = res.ok ? res.data : [];
    const stPersonnel = personnel.filter(p => p.station_id === id);

    // Course position stats
    const alongMap = getStationAlongMap();
    const along = alongMap.get(id);
    const totalDist = computeTotalDist();
    const distStr  = along != null ? RT.fmtDist(along, race?.units) : null;
    const pctStr   = (along != null && totalDist > 0) ? `${(along / totalDist * 100).toFixed(1)}%` : null;
    const elevStr  = fmtElevation(getStationElevation(s));
    const coordStr = (s.lat && s.lon) ? `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}` : null;

    const el = document.getElementById('info-panel');
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:18px;font-weight:bold;color:var(--accent4)">${s.name}</span>
        <span class="badge" style="color:var(--accent4)">${s.type.toUpperCase()}</span>
        ${s.cutoff_time ? `<span class="text-dim" style="font-size:14px">Cutoff: ${s.cutoff_time}</span>` : ''}
        ${s.type !== 'netcontrol' && s.type !== 'repeater' ? `<button class="primary" style="margin-left:auto;font-size:13px;padding:3px 10px"
          onclick="OP.openBatchCheckIn(${id})">LOG CHECK-IN</button>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:6px;margin-bottom:10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px">
        ${distStr  ? `<div><div style="font-size:11px;letter-spacing:1px;color:var(--text3)">DIST</div><div style="font-size:15px;color:var(--text)">${distStr}</div></div>` : ''}
        ${pctStr   ? `<div><div style="font-size:11px;letter-spacing:1px;color:var(--text3)">COURSE</div><div style="font-size:15px;color:var(--accent2)">${pctStr}</div></div>` : ''}
        ${elevStr  ? `<div><div style="font-size:11px;letter-spacing:1px;color:var(--text3)">ELEV</div><div style="font-size:15px;color:var(--text)">${elevStr}</div></div>` : ''}
        ${coordStr ? `<div style="grid-column:1/-1"><div style="font-size:11px;letter-spacing:1px;color:var(--text3)">COORDS</div><div style="font-size:13px;color:var(--text3);font-family:monospace">${coordStr}</div></div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:13px;letter-spacing:2px;color:var(--text3)">PERSONNEL (${stPersonnel.length})</span>
        <button style="font-size:11px;padding:1px 7px" onclick="OP.openPersonnelModal(${id})">EDIT</button>
      </div>
      ${stPersonnel.length ? stPersonnel.map(p =>
        `<div class="list-row" style="cursor:default">
          <span>${p.name}</span>
          ${p.tracker_id ? `<span class="text-dim" style="font-size:13px">${p.tracker_id}</span>` : ''}
          ${p.phone ? `<span class="text-dim" style="font-size:13px">${p.phone}</span>` : ''}
        </div>`).join('') : '<div class="text-dim" style="font-size:14px;margin-bottom:8px">None assigned.</div>'}
      ${s.type !== 'netcontrol' && s.type !== 'repeater' ? `<div style="display:flex;align-items:center;gap:8px;margin:8px 0 6px">
        <span style="font-size:13px;letter-spacing:2px;color:var(--text3)">ARRIVALS / DEPARTURES</span>
        <button style="font-size:12px;padding:1px 7px;margin-left:auto" onclick="OP.openBatchCheckIn(${id})">+ LOG</button>
      </div>
      <div id="station-event-log">
      ${events.length === 0 ? '<div class="text-dim" style="font-size:14px">No events yet.</div>' :
        events.map(e => `<div class="log-entry" style="display:flex;align-items:center;gap:6px">
          <span class="log-time" style="flex-shrink:0">${RT.fmtTime(e.timestamp, fmt24)}</span>
          <span class="log-msg ${e.event_type==='aid_arrive'||e.event_type==='start'?'log-info':''}" style="flex:1">
            ${e.participant_name ? `#${e.bib} ${e.participant_name}` : '?'} — ${formatEventType(e.event_type)}
          </span>
          <button style="font-size:11px;padding:1px 6px;flex-shrink:0"
            onclick="OP.openEditEvent(${e.id},${id})">EDIT</button>
          <button style="font-size:11px;padding:1px 6px;flex-shrink:0;color:var(--accent3);border-color:var(--accent3)"
            onclick="OP.deleteStationEvent(${e.id},${id})">DEL</button>
        </div>`).join('')}
      </div>` : ''}`;
  });
}

// ── Edit Participant Modal ────────────────────────────────────────────────────
async function openEditModal(id) {
  editingPId = id;
  const p = participants[id];
  if (!p) return;

  // Populate heats dropdown
  const heatSel = document.getElementById('em-heat');
  heatSel.innerHTML = '<option value="">— none —</option>' +
    Object.values(heats).map(h => `<option value="${h.id}"${h.id===p.heat_id?' selected':''}>${h.name}</option>`).join('');
  const classSel = document.getElementById('em-class');
  classSel.innerHTML = '<option value="">— none —</option>' +
    Object.values(classes).map(c => `<option value="${c.id}"${c.id===p.class_id?' selected':''}>${c.name}</option>`).join('');
  const stationSel = document.getElementById('em-event-station');
  stationSel.innerHTML = '<option value="">— none —</option>' +
    stations.map(s => `<option value="${s.id}">${s.name}</option>`).join('');

  document.getElementById('em-bib').value       = p.bib;
  document.getElementById('em-name').value      = p.name;
  document.getElementById('em-status').value    = p.status || 'dns';
  document.getElementById('em-tracker').value   = p.tracker_id || '';
  document.getElementById('em-phone').value     = p.phone || '';
  document.getElementById('em-emergency').value = p.emergency_contact || '';
  document.getElementById('em-start').value     = p.start_time ? new Date(p.start_time * 1000).toTimeString().slice(0,8) : '';
  document.getElementById('em-finish').value    = p.finish_time ? new Date(p.finish_time * 1000).toTimeString().slice(0,8) : '';
  document.getElementById('em-event-type').value = '';
  document.getElementById('em-event-time').value = '';
  document.getElementById('em-notes').value      = '';
  document.getElementById('edit-modal').classList.remove('hidden');
}

async function saveParticipant() {
  const id = editingPId;
  const body = {
    name:              document.getElementById('em-name').value.trim(),
    status:            document.getElementById('em-status').value,
    tracker_id:        document.getElementById('em-tracker').value.trim() || null,
    heat_id:           document.getElementById('em-heat').value || null,
    class_id:          document.getElementById('em-class').value || null,
    phone:             document.getElementById('em-phone').value.trim() || null,
    emergency_contact: document.getElementById('em-emergency').value.trim() || null,
  };

  // Parse optional time fields
  const startStr = document.getElementById('em-start').value.trim();
  const finishStr = document.getElementById('em-finish').value.trim();
  if (startStr) body.start_time = parseTimeToUnix(startStr, race?.date);
  if (finishStr) body.finish_time = parseTimeToUnix(finishStr, race?.date);

  const res = await RT.put(`/api/races/${race.id}/participants/${id}`, body);
  if (!res.ok) { RT.toast(res.error, 'warn'); return; }

  // Log manual event if selected
  const eventType = document.getElementById('em-event-type').value;
  if (eventType) {
    const stationId = document.getElementById('em-event-station').value || null;
    const notes = document.getElementById('em-notes').value.trim() || null;
    const evTimeStr = document.getElementById('em-event-time').value.trim();
    const ts = evTimeStr ? parseTimeToUnix(evTimeStr, race?.date) : Math.floor(Date.now() / 1000);
    await RT.post(`/api/races/${race.id}/events`, { participant_id: id, event_type: eventType, station_id: stationId, timestamp: ts, notes });
  }

  document.getElementById('edit-modal').classList.add('hidden');
  participants[id] = { ...participants[id], ...res.data };
  updateOrCreateMarker(participants[id]);
  renderLeaderboard();
  showParticipantInfo(id);
  RT.toast('Saved', 'ok');
}

function parseTimeToUnix(str, dateStr) {
  // Accepts HH:MM:SS, HH:MM, HHMM, or HHMMSS (colons optional)
  const base = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const s = str.trim().replace(/:/g, '');
  let h = 0, m = 0, sec = 0;
  if (s.length <= 2)      { h = +s; }
  else if (s.length <= 4) { h = +s.slice(0,2); m = +s.slice(2); }
  else                    { h = +s.slice(0,2); m = +s.slice(2,4); sec = +s.slice(4,6); }
  if ([h,m,sec].some(isNaN)) return null;
  base.setHours(h, m, sec, 0);
  return Math.floor(base.getTime() / 1000);
}

// ── WS event handlers ─────────────────────────────────────────────────────────
function handlePosition(data) {
  const { nodeId, lat, lon, altitude, speed, battery, timestamp } = data;
  // Find participant
  const p = findParticipantByNode(nodeId);
  if (p) {
    p.last_lat = lat; p.last_lon = lon;
    if (!p.registry) p.registry = {};
    p.registry.last_seen = timestamp;
    if (battery != null) p.registry.battery_level = battery;
    p._pct = computePercent(p);
    p._pace = computePace(p);
    updateOrCreateMarker(p);
    if (p.id === selectedPId) showParticipantInfo(p.id);
  }
  renderLeaderboard();
}

function handleEvent(data) {
  appendEventLog(data);
  const pid = data.participant_id;
  if (pid && participants[pid]) {
    const p = participants[pid];
    if (data.event_type === 'start')  { p.status = 'active';   p.start_time  = data.timestamp; }
    if (data.event_type === 'finish') { p.status = 'finished'; p.finish_time = data.timestamp; }
    if (data.event_type === 'dnf')      p.status = 'dnf';
    if (data.has_turnaround && !p.has_turnaround) {
      p.has_turnaround = true;
      // Seed return-leg tracking at turnaround distance so window starts correctly
      const td = _cachedTotalDist || computeTotalDist();
      if (td) { p._lastAlong = td; p._lastAlongTs = data.timestamp; }
    }
    if (data.station_id) {
      const along = getStationAlongMap().get(data.station_id);
      if (along != null) {
        // Always track the most recent confirmed station for manual-entry pace/position
        p.last_station_id = data.station_id;
        p.last_station_ts = data.timestamp;
        // Advance GPS checkpoint floor (outbound only — prevents backward GPS jumps)
        if (!p.has_turnaround) p._stationFloor = Math.max(p._stationFloor ?? 0, along);
      }
    }
    if (pid === selectedPId) showParticipantInfo(pid);
    renderLeaderboard();
  }
  // Refresh station info panel in real-time when an arrival/departure comes in for the open station
  if (data.station_id && data.station_id === selectedStationId) showStationInfo(selectedStationId);
}

function handleAlert(data) {
  alerts.push({ ...data, id: Date.now() });
  renderLeaderboard();
  renderAlertsList();
  updateAlertCount();
  RT.toast(`ALERT: ${data.type.replace('_',' ')} — Bib ${data.bib} ${data.name}`, 'alert', 8000);
  // Update marker
  const p = participants[data.participantId];
  if (p) updateOrCreateMarker(p);
}

const _MSG_CLOUD = `<circle cx="4.5" cy="9" r="3" fill="currentColor"/><circle cx="8.5" cy="7" r="3.5" fill="currentColor"/><circle cx="12" cy="9" r="2.5" fill="currentColor"/><rect x="1.5" y="9" width="13" height="5" rx="2.5" fill="currentColor"/>`;
const _MSG_STATUS_ICONS = {
  queued:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" title="Queued" style="color:#9e9e9e;vertical-align:middle;margin-left:3px">${_MSG_CLOUD}<path d="M8 13v-5M5.5 10.5L8 8l2.5 2.5" stroke="white" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  enroute:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" title="Enroute" style="color:#9e9e9e;vertical-align:middle;margin-left:3px">${_MSG_CLOUD}</svg>`,
  delivered: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" title="Delivered" style="color:#4caf50;vertical-align:middle;margin-left:3px">${_MSG_CLOUD}<path d="M5 11l2 2.5 4.5-5" stroke="white" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  error:     `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" title="Error" style="color:#e53935;vertical-align:middle;margin-left:3px">${_MSG_CLOUD}<path d="M5.5 9.5l5 4M10.5 9.5l-5 4" stroke="white" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`,
};

function handleMessageStatus(data) {
  const msg = messages.find(m => m.id === data.id);
  if (msg) { msg.status = data.status; renderMessages(); }
}

function updateMsgUnread() {
  const unread = messages.filter(m => m.direction === 'in' && !m.read).length;
  const count = document.getElementById('msg-unread-count');
  if (count) count.textContent = unread ? `(${unread} unread)` : '';
}

async function markThreadRead(nodeId) {
  const toMark = messages.filter(m => m.direction === 'in' && !m.read && m.from_node_id === nodeId);
  if (!toMark.length) return;
  for (const m of toMark) {
    m.read = 1;
    try { await RT.put(`/api/races/${race.id}/messages/${m.id}/read`, {}); } catch {}
    alerts = alerts.filter(a => a._msgId !== m.id);
  }
  updateMsgUnread();
  renderAlertsList();
  updateAlertCount();
}

function jumpToMsg(nodeId, alertId) {
  const sel = document.getElementById('msg-to');
  if (sel && nodeId) { sel.value = nodeId; renderMessages(); }
  dismissAlert(alertId);
}

function handleMessage(data) {
  const isNew = !messages.find(m => m.id === data.id);
  if (isNew) messages.unshift(data);
  renderMessages();
  if (isNew && data.direction === 'in') {
    updateMsgUnread();
    // Add to alerts panel so the badge lights up
    alerts.push({
      id: Date.now(), _msgId: data.id, _fromNodeId: data.from_node_id,
      type: 'message', from: data.from_name || data.from_node_id,
      text: data.text, timestamp: data.timestamp,
    });
    renderAlertsList();
    updateAlertCount();
    RT.toast(`MSG from ${data.from_name || data.from_node_id}: ${data.text}`, 'info', 6000);
  }
}

function handleParticipantUpdate(data) {
  if (data.action === 'add' || data.action === 'update') {
    participants[data.participant.id] = data.participant;
    updateOrCreateMarker(data.participant);
    // Immediately clear any missing/stopped alerts if the new status suppresses them
    const p = participants[data.participant.id];
    if (shouldSuppressAlerts(p)) {
      const before = alerts.length;
      alerts = alerts.filter(a => a.participantId !== p.id);
      if (alerts.length !== before) { renderAlertsList(); updateAlertCount(); }
    }
    renderLeaderboard();
  } else if (data.action === 'delete') {
    delete participants[data.id];
    renderLeaderboard();
  } else if (data.action === 'clear') {
    participants = {};
    renderAllMarkers();
    renderLeaderboard();
  }
  // Retick clock in case a status change causes the clock to freeze/unfreeze
  tickClock();
  updateStartRaceBtn();
}

function handlePersonnelUpdate(data) {
  if (data.action !== 'update') return;
  const p = data.personnel;
  const idx = personnel.findIndex(x => x.id === p.id);
  const prevStationId = idx >= 0 ? personnel[idx].station_id : null;
  if (idx >= 0) personnel[idx] = p; else personnel.push(p);
  renderPersonnelRecipients();
  // Refresh station panel if it's open for the affected station (new or previous)
  if (selectedStationId && (p.station_id === selectedStationId || prevStationId === selectedStationId)) {
    renderPersonnelTable();
  }
  if (p.station_name) {
    RT.toast(`${p.name} auto-registered at ${p.station_name}`, 'info', 5000);
  }
}

function handleStationUpdate(data) {
  if (data.action === 'add' || data.action === 'update') {
    const idx = stations.findIndex(s => s.id === data.station.id);
    if (idx >= 0) stations[idx] = data.station; else stations.push(data.station);
  } else if (data.action === 'delete') {
    stations = stations.filter(s => s.id !== data.id);
  }
  renderStationMarkers();
  renderStationList();
  checkStationWarnings();
}

function handleTrackerInfo(data) {
  const p = findParticipantByNode(data.nodeId);
  if (p) {
    if (!p.registry) p.registry = {};
    if (data.battery != null) p.registry.battery_level = data.battery;
    if (data.longName) p.registry.long_name = data.longName;
    p.registry.last_seen = data.timestamp;
    updateOrCreateMarker(p);
    renderLeaderboard();
  }
}

function updateMqttPill(status) {
  const light = document.getElementById('mqtt-light');
  if (!light) return;
  if (status?.connected) {
    light.className = 'ds-light ds-light-ok';
    light.title = `MQTT: Connected${status.host ? ' · ' + status.host : ''}`;
  } else if (status?.enabled) {
    light.className = 'ds-light ds-light-error';
    light.title = 'MQTT: Error — not connected';
  } else {
    light.className = 'ds-light ds-light-idle';
    light.title = 'MQTT: Offline';
  }
}

function updateAprsPill(status) {
  const light = document.getElementById('aprs-light');
  if (!light) return;
  if (status?.connected) {
    light.className = 'ds-light ds-light-ok';
    light.title = `APRS: Connected${status.server ? ' · ' + status.server : ''}`;
  } else if (status?.enabled) {
    light.className = 'ds-light ds-light-error';
    light.title = 'APRS: Error — not connected';
  } else {
    light.className = 'ds-light ds-light-idle';
    light.title = 'APRS: Offline';
  }
}

// ── Start Window ──────────────────────────────────────────────────────────────
let startWindowInterval = null;

function updateStartWindowBtn() {
  const btn = document.getElementById('start-window-btn');
  if (!btn) return;

  // Only show for operators/admins when feat_auto_start is on and no fixed start time
  const showBtn = race && race.feat_auto_start && !race.start_time;
  if (!showBtn) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');

  clearInterval(startWindowInterval);
  startWindowInterval = null;

  if (race.start_window_open && race.start_window_ts) {
    // Window is open — show countdown to 45-min auto-close
    const updateCountdown = () => {
      const now = Math.floor(Date.now() / 1000);
      const elapsed = now - race.start_window_ts;
      const remaining = 45 * 60 - elapsed;
      if (remaining <= 0) {
        btn.textContent = 'CLOSE START WINDOW';
        btn.style.background = 'var(--accent-red, #f85149)';
        btn.style.color = '#fff';
      } else {
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        btn.textContent = `WINDOW OPEN — ${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')} ▶ CLOSE`;
        btn.style.background = 'var(--accent-green, #3fb950)';
        btn.style.color = '#000';
      }
    };
    updateCountdown();
    startWindowInterval = setInterval(updateCountdown, 1000);
  } else {
    btn.textContent = 'OPEN START WINDOW';
    btn.style.background = '';
    btn.style.color = '';
  }
}

async function toggleStartWindow() {
  if (!race) return;
  const action = race.start_window_open ? 'close' : 'open';
  const res = await RT.post(`/api/races/${race.id}/start-window`, { action });
  if (!res.ok) RT.toast(res.error || 'Failed', 'warn');
  // Server broadcasts race_update which calls handleRaceUpdate → updateStartWindowBtn
}

function updateRacePill(r) {
  const pill = document.getElementById('race-pill');
  const overlay = document.getElementById('no-race-overlay');
  const viewerBtn = document.getElementById('viewer-link-btn');
  if (!r) {
    pill.className = 'pill pill-idle';
    pill.textContent = 'NO RACE';
    if (overlay) overlay.style.display = 'flex';
    if (viewerBtn) viewerBtn.classList.add('hidden');
    return;
  }
  pill.className = 'pill pill-ok';
  pill.textContent = r.name.toUpperCase();
  if (overlay) overlay.style.display = 'none';
  if (viewerBtn && r.viewer_token) viewerBtn.classList.remove('hidden');
}

function showViewerLink() {
  if (!race?.viewer_token) { RT.toast('No active race', 'warn'); return; }
  const url = window.location.origin + RT.BASE + 'view/' + race.viewer_token;
  document.getElementById('viewer-url').innerHTML = `<a href="${url}" target="_blank" rel="noopener" style="color:var(--accent2);text-decoration:underline">${url}</a>`;
  const qrEl = document.getElementById('viewer-qr');
  qrEl.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(qrEl, { text: url, width: 180, height: 180 });
  }
  document.getElementById('viewer-link-modal').classList.remove('hidden');
}

function copyViewerLink() {
  if (!race?.viewer_token) return;
  const url = window.location.origin + RT.BASE + 'view/' + race.viewer_token;
  navigator.clipboard.writeText(url).then(() => RT.toast('Copied!', 'ok'));
}

function checkStationWarnings() {
  const bar = document.getElementById('setup-warning');
  const txt = document.getElementById('setup-warning-text');
  if (!bar || !txt || !race) { if (bar) bar.style.display = 'none'; return; }
  const isOutBack = race.race_format === 'out_and_back';
  const missing = [];
  if (isOutBack) {
    if (!stations.some(s => s.type === 'start_finish')) missing.push('START/FINISH');
    if (!stations.some(s => s.type === 'turnaround'))   missing.push('TURNAROUND');
  } else {
    if (!stations.some(s => s.type === 'start'))  missing.push('START');
    if (!stations.some(s => s.type === 'finish')) missing.push('FINISH');
  }
  if (missing.length) {
    txt.textContent = `No ${missing.join(' or ')} station defined — participants will not auto-transition status via geofence.`;
    bar.style.display = 'flex';
  } else {
    bar.style.display = 'none';
  }
}

function findParticipantByNode(nodeId) {
  return Object.values(participants).find(p =>
    p.tracker_id === nodeId ||
    (p.registry && (p.registry.long_name === nodeId || p.registry.short_name === nodeId))
  );
}

// ── Alerts panel ──────────────────────────────────────────────────────────────
function renderAlertsList() {
  const el = document.getElementById('alerts-list');
  if (!el) return;
  if (!alerts.length) { el.innerHTML = '<div class="text-dim" style="font-size:16px;padding:6px">No active alerts.</div>'; return; }
  el.innerHTML = alerts.slice().reverse().map(a => {
    if (a.type === 'message') {
      const preview = a.text.length > 50 ? a.text.slice(0, 50) + '…' : a.text;
      return `<div class="alert-badge">
        <span style="font-size:22px">💬</span>
        <div style="min-width:0;flex:1">
          <div style="font-weight:bold">MESSAGE</div>
          <div class="text-dim" style="font-size:13px">${a.from} · ${RT.fmtTime(a.timestamp, fmt24)}</div>
          <div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${preview}</div>
        </div>
        <button style="margin-left:auto;font-size:13px;padding:2px 8px;white-space:nowrap" onclick="OP.jumpToMsg('${a._fromNodeId}', ${a.id})">View</button>
        <button style="font-size:13px;padding:2px 6px" onclick="OP.dismissAlert(${a.id})">✕</button>
      </div>`;
    }
    return `<div class="alert-badge">
      <span style="font-size:24px">⚠</span>
      <div>
        <div style="font-weight:bold">${a.type?.replace('_',' ').toUpperCase()}</div>
        <div class="text-dim" style="font-size:13px">#${a.bib} ${a.name} · ${RT.fmtTime(a.timestamp, fmt24)}</div>
        ${a.distanceFromRoute ? `<div style="font-size:13px">${a.distanceFromRoute}m off course</div>` : ''}
        ${a.battery != null ? `<div style="font-size:13px">${a.battery}% battery remaining</div>` : ''}
      </div>
      <button style="margin-left:auto;font-size:13px;padding:2px 6px" onclick="OP.dismissAlert(${a.id})">✕</button>
    </div>`;
  }).join('');
}

async function dismissAlert(id) {
  const a = alerts.find(x => x.id === id);
  alerts = alerts.filter(x => x.id !== id);
  renderAlertsList();
  updateAlertCount();
  if (a?.type === 'message' && a._msgId) {
    const m = messages.find(msg => msg.id === a._msgId);
    if (m && !m.read) {
      m.read = 1;
      try { await RT.put(`/api/races/${race.id}/messages/${a._msgId}/read`, {}); } catch {}
      updateMsgUnread();
    }
  } else {
    renderLeaderboard();
    renderAllMarkers();
  }
}

function updateAlertCount() {
  const cnt = document.getElementById('alert-count');
  const tabCnt = document.getElementById('alert-tab-count');
  if (alerts.length) {
    cnt.classList.remove('hidden');
    cnt.textContent = `${alerts.length} ALERT${alerts.length>1?'S':''}`;
    tabCnt.textContent = `(${alerts.length})`;
  } else {
    cnt.classList.add('hidden');
    tabCnt.textContent = '';
  }
}

// ── Messaging ─────────────────────────────────────────────────────────────────
function renderPersonnelRecipients() {
  const sel = document.getElementById('msg-to');
  if (!sel) return;
  const prev = sel.value;
  const msgPersonnel = personnel.filter(p => p.tracker_id);
  sel.innerHTML = '<option value="">— Select recipient —</option>' +
    msgPersonnel.map(p =>
      `<option value="${p.tracker_id}" data-name="${p.name}">${p.name}${p.station_name ? ' @ ' + p.station_name : ''}</option>`
    ).join('');
  if (prev) sel.value = prev;
  sel.onchange = () => renderMessages();
}

function renderMessages() {
  const sel = document.getElementById('msg-to');
  const nodeId = sel?.value;
  const el = document.getElementById('msg-thread-mini');
  if (!el) return;
  const thread = nodeId
    ? messages.filter(m => m.from_node_id === nodeId || m.to_node_id === nodeId)
    : messages.slice(0, 20);
  // messages array is newest-first; reverse so oldest renders at top, newest at bottom
  el.innerHTML = [...thread].reverse().map(m => {
    const cls = m.direction === 'out' ? 'msg-bubble-out' : 'msg-bubble-in';
    const from = m.direction === 'in' ? (m.from_name || m.from_node_id) : 'You';
    const statusIcon = m.direction === 'out' ? (_MSG_STATUS_ICONS[m.status] || '') : '';
    return `<div class="${cls}" style="max-width:85%;font-size:13px">
      <div style="font-size:11px;color:var(--text3);margin-bottom:2px">${from} · ${RT.fmtTime(m.timestamp, fmt24)}${statusIcon}</div>
      <div>${m.text}</div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
  if (nodeId) markThreadRead(nodeId);
}

async function sendMessage() {
  const sel = document.getElementById('msg-to');
  const to_node_id = sel?.value;
  const to_name = sel?.options[sel.selectedIndex]?.dataset.name;
  const text = document.getElementById('msg-input').value.trim();
  if (!to_node_id || !text) { RT.toast('Select a recipient and enter a message', 'warn'); return; }
  const res = await RT.post(`/api/races/${race.id}/messages`, { to_node_id, to_name, text });
  if (res.ok) {
    document.getElementById('msg-input').value = '';
    // WS broadcast handles adding to messages array and re-rendering
    if (!res.data.sent) RT.toast('Message saved — not delivered (offline)', 'warn');
  } else RT.toast(res.error, 'warn');
}

// ── Event log ─────────────────────────────────────────────────────────────────
function appendEventLog(event) {
  const el = document.getElementById('event-log');
  if (!el) return;
  const type = event.event_type || '';
  const cls = type === 'finish' ? 'log-ok' : type === 'dnf' || type === 'off_course' ? 'log-warn' : type === 'start' ? 'log-info' : '';
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = `<span class="log-time">${RT.fmtTime(event.timestamp, fmt24)}</span>
    <span class="log-msg ${cls}">
      ${event.participant_name ? `#${event.bib} ${event.participant_name}` : ''}
      — ${formatEventType(type)}
      ${event.station_name ? ' @ ' + event.station_name : ''}
      ${event.notes ? ' · ' + event.notes : ''}
    </span>`;
  el.insertBefore(div, el.firstChild);
}

// ── Missing / Stopped checks ──────────────────────────────────────────────────
function shouldSuppressAlerts(p) {
  // Don't alert for participants who are no longer racing or have finished
  return p.status === 'finished' || p.status === 'dnf' || p.status === 'dns' || (p._pct != null && p._pct >= 100);
}

function checkMissing() {
  if (!race || !race.feat_missing) return;
  const now = Math.floor(Date.now() / 1000);
  const missingTimer = race.missing_timer || 3600;
  let changed = false;
  for (const p of Object.values(participants)) {
    const key = `missing_${p.id}`;
    if (shouldSuppressAlerts(p)) {
      // Auto-dismiss any lingering alert if the participant finished or was marked DNF/DNS
      if (alerts.find(a => a.key === key)) { alerts = alerts.filter(a => a.key !== key); changed = true; }
      continue;
    }
    if (p.status !== 'active') continue;
    const lastSeen = p.registry?.last_seen || 0;
    if (lastSeen && (now - lastSeen) > missingTimer) {
      if (!alerts.find(a => a.key === key)) {
        alerts.push({ key, type: 'missing', participantId: p.id, bib: p.bib, name: p.name, timestamp: now, id: Date.now() });
        changed = true;
        RT.toast(`MISSING: Bib ${p.bib} ${p.name} — no signal for ${Math.floor((now-lastSeen)/60)} min`, 'alert', 8000);
      }
    }
  }
  if (changed) { renderAlertsList(); updateAlertCount(); }
  renderLeaderboard();
  renderAllMarkers();
}

function checkStopped() {
  if (!race || !race.feat_stopped) return;
  const now = Math.floor(Date.now() / 1000);
  const stoppedTime = race.stopped_time || 600;
  for (const p of Object.values(participants)) {
    const key = `stopped_${p.id}`;
    if (shouldSuppressAlerts(p)) {
      if (alerts.find(a => a.key === key)) { alerts = alerts.filter(a => a.key !== key); renderAlertsList(); updateAlertCount(); }
      continue;
    }
    if (p.status !== 'active') continue;
    const lastSeen = p.registry?.last_seen || 0;
    const lastSpeed = p.registry?.last_speed ?? null;
    // Only alert if we have recent signal but speed is 0 (or near 0) for stopped_time
    if (!lastSeen || (now - lastSeen) > stoppedTime * 3) continue; // signal too old — missing alert handles it
    if (lastSpeed !== null && lastSpeed < 0.5 && (now - lastSeen) > stoppedTime) {
      if (!alerts.find(a => a.key === key)) {
        alerts.push({ key, type: 'stopped', participantId: p.id, bib: p.bib, name: p.name, timestamp: now, id: Date.now() });
        renderAlertsList();
        updateAlertCount();
        RT.toast(`STOPPED: Bib ${p.bib} ${p.name} — stationary for ${Math.floor((now-lastSeen)/60)} min`, 'alert', 8000);
      }
    } else {
      alerts = alerts.filter(a => a.key !== key);
    }
  }
}

// ── Clock ─────────────────────────────────────────────────────────────────────
function clockFrozenValue() {
  // Returns the elapsed seconds to display when the clock is frozen, or null if no data
  const allP = Object.values(participants);
  const started = allP.filter(p => p.start_time);
  if (!started.length) return null;
  const earliest = Math.min(...started.map(p => p.start_time));
  // Use the latest finish_time among those who have one, otherwise latest last_seen
  const finished = started.filter(p => p.finish_time);
  const latest = finished.length
    ? Math.max(...finished.map(p => p.finish_time))
    : Math.max(...started.map(p => p.last_seen || p.start_time));
  return Math.max(0, latest - earliest);
}

function allParticipantsAccountedFor() {
  const allP = Object.values(participants);
  if (!allP.length) return false;
  return allP.every(p => p.status === 'dns' || p.status === 'dnf' || p.status === 'finished');
}

function tickClock() {
  const el = document.getElementById('race-clock');
  if (!el) return;
  const countUp = race?.clock_seconds !== 0;

  // Freeze conditions: race not active OR all participants accounted for
  const freeze = !race || race.status !== 'active' || allParticipantsAccountedFor();

  if (freeze) {
    const val = clockFrozenValue();
    el.textContent = val != null ? RT.fmtElapsed(val, countUp) : '--:--:--';
    el.style.opacity = '0.5';
    return;
  }

  el.style.opacity = '1';
  const now = Math.floor(Date.now() / 1000);
  // Use the earliest start_time among active/started participants as the clock origin
  const started = Object.values(participants).filter(p => p.start_time && p.status === 'active');
  if (!started.length) {
    el.textContent = '--:--:--';
    return;
  }
  const earliest = Math.min(...started.map(p => p.start_time));
  const elapsed = now - earliest;
  el.textContent = RT.fmtElapsed(elapsed > 0 ? elapsed : 0, countUp);
}

function startClock() {
  clearInterval(clockInterval);
  tickClock(); // immediate render
  clockInterval = setInterval(tickClock, 1000);
}

async function endRace() {
  if (!race) return;
  if (!confirm(`End race "${race.name}"?\n\nThis will mark the race as complete and stop the clock.`)) return;
  const res = await RT.post(`/api/races/${race.id}/end`, {});
  if (!res.ok) { RT.toast('Failed to end race', 'warn'); return; }
  RT.toast('Race ended', 'info');
  // handleRaceUpdate will fire via WebSocket broadcast
}

// ── Right panel tabs ──────────────────────────────────────────────────────────
function switchRightTab(id) {
  rightTab = id;
  document.querySelectorAll('#right-panel .tab-btn').forEach((b, i) => {
    const ids = ['info','alerts','msg','log','weather'];
    b.classList.toggle('active', ids[i] === id);
  });
  document.querySelectorAll('#right-panel .tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById(`right-tab-${id}`)?.classList.add('active');
  if (id === 'alerts') renderAlertsList();
  if (id === 'weather') renderWeatherPanel();
}

// ── Weather panel ─────────────────────────────────────────────────────────────
function startWxPoller() {
  clearInterval(wxPoller);
  clearInterval(wxAlertPoller);
  wxPoller      = setInterval(fetchWxData,   15 * 60 * 1000);
  wxAlertPoller = setInterval(fetchWxAlerts,  5 * 60 * 1000);
  fetchWxData();
  fetchWxAlerts();
}

async function fetchWxAlerts() {
  if (!race?.weather_enabled) return;
  const res = await RT.get(`/api/races/${race.id}/weather/alerts`);
  wxAlerts = (res.ok && Array.isArray(res.data)) ? res.data : [];
  updateWxAlertBadge();
  if (rightTab === 'weather') renderWeatherPanel();
}

function updateWxAlertBadge() {
  const btn = document.getElementById('wx-tab-btn');
  if (!btn) return;
  const count = wxAlerts.length;
  btn.textContent = count > 0 ? `WX ⚠ ${count}` : 'WX';
  btn.style.color     = count > 0 ? 'var(--accent3)' : '';
  btn.style.borderColor = count > 0 ? 'var(--accent3)' : '';
}

async function fetchWxData() {
  if (!race?.weather_enabled) return;
  const [curRes, fcRes] = await Promise.all([
    RT.get(`/api/races/${race.id}/weather`),
    RT.get(`/api/races/${race.id}/weather/forecast`),
  ]);
  if (curRes.ok && curRes.data) {
    const normalized = normalizeWeather(curRes.data);
    if (normalized) {
      wxData = normalized;
      wxError = null;
      wxDataTs = Date.now();
    } else {
      wxError = curRes.data?.message || 'Invalid weather response from server';
    }
  } else {
    wxError = curRes.error || 'Failed to load weather data';
  }
  if (fcRes.ok && Array.isArray(fcRes.data)) wxForecast = fcRes.data;
  if (rightTab === 'weather') renderWeatherPanel();
}

function renderWeatherPanel() {
  const el = document.getElementById('weather-panel');
  if (!el) return;
  if (!race?.weather_enabled) {
    el.innerHTML = '<div style="color:var(--text3);font-size:14px;padding:4px">Weather not enabled for this race.</div>';
    return;
  }
  if (wxError && !wxData) {
    el.innerHTML = `<div style="color:var(--accent3);font-size:14px;padding:4px">${wxError}</div>`;
    return;
  }
  if (!wxData) {
    el.innerHTML = '<div style="color:var(--text3);font-size:14px">Loading…</div>';
    return;
  }
  const w = wxData;
  const cond = w.weather?.[0];
  const visMi = w.visibility != null ? `${(w.visibility / 1609.34).toFixed(1)} mi` : '--';
  const wind  = w.wind_speed != null
    ? `${Math.round(w.wind_speed)} mph ${w.wind_deg != null ? windDir(w.wind_deg) : ''}`
    : '--';
  const ageSec = Math.round((Date.now() - wxDataTs) / 1000);
  const ageStr = ageSec < 60 ? 'just now' : `${Math.round(ageSec / 60)} min ago`;
  const updated = w.dt ? new Date(w.dt * 1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
  el.innerHTML = `
    ${renderAlertsSection()}
    <div style="text-align:center;padding:8px 0 10px;border-bottom:1px solid var(--border);margin-bottom:10px">
      ${cond ? `<img src="https://openweathermap.org/img/wn/${cond.icon}@2x.png" width="60" height="60" style="margin-bottom:2px">` : ''}
      <div style="font-size:35px;font-weight:bold;color:var(--text);line-height:1">${w.temp != null ? Math.round(w.temp) + '°F' : '--'}</div>
      <div style="font-size:14px;color:var(--text2);margin-top:4px;text-transform:capitalize">${cond?.description || ''}</div>
      ${w.feels_like != null ? `<div style="font-size:13px;color:var(--text3);margin-top:2px">Feels like ${Math.round(w.feels_like)}°F</div>` : ''}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
      <div class="wx-stat"><div class="wx-lbl">WIND</div><div class="wx-val" style="font-size:16px">${wind}</div></div>
      <div class="wx-stat"><div class="wx-lbl">HUMIDITY</div><div class="wx-val">${w.humidity != null ? w.humidity + '%' : '--'}</div></div>
      <div class="wx-stat"><div class="wx-lbl">VISIBILITY</div><div class="wx-val">${visMi}</div></div>
      <div class="wx-stat"><div class="wx-lbl">CLOUDS</div><div class="wx-val">${w.clouds != null ? w.clouds + '%' : '--'}</div></div>
    </div>
    ${updated ? `<div style="font-size:10px;color:var(--text3);text-align:center;margin-top:4px">OWM ${updated} · fetched ${ageStr}</div>` : ''}
    ${renderForecastStrip()}`;
}

function renderForecastStrip() {
  if (!wxForecast?.length) return '';
  const rows = wxForecast.slice(0, 8).map(s => {
    const t     = new Date(s.dt * 1000);
    const label = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    const icon  = s.weather?.[0]?.icon || '01d';
    const desc  = s.weather?.[0]?.description || '';
    const temp  = s.main?.temp != null ? Math.round(s.main.temp) + '°F' : '--';
    const pop   = Math.round((s.pop ?? 0) * 100) + '%';
    const rainMm = s.rain?.['3h'] ?? s.snow?.['3h'] ?? null;
    const vol   = rainMm != null ? (rainMm / 25.4).toFixed(2) + '"' : '—';
    const windSpd = s.wind?.speed != null ? Math.round(s.wind.speed) + ' mph' : null;
    const windDeg = s.wind?.deg   != null ? windDir(s.wind.deg) : '';
    const wind  = windSpd ? `${windSpd} ${windDeg}`.trim() : '—';
    return `
      <div style="display:grid;grid-template-columns:60px 32px 1fr;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-size:13px;font-weight:bold;color:var(--text)">${label}</div>
          <div style="font-size:12px;color:var(--text3);text-transform:capitalize;margin-top:1px">${desc}</div>
        </div>
        <img src="https://openweathermap.org/img/wn/${icon}.png" width="32" height="32">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:13px">
          <div><span style="color:var(--text3)">Temp </span><span style="color:var(--text)">${temp}</span></div>
          <div><span style="color:var(--text3)">Wind </span><span style="color:var(--text)">${wind}</span></div>
          <div><span style="color:var(--text3)">Pop </span><span style="color:#58a6ff">${pop}</span></div>
          <div><span style="color:var(--text3)">Precip </span><span style="color:#58a6ff">${vol}</span></div>
        </div>
      </div>`;
  }).join('');
  return `
    <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:6px">
      <div style="font-size:12px;letter-spacing:1px;color:var(--text3);margin-bottom:4px">24-HOUR FORECAST</div>
      ${rows}
    </div>`;
}

function renderAlertsSection() {
  if (!wxAlerts?.length) return '';
  const SEVERITY_COLOR = { Extreme: '#ff4444', Severe: '#ff8c00', Moderate: '#d29922', Minor: '#58a6ff' };
  const items = wxAlerts.map(a => {
    const color = SEVERITY_COLOR[a.severity] || 'var(--accent3)';
    const exp   = a.expires ? new Date(a.expires).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
    return `<div style="border:1px solid ${color};border-radius:4px;padding:6px 8px;margin-bottom:6px;background:${color}18">
      <div style="font-size:13px;font-weight:bold;color:${color};letter-spacing:.5px">${a.event}</div>
      <div style="font-size:13px;color:var(--text2);margin-top:2px">${a.headline || ''}</div>
      ${exp ? `<div style="font-size:12px;color:var(--text3);margin-top:3px">Expires ${exp}</div>` : ''}
    </div>`;
  }).join('');
  return `<div style="margin-bottom:8px">${items}</div>`;
}

function windDir(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

function normalizeWeather(data) {
  // OWM error response (cod != 200 or "200")
  if (data.cod && String(data.cod) !== '200') return null;
  if (data.current) {
    const c = data.current;
    return { temp: c.temp, feels_like: c.feels_like, humidity: c.humidity,
             wind_speed: c.wind_speed, wind_deg: c.wind_deg,
             visibility: c.visibility, clouds: c.clouds, weather: c.weather, dt: c.dt };
  }
  return { temp: data.main?.temp, feels_like: data.main?.feels_like, humidity: data.main?.humidity,
           wind_speed: data.wind?.speed, wind_deg: data.wind?.deg,
           visibility: data.visibility, clouds: data.clouds?.all, weather: data.weather, dt: data.dt };
}


document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('edit-modal')?.classList.add('hidden');
    document.getElementById('viewer-link-modal')?.classList.add('hidden');
    document.getElementById('personnel-modal')?.classList.add('hidden');
  }
});

init();

return { setBaseLayer, setSort, selectParticipant, switchRightTab, saveParticipant,
         openEditModal, sendMessage, dismissAlert, jumpToMsg, showViewerLink, copyViewerLink,
         toggleStartWindow, endRace,
         switchLeftTab, selectStation,
         openBatchCheckIn, closeBatchCheckIn, addBatchRow, removeBatchRow,
         resolveBib, bibKeydown, timeKeydown, submitBatchCheckIn,
         openEditEvent, saveEditEvent, deleteStationEvent,
         openPersonnelModal, renderPersonnelTable, editPersonnelRow, savePersonnelRow,
         addPersonnel, deletePersonnel, assignPersonnel,
         startRace, setWeatherOpacity };
})();
