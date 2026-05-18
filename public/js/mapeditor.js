'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const TRACK_COLOR   = '#f5a623';
const MAX_EDIT_PTS  = 1400; // above this, downsample before making editable

const BASE_LAYERS = {
  'Topo':      { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',        opts: { maxZoom: 16, maxNativeZoom: 16, attribution: 'USGS' } },
  'Satellite': { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 16, maxNativeZoom: 16, attribution: 'USGS' } },
  'Street':    { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',                                              opts: { maxZoom: 19, attribution: '© OpenStreetMap' } },
  'Dark':      { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',                                  opts: { maxZoom: 19, attribution: '© CartoDB' } },
};

// ── State ─────────────────────────────────────────────────────────────────────

let courseId = null;
let courseMeta = null;           // course row from /api/courses
let rawTrackPoints = [];         // original points as loaded from server
let waypoints = [];              // [{name, lat, lon}]

let map = null;
let routeLayer = null;           // L.Polyline — the editable track
let waypointMarkers = [];        // L.Marker array for waypoints
let baseTiles = {};

let dirty = false;
let addingWaypointMode = false;

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const user = await RT.requireLogin('admin');
  if (!user) return;

  const params = new URLSearchParams(location.search);
  courseId = params.get('courseId');
  if (!courseId) {
    setPill('NO COURSE ID', 'pill-error');
    return;
  }

  initMap();

  // Load course file list (for name) and parsed geometry in parallel
  const [listRes, parseRes] = await Promise.all([
    RT.get('/api/courses'),
    RT.get(`/api/courses/${courseId}/parse`),
  ]);

  if (!parseRes.ok) {
    RT.toast(`Failed to load course: ${parseRes.error}`, 'warn');
    setPill(`Error: ${parseRes.error}`, 'pill-error');
    return;
  }

  courseMeta = listRes.ok ? (listRes.data || []).find(c => String(c.id) === String(courseId)) : null;
  rawTrackPoints = parseRes.data.trackPoints || [];
  waypoints = (parseRes.data.points || []).map(w => ({ name: w.name, lat: w.lat, lon: w.lon }));

  const name = courseMeta?.name || `Course ${courseId}`;
  setPill(name, 'pill-ok');
  document.title = `RT — Edit: ${name}`;
  document.getElementById('me-save-btn').disabled = false;

  if (rawTrackPoints.length > MAX_EDIT_PTS) {
    showBanner(
      `This track has ${rawTrackPoints.length.toLocaleString()} points. ` +
      `The editable layer uses a simplified version (~${MAX_EDIT_PTS} pts). ` +
      `Saving will replace the original file with the simplified geometry.`
    );
  }

  renderTrack();
  renderWaypoints();
  updateStatusBar();

  window.addEventListener('beforeunload', e => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ── Map setup ─────────────────────────────────────────────────────────────────

function initMap() {
  map = L.map('me-map', { zoomControl: true });

  for (const [name, cfg] of Object.entries(BASE_LAYERS)) {
    baseTiles[name] = L.tileLayer(cfg.url, cfg.opts);
  }
  baseTiles['Topo'].addTo(map); // default matches the select default option

  map.setView([39.5, -98.35], 4); // CONUS fallback until track loads

  // Geoman toolbar — edit-vertices only
  map.pm.addControls({
    position:          'topleft',
    drawMarker:        false,
    drawCircle:        false,
    drawCircleMarker:  false,
    drawPolyline:      false,
    drawRectangle:     false,
    drawPolygon:       false,
    drawText:          false,
    editMode:          true,
    dragMode:          false,
    cutPolygon:        false,
    removalMode:       false,
    rotateMode:        false,
  });

  map.on('pm:globaleditmodetoggled', e => {
    setModeStatus(e.enabled ? 'EDITING TRACK — drag vertices, click edge to insert, right-click to remove' : '');
  });

  // Click handler for "add waypoint" mode
  map.on('click', e => {
    if (!addingWaypointMode) return;
    const wpt = { name: 'Waypoint', lat: e.latlng.lat, lon: e.latlng.lng };
    waypoints.push(wpt);
    const marker = createWaypointMarker(wpt);
    waypointMarkers.push(marker);
    setAddingWaypoint(false);
    updateStatusBar();
    setDirty(true);
    openWaypointPopup(marker, wpt);
  });
}

// ── Track rendering ───────────────────────────────────────────────────────────

function downsampleForEdit(pts, maxPts) {
  if (pts.length <= maxPts) return pts;
  const step = Math.ceil(pts.length / maxPts);
  const out = [pts[0]];
  for (let i = step; i < pts.length - 1; i += step) out.push(pts[i]);
  out.push(pts[pts.length - 1]);
  return out;
}

function renderTrack() {
  if (routeLayer) map.removeLayer(routeLayer);

  const editPts = downsampleForEdit(rawTrackPoints, MAX_EDIT_PTS);
  if (!editPts.length) return;

  routeLayer = L.polyline(
    editPts.map(p => [p[0], p[1]]),
    { color: TRACK_COLOR, weight: 5, opacity: 0.85 }
  ).addTo(map);

  map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });

  // Wire up Geoman change events so status bar stays accurate
  routeLayer.on('pm:edit',          onTrackEdited);
  routeLayer.on('pm:vertexadded',   onTrackEdited);
  routeLayer.on('pm:vertexremoved', onTrackEdited);
}

function onTrackEdited() {
  setDirty(true);
  updateStatusBar();
}

// ── Waypoint rendering ────────────────────────────────────────────────────────

function renderWaypoints() {
  waypointMarkers.forEach(m => map.removeLayer(m));
  waypointMarkers = [];
  waypoints.forEach(wpt => waypointMarkers.push(createWaypointMarker(wpt)));
}

function createWaypointMarker(wpt) {
  const marker = L.marker([wpt.lat, wpt.lon], { draggable: true })
    .addTo(map)
    .bindTooltip(wpt.name || 'Waypoint', { className: 'me-wpt-tooltip', permanent: false, direction: 'top' });

  marker.on('dragend', () => {
    const ll = marker.getLatLng();
    wpt.lat = ll.lat;
    wpt.lon = ll.lng;
    setDirty(true);
    updateStatusBar();
  });

  marker.on('click', () => openWaypointPopup(marker, wpt));
  marker._wptData = wpt;
  return marker;
}

function openWaypointPopup(marker, wpt) {
  // Close any open popup first
  map.closePopup();

  const container = document.createElement('div');
  container.className = 'me-wpt-popup';
  container.innerHTML = `
    <label>WAYPOINT NAME</label>
    <input type="text" id="me-wpt-name-inp" value="${(wpt.name || '').replace(/"/g, '&quot;')}" autocomplete="off">
    <div class="me-wpt-popup-actions">
      <button class="button primary" id="me-wpt-ok">OK</button>
      <button class="button" style="color:var(--accent3)" id="me-wpt-del">DEL</button>
    </div>
  `;

  const popup = L.popup({ maxWidth: 260 })
    .setLatLng(marker.getLatLng())
    .setContent(container)
    .openOn(map);

  // Bind after popup is in DOM
  setTimeout(() => {
    const inp = document.getElementById('me-wpt-name-inp');
    const ok  = document.getElementById('me-wpt-ok');
    const del = document.getElementById('me-wpt-del');
    if (!inp) return;
    inp.focus();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok.click(); });
    ok.addEventListener('click', () => {
      const name = inp.value.trim() || 'Waypoint';
      wpt.name = name;
      marker.setTooltipContent(name);
      popup.close();
      setDirty(true);
    });
    del.addEventListener('click', () => {
      popup.close();
      map.removeLayer(marker);
      waypointMarkers = waypointMarkers.filter(m => m !== marker);
      waypoints = waypoints.filter(w => w !== wpt);
      setDirty(true);
      updateStatusBar();
    });
  }, 0);
}

