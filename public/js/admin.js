'use strict';

function parseTimeToUnix(str, dateStr) {
  if (!str || !str.trim()) return null;
  const base = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const parts = str.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  const [h = 0, m = 0, s = 0] = parts;
  return Math.floor(base.getTime() / 1000) + h * 3600 + m * 60 + s;
}

function unixToTimeStr(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

let currentUser = null;
let races = [], activeRaceId = null;
let editingRaceId = null, editingUserId = null, editingHeatId = null;
let selectedRaceId = null; // race being configured in sub-tabs

const GLOBAL_TABS = [
  { id: 'races',    label: 'RACES' },
  { id: 'courses',  label: 'COURSES' },
  { id: 'infra',    label: 'INFRASTRUCTURE' },
  { id: 'users',    label: 'USERS' },
  { id: 'settings', label: 'DATASOURCES' },
  { id: 'logs',     label: 'LOGS' },
];
const RACE_TABS = [
  { id: 'heats',        label: 'HEATS/CLASSES' },
  { id: 'participants', label: 'PARTICIPANTS' },
  { id: 'course',       label: 'COURSE' },
  { id: 'personnel',    label: 'PERSONNEL' },
  { id: 'network',      label: 'NETWORK' },
];
let currentTab = 'races';

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  currentUser = await RT.requireLogin('admin');
  if (!currentUser) return;

  buildTabs();
  RT.connectWS(handleWS);
  await loadRaces();
  showTab('races');
}

function buildTabs() {
  document.getElementById('admin-tabs').innerHTML = GLOBAL_TABS.map(t =>
    `<button class="admin-tab${t.id===currentTab?' active':''}" onclick="showTab('${t.id}')">${t.label}</button>`
  ).join('');
  const raceTabs = document.getElementById('race-tabs');
  if (raceTabs) raceTabs.innerHTML = RACE_TABS.map(t =>
    `<button class="admin-tab${t.id===currentTab?' active':''}" onclick="showTab('${t.id}')">${t.label}</button>`
  ).join('');
  const race = races.find(r => r.id === selectedRaceId);
  const nameEl = document.getElementById('race-context-name');
  if (nameEl) nameEl.textContent = race ? race.name.toUpperCase() : '';
  const bar = document.getElementById('race-context-bar');
  if (bar) bar.classList.toggle('hidden', !selectedRaceId);
}

function showTab(id) {
  currentTab = id;
  buildTabs();
  renderTab();
}

