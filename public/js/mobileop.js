'use strict';

let race, raceId, currentStation = null;
let participants = [], heats = [], stations = [], messages = [], personnel = [], onlineUsers = [];
let me = null; // current logged-in user, set in init()
let roverStationId = null; // selected station for rover event logging
let _wsConn = null; // WS connection handle for phone_gps sends

// ── Phone GPS state ──────────────────────────────────────────────────────────
let _gpsWatchId    = null;
let _gpsLastLat    = null, _gpsLastLon = null, _gpsLastSent = 0;
const GPS_MIN_DIST     = 15;  // metres — skip update if moved less than this
const GPS_MAX_INTERVAL = 30;  // seconds — force update after this regardless of distance
const GPS_MAX_ACCURACY = 50;  // metres — discard fixes worse than this
let checkedInIds = new Set(); // participant IDs with any event at the current effective station
let expandedPendingId = null; // which pending row is currently expanded
let stationEvents = []; // latest events for current station (for buildCheckedInSet)
let activeRaces = [];
let map, markersLayer, stationMarkers = {}, routeLayer = null, trackPoints = null;
let fmt24 = false;
let baseTiles = {}, currentBaseLayer = null, currentBaseLayerName = 'Street';
let clockInterval = null;
let sortBy = 'position';

// Course distance cache — cleared whenever trackPoints or stations change
let _total = null, _cachedDists = null, _stationAlongCache = null;
const MAX_RACE_SPEED = 8, BACK_MARGIN = 100;

const BASE_LAYERS = {
  'Topo':      { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',        opts: { maxZoom: 16, maxNativeZoom: 16, attribution: 'USGS' } },
  'Satellite': { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 16, maxNativeZoom: 16, attribution: 'USGS' } },
  'Street':    { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',                                              opts: { maxZoom: 19, attribution: '© OSM' } },
  'Dark':      { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',                                  opts: { subdomains: 'abcd', maxZoom: 19, attribution: '© CartoDB' } },
};

const STATUS_COLORS = { dns: '#484f58', active: '#58a6ff', dnf: '#f78166', finished: '#3fb950' };
const EVENT_COLORS  = {
  aid_arrive: 'var(--accent2)', aid_depart: 'var(--accent)',
  dnf: 'var(--accent3)', finish: 'var(--accent2)',
  start: 'var(--accent)', manual: 'var(--text2)',
};

async function init() {
  RT.applyTheme();

  // Populate theme selector
  const themeSel = document.getElementById('mo-theme-sel');
  const savedTheme = localStorage.getItem('rt-theme') || 'dark';
  RT.THEMES.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = t.label; opt.selected = t.id === savedTheme;
    themeSel.appendChild(opt);
  });
  themeSel.onchange = () => RT.applyTheme(themeSel.value);

  const user = await RT.requireLogin(['operator', 'station']);
  if (!user) return;
  me = user;

  const params = new URLSearchParams(location.search);
  raceId = parseInt(params.get('race') || '0', 10);
  if (!raceId) { window.location.href = RT.BASE + 'race-select.html'; return; }

  const rRes = await RT.get(`/api/races/${raceId}`);
  if (!rRes.ok) {
    document.getElementById('mo-race-name').textContent = 'Race not found.';
    return;
  }
  race = rRes.data;
  fmt24 = race.time_format === '24h';
  applySpeedDisplayLabels();
  const racePill = document.getElementById('mo-race-pill');
  racePill.textContent = race.name.toUpperCase();
  racePill.className = 'pill pill-ok';
  document.title = `MobilOp — ${race.name}`;

  if (race.messaging_enabled) {
    document.getElementById('tab-msg').classList.remove('hidden');
    document.getElementById('mo-msg-sidebar').style.display = 'flex';
    const pRes = await RT.get(`/api/races/${raceId}/personnel`);
    personnel = pRes.ok ? pRes.data : [];
    renderPersonnelRecipients();
  }

  const sRes = await RT.get(`/api/races/${raceId}/stations`);
  stations = sRes.ok ? sRes.data : [];

  // Restore station from sessionStorage
  const savedId = parseInt(sessionStorage.getItem(`mo-station-${raceId}`) || '0', 10);
  const savedStation = savedId ? stations.find(s => s.id === savedId) : null;
  if (savedStation) {
    await assignStation(savedStation);
    loadStationEvents();
  } else {
    showStationPicker();
  }

  initMap();
  startClock();
  _wsConn = RT.connectWS(handleWS, null, raceId);

  const racesRes = await RT.get('/api/races');
  activeRaces = racesRes.ok ? racesRes.data.filter(r => r.status === 'active') : [];
  updateRaceSwitcher();
  initGps();
}

// ── Clock ────────────────────────────────────────────────────────────────────

function startClock() {
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = setInterval(() => {
    if (!race) return;
    const active = participants.find(p => p.status === 'active' && p.start_time);
    if (!active) return;
    const elapsed = Math.floor(Date.now() / 1000) - active.start_time;
    document.getElementById('mo-clock').textContent = RT.fmtElapsed(elapsed > 0 ? elapsed : 0, race?.clock_seconds !== 0);
  }, 1000);
}

function getSpeedDisplayLabel() {
  return race?.speed_display === 'speed' ? 'SPEED' : 'PACE';
}

function applySpeedDisplayLabels() {
  const headerLabel = document.querySelector('#mo-lb-wrap .v-lb-head span:nth-child(5)');
  if (headerLabel) headerLabel.textContent = getSpeedDisplayLabel();
  const sortBtn = document.querySelector('#mo-sort-bar .v-sort-btn[data-sort="pace"]');
  if (sortBtn) sortBtn.textContent = getSpeedDisplayLabel();
}

function formatSpeedColumn(p) {
  return p._pace ? RT.fmtSpeed(p._pace, race?.speed_units || 'min_mile') : '--';
}

// ── Race switcher ─────────────────────────────────────────────────────────────