// ── Add-waypoint mode ─────────────────────────────────────────────────────────

function setAddingWaypoint(active) {
  addingWaypointMode = active;
  map.getContainer().style.cursor = active ? 'crosshair' : '';
  setModeStatus(active ? 'CLICK MAP TO PLACE WAYPOINT  (Esc to cancel)' : '');
}

// Allow Esc to cancel add-waypoint mode
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && addingWaypointMode) setAddingWaypoint(false);
});

// ── Status bar & UI helpers ───────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function collectTrackPoints() {
  if (!routeLayer) return [];
  const lls = routeLayer.getLatLngs();
  // Geoman may return flat or nested array
  const flat = Array.isArray(lls[0]) ? lls.flat(Infinity) : lls;
  return flat.map(ll => [
    typeof ll.lat === 'number' ? ll.lat : ll[0],
    typeof ll.lng === 'number' ? ll.lng : ll[1],
  ]);
}

function updateStatusBar() {
  const pts = collectTrackPoints();
  let dist = 0;
  for (let i = 1; i < pts.length; i++) {
    dist += haversine(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]);
  }
  document.getElementById('me-stat-pts').textContent   = `${pts.length.toLocaleString()} pts`;
  document.getElementById('me-stat-dist').textContent  = RT.fmtDist(dist);
  document.getElementById('me-stat-wpts').textContent  = `${waypoints.length} waypoint${waypoints.length !== 1 ? 's' : ''}`;
}

