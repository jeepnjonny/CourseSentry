'use strict';

let race, raceId, currentStation = null;
let participants = [], heats = [], stations = [], messages = [];
let selectedParticipant = null;
let map, markersLayer, stationMarkers = {}, routeLayer = null, trackPoints = null;
let fmt24 = true;
let baseTiles = {}, currentBaseLayer = null;
let clockInterval = null;

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
  const racePill = document.getElementById('mo-race-pill');
  racePill.textContent = race.name.toUpperCase();
  racePill.className = 'pill pill-ok';
  document.title = `MobilOp — ${race.name}`;

  if (race.messaging_enabled) {
    document.getElementById('tab-msg').classList.remove('hidden');
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
  RT.connectWS(handleWS, null, raceId);

  document.getElementById('mo-bib-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') searchBib();
  });
  document.getElementById('mo-msg-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendMessage();
  });
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
  sessionStorage.setItem(`mo-station-${raceId}`, station.id);

  document.getElementById('mo-station-badge').textContent = station.name;
  document.getElementById('mo-no-station').classList.add('hidden');
  document.getElementById('mo-station-badge').style.background = 'rgba(88,166,255,.15)';
  document.getElementById('mo-station-badge').style.fontWeight = 'bold';

  // Register station on the server (callsign matching happens here)
  await RT.post(`/api/races/${raceId}/stations/${station.id}/assign`, {});
}

// ── Map ───────────────────────────────────────────────────────────────────────

function setBaseLayer(name) {
  if (currentBaseLayer) map.removeLayer(currentBaseLayer);
  currentBaseLayer = baseTiles[name] || baseTiles['Street'];
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
                  s.type === 'netcontrol' ? '#d2993a' : s.type === 'repeater' ? '#6e7681' : '#d2a679';
    const letter = s.type === 'start' ? 'S' : s.type === 'finish' ? 'F' :
                   s.type === 'start_finish' ? '⇌' : s.type === 'turnaround' ? 'T' :
                   s.type === 'netcontrol' ? 'N' : s.type === 'repeater' ? 'R' : s.name[0]?.toUpperCase() || 'A';
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
    if (msg.data.stations?.length) { stations = msg.data.stations; renderStationMarkers(); }
    if (msg.data.trackPoints?.length) { trackPoints = msg.data.trackPoints; renderRoute(); }
    renderLeaderboard();
    if (msg.data.messages) { messages = msg.data.messages; renderMessages(); }
    for (const [nodeId, pos] of Object.entries(msg.data.positions || {})) {
      updateMarker(nodeId, pos);
    }
  } else if (msg.type === 'position') {
    updateMarker(msg.data.nodeId, msg.data);
  } else if (msg.type === 'participant_update') {
    refreshParticipants();
  } else if (msg.type === 'event') {
    if (currentStation && msg.data.station_id === currentStation.id) {
      prependEventRow(msg.data);
    }
    if (selectedParticipant && msg.data.participant_id === selectedParticipant.id) {
      const updated = participants.find(p => p.id === selectedParticipant.id);
      if (updated) showParticipantCard(updated);
    }
  } else if (msg.type === 'message') {
    messages.push(msg.data);
    renderMessages();
  }
}