function configureRace(id) {
  selectedRaceId = id;
  showTab('races');
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let _infraRefreshTimer = null;
function handleWS(msg) {
  if (msg.type === 'mqtt_status')    updateMqttPill(msg.data);
  if (msg.type === 'aprs_status')    updateAprsPill(msg.data);
  if (msg.type === 'tnc_status')     updateTncLight(msg.data);
  if (msg.type === 'inreach_status') updateInreachLight(msg.data);
  if (msg.type === 'spot_status')    updateSpotLight(msg.data);
  if ((msg.type === 'tracker_info' || msg.type === 'position') && currentTab === 'infra') {
    // Throttle: at most one refresh per 5 s so bursts of MQTT/APRS packets don't flood GET /api/trackers
    if (!_infraRefreshTimer) _infraRefreshTimer = setTimeout(() => { _infraRefreshTimer = null; refreshInfra(); }, 5000);
  }
  if (msg.type === 'init') {
    if (msg.data.mqtt)    updateMqttPill(msg.data.mqtt);
    if (msg.data.aprs)    updateAprsPill(msg.data.aprs);
    if (msg.data.tnc)     updateTncLight(msg.data.tnc);
    if (msg.data.inreach) updateInreachLight(msg.data.inreach);
    if (msg.data.spot)    updateSpotLight(msg.data.spot);
  }
  if (msg.type === 'race_update') {
    // Update the race in memory and refresh the offline-maps status badge
    const idx = races.findIndex(r => r.id === msg.data.id);
    if (idx !== -1) races[idx] = msg.data;
    if (msg.data.id === selectedRaceId) renderOfflineMapsStatus(msg.data);
  }
  if (msg.type === 'log_entry' && currentTab === 'logs') appendLogEntry(msg.data);
  if (msg.type === 'infra_update' && currentTab === 'network') loadInfraNodes();
}

function updateMqttPill(status) {
  const light = document.getElementById('mqtt-light');
  if (!light) return;
  if (status.connected) {
    light.className = 'ds-light ds-light-ok';
    light.title = `MQTT: Connected${status.host ? ' · ' + status.host : ''}`;
  } else if (status.enabled) {
    light.className = 'ds-light ds-light-error';
    light.title = 'MQTT: Error — not connected';
  } else {
    light.className = 'ds-light ds-light-idle';
    light.title = 'MQTT: Offline';
  }
}

function updateTncLight(data) {
  const light = document.getElementById('tnc-light');
  if (!light) return;
  const count = data?.count ?? 0;
  if (count > 0) {
    light.className = 'ds-light ds-light-ok';
    light.title = `KISS TNC: ${count} client${count !== 1 ? 's' : ''} connected${data.hasPrimary ? ' · TX ready' : ''}`;
  } else {
    light.className = 'ds-light ds-light-idle';
    light.title = 'KISS TNC: No client connected';
  }
}

function updateInreachLight(status) {
  const light = document.getElementById('inreach-light');
  if (!light) return;
  if (status?.active && status.count > 0) {
    light.className = 'ds-light ds-light-ok';
    light.title = `InReach: Polling ${status.count} feed${status.count !== 1 ? 's' : ''}`;
  } else if (status?.active) {
    light.className = 'ds-light ds-light-idle';
    light.title = 'InReach: Active — no feeds configured';
  } else {
    light.className = 'ds-light ds-light-idle';
    light.title = 'InReach: Inactive';
  }
}

function updateSpotLight(status) {
  const light = document.getElementById('spot-light');
  if (!light) return;
  if (status?.active && status.count > 0) {
    light.className = 'ds-light ds-light-ok';
    light.title = `SPOT: Polling ${status.count} feed${status.count !== 1 ? 's' : ''}`;
  } else if (status?.active) {
    light.className = 'ds-light ds-light-idle';
    light.title = 'SPOT: Enabled — no feeds configured';
  } else {
    light.className = 'ds-light ds-light-idle';
    light.title = 'SPOT: Inactive';
  }
}

// ── Races ─────────────────────────────────────────────────────────────────────
async function loadRaces() {
  const res = await RT.get('/api/races');
  if (!res.ok) return;
  races = res.data;
  const actives = races.filter(r => r.status === 'active');
  activeRaceId = actives[0]?.id || null;
  const pillText = actives.length === 0 ? 'NO ACTIVE RACE'
    : actives.length === 1 ? actives[0].name.toUpperCase()
    : `${actives.length} ACTIVE RACES`;
  document.getElementById('active-race-pill').textContent = pillText;
  document.getElementById('active-race-pill').className = actives.length > 0 ? 'pill pill-ok' : 'pill pill-idle';
}

function renderTab() {
  const el = document.getElementById('admin-content');
  switch (currentTab) {
    case 'races':        el.innerHTML = renderRacesTab(); bindRacesTab(); break;
    case 'courses':      el.innerHTML = renderCoursesTab(); bindCoursesTab(); break;
    case 'heats':        el.innerHTML = renderHeatsTab(); bindHeatsTab(); break;
    case 'participants': el.innerHTML = renderParticipantsTab(); bindParticipantsTab(); break;
    case 'course':       el.innerHTML = renderCourseTab(); bindCourseTab(); break;
    case 'personnel':    el.innerHTML = renderPersonnelTab(); bindPersonnelTab(); break;
    case 'network':      el.innerHTML = renderNetworkTab(); bindNetworkTab(); break;
    case 'infra':     el.innerHTML = renderInfraTab(); refreshInfra(); break;
    case 'users':     el.innerHTML = renderUsersTab(); loadUsers(); break;
    case 'settings':  el.innerHTML = renderSettingsTab(); bindSettingsTab(); break;
    case 'logs':      el.innerHTML = renderLogsTab(); bindLogsTab(); break;
  }
}

function renderRacesTab() {
  return `
  <div class="card">
    <h3>RACE MANAGEMENT</h3>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="primary" onclick="openRaceModal()">+ NEW RACE</button>
    </div>
    <div id="race-list"></div>
  </div>`;
}

function bindRacesTab() {
  renderRaceList();
}

function renderRaceList() {
  const el = document.getElementById('race-list');
  if (!el) return;
  if (!races.length) { el.innerHTML = '<div class="text-dim" style="padding:12px;font-size:16px">No races yet.</div>'; return; }
  el.innerHTML = races.map(r => `
    <div class="race-card ${r.status==='active'?'active-race':''}${r.id===selectedRaceId?' selected-race':''}" onclick="configureRace(${r.id})">
      <div style="flex:1">
        <div style="font-weight:bold;color:${r.status==='active'?'var(--accent2)':'var(--text)'}">${r.name}</div>
        <div class="text-dim" style="font-size:13px">${r.date} · ${r.participant_count||0} participants</div>
      </div>
      <span class="badge" style="background:${r.status==='active'?'#3fb95022':r.status==='past'?'#48505822':'#58a6ff22'};color:${r.status==='active'?'var(--accent2)':r.status==='past'?'var(--text3)':'var(--accent)'}">${r.status.toUpperCase()}</span>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        ${r.status!=='active'?`<button onclick="event.stopPropagation();activateRace(${r.id})" class="success" style="font-size:13px;padding:3px 8px">ACTIVATE</button>`:''}
        ${r.status==='active'?`<button onclick="event.stopPropagation();deactivateRace(${r.id})" class="danger" style="font-size:13px;padding:3px 8px">DEACTIVATE</button>`:''}
        <button onclick="event.stopPropagation();openRaceModal(${r.id})" style="font-size:13px;padding:3px 8px">EDIT</button>
        <button onclick="event.stopPropagation();cloneRace(${r.id})" style="font-size:13px;padding:3px 8px">CLONE</button>
        ${r.viewer_token?`<button onclick="event.stopPropagation();copyViewerLink('${r.viewer_token}')" style="font-size:13px;padding:3px 8px;color:var(--accent4)">VIEWER LINK</button>
         <button onclick="event.stopPropagation();revokeViewerToken(${r.id})" class="danger" style="font-size:13px;padding:3px 8px">REVOKE</button>`
         :`<button onclick="event.stopPropagation();genViewerToken(${r.id})" style="font-size:13px;padding:3px 8px">GEN VIEWER</button>`}
        ${r.status!=='active'?`<button onclick="event.stopPropagation();deleteRace(${r.id})" class="danger" style="font-size:13px;padding:3px 8px">DEL</button>`:''}
      </div>
    </div>
  `).join('');
}



async function activateRace(id) {
  const race = races.find(r => r.id === id);
  if (!race?.course_id) {
    RT.toast('A course is required before activating a race. Go to the race → COURSE tab and assign one.', 'warn');
    return;
  }
  const [hr, pr] = await Promise.all([
    RT.get(`/api/races/${id}/heats`),
    RT.get(`/api/races/${id}/participants`),
  ]);
  if (hr.ok && hr.data.length > 0 && pr.ok) {
    const unassigned = pr.data.filter(p => !p.heat_id).length;
    if (unassigned > 0) {
      const ok = confirm(
        `Warning: ${unassigned} participant${unassigned !== 1 ? 's are' : ' is'} not assigned to a heat.\n\n` +
        `These participants will not be started when a heat is started. Assign them to a heat, or proceed anyway.`
      );
      if (!ok) return;
    }
  }
  const res = await RT.post(`/api/races/${id}/activate`);
  if (!res.ok) { RT.toast(res.error, 'warn'); return; }

  RT.toast('Race activated', 'ok');

  // Surface any datasource warnings returned by the server.  Each one is shown
  // as its own toast so the admin can read them individually without dismissing
  // the success notice.  The race is already active — these are advisory only.
  if (res.warnings?.length) {
    res.warnings.forEach(w => RT.toast(w, 'warn'));
  }

  await loadRaces();
  renderTab();
}

async function deactivateRace(id) {
  if (!confirm('Deactivate this race?')) return;
  const res = await RT.post(`/api/races/${id}/deactivate`);
  if (res.ok) { RT.toast('Race deactivated', 'ok'); await loadRaces(); renderTab(); }
}

async function deleteRace(id) {
  if (!confirm('Delete this race and all its data? This cannot be undone.')) return;
  const res = await RT.del(`/api/races/${id}`);
  if (res.ok) { RT.toast('Race deleted', 'ok'); await loadRaces(); renderTab(); }
  else RT.toast(res.error, 'warn');
}

async function genViewerToken(id) {
  const res = await RT.post(`/api/races/${id}/viewer-token`);
  if (res.ok) {
    await loadRaces(); renderTab();
    copyViewerLink(res.data.token);
  }
}

function copyViewerLink(token) {
  const url = `${location.origin}${RT.BASE}view/${token}`;
  window.open(url, '_blank');
  navigator.clipboard.writeText(url).then(() => RT.toast('Viewer URL opened and copied to clipboard', 'ok'));
}

async function revokeViewerToken(id) {
  if (!confirm('Revoke viewer link? Existing users will lose access.')) return;
  await RT.del(`/api/races/${id}/viewer-token`);
  await loadRaces(); renderTab();
}

async function cloneRace(id) {
  const src = races.find(r => r.id === id);
  const name = prompt(`Clone "${src.name}" — enter new race name:`, src.name + ' (Copy)');
  if (!name) return;
  const date = prompt('New race date (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
  if (!date) return;
  const res = await RT.post(`/api/races/${id}/clone`, { name, date });
  if (res.ok) { RT.toast('Race cloned', 'ok'); await loadRaces(); renderTab(); }
  else RT.toast(res.error, 'warn');
}

// ── Race Modal distance-unit helpers ──────────────────────────────────────────
let _raceModalDistUnit = 'us';

const DIST_FIELDS = [
  { id: 'rm-geofence',          unitId: 'rm-geofence-unit' },
  { id: 'rm-checkpoint-radius', unitId: 'rm-checkpoint-unit' },
  { id: 'rm-start-clearance',   unitId: 'rm-clearance-unit' },
  { id: 'rm-off-course',        unitId: 'rm-off-course-unit' },
];

function _mToDisplay(m, units) {
  return units === 'us' ? Math.round(m * 3.28084) : Math.round(m);
}
function _displayToM(v, units) {
  return units === 'us' ? Math.round(v / 3.28084) : Math.round(v);
}
function _applyDistUnit(units) {
  const label = units === 'us' ? 'ft' : 'm';
  for (const f of DIST_FIELDS) {
    document.getElementById(f.unitId).textContent = label;
  }
  _raceModalDistUnit = units;
}

function rmOnUnitsChange() {
  const newUnits = document.getElementById('rm-units').value;
  if (newUnits === _raceModalDistUnit) return;
  for (const f of DIST_FIELDS) {
    const el = document.getElementById(f.id);
    const meters = _displayToM(parseFloat(el.value) || 0, _raceModalDistUnit);
    el.value = _mToDisplay(meters, newUnits);
  }
  _applyDistUnit(newUnits);
}

// ── Race Modal ────────────────────────────────────────────────────────────────
async function openRaceModal(id) {
  editingRaceId = id || null;
  const race = id ? races.find(r => r.id === id) : null;
  document.getElementById('race-modal-title').textContent = id ? 'EDIT RACE' : 'NEW RACE';
  document.getElementById('rm-name').value           = race?.name || '';
  document.getElementById('rm-date').value           = race?.date || new Date().toISOString().split('T')[0];
  document.getElementById('rm-time-format').value    = race?.time_format || '24h';
  document.getElementById('rm-clock-seconds').value  = String(race?.clock_seconds ?? 1);
  document.getElementById('rm-missing-timer').value  = Math.round((race?.missing_timer || 3600) / 60);
  const modalUnits = race?.units || 'us';
  document.getElementById('rm-units').value                = modalUnits;
  document.getElementById('rm-speed-display').value       = race?.speed_display || 'pace';
  _applyDistUnit(modalUnits);
  document.getElementById('rm-geofence').value            = _mToDisplay(race?.geofence_radius || 15, modalUnits);
  document.getElementById('rm-checkpoint-radius').value   = _mToDisplay(race?.checkpoint_radius || 50, modalUnits);
  document.getElementById('rm-off-course').value     = _mToDisplay(race?.off_course_distance || 100, modalUnits);
  document.getElementById('rm-stopped').value        = Math.round((race?.stopped_time || 600) / 60);
  document.getElementById('rm-feat-missing').checked    = !!(race?.feat_missing   ?? 1);
  document.getElementById('rm-feat-auto-log').checked   = !!(race?.feat_auto_log  ?? 1);
  document.getElementById('rm-feat-off-course').checked = !!(race?.feat_off_course ?? 1);
  document.getElementById('rm-feat-stopped').checked    = !!(race?.feat_stopped    ?? 1);
  document.getElementById('rm-messaging').checked    = !!(race?.messaging_enabled);
  document.getElementById('rm-offline-maps').checked = !!(race?.offline_maps);
  document.getElementById('rm-viewer-map').checked       = !!(race?.viewer_map_enabled ?? 1);
  document.getElementById('rm-leaderboard').checked      = !!(race?.leaderboard_enabled ?? 1);
  document.getElementById('rm-weather').checked          = !!(race?.weather_enabled);
  document.getElementById('rm-show-names').checked       = !!(race?.viewer_show_names ?? 1);
  document.getElementById('rm-viewer-nametags').checked  = !!(race?.viewer_nametags);
  document.getElementById('rm-race-format').value    = race?.race_format || 'point_to_point';
  document.getElementById('rm-start-time').value      = unixToTimeStr(race?.start_time);
  document.getElementById('rm-start-clearance').value  = _mToDisplay(race?.start_clearance ?? 400, modalUnits);
  // Populate datasource enable checkboxes from global settings
  const sRes = await RT.get('/api/settings');
  const settings = sRes.ok ? sRes.data : {};
  document.getElementById('rm-mqtt-enabled').checked = settings.mqtt_enabled !== '0';
  document.getElementById('rm-aprs-enabled').checked = settings.aprs_enabled === '1';
  document.getElementById('rm-tnc-enabled').checked  = !!(race?.tnc_enabled ?? 1);
  document.getElementById('rm-spot-enabled').checked = settings.spot_enabled === '1';
  document.getElementById('rm-spot-feed-id').value       = race?.spot_feed_id || '';
  document.getElementById('rm-spot-feed-password').value = race?.spot_feed_password || '';
  document.getElementById('rm-tactical-callsign').value = race?.tactical_callsign || currentUser?.callsign || '';
  document.getElementById('rm-rf-path').value           = race?.rf_path || 'WIDE1-1';
  _updateCallsignRequired();
  document.getElementById('race-modal').classList.remove('hidden');
}

function _updateCallsignRequired() {
  const aprsOn = document.getElementById('rm-aprs-enabled')?.checked;
  const tncOn  = document.getElementById('rm-tnc-enabled')?.checked;
  const req    = aprsOn || tncOn;
  const marker = document.getElementById('rm-callsign-required');
  if (marker) marker.style.display = req ? '' : 'none';
  const input = document.getElementById('rm-tactical-callsign');
  if (input) input.required = req;
}

async function saveRace() {
  const aprsEnabled = document.getElementById('rm-aprs-enabled').checked;
  const tncEnabled  = document.getElementById('rm-tnc-enabled').checked;
  const callsign    = document.getElementById('rm-tactical-callsign').value.trim().toUpperCase();
  if (!document.getElementById('rm-name').value.trim() || !document.getElementById('rm-date').value) {
    RT.toast('Name and date required', 'warn'); return;
  }
  if ((aprsEnabled || tncEnabled) && !callsign) {
    RT.toast('Race callsign is required when APRS-IS or APRS-TNC is enabled.', 'warn'); return;
  }
  if (callsign && !/^[A-Z0-9]{1,6}(-[0-9]{1,2})?$/.test(callsign)) {
    RT.toast('Race callsign must be 1–6 alphanumeric characters with optional -SSID (e.g. NETCTL or W1AW-5). No spaces.', 'warn'); return;
  }
  const body = {
    name:                document.getElementById('rm-name').value.trim(),
    date:                document.getElementById('rm-date').value,
    time_format:         document.getElementById('rm-time-format').value,
    clock_seconds:       parseInt(document.getElementById('rm-clock-seconds').value),
    missing_timer:       parseInt(document.getElementById('rm-missing-timer').value) * 60,
    geofence_radius:     _displayToM(parseInt(document.getElementById('rm-geofence').value), _raceModalDistUnit),
    checkpoint_radius:   _displayToM(parseInt(document.getElementById('rm-checkpoint-radius').value), _raceModalDistUnit),
    units:               document.getElementById('rm-units').value,
    speed_display:       document.getElementById('rm-speed-display').value,
    off_course_distance: _displayToM(parseInt(document.getElementById('rm-off-course').value), _raceModalDistUnit),
    stopped_time:        parseInt(document.getElementById('rm-stopped').value) * 60,
    feat_missing:        document.getElementById('rm-feat-missing').checked    ? 1 : 0,
    feat_auto_log:       document.getElementById('rm-feat-auto-log').checked   ? 1 : 0,
    feat_off_course:     document.getElementById('rm-feat-off-course').checked ? 1 : 0,
    feat_stopped:        document.getElementById('rm-feat-stopped').checked    ? 1 : 0,
    messaging_enabled:   document.getElementById('rm-messaging').checked ? 1 : 0,
    offline_maps:        document.getElementById('rm-offline-maps').checked ? 1 : 0,
    viewer_map_enabled:  document.getElementById('rm-viewer-map').checked ? 1 : 0,
    leaderboard_enabled: document.getElementById('rm-leaderboard').checked ? 1 : 0,
    weather_enabled:     document.getElementById('rm-weather').checked ? 1 : 0,
    viewer_show_names:   document.getElementById('rm-show-names').checked ? 1 : 0,
    viewer_nametags:     document.getElementById('rm-viewer-nametags').checked ? 1 : 0,
    race_format:         document.getElementById('rm-race-format').value,
    tactical_callsign:   callsign || null,
    tnc_enabled:         tncEnabled ? 1 : 0,
    rf_path:             document.getElementById('rm-rf-path').value.trim() || 'WIDE1-1',
    start_time:          parseTimeToUnix(document.getElementById('rm-start-time').value, document.getElementById('rm-date').value) ?? null,
    start_clearance:     _displayToM(parseInt(document.getElementById('rm-start-clearance').value) || 0, _raceModalDistUnit) || 400,
    spot_feed_id:        document.getElementById('rm-spot-feed-id').value.trim() || null,
    spot_feed_password:  document.getElementById('rm-spot-feed-password').value.trim() || null,
  };
  const res = editingRaceId
    ? await RT.put(`/api/races/${editingRaceId}`, body)
    : await RT.post('/api/races', body);
  if (res.ok) {
    // Save datasource enable flags to global settings
    await RT.put('/api/settings', {
      mqtt_enabled: document.getElementById('rm-mqtt-enabled').checked ? '1' : '0',
      aprs_enabled: document.getElementById('rm-aprs-enabled').checked ? '1' : '0',
      spot_enabled: document.getElementById('rm-spot-enabled').checked ? '1' : '0',
    });
    closeModal('race-modal');
    if (!editingRaceId && res.data?.id) {
      await loadRaces();
      configureRace(res.data.id);
      RT.toast('Race created — configure heats, participants, course, and stations below', 'ok');
    } else {
      RT.toast('Race updated', 'ok');
      await loadRaces(); renderTab();
    }
  } else RT.toast(res.error, 'warn');
}

// ── Heats / Classes ───────────────────────────────────────────────────────────
let heats = [], classes = [];

function renderHeatsTab() {
  return `
  <div class="card">
    <h3>HEATS <span class="text-dim">(groups with icon/color)</span></h3>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="primary" onclick="openHeatModal()">+ ADD HEAT</button>
    </div>
    <div id="heats-list"></div>
  </div>
  <div class="card">
    <h3>CLASSES <span class="text-dim">(e.g. age groups, gender)</span></h3>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <input id="new-class-name" placeholder="Class name (e.g. M30-39)" style="width:200px">
      <button class="primary" onclick="addClass()">+ ADD</button>
    </div>
    <div id="classes-list"></div>
  </div>`;
}

async function bindHeatsTab() { await loadHeatsClasses(); }

async function loadHeatsClasses() {
  if (!selectedRaceId) return;
  const [hr, cr] = await Promise.all([
    RT.get(`/api/races/${selectedRaceId}/heats`),
    RT.get(`/api/races/${selectedRaceId}/classes`),
  ]);
  heats = hr.ok ? hr.data : [];
  classes = cr.ok ? cr.data : [];
  renderHeatsList();
  renderClassesList();
}

function renderHeatsList() {
  const el = document.getElementById('heats-list');
  if (!el) return;
  if (!heats.length) { el.innerHTML = '<div class="text-dim" style="font-size:16px;padding:6px">No heats defined.</div>'; return; }
  const race = races.find(r => r.id === selectedRaceId);
  el.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th style="color:var(--text4);width:32px">#</th><th>NAME</th><th>COLOR</th><th>SHAPE</th><th>START TIME</th><th>ICON</th><th></th></tr></thead><tbody>
    ${heats.map(h => `<tr>
      <td style="color:var(--text4);font-size:13px">${h.id}</td>
      <td>${h.name}</td>
      <td><span style="color:${h.color}">${h.color}</span></td>
      <td>${h.shape}</td>
      <td style="font-size:14px;color:var(--text3)">${h.start_time ? RT.fmtTime(h.start_time, race?.time_format === '24h') : '<span style="color:var(--text4)">—</span>'}</td>
      <td>${RT.SHAPES[h.shape]?.(h.color, 18) || ''}</td>
      <td style="text-align:right">
        <button style="font-size:13px;padding:2px 8px" onclick="openHeatModal(${h.id})">EDIT</button>
        <button class="danger" style="font-size:13px;padding:2px 8px" onclick="deleteHeat(${h.id})">DEL</button>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function renderClassesList() {
  const el = document.getElementById('classes-list');
  if (!el) return;
  if (!classes.length) { el.innerHTML = '<div class="text-dim" style="font-size:16px;padding:6px">No classes defined.</div>'; return; }
  el.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>NAME</th><th></th></tr></thead><tbody>
    ${classes.map(c => `<tr><td>${c.name}</td><td style="text-align:right">
      <button class="danger" style="font-size:13px;padding:2px 8px" onclick="deleteClass(${c.id})">DEL</button>
    </td></tr>`).join('')}
  </tbody></table></div>`;
}

function openHeatModal(id) {
  editingHeatId = id || null;
  const heat = id ? heats.find(h => h.id === id) : null;
  // Need race date for start_time parsing
  const race = races.find(r => r.id === selectedRaceId);
  document.getElementById('heat-modal-title').textContent = id ? 'EDIT HEAT' : 'NEW HEAT';
  document.getElementById('hm-name').value       = heat?.name || '';
  document.getElementById('hm-color').value      = heat?.color || '#58a6ff';
  document.getElementById('hm-shape').value      = heat?.shape || 'circle';
  document.getElementById('hm-start-time').value = unixToTimeStr(heat?.start_time);
  document.getElementById('hm-start-time').dataset.raceDate = race?.date || '';
  updateHeatPreview();
  document.getElementById('heat-modal').classList.remove('hidden');
}

function updateHeatPreview() {
  const color = document.getElementById('hm-color').value;
  const shape = document.getElementById('hm-shape').value;
  const el = document.getElementById('hm-preview');
  if (el) el.innerHTML = (RT.SHAPES[shape]?.(color, 24) || '') + `<span style="color:${color};font-size:16px">${shape}</span>`;
}

async function saveHeat() {
  const name  = document.getElementById('hm-name').value.trim();
  const color = document.getElementById('hm-color').value;
  const shape = document.getElementById('hm-shape').value;
  const startTimeEl = document.getElementById('hm-start-time');
  const start_time = parseTimeToUnix(startTimeEl.value, startTimeEl.dataset.raceDate) ?? null;
  if (!name) { RT.toast('Name required', 'warn'); return; }
  const res = editingHeatId
    ? await RT.put(`/api/races/${selectedRaceId}/heats/${editingHeatId}`, { name, color, shape, start_time })
    : await RT.post(`/api/races/${selectedRaceId}/heats`, { name, color, shape, start_time });
  if (res.ok) { closeModal('heat-modal'); await loadHeatsClasses(); RT.toast('Heat saved', 'ok'); }
  else RT.toast(res.error, 'warn');
}

async function deleteHeat(id) {
  await RT.del(`/api/races/${selectedRaceId}/heats/${id}`);
  await loadHeatsClasses();
}

async function addClass() {
  const name = document.getElementById('new-class-name').value.trim();
  if (!name) return;
  const res = await RT.post(`/api/races/${selectedRaceId}/classes`, { name });
  if (res.ok) { document.getElementById('new-class-name').value = ''; await loadHeatsClasses(); }
}

async function deleteClass(id) {
  await RT.del(`/api/races/${selectedRaceId}/classes/${id}`);
  await loadHeatsClasses();
}

// ── Course File Library ───────────────────────────────────────────────────────
let courseFiles = [], selectedCourseId = null;
let courseParseData = null; // { paths, points, trackPoints, totalDistance, pathIndex }
let _courseTabContext = 'global'; // 'global' | 'race'

// ── Global COURSES tab ────────────────────────────────────────────────────────
function renderCoursesTab() {
  return `
  <div class="card" style="margin-bottom:12px">
    <div id="course-detail-inner" style="color:var(--text3);font-size:16px;padding:20px;text-align:center">
      Select a course file to preview
    </div>
  </div>
  <div class="card" style="margin-bottom:0">
    <h3>KML / GPX LIBRARY</h3>
    <div style="margin-bottom:8px">
      <div class="upload-zone" onclick="document.getElementById('course-upload-input').click()" style="padding:8px;cursor:pointer">
        <span style="font-size:14px">&#8593; Upload KML or GPX</span>
        <input type="file" id="course-upload-input" accept=".kml,.gpx" style="display:none" onchange="uploadCourseFile(this)">
      </div>
    </div>
    <div id="course-file-list"><div class="text-dim" style="font-size:16px;padding:6px">Loading...</div></div>
  </div>`;
}

async function bindCoursesTab() {
  _courseTabContext = 'global';
  selectedCourseId = null;
  courseParseData = null;
  await loadCourseFiles();
}

function renderOfflineMapsStatus(race) {
  const el = document.getElementById('offline-maps-status');
  if (!el) return;
  if (!race?.offline_maps) { el.innerHTML = ''; return; }
  const s = race.offline_maps_status || null;
  if (!s) {
    el.innerHTML = '<span style="color:var(--text3)">&#x23F3; Offline maps enabled — tiles will download when a course is assigned.</span>';
  } else if (s.startsWith('downloading')) {
    const pct = parseInt(s.split(':')[1]) || 0;
    el.innerHTML = `<span style="color:var(--accent2)">&#x25BC; Downloading tiles&hellip; ${pct}%</span>`;
  } else if (s === 'ready') {
    el.innerHTML = '<span style="color:var(--accent2)">&#x2713; Offline tiles ready (Topo &amp; Satellite, z8&ndash;14)</span>';
  } else if (s === 'error') {
    el.innerHTML = '<span style="color:var(--accent3)">&#x2717; Tile download failed &mdash; check server logs. Retry by re-assigning the course.</span>';
  }
}

function renderCourseTab() {
  const race = races.find(r => r.id === selectedRaceId);
  const courseOpts = '<option value="">— None —</option>' +
    courseFiles.map(c => `<option value="${c.id}"${c.id === race?.course_id ? ' selected' : ''}>${c.name} (${c.file_type.toUpperCase()})</option>`).join('');
  return `
  <div class="card">
    <h3>COURSE FILE</h3>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select id="race-course-sel" style="flex:1;min-width:180px">${courseOpts}</select>
      <button class="primary" onclick="saveRaceCourseAssignment()" style="font-size:13px;padding:4px 10px">ASSIGN</button>
      <span style="font-size:13px;color:var(--text3)">Upload files in the
        <a href="#" onclick="showTab('courses');return false;" style="color:var(--accent)">COURSES</a> tab
      </span>
    </div>
    <div id="offline-maps-status" style="margin-top:8px;font-size:13px"></div>
    <div id="race-course-preview" style="margin-top:10px"></div>
    <div id="race-course-seed"></div>
  </div>

  <div class="card">
    <h3>RACE STATIONS</h3>
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <button class="primary" onclick="openStationModal()">+ ADD</button>
    </div>
    <div id="stations-list"></div>
  </div>`;
}

async function bindCourseTab() {
  _courseTabContext = 'race';
  const race = races.find(r => r.id === selectedRaceId);
  await Promise.all([loadCourseFiles(), loadStations()]);
  // Populate the dropdown now that courseFiles is loaded
  const sel = document.getElementById('race-course-sel');
  if (sel) {
    sel.innerHTML = '<option value="">— None —</option>' +
      courseFiles.map(c => `<option value="${c.id}"${c.id === race?.course_id ? ' selected' : ''}>${c.name} (${c.file_type.toUpperCase()})</option>`).join('');
  }
  renderOfflineMapsStatus(race);
  if (race?.course_id) await loadAssignedCourse(race.course_id);
}

async function saveRaceCourseAssignment() {
  const courseVal = document.getElementById('race-course-sel').value;
  const courseId = courseVal ? parseInt(courseVal) : null;
  const res = await RT.put(`/api/races/${selectedRaceId}`, { course_id: courseId });
  if (!res.ok) { RT.toast(res.error, 'warn'); return; }
  await loadRaces();
  RT.toast(courseId ? 'Course assigned' : 'Course removed', 'ok');
  const preview = document.getElementById('race-course-preview');
  const seed = document.getElementById('race-course-seed');
  if (courseId) {
    if (preview) preview.innerHTML = '<div class="text-dim" style="padding:12px;text-align:center;font-size:14px">Loading preview...</div>';
    if (seed) seed.innerHTML = '';
    await loadAssignedCourse(courseId);
  } else {
    if (preview) preview.innerHTML = '';
    if (seed) seed.innerHTML = '';
  }
}

async function loadAssignedCourse(courseId) {
  const previewEl = document.getElementById('race-course-preview');
  const seedEl = document.getElementById('race-course-seed');
  if (!previewEl) return;
  const res = await RT.get(`/api/courses/${courseId}/parse`);
  if (!res.ok) { previewEl.innerHTML = `<div class="text-dim" style="font-size:14px">Error loading course: ${res.error}</div>`; return; }
  courseParseData = res.data;
  const d = courseParseData;
  const course = courseFiles.find(c => c.id === courseId);
  const dist = d.totalDistance ? RT.fmtDist(d.totalDistance) : '—';
  const svg = buildCourseSVG(d.trackPoints, 520, 200, null, stations);
  const hasPaths = d.paths?.length > 1;
  previewEl.innerHTML = `
    <div style="font-size:13px;color:var(--text3);margin-bottom:6px">${course?.name || ''} · ${dist}${d.trackPoints ? ` · ${d.trackPoints.length} pts` : ''}</div>
    ${svg}
    ${hasPaths ? `<div style="margin-top:8px">
      <label style="font-size:13px;letter-spacing:1px;color:var(--text3)">SELECT PATH</label>
      <select onchange="setCoursePathIndex(${courseId}, this.value)" style="margin-top:4px;font-size:13px">
        ${d.paths.map(p => `<option value="${p.index}"${p.index === d.pathIndex ? ' selected' : ''}>${p.name} (${p.pointCount} pts)</option>`).join('')}
      </select>
    </div>` : ''}`;

  // Build seed / auto-create section
  const race = races.find(r => r.id === selectedRaceId);
  const isOutBack = race?.race_format === 'out_and_back';
  const missingA = isOutBack ? !stations.some(s => s.type === 'start_finish') : !stations.some(s => s.type === 'start');
  const missingB = isOutBack ? !stations.some(s => s.type === 'turnaround')   : !stations.some(s => s.type === 'finish');
  let seedHtml = '';
  if ((missingA || missingB) && d.trackPoints?.length >= 2) {
    const labelA = isOutBack ? 'START/FINISH' : 'START';
    const labelB = isOutBack ? 'TURNAROUND'   : 'FINISH';
    const missing = [missingA && labelA, missingB && labelB].filter(Boolean).join(' + ');
    seedHtml += `<div style="background:rgba(210,153,34,.10);border:1px solid rgba(210,153,34,.35);border-radius:4px;padding:7px 10px;margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="font-size:14px;color:#d2993a;flex:1">&#9888; No ${missing} station for <strong>${race?.name || 'this race'}</strong></span>
      <button onclick="autoCreateStartFinish()" style="font-size:13px;padding:4px 10px;white-space:nowrap">AUTO-CREATE FROM TRACK</button>
    </div>`;
  }
  const wpts = d.points || [];
  if (wpts.length) {
    seedHtml += `<div style="margin-top:10px">
      <div style="font-size:13px;letter-spacing:1px;color:var(--text3);margin-bottom:6px">WAYPOINTS / POINTS OF INTEREST (${wpts.length})</div>
      <div style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:4px">
        ${wpts.map((w, i) => `<div class="infra-row" style="gap:6px;flex-wrap:nowrap">
          <input type="checkbox" id="wpt-${i}" checked style="flex-shrink:0">
          <label for="wpt-${i}" style="flex:1;font-size:16px;cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${w.name}</label>
          <span class="text-dim" style="font-size:13px;flex-shrink:0;white-space:nowrap">${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}</span>
          <select id="wpt-type-${i}" style="font-size:13px;padding:1px 4px;flex-shrink:0;width:auto">
            <option value="aid">Aid Station</option>
            <option value="checkpoint">Checkpoint</option>
            <option value="start">Start</option>
            <option value="finish">Finish</option>
            <option value="start_finish">Start / Finish</option>
            <option value="turnaround">Turnaround</option>
            <option value="netcontrol">Net Control</option>
            <option value="repeater">Repeater</option>
          </select>
        </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="primary" onclick="seedWaypointsToRace()" style="font-size:13px;padding:4px 10px">SEED STATIONS TO RACE</button>
      </div>
    </div>`;
  }
  if (seedEl) seedEl.innerHTML = seedHtml;
}

// ── KML/GPX course library ────────────────────────────────────────────────────
async function loadCourseFiles() {
  const res = await RT.get('/api/courses');
  courseFiles = res.ok ? res.data : [];
  renderCourseFileList();
}

function renderCourseFileList() {
  const el = document.getElementById('course-file-list');
  if (!el) return;
  if (!courseFiles.length) { el.innerHTML = '<div class="text-dim" style="font-size:16px;padding:6px">No course files uploaded yet.</div>'; return; }
  el.style.maxHeight = '';
  el.style.overflowY = '';
  el.innerHTML = courseFiles.map(c => `
    <div class="infra-row" style="cursor:pointer;border-radius:4px;min-width:0;${c.id===selectedCourseId?'background:var(--surface3,#161b22);':''}" onclick="selectCourse(${c.id})">
      <span title="${c.name}" style="flex:1;font-size:16px;font-weight:bold;color:var(--accent4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${c.name}</span>
      <span class="badge" style="flex-shrink:0;color:${c.file_type==='kml'?'var(--accent4)':'var(--accent)'};">${c.file_type.toUpperCase()}</span>
      <button style="font-size:13px;padding:2px 6px;flex-shrink:0" onclick="event.stopPropagation();renameCourse(${c.id})">REN</button>
      <button class="danger" style="font-size:13px;padding:2px 6px;flex-shrink:0" onclick="event.stopPropagation();deleteCourse(${c.id})">DEL</button>
    </div>`).join('');
}

async function selectCourse(id) {
  selectedCourseId = id;
  renderCourseFileList();
  const el = document.getElementById('course-detail-inner');
  el.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;font-size:16px">Loading...</div>';
  const res = await RT.get(`/api/courses/${id}/parse`);
  if (!res.ok) { el.innerHTML = `<div class="text-dim" style="padding:20px;text-align:center;font-size:16px">Error: ${res.error}</div>`; return; }
  courseParseData = res.data;
  renderCourseDetail(el, courseFiles.find(c => c.id === id));
}

function buildCourseSVG(points, w, h, waypoints, stationMarkers) {
  if (!points || points.length < 2) return `<svg width="${w}" height="${h}"><text x="${w/2}" y="${h/2}" text-anchor="middle" fill="#888" font-size="12">No track data</text></svg>`;
  const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const pad = 16;
  const rangeX = maxLon - minLon || 0.0001, rangeY = maxLat - minLat || 0.0001;
  const scale = Math.min((w - pad*2) / rangeX, (h - pad*2) / rangeY);
  const drawnW = rangeX * scale, drawnH = rangeY * scale;
  const offX = pad + (w - pad*2 - drawnW) / 2;
  const offY = pad + (h - pad*2 - drawnH) / 2;
  const toX = lon => offX + (lon - minLon) * scale;
  const toY = lat => h - offY - (lat - minLat) * scale;
  const d = points.map((p, i) => `${i===0?'M':'L'}${toX(p[1]).toFixed(1)},${toY(p[0]).toFixed(1)}`).join(' ');
  const sx = toX(points[0][1]).toFixed(1), sy = toY(points[0][0]).toFixed(1);
  const ex = toX(points[points.length-1][1]).toFixed(1), ey = toY(points[points.length-1][0]).toFixed(1);
  const wptSvg = (waypoints || []).map(wp => {
    const cx = toX(wp.lon).toFixed(1), cy = toY(wp.lat).toFixed(1);
    const label = (wp.name || '').length > 14 ? wp.name.slice(0, 13) + '…' : wp.name;
    return `<circle cx="${cx}" cy="${cy}" r="4" fill="#58a6ff" stroke="#0d1117" stroke-width="1.5"/>
    <text x="${cx}" y="${(parseFloat(cy) - 7).toFixed(1)}" text-anchor="middle" fill="#58a6ff" font-size="9" font-family="monospace">${label}</text>`;
  }).join('');
  const STYPE_COLORS = { start:'#3fb950', finish:'#f78166', start_finish:'#a371f7', turnaround:'#58a6ff', aid:'#d2a679', checkpoint:'#e8c55a', netcontrol:'#8b949e', repeater:'#8b949e' };
  const stSvg = (stationMarkers || []).filter(s => s.lat && s.lon).map(s => {
    const cx = toX(s.lon).toFixed(1), cy = toY(s.lat).toFixed(1);
    const color = STYPE_COLORS[s.type] || '#8b949e';
    const label = (s.name || '').length > 12 ? s.name.slice(0, 11) + '…' : s.name;
    return `<circle cx="${cx}" cy="${cy}" r="5" fill="${color}" stroke="#0d1117" stroke-width="1.5"/>
    <text x="${cx}" y="${(parseFloat(cy) + 15).toFixed(1)}" text-anchor="middle" fill="${color}" font-size="9" font-family="monospace">${label}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${h}px;display:block;background:var(--surface2);border-radius:6px">
    <path d="${d}" fill="none" stroke="#f5a623" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${wptSvg}
    ${stSvg}
    <circle cx="${sx}" cy="${sy}" r="5" fill="#3fb950" stroke="#0d1117" stroke-width="1.5"/>
    <circle cx="${ex}" cy="${ey}" r="5" fill="#f85149" stroke="#0d1117" stroke-width="1.5"/>
  </svg>`;
}

function renderCourseDetail(el, course) {
  const d = courseParseData;
  const hasPaths = d.paths?.length > 1;
  const dist = d.totalDistance ? RT.fmtDist(d.totalDistance) : '—';
  const wpts = d.points || [];
  const svg = buildCourseSVG(d.trackPoints, 900, 280, wpts);

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-size:17px;font-weight:bold;color:var(--text)">${course.name}</div>
      <div class="text-dim" style="font-size:14px">${dist}${d.trackPoints?` · ${d.trackPoints.length} pts`:''}</div>
    </div>
    ${svg}
    ${hasPaths ? `
    <div style="margin-top:10px">
      <label style="font-size:13px;letter-spacing:1px;color:var(--text3)">SELECT PATH</label>
      <select onchange="setCoursePathIndex(${course.id}, this.value)" style="margin-top:4px">
        ${d.paths.map(p => `<option value="${p.index}"${p.index===d.pathIndex?' selected':''}>${p.name} (${p.pointCount} pts)</option>`).join('')}
      </select>
    </div>` : ''}
    ${!races.some(r => r.status === 'active' && r.course_id === course.id) ? `
    <div style="margin-top:12px">
      <button onclick="window.open('mapeditor.html?courseId=${course.id}')">EDIT MAP</button>
    </div>` : ''}
    `;
}


async function autoCreateStartFinish() {
  const pts = courseParseData?.trackPoints;
  if (!pts?.length) return;
  const race = races.find(r => r.id === selectedRaceId);
  const isOutBack = race?.race_format === 'out_and_back';
  const toCreate = [];
  if (isOutBack) {
    if (!stations.some(s => s.type === 'start_finish'))
      toCreate.push({ name: 'Start/Finish', type: 'start_finish', lat: pts[0][0],            lon: pts[0][1] });
    if (!stations.some(s => s.type === 'turnaround'))
      toCreate.push({ name: 'Turnaround',   type: 'turnaround',   lat: pts[pts.length-1][0], lon: pts[pts.length-1][1] });
  } else {
    if (!stations.some(s => s.type === 'start'))
      toCreate.push({ name: 'Start',  type: 'start',  lat: pts[0][0],            lon: pts[0][1] });
    if (!stations.some(s => s.type === 'finish'))
      toCreate.push({ name: 'Finish', type: 'finish', lat: pts[pts.length-1][0], lon: pts[pts.length-1][1] });
  }
  if (!toCreate.length) return;
  for (const s of toCreate) await RT.post(`/api/races/${selectedRaceId}/stations`, s);
  RT.toast(`Created ${toCreate.map(s => s.name).join(' + ')} station(s)`, 'ok');
  await loadStations();
  if (_courseTabContext === 'race') {
    const r = races.find(x => x.id === selectedRaceId);
    if (r?.course_id) await loadAssignedCourse(r.course_id);
  } else if (selectedCourseId) {
    await selectCourse(selectedCourseId);
  }
}

async function setCoursePathIndex(courseId, idx) {
  await RT.put(`/api/courses/${courseId}`, { path_index: parseInt(idx) });
  RT.toast('Course path updated', 'ok');
  if (_courseTabContext === 'race') {
    await loadAssignedCourse(courseId);
  } else {
    await selectCourse(courseId);
  }
}

async function uploadCourseFile(input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('course', file);
  const res = await fetch(RT.BASE + 'api/courses/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json.ok) {
    RT.toast(`Uploaded: ${file.name}`, 'ok');
    await loadCourseFiles();
    selectCourse(json.data.id);
  } else RT.toast(json.error || 'Upload failed', 'warn');
  input.value = '';
}

async function renameCourse(id) {
  const c = courseFiles.find(x => x.id === id);
  const name = prompt('Rename course:', c?.name || '');
  if (!name || name === c?.name) return;
  await RT.put(`/api/courses/${id}`, { name });
  await loadCourseFiles();
  if (selectedCourseId === id) await selectCourse(id);
}

async function deleteCourse(id) {
  await RT.del(`/api/courses/${id}`);
  if (selectedCourseId === id) {
    selectedCourseId = null;
    courseParseData = null;
    const el = document.getElementById('course-detail-inner');
    if (el) el.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;font-size:16px">Select a course file to preview</div>';
  }
  await loadCourseFiles();
  RT.toast('Course deleted', 'ok');
}

async function seedWaypointsToRace() {
  const raceId = selectedRaceId;
  const wpts = courseParseData?.points || [];
  const waypoints = wpts
    .map((w, i) => ({ ...w, type: document.getElementById(`wpt-type-${i}`)?.value || 'aid', checked: document.getElementById(`wpt-${i}`)?.checked }))
    .filter(w => w.checked);
  if (!waypoints.length) { RT.toast('No waypoints selected', 'warn'); return; }
  const res = await RT.post(`/api/races/${raceId}/stations/seed`, { waypoints });
  if (res.ok) {
    RT.toast(`Seeded ${res.data.length} stations`, 'ok');
    selectedRaceId = raceId;
    await loadStations();
    const race = races.find(r => r.id === raceId);
    if (race?.course_id) await loadAssignedCourse(race.course_id);
  } else RT.toast(res.error, 'warn');
}

// ── Race stations ─────────────────────────────────────────────────────────────
let stations = [];

async function loadStations() {
  if (!selectedRaceId) return;
  const res = await RT.get(`/api/races/${selectedRaceId}/stations`);
  stations = res.ok ? res.data : [];
  renderStationsList();
}

function stationWarningHtml() {
  if (!stations.length) return '';
  const race = races.find(r => r.id === selectedRaceId);
  const isOutBack = race?.race_format === 'out_and_back';
  const missing = [];
  if (isOutBack) {
    if (!stations.some(s => s.type === 'start_finish')) missing.push('START/FINISH');
    if (!stations.some(s => s.type === 'turnaround'))   missing.push('TURNAROUND');
  } else {
    if (!stations.some(s => s.type === 'start'))  missing.push('START');
    if (!stations.some(s => s.type === 'finish')) missing.push('FINISH');
  }
  if (!missing.length) return '';
  return `<div style="background:rgba(210,153,34,.12);border:1px solid rgba(210,153,34,.4);border-radius:4px;padding:7px 10px;margin-bottom:8px;font-size:14px;color:#d2993a">
    &#9888; No <strong>${missing.join(' or ')}</strong> station defined — participants will not auto-transition status via geofence.
  </div>`;
}

function renderStationsList() {
  const el = document.getElementById('stations-list');
  if (!el) return;
  if (!stations.length) { el.innerHTML = '<div class="text-dim" style="font-size:16px;padding:6px">No stations yet. Seed from a course file above, or add manually.</div>'; return; }
  el.innerHTML = stationWarningHtml() + `<div class="table-scroll"><table class="data-table"><thead><tr><th>#</th><th>NAME</th><th>TYPE</th><th>LAT</th><th>LON</th><th>CUTOFF</th><th></th></tr></thead><tbody>
    ${stations.map((s, i) => `<tr>
      <td class="text-dim">${i + 1}</td>
      <td>${s.name}</td>
      <td><span class="badge" style="color:var(--accent4)">${s.type.toUpperCase()}</span></td>
      <td class="text-dim">${s.lat.toFixed(5)}</td>
      <td class="text-dim">${s.lon.toFixed(5)}</td>
      <td>${s.cutoff_time || '--'}</td>
      <td style="text-align:right">
        <button style="font-size:13px;padding:2px 8px" onclick="openStationModal(${s.id})">EDIT</button>
        <button class="danger" style="font-size:13px;padding:2px 8px" onclick="deleteStation(${s.id})">DEL</button>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}


let editingStationId = null;

function openStationModal(id) {
  editingStationId = id || null;
  const s = id ? stations.find(x => x.id === id) : null;
  document.getElementById('station-modal-title').textContent = id ? 'EDIT STATION' : 'NEW STATION';
  document.getElementById('sm-name').value   = s?.name || '';
  document.getElementById('sm-type').value   = s?.type || 'aid';
  document.getElementById('sm-lat').value    = s?.lat ?? '';
  document.getElementById('sm-lon').value    = s?.lon ?? '';
  document.getElementById('sm-cutoff').value = s?.cutoff_time || '';
  document.getElementById('station-modal').classList.remove('hidden');
  document.getElementById('sm-name').focus();
}

async function saveStation() {
  const name   = document.getElementById('sm-name').value.trim();
  const type   = document.getElementById('sm-type').value;
  const lat    = parseFloat(document.getElementById('sm-lat').value);
  const lon    = parseFloat(document.getElementById('sm-lon').value);
  const cutoff = document.getElementById('sm-cutoff').value.trim() || null;
  if (!name) { RT.toast('Name required', 'warn'); return; }
  if (isNaN(lat) || isNaN(lon)) { RT.toast('Valid lat/lon required', 'warn'); return; }
  const body = { name, type, lat, lon, cutoff_time: cutoff };
  const res = editingStationId
    ? await RT.put(`/api/races/${selectedRaceId}/stations/${editingStationId}`, body)
    : await RT.post(`/api/races/${selectedRaceId}/stations`, body);
  if (res.ok) {
    closeModal('station-modal');
    await loadStations();
    RT.toast(editingStationId ? 'Station updated' : 'Station added', 'ok');
  } else RT.toast(res.error, 'warn');
}

async function deleteStation(id) {
  await RT.del(`/api/races/${selectedRaceId}/stations/${id}`);
  await loadStations();
}

// ── Participants ──────────────────────────────────────────────────────────────
let participants = [], participantsCsvContent = '';
let editingParticipantId = null;
let selectedParticipantIds = new Set();

function renderParticipantsTab() {
  return `
  <div class="card">
    <h3>PARTICIPANTS</h3>
    <div id="pt-summary" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"></div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="primary" onclick="openParticipantModal()">+ ADD</button>
      <button onclick="togglePtCsvPanel()">CSV IMPORT</button>
      <button onclick="exportParticipantsCsv()">CSV EXPORT</button>
      <button class="danger" onclick="clearAllParticipants()" style="margin-left:auto">CLEAR ALL</button>
    </div>
    <div id="pt-bulk-bar" class="hidden" style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-top:8px;background:var(--surface2);border:1px solid var(--accent);border-radius:6px;flex-wrap:wrap">
      <span id="pt-bulk-count" style="font-size:14px;color:var(--accent);min-width:70px;white-space:nowrap"></span>
      <select id="pt-bulk-field" onchange="updateBulkValueOptions()" style="font-size:14px">
        <option value="heat_id">Set Heat</option>
        <option value="class_id">Set Class</option>
        <option value="status">Set Status</option>
      </select>
      <select id="pt-bulk-value" style="font-size:14px;min-width:120px"></select>
      <button class="primary" onclick="applyBulkAction()" style="font-size:14px;padding:4px 12px">APPLY</button>
      <button onclick="clearParticipantSelection()" style="font-size:14px;padding:4px 12px">DESELECT ALL</button>
    </div>
    <div id="pt-csv-panel" class="hidden" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:10px">
      <div style="font-size:14px;color:var(--text3);margin-bottom:6px">
        <span style="color:var(--accent3)">Required columns:</span> <code>bib, name, tracker_id</code><br>
        <span style="color:var(--text3)">Optional columns:</span> <code>heat, class, age, phone, emergency_contact</code><br>
        First row must be a header. Heat/class matched by name. Duplicate bibs are updated.
      </div>
      <div class="upload-zone" onclick="document.getElementById('pt-csv-input').click()" id="pt-csv-zone">
        <span id="pt-csv-label" style="font-size:14px">&#8593; Select CSV file</span>
        <input type="file" id="pt-csv-input" accept=".csv" style="display:none" onchange="ptCsvSelected(this)">
      </div>
      <div id="pt-csv-error" style="font-size:14px;color:var(--accent3);margin-top:6px;display:none"></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="primary" id="pt-csv-btn" onclick="importParticipantsCsv()" disabled>IMPORT</button>
        <button onclick="togglePtCsvPanel()">CANCEL</button>
      </div>
    </div>
    <div id="participants-list" style="margin-top:10px"></div>
  </div>`;
}

async function bindParticipantsTab() { await loadParticipants(); }

async function loadParticipants() {
  if (!selectedRaceId) return;
  const pr = await RT.get(`/api/races/${selectedRaceId}/participants`);
  const hr = await RT.get(`/api/races/${selectedRaceId}/heats`);
  const cr = await RT.get(`/api/races/${selectedRaceId}/classes`);
  participants = pr.ok ? pr.data : [];
  heats        = hr.ok ? hr.data : [];
  classes      = cr.ok ? cr.data : [];
  renderParticipantSummary();
  renderParticipantsList();
}

function renderParticipantSummary() {
  const el = document.getElementById('pt-summary');
  if (!el) return;
  const counts = { dns:0, active:0, dnf:0, finished:0 };
  participants.forEach(p => { if (counts[p.status] != null) counts[p.status]++; });
  const colors = { dns:'var(--text3)', active:'var(--accent)', dnf:'var(--accent3)', finished:'var(--accent2)' };
  el.innerHTML = Object.entries(counts).map(([s, n]) =>
    `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:4px 12px;text-align:center">
      <div style="font-size:24px;font-weight:bold;color:${colors[s]}">${n}</div>
      <div style="font-size:13px;color:var(--text3);letter-spacing:1px">${s.toUpperCase()}</div>
    </div>`
  ).join('') + `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:4px 12px;text-align:center">
    <div style="font-size:24px;font-weight:bold;color:var(--text)">${participants.length}</div>
    <div style="font-size:13px;color:var(--text3);letter-spacing:1px">TOTAL</div>
  </div>`;
}

function renderParticipantsList() {
  const el = document.getElementById('participants-list');
  if (!el) return;
  selectedParticipantIds = new Set();
  updateBulkBar();
  if (!participants.length) {
    el.innerHTML = '<div class="text-dim" style="font-size:16px;padding:6px">No participants yet. Add manually or import a CSV.</div>';
    return;
  }
  const STATUS_C = { dns:'var(--text3)', active:'var(--accent)', dnf:'var(--accent3)', finished:'var(--accent2)' };
  el.innerHTML = `<div class="table-scroll"><table class="data-table">
    <thead><tr>
      <th style="width:28px"><input type="checkbox" id="pt-select-all" onchange="toggleSelectAllParticipants(this.checked)" title="Select all"></th>
      <th>#</th><th>BIB</th><th>NAME</th><th>HEAT</th><th>CLASS</th><th>TRACKER</th><th>STATUS</th><th>AGE</th><th></th>
    </tr></thead>
    <tbody>${participants.map((p, i) => {
      const heat = heats.find(h => h.id === p.heat_id);
      const cls  = classes.find(c => c.id === p.class_id);
      const dot  = heat ? `<span class="dot" style="background:${heat.color}"></span>` : '';
      return `<tr id="pt-row-${p.id}">
        <td><input type="checkbox" onchange="toggleParticipantSelect(${p.id}, this.checked)"></td>
        <td class="text-dim">${i+1}</td>
        <td style="font-weight:bold">${p.bib}</td>
        <td>${p.name}</td>
        <td style="white-space:nowrap">${dot} ${heat?.name || '<span class="text-dim">—</span>'}</td>
        <td>${cls?.name || '<span class="text-dim">—</span>'}</td>
        <td style="font-size:13px;color:var(--accent4)">${p.tracker_id || '<span class="text-dim">—</span>'}</td>
        <td><span style="color:${STATUS_C[p.status]||'var(--text3)'};font-size:13px;letter-spacing:1px">${(p.status||'dns').toUpperCase()}</span></td>
        <td class="text-dim">${p.age || '—'}</td>
        <td style="text-align:right;white-space:nowrap">
          <button style="font-size:13px;padding:2px 8px" onclick="openParticipantModal(${p.id})">EDIT</button>
          <button class="danger" style="font-size:13px;padding:2px 8px" onclick="deleteParticipant(${p.id})">DEL</button>
        </td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function toggleParticipantSelect(id, checked) {
  if (checked) selectedParticipantIds.add(id);
  else selectedParticipantIds.delete(id);
  const row = document.getElementById(`pt-row-${id}`);
  if (row) row.style.background = checked ? 'var(--surface3,#161b22)' : '';
  const allBox = document.getElementById('pt-select-all');
  if (allBox) allBox.checked = selectedParticipantIds.size === participants.length;
  updateBulkBar();
}

function toggleSelectAllParticipants(checked) {
  participants.forEach(p => {
    const cb = document.querySelector(`#pt-row-${p.id} input[type=checkbox]`);
    if (cb) cb.checked = checked;
    const row = document.getElementById(`pt-row-${p.id}`);
    if (row) row.style.background = checked ? 'var(--surface3,#161b22)' : '';
    if (checked) selectedParticipantIds.add(p.id);
    else selectedParticipantIds.delete(p.id);
  });
  updateBulkBar();
}

function clearParticipantSelection() {
  toggleSelectAllParticipants(false);
  const allBox = document.getElementById('pt-select-all');
  if (allBox) allBox.checked = false;
}

function updateBulkBar() {
  const bar = document.getElementById('pt-bulk-bar');
  const count = document.getElementById('pt-bulk-count');
  if (!bar) return;
  const n = selectedParticipantIds.size;
  if (n === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  count.textContent = `${n} selected`;
  updateBulkValueOptions();
}

function updateBulkValueOptions() {
  const field = document.getElementById('pt-bulk-field')?.value;
  const sel = document.getElementById('pt-bulk-value');
  if (!sel || !field) return;
  if (field === 'heat_id') {
    sel.innerHTML = '<option value="">— None —</option>' +
      heats.map(h => `<option value="${h.id}">${h.name}</option>`).join('');
  } else if (field === 'class_id') {
    sel.innerHTML = '<option value="">— None —</option>' +
      classes.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  } else {
    sel.innerHTML = ['dns','active','dnf','finished']
      .map(s => `<option value="${s}">${s.toUpperCase()}</option>`).join('');
  }
}

async function applyBulkAction() {
  const field = document.getElementById('pt-bulk-field')?.value;
  const rawVal = document.getElementById('pt-bulk-value')?.value;
  const ids = [...selectedParticipantIds];
  if (!ids.length || !field) return;
  const value = (field === 'heat_id' || field === 'class_id')
    ? (rawVal ? parseInt(rawVal) : null)
    : rawVal;
  const res = await RT.put(`/api/races/${selectedRaceId}/participants`, { ids, field, value });
  if (res.ok) {
    RT.toast(`Updated ${res.updated} participant(s)`, 'ok');
    await loadParticipants();
  } else {
    RT.toast(res.error || 'Bulk update failed', 'warn');
  }
}

function openParticipantModal(id) {
  editingParticipantId = id || null;
  const p = id ? participants.find(x => x.id === id) : null;
  document.getElementById('pm2-title').textContent = id ? 'EDIT PARTICIPANT' : 'NEW PARTICIPANT';
  // Auto-populate next sequential bib when adding a new participant
  const nextBib = id ? (p?.bib || '') : (() => {
    const bibs = participants.map(x => parseInt(x.bib)).filter(n => !isNaN(n));
    return bibs.length ? (Math.max(...bibs) + 1).toString() : '1';
  })();
  document.getElementById('pm2-bib').value               = nextBib;
  document.getElementById('pm2-name').value              = p?.name || '';
  document.getElementById('pm2-tracker').value           = p?.tracker_id || '';
  document.getElementById('pm2-age').value               = p?.age || '';
  document.getElementById('pm2-inreach-url').value       = p?.inreach_url || '';
  document.getElementById('pm2-phone').value             = p?.phone || '';
  document.getElementById('pm2-emergency').value         = p?.emergency_contact || '';
  document.getElementById('pm2-status').value            = p?.status || 'dns';
  // Populate heat/class selects
  const hSel = document.getElementById('pm2-heat');
  hSel.innerHTML = '<option value="">— None —</option>' +
    heats.map(h => `<option value="${h.id}"${h.id===p?.heat_id?' selected':''}>${h.name}</option>`).join('');
  const cSel = document.getElementById('pm2-class');
  cSel.innerHTML = '<option value="">— None —</option>' +
    classes.map(c => `<option value="${c.id}"${c.id===p?.class_id?' selected':''}>${c.name}</option>`).join('');
  document.getElementById('participant-modal').classList.remove('hidden');
  document.getElementById('pm2-bib').focus();
}

async function saveParticipant() {
  const bib  = document.getElementById('pm2-bib').value.trim();
  const name = document.getElementById('pm2-name').value.trim();
  if (!bib || !name) { RT.toast('Bib and name required', 'warn'); return; }
  const body = {
    bib,
    name,
    tracker_id:        document.getElementById('pm2-tracker').value.trim() || null,
    inreach_url:       document.getElementById('pm2-inreach-url').value.trim() || null,
    age:               parseInt(document.getElementById('pm2-age').value) || null,
    phone:             document.getElementById('pm2-phone').value.trim() || null,
    emergency_contact: document.getElementById('pm2-emergency').value.trim() || null,
    status:            document.getElementById('pm2-status').value,
    heat_id:           document.getElementById('pm2-heat').value   ? parseInt(document.getElementById('pm2-heat').value)  : null,
    class_id:          document.getElementById('pm2-class').value  ? parseInt(document.getElementById('pm2-class').value) : null,
  };
  const res = editingParticipantId
    ? await RT.put(`/api/races/${selectedRaceId}/participants/${editingParticipantId}`, body)
    : await RT.post(`/api/races/${selectedRaceId}/participants`, body);
  if (res.ok) {
    closeModal('participant-modal');
    await loadParticipants();
    RT.toast(editingParticipantId ? 'Participant updated' : 'Participant added', 'ok');
  } else RT.toast(res.error, 'warn');
}

async function deleteParticipant(id) {
  const res = await RT.del(`/api/races/${selectedRaceId}/participants/${id}`);
  if (res.ok) { await loadParticipants(); RT.toast('Participant deleted', 'ok'); }
  else RT.toast(res.error, 'warn');
}

async function clearAllParticipants() {
  const res = await RT.del(`/api/races/${selectedRaceId}/participants`);
  if (res.ok) {
    participants = [];
    renderParticipantSummary();
    renderParticipantsList();
    RT.toast(`Cleared ${res.deleted} participants`, 'ok');
  } else RT.toast(res.error || 'Failed to clear participants', 'warn');
}

function togglePtCsvPanel() {
  participantsCsvContent = '';
  const panel = document.getElementById('pt-csv-panel');
  if (!panel) return;
  document.getElementById('pt-csv-label').textContent = '↑ Select CSV file';
  document.getElementById('pt-csv-btn').disabled = true;
  const errEl = document.getElementById('pt-csv-error');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  panel.classList.toggle('hidden');
}

function ptCsvSelected(input) {
  const file = input.files[0];
  const errEl = document.getElementById('pt-csv-error');
  const btn   = document.getElementById('pt-csv-btn');
  const label = document.getElementById('pt-csv-label');

  function showError(msg) {
    participantsCsvContent = '';
    btn.disabled = true;
    label.textContent = '↑ Select CSV file';
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    const firstLine = text.split(/\r?\n/)[0] || '';
    const normalize = s => s.toLowerCase().replace(/[\s_\-"']+/g, '');
    const headers = firstLine.split(',').map(h => normalize(h.trim()));

    const REQUIRED = [
      { label: 'bib',        match: h => h === 'bib' },
      { label: 'name',       match: h => h === 'name' },
      { label: 'tracker_id', match: h => h === 'trackerid' || h === 'tracker' },
    ];

    const missing = REQUIRED.filter(r => !headers.some(r.match)).map(r => r.label);

    if (missing.length) {
      const found = firstLine.split(',').map(h => h.trim()).join(', ') || '(empty)';
      showError(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Found: ${found}`);
      return;
    }

    errEl.style.display = 'none';
    errEl.textContent = '';
    participantsCsvContent = text;
    label.textContent = `✓ ${file.name}`;
    btn.disabled = false;
  };
  reader.readAsText(file);
}

async function importParticipantsCsv() {
  if (!participantsCsvContent) return;
  const res = await RT.post(`/api/races/${selectedRaceId}/participants/import`, { csv: participantsCsvContent });
  if (res.ok) {
    const errors = res.errors || [];
    document.getElementById('pt-csv-panel').classList.add('hidden');
    participants = res.data || [];
    renderParticipantSummary();
    renderParticipantsList();
    RT.toast(`Imported ${participants.length} participants${errors.length ? ` (${errors.length} skipped)` : ''}`, errors.length ? 'warn' : 'ok');
    if (errors.length) console.warn('Import errors:', errors);
  } else RT.toast(res.error, 'warn');
}

function exportParticipantsCsv() {
  const header = 'bib,name,tracker_id,heat,class,age,phone,emergency_contact,status';
  const rows = participants.map(p => {
    const heat = heats.find(h => h.id === p.heat_id);
    const cls  = classes.find(c => c.id === p.class_id);
    return [p.bib, p.name, p.tracker_id||'', heat?.name||'', cls?.name||'',
            p.age||'', p.phone||'', p.emergency_contact||'', p.status].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',');
  });
  const csv = [header, ...rows].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `participants_race${selectedRaceId}.csv`;
  a.click();
}

// ── Personnel ─────────────────────────────────────────────────────────────────
let personnel = [], personnelCsvContent = '';
function renderPersonnelTab() {
  return `
  <div class="card">
    <h3>AID STATION PERSONNEL</h3>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="primary" onclick="openPersonnelModal()">+ ADD PERSON</button>
      <button onclick="showPersonnelCsvPanel()">CSV IMPORT</button>
      <button class="danger" onclick="clearAllPersonnel()">DELETE ALL</button>
    </div>
    <div id="pers-csv-panel" class="hidden" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:10px">
      <div class="text-dim" style="font-size:14px;margin-bottom:6px">Columns: name, station_name, tracker_id, phone</div>
      <div class="upload-zone" onclick="document.getElementById('pers-csv-input').click()" style="padding:8px">
        <div id="pers-csv-label">&#8593; Select CSV file</div>
        <input type="file" id="pers-csv-input" accept=".csv" style="display:none" onchange="personnelCsvSelected(this)">
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="primary" id="pers-csv-btn" disabled onclick="importPersonnelCsv()">IMPORT</button>
        <button onclick="document.getElementById('pers-csv-panel').classList.add('hidden')">CANCEL</button>
      </div>
    </div>
    <div id="personnel-list"></div>
  </div>`;
}

function showPersonnelCsvPanel() {
  personnelCsvContent = '';
  document.getElementById('pers-csv-label').textContent = '↑ Select CSV file';
  document.getElementById('pers-csv-btn').disabled = true;
  document.getElementById('pers-csv-panel').classList.remove('hidden');
}

function personnelCsvSelected(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    personnelCsvContent = e.target.result;
    document.getElementById('pers-csv-label').textContent = `✓ ${file.name}`;
    document.getElementById('pers-csv-btn').disabled = false;
  };
  reader.readAsText(file);
}

async function importPersonnelCsv() {
  if (!personnelCsvContent) return;
  const res = await RT.post(`/api/races/${selectedRaceId}/personnel/import`, { csv: personnelCsvContent });
  if (res.ok) {
    RT.toast('Personnel imported', 'ok');
    document.getElementById('pers-csv-panel').classList.add('hidden');
    await loadPersonnel();
  } else RT.toast(res.error, 'warn');
}

async function bindPersonnelTab() { await loadPersonnel(); }

async function loadPersonnel() {
  if (!selectedRaceId) return;
  const [pr, sr] = await Promise.all([
    RT.get(`/api/races/${selectedRaceId}/personnel`),
    RT.get(`/api/races/${selectedRaceId}/stations`),
  ]);
  personnel = pr.ok ? pr.data : [];
  stations = sr.ok ? sr.data : [];
  const el = document.getElementById('personnel-list');
  if (!el) return;
  if (!personnel.length) { el.innerHTML = '<div class="text-dim" style="font-size:16px;padding:6px">No personnel yet.</div>'; return; }
  el.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>NAME</th><th>STATION</th><th>TRACKER ID</th><th>PHONE</th><th></th></tr></thead><tbody>
    ${personnel.map(p => `<tr>
      <td>${p.name}</td>
      <td>${p.is_rover ? '<span style="color:var(--accent);font-size:12px;letter-spacing:1px">ROVER</span>' : (p.station_name || '<span class="text-dim">—</span>')}</td>
      <td>${p.tracker_id || '<span class="text-dim">—</span>'}</td>
      <td>${p.phone || '<span class="text-dim">—</span>'}</td>
      <td style="text-align:right">
        <button style="font-size:13px;padding:2px 8px" onclick="openPersonnelModal(${p.id})">EDIT</button>
        <button class="danger" style="font-size:13px;padding:2px 8px" onclick="deletePersonnel(${p.id})">DEL</button>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

let editingPersonnelId = null;

function pmBuildStationOptions() {
  return '<option value="">— Unassigned —</option>' +
    '<option value="rover">Rover (mobile, no fixed station)</option>' +
    stations.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
}

function pmAddQRow(focusName = true) {
  const container = document.getElementById('pm-qrows');
  const div = document.createElement('div');
  div.className = 'pm-qrow';
  div.innerHTML = `
    <input class="pm-q-name"    placeholder="Name"       onkeydown="pmQKeydown(event,this)">
    <select class="pm-q-station" onkeydown="pmQKeydown(event,this)">${pmBuildStationOptions()}</select>
    <input class="pm-q-tracker" placeholder="Tracker ID" onkeydown="pmQKeydown(event,this)">
    <input class="pm-q-phone"   placeholder="Phone"      onkeydown="pmQKeydown(event,this)">
    <button tabindex="-1" onclick="pmRemoveQRow(this)" style="padding:2px 6px;color:var(--accent3)">✕</button>`;
  container.appendChild(div);
  if (focusName) div.querySelector('.pm-q-name').focus();
  return div;
}

function pmRemoveQRow(btn) {
  const container = document.getElementById('pm-qrows');
  const row = btn.closest('.pm-qrow');
  if (container.children.length > 1) {
    row.remove();
  } else {
    row.querySelector('.pm-q-name').value    = '';
    row.querySelector('.pm-q-station').value = '';
    row.querySelector('.pm-q-tracker').value = '';
    row.querySelector('.pm-q-phone').value   = '';
  }
}

function pmQKeydown(e, el) {
  if (e.key === 'Enter') {
    e.preventDefault();
    pmAddQRow(true);
    return;
  }
  if (e.key === 'Tab' && !e.shiftKey && el.classList.contains('pm-q-phone')) {
    const allPhones = [...document.querySelectorAll('#pm-qrows .pm-q-phone')];
    if (allPhones.indexOf(el) === allPhones.length - 1) {
      e.preventDefault();
      pmAddQRow(true);
    }
  }
}

function pmUpdatePreview() {
  const color = document.getElementById('pm-color')?.value || '#f5a623';
  const shape = document.getElementById('pm-shape')?.value || 'triangle';
  const el = document.getElementById('pm-icon-preview');
  if (el) el.innerHTML = RT.SHAPES[shape]?.(color, 24) || '';
}

function openPersonnelModal(id) {
  editingPersonnelId = id || null;
  const inner   = document.getElementById('pm-inner');
  const editSec = document.getElementById('pm-edit-section');
  const newSec  = document.getElementById('pm-new-section');
  document.getElementById('personnel-modal-title').textContent = id ? 'EDIT PERSONNEL' : 'NEW PERSONNEL';

  if (id) {
    inner.classList.remove('modal-wide');
    editSec.classList.remove('hidden');
    newSec.classList.add('hidden');
    const p = personnel.find(x => x.id === id);
    document.getElementById('pm-name').value       = p?.name       || '';
    document.getElementById('pm-tracker-id').value = p?.tracker_id || '';
    document.getElementById('pm-phone').value      = p?.phone      || '';
    document.getElementById('pm-color').value      = p?.color      || '#f5a623';
    document.getElementById('pm-shape').value      = p?.shape      || 'triangle';
    const sel = document.getElementById('pm-station-id');
    sel.innerHTML = '<option value="">— Unassigned —</option>' +
      '<option value="rover"' + (p?.is_rover ? ' selected' : '') + '>Rover (mobile, no fixed station)</option>' +
      stations.map(s => `<option value="${s.id}"${!p?.is_rover && s.id === p?.station_id ? ' selected' : ''}>${s.name}</option>`).join('');
    pmUpdatePreview();
    document.getElementById('personnel-modal').classList.remove('hidden');
    document.getElementById('pm-name').focus();
  } else {
    inner.classList.add('modal-wide');
    editSec.classList.add('hidden');
    newSec.classList.remove('hidden');
    document.getElementById('pm-qrows').innerHTML = '';
    pmAddQRow();
    document.getElementById('personnel-modal').classList.remove('hidden');
  }
}

async function savePersonnel() {
  if (editingPersonnelId) {
    const name       = document.getElementById('pm-name').value.trim();
    const station_id = document.getElementById('pm-station-id').value || null;
    const tracker_id = document.getElementById('pm-tracker-id').value.trim() || null;
    const phone      = document.getElementById('pm-phone').value.trim() || null;
    const color      = document.getElementById('pm-color').value || '#f5a623';
    const shape      = document.getElementById('pm-shape').value || 'triangle';
    if (!name) { RT.toast('Name required', 'warn'); return; }
    const is_rover = station_id === 'rover';
    const body = { name, station_id: is_rover || !station_id ? null : parseInt(station_id), is_rover, tracker_id, phone, color, shape };
    const res = await RT.put(`/api/races/${selectedRaceId}/personnel/${editingPersonnelId}`, body);
    if (res.ok) {
      closeModal('personnel-modal');
      await loadPersonnel();
      RT.toast('Personnel updated', 'ok');
    } else RT.toast(res.error, 'warn');
    return;
  }

  const rows = [...document.querySelectorAll('#pm-qrows .pm-qrow')];
  const toSave = rows.map(row => ({
    name:       row.querySelector('.pm-q-name').value.trim(),
    station_id: row.querySelector('.pm-q-station').value || null,
    tracker_id: row.querySelector('.pm-q-tracker').value.trim() || null,
    phone:      row.querySelector('.pm-q-phone').value.trim() || null,
  })).filter(r => r.name);
  if (!toSave.length) { RT.toast('Enter at least one name', 'warn'); return; }

  let saved = 0;
  for (const r of toSave) {
    const is_rover = r.station_id === 'rover';
    const body = {
      name:       r.name,
      station_id: is_rover || !r.station_id ? null : parseInt(r.station_id),
      is_rover,
      tracker_id: r.tracker_id,
      phone:      r.phone,
      color:      '#f5a623',
      shape:      'triangle',
    };
    const res = await RT.post(`/api/races/${selectedRaceId}/personnel`, body);
    if (res.ok) saved++;
    else RT.toast(`Failed to save "${r.name}": ${res.error}`, 'warn');
  }
  if (saved > 0) {
    closeModal('personnel-modal');
    await loadPersonnel();
    RT.toast(`${saved} personnel added`, 'ok');
  }
}

async function deletePersonnel(id) {
  await RT.del(`/api/races/${selectedRaceId}/personnel/${id}`);
  await loadPersonnel();
}

async function clearAllPersonnel() {
  const res = await RT.del(`/api/races/${selectedRaceId}/personnel`);
  if (res.ok) { await loadPersonnel(); RT.toast(`Cleared ${res.deleted} personnel`, 'ok'); }
  else RT.toast(res.error || 'Failed', 'warn');
}

// ── Network (race-scoped infrastructure: digipeaters, iGates, repeaters, beacons) ──
// This is distinct from the global "INFRASTRUCTURE" tab below (which lists every
// tracker_registry row seen via MQTT/APRS and assigns a tracker to a *person*).
// This tab manages infra_nodes: race-scoped devices that can be assigned to a
// station and pre-registered before they've ever beaconed.
let infraNodes = [];

function renderNetworkTab() {
  return `
  <div class="card">
    <h3>NETWORK <span class="text-dim">(digipeaters, iGates, repeaters &amp; beacons)</span></h3>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="primary" onclick="openInfraNodeModal()">+ REGISTER NODE</button>
    </div>
    <div id="network-list"></div>
  </div>`;
}

async function bindNetworkTab() {
  await loadStationsForNetwork();
  await loadInfraNodes();
}

// Stations are needed for the "assign to station" dropdown; loaded independently
// of loadPersonnel() so the NETWORK tab works even if PERSONNEL hasn't been visited.
async function loadStationsForNetwork() {
  if (!selectedRaceId) return;
  const sr = await RT.get(`/api/races/${selectedRaceId}/stations`);
  if (sr.ok) stations = sr.data;
}

const INFRA_HEALTH_LABEL = { ok: 'OK', stale: 'STALE', never_seen: 'NEVER SEEN' };

async function loadInfraNodes() {
  if (!selectedRaceId) return;
  const res = await RT.get(`/api/races/${selectedRaceId}/infrastructure`);
  infraNodes = res.ok ? res.data : [];
  const el = document.getElementById('network-list');
  if (!el) return;
  if (!infraNodes.length) { el.innerHTML = '<div class="text-dim" style="font-size:16px;padding:6px">No infrastructure registered yet.</div>'; return; }

  el.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr>
    <th>NAME</th><th>TYPE</th><th>STATION</th><th>NODE ID</th><th>BATTERY</th><th>LAST SEEN</th><th>HEALTH</th><th></th>
  </tr></thead><tbody>
    ${infraNodes.map(n => `<tr style="${n.health !== 'ok' ? 'opacity:0.6' : ''}">
      <td>${n.name}</td>
      <td class="text-dim">${n.node_type}</td>
      <td>${n.station_name || '<span class="text-dim">— Unassigned —</span>'}</td>
      <td class="text-accent">${n.node_id || '<span class="text-dim">—</span>'}</td>
      <td>${n.battery_level != null ? RT.fmtBattery(n.battery_level) : '—'}</td>
      <td>${n.last_seen ? RT.timeAgo(n.last_seen) : '—'}</td>
      <td class="${n.health === 'stale' ? 'text-warn' : n.health === 'never_seen' ? 'text-dim' : 'text-accent2'}">${INFRA_HEALTH_LABEL[n.health]}</td>
      <td style="text-align:right">
        <button style="font-size:13px;padding:2px 8px" onclick="openInfraNodeModal(${n.id})">EDIT</button>
        <button class="danger" style="font-size:13px;padding:2px 8px" onclick="deleteInfraNode(${n.id})">DEL</button>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

let editingInfraNodeId = null;

function openInfraNodeModal(id) {
  editingInfraNodeId = id || null;
  const n = id ? infraNodes.find(x => x.id === id) : null;
  document.getElementById('infra-node-modal-title').textContent = id ? 'EDIT INFRASTRUCTURE NODE' : 'NEW INFRASTRUCTURE NODE';
  document.getElementById('in-name').value    = n?.name    || '';
  document.getElementById('in-type').value    = n?.node_type || 'repeater';
  document.getElementById('in-node-id').value = n?.node_id || '';
  document.getElementById('in-notes').value   = n?.notes   || '';
  const sel = document.getElementById('in-station-id');
  sel.innerHTML = '<option value="">— Unassigned —</option>' +
    stations.map(s => `<option value="${s.id}"${s.id === n?.station_id ? ' selected' : ''}>${s.name}</option>`).join('');
  document.getElementById('infra-node-modal').classList.remove('hidden');
  document.getElementById('in-name').focus();
}

async function saveInfraNode() {
  const name       = document.getElementById('in-name').value.trim();
  const node_type  = document.getElementById('in-type').value;
  const node_id    = document.getElementById('in-node-id').value.trim() || null;
  const station_id = document.getElementById('in-station-id').value || null;
  const notes      = document.getElementById('in-notes').value.trim() || null;
  if (!name) { RT.toast('Name required', 'warn'); return; }

  const body = { name, node_type, node_id, station_id: station_id ? parseInt(station_id) : null, notes };
  const res = editingInfraNodeId
    ? await RT.put(`/api/races/${selectedRaceId}/infrastructure/${editingInfraNodeId}`, body)
    : await RT.post(`/api/races/${selectedRaceId}/infrastructure`, body);

  if (res.ok) {
    closeModal('infra-node-modal');
    await loadInfraNodes();
    RT.toast(editingInfraNodeId ? 'Node updated' : 'Node registered', 'ok');
  } else RT.toast(res.error || 'Failed', 'warn');
}

async function deleteInfraNode(id) {
  const res = await RT.del(`/api/races/${selectedRaceId}/infrastructure/${id}`);
  if (res.ok) await loadInfraNodes();
  else RT.toast(res.error || 'Failed', 'warn');
}

// ── Infrastructure ────────────────────────────────────────────────────────────
function renderInfraTab() {
  return `
  <div class="card">
    <h3>TRACKER REGISTRY <span class="text-dim">(all nodes seen via MQTT or APRS)</span></h3>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <button onclick="purgeTrackers()" style="font-size:14px;padding:4px 12px;background:var(--surface2);border:1px solid var(--border);color:var(--accent3);border-radius:4px;cursor:pointer">PURGE OLDER THAN</button>
      <input id="purge-hours" type="number" min="1" value="24" style="width:56px;text-align:right">
      <span style="font-size:14px;color:var(--text3)">hours</span>
    </div>
    <div id="infra-list"><div class="text-dim" style="font-size:16px;padding:6px">Loading...</div></div>
  </div>`;
}

let _assignNodeId = null, _assignLongName = null;
let _infraPeople = []; // [{id, name, type, tracker_id}]

async function refreshInfra() {
  const [res, ptRes, pnlRes] = await Promise.all([
    RT.get('/api/trackers'),
    selectedRaceId ? RT.get(`/api/races/${selectedRaceId}/participants`) : Promise.resolve({ ok: false }),
    selectedRaceId ? RT.get(`/api/races/${selectedRaceId}/personnel`)    : Promise.resolve({ ok: false }),
  ]);
  const el = document.getElementById('infra-list');
  if (!el || !res.ok) return;

  _infraPeople = [
    ...(ptRes.ok  ? ptRes.data.map(p  => ({ id: p.id,  name: p.name,  type: 'participant', tracker_id: p.tracker_id  })) : []),
    ...(pnlRes.ok ? pnlRes.data.map(p => ({ id: p.id,  name: p.name,  type: 'personnel',   tracker_id: p.tracker_id  })) : []),
  ];

  const trackers = res.data;
  if (!trackers.length) { el.innerHTML = '<div class="text-dim" style="font-size:16px;padding:6px">No trackers seen yet.</div>'; return; }
  const now = Math.floor(Date.now() / 1000);
  const missingTimer = (races.find(r=>r.id===activeRaceId))?.missing_timer || 3600;

  const assignedCol = selectedRaceId ? '<th>ASSIGNED TO</th>' : '';
  el.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>NODE ID</th><th>LONG NAME</th><th>SHORT</th><th>BATTERY</th><th>LAST SEEN</th><th>POSITION</th>${assignedCol}</tr></thead><tbody>
    ${trackers.map(t => {
      const missing = t.last_seen && (now - t.last_seen) > missingTimer;
      const age = RT.timeAgo(t.last_seen);
      let assignCell = '';
      if (selectedRaceId) {
        const person = _infraPeople.find(p => p.tracker_id && (p.tracker_id === t.node_id || p.tracker_id === t.long_name));
        assignCell = person
          ? `<td><span style="color:var(--accent2)">${person.name}</span> <span class="text-dim" style="font-size:13px">${person.type === 'participant' ? 'racer' : 'crew'}</span></td>`
          : `<td><a href="#" style="font-size:13px;color:var(--accent4)" onclick="openAssignPicker('${t.node_id}','${(t.long_name||'').replace(/'/g,"\\'")}');return false">ASSIGN</a></td>`;
      }
      return `<tr style="${missing?'opacity:0.45':''}">
        <td class="text-accent">${t.node_id}</td>
        <td>${t.long_name||'—'}</td>
        <td>${t.short_name||'—'}</td>
        <td>${t.battery_level!=null?RT.fmtBattery(t.battery_level):'—'}</td>
        <td class="${missing?'text-warn':''}">${age}</td>
        <td class="text-dim">${t.last_lat?`${t.last_lat.toFixed(4)}, ${t.last_lon.toFixed(4)}`:'—'}</td>
        ${assignCell}
      </tr>`;
    }).join('')}
  </tbody></table></div>`;
}

function openAssignPicker(nodeId, longName) {
  _assignNodeId = nodeId;
  _assignLongName = longName;
  const nodeEl = document.getElementById('assign-modal-node');
  if (nodeEl) nodeEl.textContent = `Node: ${longName || nodeId}`;
  const sel = document.getElementById('assign-person-sel');
  if (!sel) return;
  const unassigned = _infraPeople.filter(p => !p.tracker_id);
  sel.innerHTML = unassigned.length
    ? unassigned.map(p => `<option value="${p.type}:${p.id}">${p.name} (${p.type === 'participant' ? 'racer' : 'crew'})</option>`).join('')
    : '<option value="">— No unassigned people —</option>';
  document.getElementById('assign-modal').classList.remove('hidden');
}

async function confirmAssignTracker() {
  const sel = document.getElementById('assign-person-sel');
  if (!sel?.value) return;
  const [type, idStr] = sel.value.split(':');
  const id = parseInt(idStr);
  const url = type === 'participant'
    ? `/api/races/${selectedRaceId}/participants/${id}`
    : `/api/races/${selectedRaceId}/personnel/${id}`;
  const res = await RT.put(url, { tracker_id: _assignNodeId });
  if (res.ok) {
    RT.toast('Tracker assigned', 'ok');
    closeModal('assign-modal');
    await refreshInfra();
  } else {
    RT.toast(res.error || 'Assignment failed', 'warn');
  }
}

async function purgeTrackers() {
  const hours = parseFloat(document.getElementById('purge-hours')?.value);
  if (!hours || hours <= 0) { RT.toast('Enter a valid number of hours', 'warn'); return; }
  const res = await RT.del(`/api/trackers?olderThan=${hours}`);
  if (res.ok) {
    RT.toast(`Purged ${res.deleted} node(s)`, 'ok');
    refreshInfra();
  } else {
    RT.toast(res.error || 'Purge failed', 'warn');
  }
}

// ── Users ─────────────────────────────────────────────────────────────────────
let users = [];
function renderUsersTab() {
  return `
  <div class="card">
    <h3>USER MANAGEMENT</h3>
    <button class="primary" onclick="openUserModal()" style="margin-bottom:10px">+ NEW USER</button>
    <div id="users-list"></div>
  </div>`;
}

function aprsPasscode(callsign) {
  const base = callsign.toUpperCase().split('-')[0];
  let hash = 0x73e2;
  for (let i = 0; i < base.length; i += 2) {
    hash ^= base.charCodeAt(i) << 8;
    if (i + 1 < base.length) hash ^= base.charCodeAt(i + 1);
  }
  return hash & 0x7fff;
}

function umUpdatePasscode() {
  const val = document.getElementById('um-callsign').value.trim();
  const el = document.getElementById('um-passcode');
  el.textContent = val ? aprsPasscode(val) : '—';
}

function umUpdatePreview() {
  const color = document.getElementById('um-color')?.value || '#f5a623';
  const shape = document.getElementById('um-shape')?.value || 'triangle';
  const el = document.getElementById('um-icon-preview');
  if (el) el.innerHTML = RT.SHAPES[shape]?.(color, 24) || '';
}

async function loadUsers() {
  const res = await RT.get('/api/users');
  users = res.ok ? res.data : [];
  const el = document.getElementById('users-list');
  if (!el) return;
  el.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>USERNAME</th><th>ROLE</th><th>CALLSIGN</th><th>PHONE</th><th>MARKER</th><th>CREATED</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr>
      <td>${u.username}${u.id===currentUser.id?' <span class="text-dim">(you)</span>':''}</td>
      <td><span class="badge" style="color:${u.role==='admin'?'var(--accent3)':u.role==='station'?'var(--accent2)':'var(--accent)'}">${u.role.toUpperCase()}</span></td>
      <td style="font-size:13px;color:var(--accent2)">${u.callsign || '<span class="text-dim">—</span>'}</td>
      <td style="font-size:13px">${u.phone || '<span class="text-dim">—</span>'}</td>
      <td>${RT.SHAPES[u.shape]?.(u.color, 18) || '<span class="text-dim">—</span>'}</td>
      <td class="text-dim">${new Date(u.created_at*1000).toLocaleDateString()}</td>
      <td style="text-align:right">
        <button style="font-size:13px;padding:2px 8px" onclick="openUserModal(${u.id})">EDIT</button>
        ${u.id!==currentUser.id?`<button class="danger" style="font-size:13px;padding:2px 8px" onclick="deleteUser(${u.id})">DEL</button>`:''}
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function openUserModal(id) {
  editingUserId = id || null;
  const user = id ? users.find(u => u.id === id) : null;
  document.getElementById('user-modal-title').textContent = id ? 'EDIT USER' : 'NEW USER';
  document.getElementById('um-username').value = user?.username || '';
  document.getElementById('um-password').value = '';
  document.getElementById('um-role').value = user?.role || 'station';
  document.getElementById('um-callsign').value = user?.callsign || '';
  document.getElementById('um-phone').value = user?.phone || '';
  document.getElementById('um-color').value = user?.color || '#f5a623';
  document.getElementById('um-shape').value = user?.shape || 'triangle';
  umUpdatePasscode();
  umUpdatePreview();
  document.getElementById('user-modal').classList.remove('hidden');
}

async function saveUser() {
  const username = document.getElementById('um-username').value.trim();
  const password = document.getElementById('um-password').value;
  const role     = document.getElementById('um-role').value;
  const callsign = document.getElementById('um-callsign').value.trim().toUpperCase() || null;
  const phone    = document.getElementById('um-phone').value.trim() || null;
  const color    = document.getElementById('um-color').value || '#f5a623';
  const shape    = document.getElementById('um-shape').value || 'triangle';
  if (!username) { RT.toast('Username required', 'warn'); return; }
  if (!editingUserId && !password) { RT.toast('Password required for new user', 'warn'); return; }
  const body = { username, role, callsign, phone, color, shape };
  if (password) body.password = password;
  const res = editingUserId
    ? await RT.put(`/api/users/${editingUserId}`, body)
    : await RT.post('/api/users', body);
  if (res.ok) { closeModal('user-modal'); await loadUsers(); RT.toast('User saved', 'ok'); }
  else RT.toast(res.error, 'warn');
}

async function deleteUser(id) {
  await RT.del(`/api/users/${id}`);
  await loadUsers();
}

// ── Settings ──────────────────────────────────────────────────────────────────
function renderSettingsTab() {
  return `
  <div style="font-size:13px;color:var(--text3);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-bottom:10px">
    &#9432; Enable / disable each datasource below. If a race is activated with participant tracker IDs that don't have a matching enabled datasource, a warning will appear at that time.
  </div>
  <div class="card">
    <h3>MESHTASTIC / MQTT</h3>
    <div class="form-row">
      <div class="form-group"><label>BROKER HOST</label><input id="s-mqtt-host" placeholder="apps.k7swi.org"></div>
      <div class="form-group">
        <label>PROTOCOL</label>
        <select id="s-mqtt-protocol" onchange="updateMqttPortDefault()">
          <option value="tcp">TCP (mqtt://)</option>
          <option value="ws">WebSocket (ws://)</option>
        </select>
      </div>
      <div class="form-group"><label>PORT</label><input id="s-mqtt-port" type="number" value="1883"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>USERNAME</label><input id="s-mqtt-user" placeholder="racetracker"></div>
      <div class="form-group"><label>PASSWORD</label><input id="s-mqtt-pass" type="password" autocomplete="new-password"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>REGION</label><input id="s-mqtt-region" placeholder="US"></div>
      <div class="form-group"><label>CHANNEL</label><input id="s-mqtt-channel" placeholder="CourseSentry"></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>PSK (base64) <span class="text-dim">for encrypted protobuf</span></label>
        <input id="s-mqtt-psk" placeholder="AQ==">
      </div>
    </div>
    <div style="font-size:13px;color:var(--text3);margin-top:2px">
      Both JSON (<code>msh/{region}/2/json/{channel}/#</code>) and encrypted protobuf (<code>msh/{region}/2/e/{channel}/#</code>) are subscribed automatically.
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="primary" onclick="saveMqttSettings()">SAVE</button>
      <button onclick="testMqtt()" id="s-mqtt-test-btn">TEST CONNECTION</button>
      <span id="s-mqtt-status" style="font-size:14px;align-self:center;color:var(--text3)"></span>
    </div>
  </div>

  <div class="card">
    <h3>APRS-IS</h3>
    <div class="form-row">
      <div class="form-group"><label>CALLSIGN</label><input id="s-aprs-callsign" placeholder="K7SWI" oninput="this.value=this.value.toUpperCase()"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>SERVER</label><input id="s-aprs-server" placeholder="rotate.aprs2.net"></div>
      <div class="form-group"><label>PORT</label><input id="s-aprs-port" type="number" value="14580"></div>
    </div>
    <div style="margin:8px 0 4px">
      <label style="font-size:14px;letter-spacing:1px;color:var(--text3)">SERVER FILTER</label>
    </div>
    <div style="display:flex;gap:16px;margin-bottom:6px">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:16px">
        <input type="radio" name="aprs-filter" id="s-aprs-filter-location" value="location" onchange="updateAprsFilterPreview()" checked>
        By location <span class="text-dim">(auto-compute center + radius of course)</span>
      </label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:16px">
        <input type="radio" name="aprs-filter" id="s-aprs-filter-callsign" value="callsign" onchange="updateAprsFilterPreview()">
        By callsign <span class="text-dim">(auto-collect tracker IDs from participants &amp; personnel)</span>
      </label>
    </div>
    <div style="font-size:13px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:6px 10px;font-family:monospace;color:var(--accent4)" id="aprs-filter-preview">
      Previewing filter…
    </div>
    <div style="margin-top:10px">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:16px">
        <input type="checkbox" id="s-aprs-igate-enabled">
        Enable RF→APRS-IS Igate
      </label>
      <div style="font-size:13px;color:var(--text3);margin-top:3px;margin-left:24px">
        Forwards TNC-received packets to APRS-IS. Requires a valid callsign with a verified (authenticated) APRS-IS connection.
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="primary" onclick="saveAprsSettings()">SAVE</button>
      <button onclick="testAprs()" id="s-aprs-test-btn">TEST</button>
      <span id="s-aprs-status" style="font-size:14px;align-self:center;color:var(--text3)"></span>
    </div>
  </div>

  <div class="card">
    <h3>OPENWEATHER</h3>
    <div class="form-group" style="max-width:400px">
      <label>API KEY</label>
      <input id="settings-weather-key" placeholder="Paste OpenWeather API key here">
    </div>
    <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
      <button class="primary" onclick="saveWeatherSettings()">SAVE</button>
      <button onclick="testWeather()" id="s-weather-test-btn">TEST KEY</button>
      <span id="s-weather-status" style="font-size:14px;color:var(--text3)"></span>
    </div>
  </div>

  `;
}

function updateMqttPortDefault() {
  const proto = document.getElementById('s-mqtt-protocol')?.value;
  const portEl = document.getElementById('s-mqtt-port');
  if (!portEl) return;
  const cur = parseInt(portEl.value);
  if (proto === 'ws' && (cur === 1883 || !cur)) portEl.value = '9001';
  else if (proto === 'tcp' && (cur === 9001 || !cur)) portEl.value = '1883';
}

async function bindSettingsTab() {
  const [sRes, aprsRes] = await Promise.all([RT.get('/api/settings'), RT.get('/api/aprs/status')]);
  if (!sRes.ok) return;
  const s = sRes.data;

  document.getElementById('s-mqtt-host').value         = s.mqtt_host || '';
  document.getElementById('s-mqtt-protocol').value     = s.mqtt_protocol || 'tcp';
  document.getElementById('s-mqtt-port').value         = s.mqtt_port || s.mqtt_port_ws || (s.mqtt_protocol === 'ws' ? '9001' : '1883');
  document.getElementById('s-mqtt-user').value         = s.mqtt_user || '';
  document.getElementById('s-mqtt-pass').value         = s.mqtt_pass || '';
  document.getElementById('s-mqtt-region').value       = s.mqtt_region || '';
  document.getElementById('s-mqtt-channel').value      = s.mqtt_channel || '';
  document.getElementById('s-mqtt-psk').value          = s.mqtt_psk || '';
  document.getElementById('s-aprs-callsign').value   = s.aprs_callsign || '';
  document.getElementById('s-aprs-server').value     = s.aprs_server || 'rotate.aprs2.net';
  document.getElementById('s-aprs-port').value       = s.aprs_port || '14580';
  const filterType = s.aprs_filter_type || 'location';
  document.getElementById(`s-aprs-filter-${filterType}`).checked = true;
  document.getElementById('s-aprs-igate-enabled').checked = s.aprs_igate_enabled === '1';

  document.getElementById('settings-weather-key').value = s.weather_api_key || '';

  if (aprsRes.ok) updateAprsPill(aprsRes.data);
  await updateAprsFilterPreview();
}

async function saveMqttSettings() {
  const res = await RT.put('/api/settings', {
    mqtt_host:       document.getElementById('s-mqtt-host').value.trim() || null,
    mqtt_protocol:   document.getElementById('s-mqtt-protocol').value,
    mqtt_port:       document.getElementById('s-mqtt-port').value || '1883',
    mqtt_user:       document.getElementById('s-mqtt-user').value.trim() || null,
    mqtt_pass:       document.getElementById('s-mqtt-pass').value || null,
    mqtt_region:     document.getElementById('s-mqtt-region').value.trim() || null,
    mqtt_channel:    document.getElementById('s-mqtt-channel').value.trim() || null,
    mqtt_psk:        document.getElementById('s-mqtt-psk').value.trim() || null,
  });
  if (res.ok) RT.toast('MQTT settings saved', 'ok');
  else RT.toast(res.error, 'warn');
}

async function saveAprsSettings() {
  const filterType = document.querySelector('input[name="aprs-filter"]:checked')?.value || 'location';
  const res = await RT.put('/api/settings', {
    aprs_callsign:    document.getElementById('s-aprs-callsign').value.trim().toUpperCase() || null,
    aprs_passcode:    '-1',
    aprs_server:      document.getElementById('s-aprs-server').value.trim() || 'rotate.aprs2.net',
    aprs_port:        document.getElementById('s-aprs-port').value || '14580',
    aprs_filter_type: filterType,
    aprs_igate_enabled: document.getElementById('s-aprs-igate-enabled').checked ? '1' : '0',
  });
  if (res.ok) RT.toast('APRS-IS settings saved', 'ok');
  else RT.toast(res.error, 'warn');
}

async function saveWeatherSettings() {
  const res = await RT.put('/api/settings', {
    weather_api_key: document.getElementById('settings-weather-key').value.trim() || null,
  });
  if (res.ok) RT.toast('Weather settings saved', 'ok');
  else RT.toast(res.error, 'warn');
}

// kept for backward compat (MQTT test calls it)
async function saveSettings() { await saveMqttSettings(); }

async function testMqtt() {
  const btn = document.getElementById('s-mqtt-test-btn');
  const status = document.getElementById('s-mqtt-status');
  btn.disabled = true;
  status.textContent = 'Testing...';
  status.style.color = 'var(--text3)';
  await saveMqttSettings();
  const res = await RT.post('/api/settings/mqtt-test', {});
  btn.disabled = false;
  if (res.ok && res.data?.connected) {
    status.textContent = '✓ Connected';
    status.style.color = 'var(--accent2)';
  } else {
    status.textContent = '✗ Failed';
    status.style.color = 'var(--accent3)';
  }
}

function updateAprsPill(status) {
  const light = document.getElementById('aprs-light');
  if (!light) return;
  if (status.connected) {
    light.className = 'ds-light ds-light-ok';
    light.title = `APRS: Connected${status.server ? ' · ' + status.server : ''}`;
  } else if (status.enabled) {
    light.className = 'ds-light ds-light-error';
    light.title = 'APRS: Error — not connected';
  } else {
    light.className = 'ds-light ds-light-idle';
    light.title = 'APRS: Offline';
  }
}


async function testWeather() {
  const btn = document.getElementById('s-weather-test-btn');
  const span = document.getElementById('s-weather-status');
  btn.disabled = true;
  span.textContent = 'Testing…';
  span.style.color = 'var(--text3)';
  await saveWeatherSettings();
  const res = await RT.post('/api/weather/test', {});
  btn.disabled = false;
  if (res.ok) {
    span.textContent = '✓ API key valid';
    span.style.color = 'var(--accent2)';
    updateWeatherPill({ configured: true, ok: true });
  } else {
    span.textContent = `✗ ${res.error || 'Invalid key'}`;
    span.style.color = 'var(--accent3)';
    updateWeatherPill({ configured: true, ok: false });
  }
}

async function updateAprsFilterPreview() {
  const el = document.getElementById('aprs-filter-preview');
  if (!el) return;
  const type = document.querySelector('input[name="aprs-filter"]:checked')?.value || 'location';
  el.textContent = 'Computing…';
  const res = await RT.get(`/api/aprs/filter-preview?type=${type}`);
  if (res.ok) {
    el.textContent = res.filter
      ? `#filter ${res.filter}`
      : '(no active race or track data — no filter will be applied)';
  } else {
    el.textContent = 'Error computing filter';
  }
}

async function testAprs() {
  const btn = document.getElementById('s-aprs-test-btn');
  const status = document.getElementById('s-aprs-status');
  btn.disabled = true;
  status.textContent = 'Testing…';
  status.style.color = 'var(--text3)';
  await saveAprsSettings();
  const res = await RT.post('/api/aprs/connect', {});
  btn.disabled = false;
  if (res.ok && res.data?.connected) {
    status.textContent = '✓ Connected';
    status.style.color = 'var(--accent2)';
    updateAprsPill(res.data);
  } else {
    status.textContent = '✗ Not connected — check logs';
    status.style.color = 'var(--accent3)';
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-bg:not(.hidden)').forEach(m => m.classList.add('hidden'));
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    const modal = e.target.closest('.modal-bg');
    if (!modal) return;
    if (modal.id === 'participant-modal') saveParticipant();
    if (modal.id === 'personnel-modal' && editingPersonnelId)  savePersonnel();
    if (modal.id === 'station-modal')    saveStation();
    if (modal.id === 'user-modal')       saveUser();
    if (modal.id === 'infra-node-modal') saveInfraNode();
  }
});

// Bind heat preview updates
document.addEventListener('change', e => {
  if (e.target.id === 'hm-color' || e.target.id === 'hm-shape') updateHeatPreview();
  if (e.target.id === 'rm-aprs-enabled' || e.target.id === 'rm-tnc-enabled') _updateCallsignRequired();
});

// ── Logs Tab ──────────────────────────────────────────────────────────────────
const LOG_CHANNELS = ['mqtt', 'aprs', 'tnc', 'race', 'system', 'console'];
const LOG_LEVEL_COLORS = { info: 'var(--text)', warn: '#d2a679', error: '#f78166', debug: 'var(--text3)' };
let logsChannel = 'mqtt';
let logsPaused = false;

function renderLogsTab() {
  return `
  <div class="card" style="padding:12px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <span style="font-size:14px;letter-spacing:1px;color:var(--text3)">CHANNEL</span>
      ${LOG_CHANNELS.map(c => `<button id="log-ch-${c}" class="log-ch-btn${c===logsChannel?' active':''}" onclick="setLogChannel('${c}')">${c.toUpperCase()}</button>`).join('')}
      <div style="flex:1"></div>
      <button id="log-pause-btn" onclick="toggleLogPause()" style="font-size:13px;padding:3px 10px">${logsPaused?'RESUME':'PAUSE'}</button>
      <button onclick="clearLogView()" style="font-size:13px;padding:3px 10px">CLEAR VIEW</button>
      <button onclick="loadLogs()" style="font-size:13px;padding:3px 10px">REFRESH</button>
    </div>
    <div id="log-stream" style="font-family:monospace;font-size:14px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px;height:520px;overflow-y:auto;display:flex;flex-direction:column;gap:2px"></div>
  </div>`;
}

function bindLogsTab() {
  loadLogs();
}

async function loadLogs() {
  const res = await RT.get(`/api/logs?channel=${logsChannel}&limit=500`);
  if (!res.ok) return;
  const el = document.getElementById('log-stream');
  if (!el) return;
  el.innerHTML = '';
  for (const entry of res.data) el.appendChild(buildLogRow(entry));
  el.scrollTop = el.scrollHeight;
}

const LOG_SOURCE_COLORS = { 'APRS-IS': '#58a6ff', TNC: '#3fb950' };
function _sourceColor(src) {
  if (!src) return 'var(--text3)';
  if (src.startsWith('TNC')) return LOG_SOURCE_COLORS.TNC;
  return LOG_SOURCE_COLORS[src] || 'var(--text3)';
}

function buildLogRow(entry) {
  const d = new Date(entry.ts * 1000);
  const time = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const color = LOG_LEVEL_COLORS[entry.level] || 'var(--text)';
  const src = entry.source || '';
  const srcBadge = src
    ? `<span style="color:${_sourceColor(src)};min-width:72px;font-size:12px;letter-spacing:.5px">[${src}]</span>`
    : `<span style="min-width:72px"></span>`;
  const row = document.createElement('div');
  row.style.cssText = `display:flex;gap:8px;padding:2px 4px;border-radius:3px;line-height:1.5`;
  row.innerHTML = `<span style="color:var(--text3);min-width:64px">${time}</span>`
    + `<span style="color:var(--accent4);min-width:48px">${(entry.level||'info').toUpperCase()}</span>`
    + srcBadge
    + `<span style="color:${color};word-break:break-all">${entry.msg}</span>`;
  return row;
}

function appendLogEntry(entry) {
  if (logsPaused) return;
  if (entry.channel !== logsChannel) return;
  const el = document.getElementById('log-stream');
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.appendChild(buildLogRow(entry));
  if (atBottom) el.scrollTop = el.scrollHeight;
  // Trim to 1000 rows in view
  while (el.children.length > 1000) el.removeChild(el.firstChild);
}

function setLogChannel(ch) {
  logsChannel = ch;
  document.querySelectorAll('.log-ch-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`log-ch-${ch}`);
  if (btn) btn.classList.add('active');
  loadLogs();
}

function toggleLogPause() {
  logsPaused = !logsPaused;
  const btn = document.getElementById('log-pause-btn');
  if (btn) btn.textContent = logsPaused ? 'RESUME' : 'PAUSE';
}

function clearLogView() {
  const el = document.getElementById('log-stream');
  if (el) el.innerHTML = '';
}

function goToRFAnalysis() {
  const url = RT.BASE + 'rf-analysis.html' + (activeRaceId ? `?race=${activeRaceId}` : '');
  window.location.href = url;
}

function openAdminHelp() {
  const map = {
    races: '#new-race', courses: '#course-setup', course: '#course-setup',
    participants: '#participants', heats: '#participants',
    personnel: '#new-race', infra: '#tracker-setup',
    settings: '#tracker-setup', logs: '#overview', users: '#overview'
  };
  window.open(RT.BASE + 'help.html' + (map[currentTab] || '#overview'));
}

init();