function setModeStatus(text) {
  const el  = document.getElementById('me-stat-mode');
  const sep = document.getElementById('me-stat-mode-sep');
  el.textContent   = text;
  sep.style.display = text ? '' : 'none';
}

function setDirty(d) {
  dirty = d;
  document.getElementById('me-unsaved').style.display = d ? '' : 'none';
}

function setPill(text, cls) {
  const el = document.getElementById('me-course-pill');
  el.textContent = text;
  el.className = `pill ${cls}`;
}

function showBanner(msg) {
  const b = document.getElementById('me-warn-banner');
  b.textContent = msg;
  b.style.display = '';
  setTimeout(() => { b.style.display = 'none'; }, 10000);
}

// ── Save & Cancel ─────────────────────────────────────────────────────────────

async function saveEdits() {
  // Commit any in-progress Geoman edit
  if (map.pm.globalEditModeEnabled()) map.pm.disableGlobalEditMode();

  const btn = document.getElementById('me-save-btn');
  btn.disabled = true;
  btn.textContent = 'SAVING...';

  const trackPts = collectTrackPoints();
  if (trackPts.length < 2) {
    RT.toast('Track must have at least 2 points', 'warn');
    btn.disabled = false;
    btn.textContent = 'SAVE';
    return;
  }

  const wpts = waypoints.map(w => ({ name: w.name, lat: w.lat, lon: w.lon }));
  const res = await RT.put(`/api/courses/${courseId}/geometry`, { trackPoints: trackPts, waypoints: wpts });

  btn.disabled = false;
  btn.textContent = 'SAVE';

  if (res.ok) {
    RT.toast('Course saved', 'ok');
    setDirty(false);
  } else {
    RT.toast(`Save failed: ${res.error}`, 'warn');
  }
}

function cancelEdits() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  // Page is opened in a new tab (target="_blank"), so close it.
  // If the browser blocks window.close() (e.g. navigated directly), fall back to admin.
  window.close();
  setTimeout(() => { window.location.href = RT.BASE + 'admin.html'; }, 300);
}

function setBaseLayer(name) {
  for (const [n, tile] of Object.entries(baseTiles)) {
    if (map.hasLayer(tile)) map.removeLayer(tile);
  }
  if (baseTiles[name]) baseTiles[name].addTo(map);
}

// ── Add Waypoint button (called from topbar) ──────────────────────────────────
// Exposed as globals so inline onclick handlers in the HTML can reach them.

window.saveEdits          = saveEdits;
window.cancelEdits        = cancelEdits;
window.setBaseLayer       = setBaseLayer;
window.toggleAddWaypoint  = function() { setAddingWaypoint(!addingWaypointMode); };

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