async function refreshParticipants() {
  const res = await RT.get(`/api/races/${raceId}/participants`);
  if (!res.ok) return;
  participants = res.data;
  renderLeaderboard();
  if (selectedParticipant) {
    const updated = participants.find(p => p.id === selectedParticipant.id);
    if (updated) showParticipantCard(updated);
  }
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

function renderLeaderboard() {
  const body = document.getElementById('mo-lb-body');
  if (!body) return;
  const now = Math.floor(Date.now() / 1000);
  const ORDER = { active: 0, finished: 1, dnf: 2, dns: 3 };
  const sorted = [...participants].sort((a, b) =>
    (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) ||
    (a.bib || '').localeCompare(b.bib || '', undefined, { numeric: true })
  );

  body.innerHTML = sorted.map(p => {
    const heat = heats.find(h => h.id === p.heat_id);
    const color = STATUS_COLORS[p.status] || '#484f58';
    const startTs = p.start_time || heat?.start_time || race?.start_time || 0;
    const elapsed =
      p.status === 'active'   && startTs ? RT.fmtElapsed(now - startTs, false) :
      p.status === 'finished' && p.finish_time && startTs ? RT.fmtElapsed(p.finish_time - startTs, false) : '--';
    return `<div class="mo-lb-row" onclick="lookupParticipant(${p.id})">
      <span style="font-weight:bold">${p.bib}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name}</span>
      <span style="color:${color};font-size:12px;letter-spacing:.5px">${(p.status || 'dns').toUpperCase()}</span>
      <span style="color:var(--text2);font-size:13px">${elapsed}</span>
    </div>`;
  }).join('');
}

// ── LOG ───────────────────────────────────────────────────────────────────────

function searchBib() {
  const bib = document.getElementById('mo-bib-input').value.trim().toUpperCase();
  if (!bib) return;
  const p = participants.find(p => String(p.bib).toUpperCase() === bib);
  if (p) {
    showParticipantCard(p);
  } else {
    document.getElementById('mo-p-name').textContent = `Bib "${bib}" not found`;
    document.getElementById('mo-p-meta').innerHTML = '';
    document.getElementById('mo-participant-card').classList.add('visible');
    selectedParticipant = null;
  }
}

function lookupParticipant(id) {
  const p = participants.find(p => p.id === id);
  if (!p) return;
  switchTab('log');
  document.getElementById('mo-bib-input').value = p.bib;
  showParticipantCard(p);
}

function showParticipantCard(p) {
  selectedParticipant = p;
  const heat = heats.find(h => h.id === p.heat_id);
  const color = STATUS_COLORS[p.status] || '#484f58';
  document.getElementById('mo-p-name').textContent = `#${p.bib} ${p.name}`;
  document.getElementById('mo-p-meta').innerHTML =
    `<span style="color:${color};font-weight:bold">${(p.status || 'dns').toUpperCase()}</span>` +
    (heat ? `<span>${heat.name}</span>` : '') +
    (p.age  ? `<span>Age ${p.age}</span>` : '');
  document.getElementById('mo-participant-card').classList.add('visible');
}

async function logEvent(eventType) {
  if (!selectedParticipant) { RT.toast('Select a participant first', 'warn'); return; }
  if (!currentStation) { RT.toast('No station assigned', 'warn'); showStationPicker(); return; }

  const ts = Math.floor(Date.now() / 1000);
  const res = await RT.post(`/api/races/${raceId}/events`, {
    participant_id: selectedParticipant.id,
    event_type: eventType,
    station_id: currentStation.id,
    timestamp: ts,
  });

  if (res.ok) {
    const label = eventType.replace(/_/g, ' ').toUpperCase();
    RT.toast(`${label} — #${selectedParticipant.bib} ${selectedParticipant.name}`, 'ok');
    // Optimistic status update
    const idx = participants.findIndex(p => p.id === selectedParticipant.id);
    if (idx !== -1) {
      if (eventType === 'dnf') participants[idx].status = 'dnf';
      else if (eventType === 'finish') { participants[idx].status = 'finished'; participants[idx].finish_time = ts; }
      showParticipantCard(participants[idx]);
      renderLeaderboard();
    }
    document.getElementById('mo-bib-input').value = '';
    document.getElementById('mo-bib-input').focus();
  } else {
    RT.toast(res.error || 'Failed to log event', 'warn');
  }
}

async function loadStationEvents() {
  if (!currentStation) return;
  const res = await RT.get(`/api/races/${raceId}/events?station_id=${currentStation.id}&limit=50`);
  if (!res.ok) return;
  const list = document.getElementById('mo-events-list');
  list.innerHTML = '';
  for (const ev of res.data) list.appendChild(buildEventRow(ev));
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

function renderMessages() {
  const body = document.getElementById('mo-msg-body');
  body.innerHTML = messages.map(m => {
    const out = m.direction === 'out';
    return `<div class="${out ? 'mo-msg-out' : 'mo-msg-in'}">
      ${!out ? `<div class="mo-msg-from">${m.from_name || m.from_node_id || '?'}</div>` : ''}
      <div class="mo-msg-text">${m.text}</div>
      <div class="mo-msg-ts">${RT.fmtTime(m.timestamp, fmt24)}</div>
    </div>`;
  }).join('');
  body.scrollTop = body.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById('mo-msg-input');
  const text = input.value.trim();
  if (!text) return;
  const res = await RT.post(`/api/races/${raceId}/messages`, { text, direction: 'out' });
  if (res.ok) {
    input.value = '';
    messages.push(res.data);
    renderMessages();
  } else {
    RT.toast(res.error || 'Send failed', 'warn');
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.mo-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
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