function updateRaceSwitcher() {
  const pill = document.getElementById('mo-race-pill');
  if (!pill) return;
  const others = activeRaces.filter(r => r.id !== race?.id);
  pill.querySelector('.race-switcher-chevron')?.remove();
  if (!others.length) { pill.style.cursor = ''; pill.onclick = null; pill.title = ''; return; }
  pill.style.cursor = 'pointer';
  pill.title = 'Switch race';
  const chev = document.createElement('span');
  chev.className = 'race-switcher-chevron';
  chev.textContent = ' ▾';
  chev.style.fontSize = '11px';
  pill.appendChild(chev);
  pill.onclick = (e) => { e.stopPropagation(); toggleRaceSwitcherDropdown(others); };
}

function toggleRaceSwitcherDropdown(others) {
  const existing = document.getElementById('race-switcher-drop');
  if (existing) { existing.remove(); return; }
  const pill = document.getElementById('mo-race-pill');
  const rect = pill.getBoundingClientRect();
  const drop = document.createElement('div');
  drop.id = 'race-switcher-drop';
  drop.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;
    background:var(--surface);border:1px solid var(--border);border-radius:6px;
    box-shadow:0 4px 16px rgba(0,0,0,.4);z-index:1000;min-width:200px;padding:4px 0`;
  drop.innerHTML = others.map(r =>
    `<div style="padding:10px 14px;cursor:pointer;font-size:14px;white-space:nowrap"
      onmouseover="this.style.background='var(--hover,rgba(255,255,255,.06))'"
      onmouseout="this.style.background=''"
      onclick="switchToRace(${r.id})">${r.name}</div>`
  ).join('');
  document.body.appendChild(drop);
  setTimeout(() => document.addEventListener('click', () => drop.remove(), { once: true }), 0);
}

function switchToRace(id) {
  const url = new URL(location.href);
  url.searchParams.set('race', id);
  location.href = url.toString();
}

// ── Station picker ────────────────────────────────────────────────────────────

function showStationPicker() {
  const list = document.getElementById('sp-list');
  const pickable = stations.filter(s => !['netcontrol', 'repeater'].includes(s.type));

  if (!pickable.length) {
    list.innerHTML = '<p style="color:var(--text2);font-size:14px">No stations configured for this race.</p>';
  } else {
    list.innerHTML = pickable.map(s => `
      <div class="sp-item" onclick="pickStation(${s.id})">
        <div class="sp-item-name">${s.name}</div>
        <div class="sp-item-type">${s.type.replace(/_/g, ' ')}</div>
      </div>`).join('');
  }

  // Show cancel button only if a station is already assigned (re-picking)
  document.getElementById('sp-footer').style.display = currentStation ? '' : 'none';
  document.getElementById('station-picker').classList.remove('hidden');
}

async function pickStation(stationId) {
  const station = stations.find(s => s.id === stationId);
  if (!station) return;
  document.getElementById('station-picker').classList.add('hidden');
  await assignStation(station);
  loadStationEvents();
}

async function assignStation(station) {
  currentStation = station;
  roverStationId = null;
  checkedInIds = new Set();
  expandedPendingId = null;
  stationEvents = [];
  sessionStorage.setItem(`mo-station-${raceId}`, station.id);

  document.getElementById('mo-station-badge').textContent = station.name;
  document.getElementById('mo-no-station').classList.add('hidden');
  document.getElementById('mo-station-badge').style.background = 'rgba(88,166,255,.15)';
  document.getElementById('mo-station-badge').style.fontWeight = 'bold';

  // Populate rover station selector with all pickable stations
  const roverRow = document.getElementById('mo-rover-station-row');
  if (station.type === 'rover') {
    const sel = document.getElementById('mo-rover-station-sel');
    const pickable = stations.filter(s => s.type !== 'rover' && s.type !== 'netcontrol' && s.type !== 'repeater');
    sel.innerHTML = '<option value="">— select —</option>' +
      pickable.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    roverRow.style.display = 'flex';
  } else {
    roverRow.style.display = 'none';
  }

  // Register station on the server (callsign matching happens here)
  await RT.post(`/api/races/${raceId}/stations/${station.id}/assign`, {});
}

// ── Map ───────────────────────────────────────────────────────────────────────

function updateBaseLayerSelector() {
  const sel = document.getElementById('mo-base-layer-sel');
  if (!sel) return;
  const offlineOnly = !!(race?.offline_maps && race?.offline_maps_status === 'ready');
  for (const opt of sel.options) {
    const capable = opt.value === 'Topo' || opt.value === 'Satellite';
    opt.hidden   = offlineOnly && !capable;
    opt.disabled = offlineOnly && !capable;
  }
  if (offlineOnly && sel.value !== 'Topo' && sel.value !== 'Satellite') {
    setBaseLayer('Topo');
  }
}

function setBaseLayer(name) {
  if (currentBaseLayer) map.removeLayer(currentBaseLayer);
  currentBaseLayerName = name;
  const layerKey = name.toLowerCase(); // 'Topo' → 'topo', 'Satellite' → 'satellite'
  const OFFLINE_CAPABLE = { topo: true, satellite: true };
  const useOffline = race?.offline_maps && race?.offline_maps_status === 'ready' && OFFLINE_CAPABLE[layerKey];
  if (useOffline) {
    currentBaseLayer = L.tileLayer(
      `${RT.BASE}api/tiles/${race.id}/${layerKey}/{z}/{x}/{y}`,
      { maxZoom: 16, maxNativeZoom: 14, attribution: 'USGS (offline)' }
    );
  } else {
    currentBaseLayer = baseTiles[name] || baseTiles['Street'];
  }
  currentBaseLayer.addTo(map);
  const sel = document.getElementById('mo-base-layer-sel');
  if (sel) sel.value = name;
}

function renderRoute() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (!trackPoints || trackPoints.length < 2) return;
  routeLayer = L.polyline(trackPoints, { color: '#f5a623', weight: 5, opacity: 0.85 }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
}

function renderStationMarkers() {
  Object.values(stationMarkers).forEach(m => map.removeLayer(m));
  stationMarkers = {};
  for (const s of stations) {
    const color = s.type === 'start' ? '#3fb950' : s.type === 'finish' ? '#f78166' :
                  s.type === 'start_finish' ? '#a371f7' : s.type === 'turnaround' ? '#58a6ff' :
                  s.type === 'netcontrol' ? '#d2993a' : s.type === 'repeater' ? '#6e7681' :
                  s.type === 'rover' ? '#c084fc' : '#d2a679';
    const letter = s.type === 'start' ? 'S' : s.type === 'finish' ? 'F' :
                   s.type === 'start_finish' ? '⇌' : s.type === 'turnaround' ? 'T' :
                   s.type === 'netcontrol' ? 'N' : s.type === 'repeater' ? 'R' :
                   s.type === 'rover' ? '⟳' : s.name[0]?.toUpperCase() || 'A';
    const icon = L.divIcon({
      html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2px solid #fff4;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;color:#000">${letter}</div>`,
      className: '', iconAnchor: [10, 10],
    });
    stationMarkers[s.id] = L.marker([s.lat, s.lon], { icon }).bindTooltip(s.name).addTo(map);
  }
  if (stations.length && !trackPoints) {
    const bounds = L.latLngBounds(stations.map(s => [s.lat, s.lon]));
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function initMap() {
  map = L.map('mo-map', { zoomControl: true, maxZoom: 16 });
  for (const [name, cfg] of Object.entries(BASE_LAYERS)) {
    baseTiles[name] = L.tileLayer(cfg.url, cfg.opts);
  }
  setBaseLayer('Street');
  markersLayer = L.layerGroup().addTo(map);
  renderStationMarkers();
  if (!stations.length) map.setView([39.5, -98.5], 5);
}

const trackerMarkers = {};

function updateMarker(nodeId, pos) {
  const p = participants.find(p => p.tracker_id === nodeId);
  const heat = p ? heats.find(h => h.id === p.heat_id) : null;
  const { svg, cls } = RT.trackerIcon(heat, false, false);
  const icon = L.divIcon({ html: svg, className: cls, iconSize: [20, 20], iconAnchor: [10, 10] });
  if (trackerMarkers[nodeId]) {
    trackerMarkers[nodeId].setLatLng([pos.lat, pos.lon]).setIcon(icon);
  } else {
    trackerMarkers[nodeId] = L.marker([pos.lat, pos.lon], { icon }).addTo(markersLayer);
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function handleWS(msg) {
  if (msg.type === 'init') {
    participants = msg.data.participants || [];
    heats        = msg.data.heats || [];
    onlineUsers  = msg.data.onlineUsers || [];
    if (msg.data.race) { race = msg.data.race; fmt24 = race.time_format === '24h'; }
    // Seed _lastStation from server-supplied field
    participants.forEach(p => { p._lastStation = p.last_station_name || null; });
    if (msg.data.stations?.length) {
      stations = msg.data.stations;
      _stationAlongCache = null;
      renderStationMarkers();
    }
    if (msg.data.trackPoints?.length) {
      trackPoints = msg.data.trackPoints;
      _cachedDists = null; _total = null; _stationAlongCache = null;
      renderRoute();
    }
    renderLeaderboard();
    if (msg.data.messages) { messages = msg.data.messages; renderMessages(); }
    for (const [nodeId, pos] of Object.entries(msg.data.positions || {})) {
      updateMarker(nodeId, pos);
    }
    // Restrict selector and switch to offline URLs if already ready
    updateBaseLayerSelector();
    if (race?.offline_maps && race?.offline_maps_status === 'ready') setBaseLayer(currentBaseLayerName);
  } else if (msg.type === 'position') {
    const p = participants.find(x => x.tracker_id === msg.data.nodeId);
    if (p) { p.last_lat = msg.data.lat; p.last_lon = msg.data.lon; }
    updateMarker(msg.data.nodeId, msg.data);
    renderLeaderboard();
  } else if (msg.type === 'participant_update') {
    refreshParticipants();
  } else if (msg.type === 'event') {
    const ev = msg.data;
    const p = participants.find(x => x.id === ev.participant_id);
    if (p) {
      if (ev.event_type === 'start')  { p.status = 'active';   p.start_time = ev.timestamp; }
      if (ev.event_type === 'finish') { p.status = 'finished'; p.finish_time = ev.timestamp; }
      if (ev.event_type === 'dnf')      p.status = 'dnf';
      if (ev.has_turnaround && !p.has_turnaround) {
        p.has_turnaround = true;
        const td = _total || computeTotal();
        if (td) { p._lastAlong = td; p._lastAlongTs = ev.timestamp; }
      }
      if (ev.station_id && !p.has_turnaround) {
        const along = getStationAlongMap().get(ev.station_id);
        if (along != null) p._stationFloor = Math.max(p._stationFloor ?? 0, along);
        p.last_station_id = ev.station_id;
        p.last_station_ts = ev.timestamp;
      }
      if (ev.event_type === 'aid_depart' && ev.station_name)
        p._lastStation = ev.station_name;
      renderLeaderboard();
    }
    const effectiveStationId = roverStationId || currentStation?.id;
    if (currentStation && ev.station_id === effectiveStationId) {
      prependEventRow(ev);
      if (ev.participant_id) {
        checkedInIds.add(ev.participant_id);
        if (expandedPendingId === ev.participant_id) expandedPendingId = null;
        renderPendingList();
      }
    }
  } else if (msg.type === 'race_update') {
    if (msg.data?.id === race?.id) {
      const wasOfflineReady = race.offline_maps_status === 'ready';
      race = msg.data;
      fmt24 = race.time_format === '24h';
      applySpeedDisplayLabels();
      if (!wasOfflineReady && race.offline_maps_status === 'ready') setBaseLayer(currentBaseLayerName);
      updateBaseLayerSelector();
    }
  } else if (msg.type === 'message') {
    const isNew = !messages.find(m => m.id === msg.data.id);
    if (isNew) messages.unshift(msg.data);
    renderMessages();
  } else if (msg.type === 'users_online') {
    onlineUsers = msg.data;
    renderPersonnelRecipients();
  }
}

async function refreshParticipants() {
  const res = await RT.get(`/api/races/${raceId}/participants`);
  if (!res.ok) return;
  // Preserve computed fields (_lastAlong, _lastStation, etc.) across refresh
  const prev = new Map(participants.map(p => [p.id, p]));
  participants = res.data.map(p => ({ ...p, ...{ _lastStation: p.last_station_name || null }, ...pick(prev.get(p.id), '_lastAlong', '_lastAlongTs', '_stationFloor', '_lastStation', 'has_turnaround') }));
  renderLeaderboard();
  renderPendingList();
}

function pick(obj, ...keys) {
  if (!obj) return {};
  return Object.fromEntries(keys.filter(k => obj[k] != null).map(k => [k, obj[k]]));
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

function fmtParticipantName(name) {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function renderLeaderboard() {
  const el = document.getElementById('mo-lb-body');
  if (!el) return;
  const list = [...participants];
  list.forEach(p => { p._pct = computePct(p); });

  list.sort((a, b) => {
    if (sortBy === 'position') return (b._pct || 0) - (a._pct || 0);
    if (sortBy === 'bib') return String(a.bib).localeCompare(String(b.bib), undefined, { numeric: true });
    if (sortBy === 'pace') return (a._pace || Infinity) - (b._pace || Infinity);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'heat') {
      const ha = heats.find(h => h.id === a.heat_id), hb = heats.find(h => h.id === b.heat_id);
      return (ha?.name || '').localeCompare(hb?.name || '');
    }
    return 0;
  });

  const STATUS_COLORS = { dns: '#8b949e', active: '#58a6ff', dnf: '#f78166', finished: '#3fb950' };

  el.innerHTML = list.map((p, i) => {
    const sc = STATUS_COLORS[p.status] || '#8b949e';
    const heat = heats.find(h => h.id === p.heat_id);
    const dot = heat ? `<span class="dot" style="background:${heat.color}"></span>` : '';
    const pct = p._pct != null ? `${p._pct.toFixed(0)}%` : '--';
    const finished = p.status === 'finished';
    const lastAid = p._lastStation || '--';
    return `<div class="v-lb-row v-lb-cols ${finished ? 'text-ok' : ''}" onclick="lookupParticipant(${p.id})" style="cursor:pointer">
      <span style="color:var(--text2)">${i + 1}</span>
      <span style="color:${sc};font-weight:bold">${p.bib}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${dot} ${fmtParticipantName(p.name)}</span>
      <span style="color:var(--accent)">${pct}</span>
      <span style="color:var(--text);font-size:13px">${p._pct && p.start_time ? formatSpeedColumn(p) : '--'}</span>
      <span style="color:var(--text2);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${lastAid}</span>
    </div>`;
  }).join('');
}

function setSort(key) {
  sortBy = key;
  document.querySelectorAll('.v-sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
  renderLeaderboard();
}

// ── Course progress computation (mirrors viewer.js exactly) ──────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Phone GPS reporting ───────────────────────────────────────────────────────

function initGps() {
  const enabled = localStorage.getItem('mo-gps') === '1';
  _setGps(enabled);
}

function toggleGps() {
  const enable = _gpsWatchId === null;
  localStorage.setItem('mo-gps', enable ? '1' : '0');
  _setGps(enable);
}

function _setGps(enable) {
  const btn = document.getElementById('mo-gps-btn');
  if (!enable) {
    if (_gpsWatchId !== null) { navigator.geolocation.clearWatch(_gpsWatchId); _gpsWatchId = null; }
    _gpsLastLat = null; _gpsLastLon = null; _gpsLastSent = 0;
    if (btn) { btn.title = 'Enable GPS reporting'; btn.style.opacity = '0.45'; }
    return;
  }
  if (!navigator.geolocation) {
    RT.toast('GPS not available on this device', 'warn');
    localStorage.removeItem('mo-gps');
    return;
  }
  if (btn) { btn.title = 'Disable GPS reporting'; btn.style.opacity = '1'; }
  _gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude: lat, longitude: lon, altitude, speed, heading, accuracy } = pos.coords;
      if (accuracy > GPS_MAX_ACCURACY) return; // poor fix — skip
      const now = Math.floor(Date.now() / 1000);
      const dist = (_gpsLastLat !== null) ? haversine(lat, lon, _gpsLastLat, _gpsLastLon) : Infinity;
      if (dist < GPS_MIN_DIST && (now - _gpsLastSent) < GPS_MAX_INTERVAL) return;
      _gpsLastLat = lat; _gpsLastLon = lon; _gpsLastSent = now;
      _wsConn?.send({ type: 'phone_gps', data: { lat, lon, altitude, speed, heading, accuracy } });
    },
    err => { console.warn('GPS watch error:', err.message); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}

function ensureDistCache() {
  if (_cachedDists || !trackPoints || trackPoints.length < 2) return;
  _cachedDists = [0];
  for (let i = 1; i < trackPoints.length; i++)
    _cachedDists.push(_cachedDists[i - 1] + haversine(
      trackPoints[i - 1][0], trackPoints[i - 1][1], trackPoints[i][0], trackPoints[i][1]));
  _total = _cachedDists[_cachedDists.length - 1];
}

function computeTotal() {
  ensureDistCache();
  return _total || 0;
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
      const [lat1, lon1] = trackPoints[i], [lat2, lon2] = trackPoints[i + 1];
      const ax = s.lat - lat1, ay = s.lon - lon1, bx = lat2 - lat1, by = lon2 - lon1;
      const t = Math.max(0, Math.min(1, (ax * bx + ay * by) / Math.max(1e-10, bx * bx + by * by)));
      const d = haversine(s.lat, s.lon, lat1 + t * bx, lon1 + t * by);
      if (d < minD) { minD = d; best = _cachedDists[i] + t * (_cachedDists[i + 1] - _cachedDists[i]); }
    }
    _stationAlongCache.set(s.id, best);
  }
  return _stationAlongCache;
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

  const now = Math.floor(Date.now() / 1000);
  const lastAlong = p._lastAlong ?? 0;
  const lastTs = p._lastAlongTs ?? (p.start_time || now);
  const travelDist = Math.max(0, now - lastTs) * MAX_RACE_SPEED + BACK_MARGIN;
  const windowMin = Math.max(0, lastAlong - travelDist);
  const windowMax = Math.min(totalDist, lastAlong + travelDist);

  let minD = Infinity, bestAlong = lastAlong;
  for (let i = 0; i < trackPoints.length - 1; i++) {
    if (_cachedDists[i + 1] < windowMin || _cachedDists[i] > windowMax) continue;
    const [lat1, lon1] = trackPoints[i], [lat2, lon2] = trackPoints[i + 1];
    const segLen = _cachedDists[i + 1] - _cachedDists[i];
    const ax = p.last_lat - lat1, ay = p.last_lon - lon1, bx = lat2 - lat1, by = lon2 - lon1;
    const t = Math.max(0, Math.min(1, (ax * bx + ay * by) / Math.max(1e-10, bx * bx + by * by)));
    const d = haversine(p.last_lat, p.last_lon, lat1 + t * bx, lon1 + t * by);
    if (d < minD) { minD = d; bestAlong = _cachedDists[i] + t * segLen; }
  }

  if (!(race?.race_format === 'out_and_back' && p.has_turnaround))
    bestAlong = Math.max(bestAlong, p._stationFloor ?? 0);

  p._lastAlong = bestAlong;
  p._lastAlongTs = now;

  if (race?.race_format === 'out_and_back') {
    if (p.has_turnaround) return Math.min(100, (2 * totalDist - bestAlong) / (2 * totalDist) * 100);
    return Math.min(50, bestAlong / (2 * totalDist) * 100);
  }
  return Math.min(100, bestAlong / totalDist * 100);
}

function fmtPace(p) {
  if (!p.start_time || !p._pct) return '--';
  const total = computeTotal();
  if (!total) return '--';
  if (!p.last_lat && p.last_station_id && p.last_station_ts) {
    const along = getStationAlongMap().get(p.last_station_id);
    if (along == null || along <= 0) return '--';
    const stationElapsed = p.last_station_ts - p.start_time;
    if (stationElapsed <= 0) return '--';
    const distCovered = (race?.race_format === 'out_and_back' && p.has_turnaround)
      ? 2 * total - along : along;
    return RT.fmtPace(distCovered / stationElapsed);
  }
  const dist = race?.race_format === 'out_and_back' ? total * 2 : total;
  const elapsed = (p.status === 'finished' && p.finish_time)
    ? p.finish_time - p.start_time
    : Math.floor(Date.now() / 1000) - p.start_time;
  if (elapsed <= 0) return '--';
  return RT.fmtPace(dist / elapsed);
}

// ── LOG ───────────────────────────────────────────────────────────────────────

function buildCheckedInSet(events) {
  const stationId = roverStationId || currentStation?.id;
  checkedInIds = new Set(
    events
      .filter(e => e.station_id === stationId && e.participant_id)
      .map(e => e.participant_id)
  );
}

const EVENT_BTN = {
  aid_arrive: { label: 'ARRIVE', cls: 'mo-btn-arrive' },
  aid_depart: { label: 'DEPART', cls: 'mo-btn-depart' },
  finish:     { label: 'FINISH', cls: 'mo-btn-arrive' },
  start:      { label: 'START',  cls: 'mo-btn-depart' },
  dnf:        { label: 'DNF',    cls: 'mo-btn-dnf'    },
  dns:        { label: 'DNS',    cls: 'mo-btn-dnf'    },
};

function getStationEventTypes(type) {
  switch (type) {
    case 'finish':       return ['finish'];
    case 'start':        return ['start', 'dns', 'dnf'];
    case 'start_finish': return ['start', 'finish', 'dns', 'dnf'];
    default:             return ['aid_depart', 'aid_arrive', 'dnf'];
  }
}

function getEffectiveStationType() {
  if (currentStation?.type === 'rover') {
    return stations.find(s => s.id === roverStationId)?.type || 'aid';
  }
  return currentStation?.type || 'aid';
}

function renderPendingList() {
  const el = document.getElementById('mo-pending-list');
  if (!el) return;

  if (!currentStation) {
    el.innerHTML = '<div style="padding:16px 12px;color:var(--text3);font-size:14px">No station assigned.</div>';
    document.getElementById('mo-pending-label').textContent = 'PENDING CHECK-IN';
    return;
  }

  const stationType = getEffectiveStationType();
  const isStart  = ['start', 'start_finish'].includes(stationType);
  const isFinish = ['finish', 'start_finish'].includes(stationType);
  const eventTypes = getStationEventTypes(stationType);

  const eligible = participants.filter(p => {
    if (checkedInIds.has(p.id)) return false;
    if (isStart && isFinish) return p.status === 'dns' || p.status === 'active';
    if (isStart)  return p.status === 'dns';
    return p.status === 'active';
  });

  if (isStart) {
    eligible.sort((a, b) => String(a.bib).localeCompare(String(b.bib), undefined, { numeric: true }));
  } else {
    eligible.sort((a, b) => (b._pct || 0) - (a._pct || 0));
  }

  document.getElementById('mo-pending-label').textContent = `PENDING CHECK-IN  (${eligible.length})`;

  if (!eligible.length) {
    el.innerHTML = '<div style="padding:16px 12px;color:var(--text3);font-size:14px;text-align:center">All participants accounted for.</div>';
    return;
  }

  el.innerHTML = eligible.map(p => {
    const sc = STATUS_COLORS[p.status] || '#8b949e';
    const pct = p._pct != null ? `${p._pct.toFixed(0)}%` : '--';
    const isExpanded = p.id === expandedPendingId;
    const heat = heats.find(h => h.id === p.heat_id);
    const dot = heat ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${heat.color};margin-right:4px;flex-shrink:0"></span>` : '';
    const actionBtns = eventTypes.map(et => {
      const cfg = EVENT_BTN[et];
      return `<button class="mo-action-btn ${cfg.cls}" onclick="event.stopPropagation();logPendingEvent(${p.id},'${et}')">${cfg.label}</button>`;
    }).join('');
    return `<div class="mo-pending-row${isExpanded ? ' expanded' : ''}" data-pid="${p.id}" onclick="togglePendingRow(${p.id})">
        <span style="color:${sc};font-weight:bold">${p.bib}</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center">${dot}${fmtParticipantName(p.name)}</span>
        <span style="color:var(--accent);text-align:right">${pct}</span>
        <span style="color:var(--text3);font-size:16px;text-align:right">${isExpanded ? '&#9650;' : '&#9654;'}</span>
      </div>
      ${isExpanded ? `<div class="mo-pending-actions">${actionBtns}</div>` : ''}`;
  }).join('');
}

function togglePendingRow(id) {
  expandedPendingId = (expandedPendingId === id) ? null : id;
  renderPendingList();
  if (expandedPendingId === id) {
    setTimeout(() => document.querySelector(`[data-pid="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 30);
  }
}

async function logPendingEvent(participantId, eventType) {
  if (!currentStation) { RT.toast('No station assigned', 'warn'); return; }
  const isRover = currentStation.type === 'rover';
  if (isRover && !roverStationId) { RT.toast('Select a station location first', 'warn'); return; }

  const res = await RT.post(`/api/races/${raceId}/events`, {
    participant_id: participantId,
    event_type: eventType,
    station_id: isRover ? roverStationId : currentStation.id,
  });

  if (!res.ok) { RT.toast(res.error || 'Failed to log event', 'warn'); return; }

  checkedInIds.add(participantId);
  expandedPendingId = null;

  const idx = participants.findIndex(p => p.id === participantId);
  if (idx !== -1) {
    if (eventType === 'dnf') participants[idx].status = 'dnf';
    else if (eventType === 'finish') { participants[idx].status = 'finished'; participants[idx].finish_time = res.data.timestamp; }
    else if (eventType === 'start') { participants[idx].status = 'active'; participants[idx].start_time = res.data.timestamp; }
    renderLeaderboard();
  }

  renderPendingList();
  const label = eventType.replace('aid_', '').toUpperCase();
  const p = participants[idx];
  RT.toast(`${label} — #${p?.bib} ${p?.name}`, 'ok');
}

function lookupParticipant(id) {
  switchTab('log');
  if (!checkedInIds.has(id)) {
    expandedPendingId = id;
    renderPendingList();
    setTimeout(() => document.querySelector(`[data-pid="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  }
}

// ── Batch check-in modal ──────────────────────────────────────────────────────

function openMobileBatch() {
  if (!currentStation) { RT.toast('No station assigned', 'warn'); return; }
  const isRover = currentStation.type === 'rover';
  if (isRover && !roverStationId) { RT.toast('Select a station location first', 'warn'); return; }

  const stationName = isRover
    ? stations.find(s => s.id === roverStationId)?.name
    : currentStation.name;
  document.getElementById('mo-bc-station').textContent = stationName || '';

  const stationType = getEffectiveStationType();
  const eventTypes = getStationEventTypes(stationType);
  const LABELS = { aid_arrive: 'Arrive', aid_depart: 'Depart', finish: 'Finish', start: 'Start', dnf: 'DNF', dns: 'DNS' };
  const sel = document.getElementById('mo-bc-event-type');
  sel.innerHTML = eventTypes.map(et => `<option value="${et}">${LABELS[et] || et}</option>`).join('');
  sel.value = eventTypes[0];

  const now = new Date();
  document.getElementById('mo-bc-default-time').value =
    [now.getHours(), now.getMinutes(), now.getSeconds()].map(v => String(v).padStart(2, '0')).join(':');

  document.getElementById('mo-bc-rows').innerHTML = '';
  document.getElementById('mo-bc-status').textContent = '';
  addMobileBatchRow();
  document.getElementById('mo-batch-modal').classList.remove('hidden');
  setTimeout(() => document.querySelector('#mo-bc-rows .mo-bc-bib')?.focus(), 50);
}

function closeMobileBatch() {
  document.getElementById('mo-batch-modal').classList.add('hidden');
}

function addMobileBatchRow(bibVal = '', focusBib = false) {
  const container = document.getElementById('mo-bc-rows');
  const div = document.createElement('div');
  div.className = 'bc-row';
  div.innerHTML = `
    <div><input class="mo-bc-bib bc-bib" placeholder="BIB or name"
      style="width:100%;font-size:18px;padding:10px 8px"
      value="${bibVal}"
      onblur="resolveMobileBib(this)"
      onkeydown="mobileBibKeydown(event,this)"></div>
    <div><div class="bc-bib-name text-dim">—</div></div>
    <div><button onclick="this.closest('.bc-row').remove()"
      style="padding:8px 12px;color:var(--accent3);font-size:16px;background:none;border:none;cursor:pointer">&#x2715;</button></div>`;
  container.appendChild(div);
  if (bibVal) resolveMobileBib(div.querySelector('.mo-bc-bib'));
  if (focusBib) div.querySelector('.mo-bc-bib').focus();
  return div.querySelector('.mo-bc-bib');
}

function resolveMobileBib(input) {
  const val = input.value.trim();
  const nameEl = input.closest('.bc-row')?.querySelector('.bc-bib-name');
  if (!nameEl) return;
  if (!val) { nameEl.textContent = '—'; nameEl.style.color = ''; return; }
  const match = participants.find(p =>
    String(p.bib).toLowerCase() === val.toLowerCase() ||
    p.name?.toLowerCase().includes(val.toLowerCase())
  );
  if (match) {
    input.value = match.bib;
    nameEl.textContent = match.name;
    nameEl.style.color = 'var(--accent2)';
  } else {
    nameEl.textContent = 'Not found';
    nameEl.style.color = 'var(--accent3)';
  }
}

function mobileBibKeydown(e, input) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const rows = [...document.querySelectorAll('#mo-bc-rows .mo-bc-bib')];
  const idx = rows.indexOf(input);
  if (idx === rows.length - 1) addMobileBatchRow('', true);
  else rows[idx + 1].focus();
}

async function submitMobileBatch() {
  if (!currentStation) return;
  const isRover = currentStation.type === 'rover';
  const stationId = isRover ? roverStationId : currentStation.id;
  if (!stationId) { RT.toast('No station selected', 'warn'); return; }

  const eventType = document.getElementById('mo-bc-event-type').value;
  const defaultTimeStr = document.getElementById('mo-bc-default-time').value.trim();
  const defaultTs = defaultTimeStr
    ? parseTimeToUnix(defaultTimeStr, race?.date)
    : Math.floor(Date.now() / 1000);

  const bibs = [...document.querySelectorAll('#mo-bc-rows .mo-bc-bib')]
    .map(i => i.value.trim()).filter(Boolean);
  if (!bibs.length) { RT.toast('No entries', 'warn'); return; }

  const statusEl = document.getElementById('mo-bc-status');
  statusEl.textContent = `Submitting ${bibs.length}…`;

  let ok = 0, fail = 0;
  for (const bib of bibs) {
    const p = participants.find(x => String(x.bib).toLowerCase() === bib.toLowerCase());
    if (!p) { fail++; continue; }
    const res = await RT.post(`/api/races/${raceId}/events`, {
      participant_id: p.id,
      event_type: eventType,
      station_id: stationId,
      timestamp: defaultTs,
    });
    if (res.ok) {
      ok++;
      checkedInIds.add(p.id);
    } else {
      fail++;
    }
  }

  const msg = `${ok} logged${fail ? `, ${fail} failed` : ''}`;
  statusEl.textContent = msg;
  RT.toast(msg, fail ? 'warn' : 'ok');
  if (ok > 0) {
    renderPendingList();
    setTimeout(closeMobileBatch, 800);
  }
}

function parseTimeToUnix(str, dateStr) {
  const base = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const s = str.trim().replace(/:/g, '');
  let h = 0, m = 0, sec = 0;
  if (s.length <= 2)      { h = +s; }
  else if (s.length <= 4) { h = +s.slice(0, 2); m = +s.slice(2); }
  else                    { h = +s.slice(0, 2); m = +s.slice(2, 4); sec = +s.slice(4, 6); }
  if ([h, m, sec].some(isNaN)) return null;
  base.setHours(h, m, sec, 0);
  return Math.floor(base.getTime() / 1000);
}

async function loadStationEvents() {
  if (!currentStation) return;
  const url = currentStation.type === 'rover'
    ? `/api/races/${raceId}/events?limit=200`
    : `/api/races/${raceId}/events?station_id=${currentStation.id}&limit=200`;
  const res = await RT.get(url);
  if (!res.ok) return;
  stationEvents = res.data;
  buildCheckedInSet(stationEvents);
  const list = document.getElementById('mo-events-list');
  list.innerHTML = '';
  for (const ev of res.data.slice(0, 50)) list.appendChild(buildEventRow(ev));
  renderPendingList();
}

function prependEventRow(ev) {
  const list = document.getElementById('mo-events-list');
  list.insertBefore(buildEventRow(ev), list.firstChild);
}

function buildEventRow(ev) {
  const color = EVENT_COLORS[ev.event_type] || 'var(--text2)';
  const who = ev.participant_name ? `#${ev.bib} ${ev.participant_name}` : '—';
  const row = document.createElement('div');
  row.className = 'mo-event-row';
  row.innerHTML =
    `<span class="mo-event-time">${RT.fmtTime(ev.timestamp, fmt24)}</span>` +
    `<span class="mo-event-type" style="color:${color}">${ev.event_type.replace(/_/g, ' ')}</span>` +
    `<span class="mo-event-who">${who}</span>`;
  return row;
}

// ── Messages ──────────────────────────────────────────────────────────────────

// Resolve a tracker_id (name or hex node_id) to all matching hex node_ids for
// message thread filtering (mirrors operator.js exactly).
function resolveNodeIdForMessages(trackerId) {
  if (!trackerId) return [];
  const ids = new Set([trackerId]);
  if (trackerId.startsWith('web:')) return [...ids]; // web-only ID, exact match
  if (/^![0-9a-f]{8}$/i.test(trackerId)) return [...ids];
  for (const p of participants) {
    const hex = p.registry?.node_id;
    if (hex && (
      p.tracker_id?.toLowerCase() === trackerId.toLowerCase() ||
      p.registry?.long_name?.toLowerCase() === trackerId.toLowerCase() ||
      p.registry?.short_name?.toLowerCase() === trackerId.toLowerCase()
    )) ids.add(hex);
  }
  for (const m of messages) {
    if (m.direction === 'out' && m.to_name === trackerId && /^![0-9a-f]{8}$/i.test(m.to_node_id))
      ids.add(m.to_node_id);
  }
  return [...ids];
}

function renderPersonnelRecipients() {
  const radioOpts = personnel.filter(p => p.tracker_id).map(p =>
    `<option value="${p.tracker_id}" data-name="${p.name}">${p.name}${p.station_name ? ' @ ' + p.station_name : ''}</option>`
  ).join('');

  const webUsers = onlineUsers.filter(u => u.username !== me?.username);
  const webOpts = webUsers.map(u =>
    `<option value="web:${u.username}" data-name="${u.username}">${u.username} (${u.role})</option>`
  ).join('');

  const opts = '<option value="">— Select recipient —</option>' +
    (radioOpts ? `<optgroup label="RADIO">${radioOpts}</optgroup>` : '') +
    (webOpts   ? `<optgroup label="ONLINE">${webOpts}</optgroup>`  : '');

  const sel = document.getElementById('mo-msg-to');
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = opts;
    if (prev) sel.value = prev;
    sel.onchange = () => { renderMessages(); updateMsgCharCount(); };
    updateMsgCharCount();
  }

  const selM = document.getElementById('mo-msg-to-mobile');
  if (selM) {
    const prev = selM.value;
    selM.innerHTML = opts;
    if (prev) selM.value = prev;
    selM.onchange = () => { renderMessages(); updateMsgCharCountMobile(); };
    updateMsgCharCountMobile();
  }
}

function updateMsgCharCount() {
  const sel = document.getElementById('mo-msg-to');
  const input = document.getElementById('mo-msg-input');
  const counter = document.getElementById('mo-msg-char-count');
  if (!input || !counter) return;
  const firstName = (sel?.options[sel?.selectedIndex]?.dataset.name || '').split(' ')[0];
  const prefixLen = firstName ? firstName.length + 2 : 0;
  const maxTypable = 67 - prefixLen;
  input.maxLength = maxTypable;
  const remaining = maxTypable - (input.value?.length || 0);
  counter.textContent = remaining;
  counter.style.color = remaining <= 5 ? 'var(--error)' : remaining <= 15 ? 'var(--accent2)' : 'var(--text3)';
}

function updateMsgUnread() {
  const unread = messages.filter(m => m.direction === 'in' && !m.read).length;
  const badge = document.getElementById('mo-msg-unread');
  if (badge) badge.textContent = unread ? `${unread} NEW` : '';
}

function renderMessages() {
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const sel = document.getElementById('mo-msg-to');
  const nodeId = sel?.value;
  const ids = new Set(resolveNodeIdForMessages(nodeId));
  // messages array is newest-first; filter by selected thread or show recent 20
  const thread = ids.size
    ? messages.filter(m => ids.has(m.from_node_id) || ids.has(m.to_node_id))
    : messages.slice(0, 20);
  const reversed = [...thread].reverse();

  // Sidebar thread (desktop)
  const sidebar = document.getElementById('mo-msg-thread');
  if (sidebar) {
    sidebar.innerHTML = reversed.map(m => {
      const cls = m.direction === 'out' ? 'msg-bubble-out' : 'msg-bubble-in';
      const from = m.direction === 'in' ? (m.from_name || m.from_node_id) : 'You';
      return `<div class="${cls}">
        <div style="font-size:11px;color:var(--text3);margin-bottom:2px">${from} · ${RT.fmtTime(m.timestamp, fmt24)}</div>
        <div>${esc(m.text)}</div>
      </div>`;
    }).join('');
    sidebar.scrollTop = sidebar.scrollHeight;
  }

  // Full-screen mobile panel
  const panel = document.getElementById('mo-msg-body');
  if (panel) {
    panel.innerHTML = reversed.map(m => {
      const out = m.direction === 'out';
      return `<div class="${out ? 'mo-msg-out' : 'mo-msg-in'}">
        ${!out ? `<div class="mo-msg-from">${esc(m.from_name || m.from_node_id || '?')}</div>` : ''}
        <div class="mo-msg-text">${esc(m.text)}</div>
        <div class="mo-msg-ts">${RT.fmtTime(m.timestamp, fmt24)}</div>
      </div>`;
    }).join('');
    panel.scrollTop = panel.scrollHeight;
  }

  updateMsgUnread();
}

async function sendMessage() {
  const sel = document.getElementById('mo-msg-to');
  const to_node_id = sel?.value;
  const to_name = sel?.options[sel?.selectedIndex]?.dataset.name;
  const input = document.getElementById('mo-msg-input');
  const rawText = input?.value.trim();
  if (!to_node_id || !rawText) { RT.toast('Select a recipient and enter a message', 'warn'); return; }
  const firstName = (to_name || '').split(' ')[0];
  const text = firstName ? `${firstName}: ${rawText}` : rawText;
  const res = await RT.post(`/api/races/${raceId}/messages`, { to_node_id, to_name, text });
  if (res.ok) {
    input.value = '';
    updateMsgCharCount();
    if (!res.data.sent) RT.toast('Message saved — not delivered (offline)', 'warn');
  } else {
    RT.toast(res.error || 'Send failed', 'warn');
  }
}

function updateMsgCharCountMobile() {
  const sel = document.getElementById('mo-msg-to-mobile');
  const input = document.getElementById('mo-msg-panel-input');
  const counter = document.getElementById('mo-msg-char-count-mobile');
  if (!input || !counter) return;
  const firstName = (sel?.options[sel?.selectedIndex]?.dataset.name || '').split(' ')[0];
  const prefixLen = firstName ? firstName.length + 2 : 0;
  const maxTypable = 67 - prefixLen;
  input.maxLength = maxTypable;
  const remaining = maxTypable - (input.value?.length || 0);
  counter.textContent = remaining;
  counter.style.color = remaining <= 5 ? 'var(--error)' : remaining <= 15 ? 'var(--accent2)' : 'var(--text3)';
}

async function sendMessageMobile() {
  const sel = document.getElementById('mo-msg-to-mobile');
  const to_node_id = sel?.value;
  const to_name = sel?.options[sel?.selectedIndex]?.dataset.name;
  const input = document.getElementById('mo-msg-panel-input');
  const rawText = input?.value.trim();
  if (!to_node_id || !rawText) { RT.toast('Select a recipient and enter a message', 'warn'); return; }
  const firstName = (to_name || '').split(' ')[0];
  const text = firstName ? `${firstName}: ${rawText}` : rawText;
  const res = await RT.post(`/api/races/${raceId}/messages`, { to_node_id, to_name, text });
  if (res.ok) {
    input.value = '';
    updateMsgCharCountMobile();
    if (!res.data.sent) RT.toast('Message saved — not delivered (offline)', 'warn');
  } else {
    RT.toast(res.error || 'Send failed', 'warn');
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.rt-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.mo-extra-panel').forEach(p => p.classList.remove('active'));
  document.body.classList.remove('mo-lb-mode', 'mo-extra-active');

  if (name === 'lb') {
    document.body.classList.add('mo-lb-mode');
  } else if (name === 'log') {
    document.getElementById('mo-log-panel').classList.add('active');
    document.body.classList.add('mo-extra-active');
  } else if (name === 'msg') {
    document.getElementById('mo-msg-panel').classList.add('active');
    document.body.classList.add('mo-extra-active');
  } else { // map
    setTimeout(() => map?.invalidateSize(), 50);
  }
}

init();
