'use strict';
// Shared map/course-progress logic between operator.js and mobileop.js.
//
// Both pages load this via a plain <script> tag (no bundler) between
// common.js and their own script, so functions are exposed as MapShared.*
// globals rather than an import.
//
// The course-progress functions (computePercent/computePace/etc.) take an
// explicit `ctx` ({ race, trackPoints, stations }) and a per-page-owned
// mutable `cache` ({ dists, totalDist, stationAlong }) object instead of
// reading module-scope globals, since operator.js and mobileop.js each keep
// their own race/trackPoints/stations state under different variable names.
// Reset a page's cache object (new {} ) any time trackPoints changes.
//
// Marker-rendering functions (renderStationMarkers/updateInfraMarkers/
// updatePersonnelMarkers/toggleInfra) take the page's map/layer/cache objects
// plus an `opts` object for the handful of things that legitimately differ
// between the admin-grade operator map and the lean field view (icon size,
// tooltip options, click callbacks). updateBaseLayerSelector/setBaseLayer and
// renderLeaderboard are NOT shared here — operator.js and mobileop.js use
// genuinely different tile-caching strategies and leaderboard data shapes
// (enriched participant objects vs. live heats/classes array lookups), so
// forcing them through a shared function would be papering over a real
// architectural difference rather than eliminating duplication.

const MapShared = (() => {

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // Course station types that count as "infrastructure" for the map's
  // Infrastructure toggle, alongside registered network nodes.
  function isInfraStationType(type) {
    return type === 'repeater' || type === 'netcontrol';
  }

  // ── Course-progress engine ────────────────────────────────────────────────
  function ensureDistCache(ctx, cache) {
    if (cache.dists || !ctx.trackPoints || ctx.trackPoints.length < 2) return;
    cache.dists = [0];
    for (let i = 1; i < ctx.trackPoints.length; i++)
      cache.dists.push(cache.dists[i - 1] + haversine(
        ctx.trackPoints[i - 1][0], ctx.trackPoints[i - 1][1], ctx.trackPoints[i][0], ctx.trackPoints[i][1]));
    cache.totalDist = cache.dists[cache.dists.length - 1];
  }

  function computeTotalDist(ctx, cache) {
    ensureDistCache(ctx, cache);
    return cache.totalDist || 0;
  }

  function getStationAlongMap(ctx, cache) {
    if (cache.stationAlong) return cache.stationAlong;
    if (!ctx.trackPoints || ctx.trackPoints.length < 2) return new Map();
    ensureDistCache(ctx, cache);
    cache.stationAlong = new Map();
    for (const s of ctx.stations) {
      if (!s.lat || !s.lon) continue;
      let minD = Infinity, best = 0;
      for (let i = 0; i < ctx.trackPoints.length - 1; i++) {
        const [lat1, lon1] = ctx.trackPoints[i], [lat2, lon2] = ctx.trackPoints[i + 1];
        const ax = s.lat - lat1, ay = s.lon - lon1, bx = lat2 - lat1, by = lon2 - lon1;
        const t = clamp01((ax * bx + ay * by) / Math.max(1e-10, bx * bx + by * by));
        const d = haversine(s.lat, s.lon, lat1 + t * bx, lon1 + t * by);
        if (d < minD) { minD = d; best = cache.dists[i] + t * (cache.dists[i + 1] - cache.dists[i]); }
      }
      cache.stationAlong.set(s.id, best);
    }
    return cache.stationAlong;
  }

  // Last manually-confirmed station fix for a participant, or null.
  function getManualFix(p, ctx, cache) {
    if (!p.last_station_id || !p.last_station_ts) return null;
    const along = getStationAlongMap(ctx, cache).get(p.last_station_id);
    if (along == null) return null;
    const stn = ctx.stations.find(s => s.id === p.last_station_id);
    return { along, ts: p.last_station_ts, lat: stn?.lat, lon: stn?.lon, station: stn };
  }

  const MAX_RACE_SPEED = 8, BACK_MARGIN = 100;

  // ctx: { race, trackPoints, stations }. cache: page-owned {} reset when
  // trackPoints changes. Mutates p._lastAlong/_lastAlongTs as a side effect
  // (both progress and pace need the same "along-course" anchor).
  function computePercent(p, ctx, cache) {
    if (p.status === 'finished') return 100;
    if (p.status === 'dns') return null;

    const hasGps = p.last_lat != null && p.last_lon != null;

    if (!hasGps) {
      // Manual-entry fallback: no GPS but a last confirmed station check-in.
      if (!ctx.trackPoints || !ctx.trackPoints.length) return null;
      const fix = getManualFix(p, ctx, cache);
      if (!fix) return null;
      ensureDistCache(ctx, cache);
      const totalDist = cache.totalDist;
      if (!totalDist) return null;
      const isOAB = ctx.race?.race_format === 'out_and_back';
      // Anchor the next GPS-based search window to this manual fix, so a
      // participant who gets a signal back doesn't have their along-course
      // position searched from scratch starting at 0.
      p._lastAlong = fix.along;
      p._lastAlongTs = fix.ts;
      if (isOAB) {
        if (p.has_turnaround) return Math.min(100, (2 * totalDist - fix.along) / (2 * totalDist) * 100);
        return Math.min(50, fix.along / (2 * totalDist) * 100);
      }
      return Math.min(100, fix.along / totalDist * 100);
    }

    if (!ctx.trackPoints || !ctx.trackPoints.length) return null;
    ensureDistCache(ctx, cache);
    const totalDist = cache.totalDist;
    if (totalDist === 0) return 0;

    // Constrain the nearest-point search to a window reachable given max race
    // speed since the last fix, instead of scanning the whole course each time.
    const now = Math.floor(Date.now() / 1000);
    const lastAlong = p._lastAlong ?? 0;
    const lastTs = p._lastAlongTs ?? (p.start_time || now);
    const travelDist = Math.max(0, now - lastTs) * MAX_RACE_SPEED + BACK_MARGIN;
    const windowMin = Math.max(0, lastAlong - travelDist);
    const windowMax = Math.min(totalDist, lastAlong + travelDist);

    let minD = Infinity, bestAlong = lastAlong;
    for (let i = 0; i < ctx.trackPoints.length - 1; i++) {
      if (cache.dists[i + 1] < windowMin || cache.dists[i] > windowMax) continue;
      const [lat1, lon1] = ctx.trackPoints[i], [lat2, lon2] = ctx.trackPoints[i + 1];
      const segLen = cache.dists[i + 1] - cache.dists[i];
      const ax = p.last_lat - lat1, ay = p.last_lon - lon1, bx = lat2 - lat1, by = lon2 - lon1;
      const t = clamp01((ax * bx + ay * by) / Math.max(1e-10, bx * bx + by * by));
      const d = haversine(p.last_lat, p.last_lon, lat1 + t * bx, lon1 + t * by);
      if (d < minD) { minD = d; bestAlong = cache.dists[i] + t * segLen; }
    }

    // Checkpoint floor prevents a backwards jump on the outbound leg only.
    if (!(ctx.race?.race_format === 'out_and_back' && p.has_turnaround))
      bestAlong = Math.max(bestAlong, p._stationFloor ?? 0);

    p._lastAlong = bestAlong;
    p._lastAlongTs = p.registry?.last_seen || now;

    if (ctx.race?.race_format === 'out_and_back') {
      if (p.has_turnaround) return Math.min(100, (2 * totalDist - bestAlong) / (2 * totalDist) * 100);
      return Math.min(50, bestAlong / (2 * totalDist) * 100);
    }
    return Math.min(100, bestAlong / totalDist * 100);
  }

  // Requires p._pct to already be set (call computePercent first) for the
  // GPS branch — mirrors the original per-participant call order.
  function computePace(p, ctx, cache) {
    if (!p.start_time) return null;

    if (p.status === 'finished' && p.finish_time) {
      const totalDist = computeTotalDist(ctx, cache);
      if (!totalDist) return null;
      const elapsed = p.finish_time - p.start_time;
      if (elapsed <= 0) return null;
      const dist = ctx.race?.race_format === 'out_and_back' ? totalDist * 2 : totalDist;
      return dist / elapsed; // m/s
    }

    if (p.last_lat != null && p.last_lon != null) {
      const pct = p._pct;
      if (pct == null || !ctx.trackPoints) return null;
      const elapsed = Math.floor(Date.now() / 1000) - p.start_time;
      if (elapsed <= 0) return null;
      let totalDist = computeTotalDist(ctx, cache);
      if (!totalDist) return null;
      if (ctx.race?.race_format === 'out_and_back') totalDist *= 2;
      return (pct / 100 * totalDist) / elapsed; // m/s
    }

    // Manual-entry fallback: pace from start_time to last confirmed station.
    const fix = getManualFix(p, ctx, cache);
    if (!fix || fix.along <= 0) return null;
    const elapsed = fix.ts - p.start_time;
    if (elapsed <= 0) return null;
    const isOAB = ctx.race?.race_format === 'out_and_back';
    const totalDist = computeTotalDist(ctx, cache);
    if (!totalDist) return null;
    const distCovered = (isOAB && p.has_turnaround) ? 2 * totalDist - fix.along : fix.along;
    return distCovered / elapsed; // m/s
  }

  // ── Station markers ───────────────────────────────────────────────────────
  function stationMarkerStyle(type, name) {
    const color = type === 'start' ? '#3fb950' : type === 'finish' ? '#f78166' :
                  type === 'start_finish' ? '#a371f7' : type === 'turnaround' ? '#58a6ff' :
                  type === 'netcontrol' ? '#d2993a' : type === 'repeater' ? '#6e7681' :
                  type === 'rover' ? '#c084fc' : '#d2a679';
    const letter = type === 'start' ? 'S' : type === 'finish' ? 'F' :
                   type === 'start_finish' ? '⇌' : type === 'turnaround' ? 'T' :
                   type === 'netcontrol' ? 'N' : type === 'repeater' ? 'R' :
                   type === 'rover' ? '⟳' : name?.[0]?.toUpperCase() || 'A';
    return { color, letter };
  }

  // stationMarkers: page-owned {id: marker} cache, mutated in place (cleared
  // and repopulated) so the caller's reference stays valid.
  function renderStationMarkers(stations, map, stationMarkers, opts = {}) {
    const {
      iconSize = 22, fontSize = 13, courierFont = true,
      tooltipOptions = { permanent: false, direction: 'top' },
      onClick, showInfraMarkers = false,
      fitBoundsIfNoRoute = false, trackPoints,
    } = opts;

    Object.values(stationMarkers).forEach(m => map.removeLayer(m));
    for (const k of Object.keys(stationMarkers)) delete stationMarkers[k];

    for (const s of stations) {
      const { color, letter } = stationMarkerStyle(s.type, s.name);
      const font = courierFont ? ";font-family:'Courier New'" : '';
      const icon = L.divIcon({
        html: `<div style="width:${iconSize}px;height:${iconSize}px;border-radius:50%;background:${color};border:2px solid #fff4;display:flex;align-items:center;justify-content:center;font-size:${fontSize}px;font-weight:bold;color:#000${font}">${letter}</div>`,
        className: '', iconAnchor: [iconSize / 2, iconSize / 2],
      });
      const marker = L.marker([s.lat, s.lon], { icon }).bindTooltip(s.name, tooltipOptions);
      marker._stnType = s.type;
      if (onClick) marker.on('click', () => onClick(s.id));
      if (!isInfraStationType(s.type) || showInfraMarkers) marker.addTo(map);
      stationMarkers[s.id] = marker;
    }

    if (fitBoundsIfNoRoute && stations.length && !trackPoints) {
      const bounds = L.latLngBounds(stations.map(s => [s.lat, s.lon]));
      map.fitBounds(bounds, { padding: [30, 30] });
    }
  }

  // ── Infrastructure markers ────────────────────────────────────────────────
  const INFRA_COLORS  = { digipeater: '#a371f7', igate: '#58a6ff', repeater: '#6e7681', beacon: '#3fb950', other: '#d2a679' };
  const INFRA_LETTERS = { digipeater: 'D', igate: 'I', repeater: 'R', beacon: 'B', other: '?' };

  function updateInfraMarkers(infraNodes, infraLayer, opts = {}) {
    const { courierFont = true, tooltipOptions = { permanent: false, direction: 'top' }, onClick } = opts;
    if (!infraLayer) return;
    for (const n of infraNodes) {
      if (n.resolved_lat == null || n.resolved_lon == null) {
        const ex = infraLayer.getLayers().find(m => m._infraId === n.id);
        if (ex) infraLayer.removeLayer(ex);
        continue;
      }
      const color = INFRA_COLORS[n.node_type] || INFRA_COLORS.other;
      const dim = n.health !== 'ok'; // stale or never_seen
      const font = courierFont ? ";font-family:'Courier New'" : '';
      const icon = L.divIcon({
        html: `<div style="width:20px;height:20px;border-radius:4px;background:${color};opacity:${dim ? 0.45 : 1};
                border:2px solid #fff4;display:flex;align-items:center;justify-content:center;
                font-size:11px;font-weight:bold;color:#000${font}">${INFRA_LETTERS[n.node_type] || '?'}</div>`,
        className: '', iconAnchor: [10, 10],
      });
      const healthNote = n.health !== 'ok' ? ` — ${n.health.replace('_', ' ')}` : '';
      const tooltip = `${n.name} (${n.node_type})${healthNote}`;
      const existing = infraLayer.getLayers().find(m => m._infraId === n.id);
      if (existing) {
        existing.setLatLng([n.resolved_lat, n.resolved_lon]);
        existing.setIcon(icon);
        existing.unbindTooltip();
        existing.bindTooltip(tooltip, tooltipOptions);
      } else {
        const m = L.marker([n.resolved_lat, n.resolved_lon], { icon });
        m._infraId = n.id;
        m.bindTooltip(tooltip, tooltipOptions);
        if (onClick) m.on('click', () => { if (n.station_id) onClick(n.station_id); });
        m.addTo(infraLayer);
      }
    }
    for (const m of [...infraLayer.getLayers()]) {
      if (!infraNodes.some(n => n.id === m._infraId)) infraLayer.removeLayer(m);
    }
  }

  function toggleInfra(on, map, infraLayer, stationMarkers) {
    const show = !!on;
    if (show) { if (!map.hasLayer(infraLayer)) infraLayer.addTo(map); }
    else if (map.hasLayer(infraLayer)) map.removeLayer(infraLayer);
    // Course stations of type repeater/netcontrol are infrastructure too, but
    // are plotted directly on the map — show/hide them alongside network nodes.
    for (const m of Object.values(stationMarkers)) {
      if (!isInfraStationType(m._stnType)) continue;
      if (show) { if (!map.hasLayer(m)) m.addTo(map); }
      else if (map.hasLayer(m)) map.removeLayer(m);
    }
    return show;
  }

  // ── Personnel markers ─────────────────────────────────────────────────────
  // geofenceRadius: when set, personnel within this many meters of any station
  // are hidden (they're presumed to be "at" the station, not in the field).
  function updatePersonnelMarkers(personnel, stations, personnelLayer, opts = {}) {
    const { geofenceRadius = null, showNametags = false } = opts;
    if (!personnelLayer) return;
    for (const p of personnel) {
      if (!p.tracker_id || !p.last_lat || !p.last_lon) {
        const ex = personnelLayer.getLayers().find(m => m._perId === p.id);
        if (ex) personnelLayer.removeLayer(ex);
        continue;
      }
      if (geofenceRadius != null) {
        const nearStation = stations.some(s => s.lat && s.lon &&
          haversine(p.last_lat, p.last_lon, s.lat, s.lon) <= geofenceRadius);
        if (nearStation) {
          const ex = personnelLayer.getLayers().find(m => m._perId === p.id);
          if (ex) personnelLayer.removeLayer(ex);
          continue;
        }
      }
      const color = p.color || '#f5a623';
      const shape = p.shape || 'triangle';
      const svg = RT.SHAPES[shape]?.(color, 20) || RT.SHAPES.triangle(color, 20);
      const label = RT.fmtLabel(p.name);
      const icon = L.divIcon({
        html: `<div title="${label}">${svg}</div>`,
        className: 'leaflet-div-icon', iconAnchor: [10, 10],
      });
      const tooltipOpts = { permanent: showNametags, direction: 'bottom', offset: [0, 6], className: 'map-nametag' };
      const existing = personnelLayer.getLayers().find(m => m._perId === p.id);
      if (existing) {
        existing.setLatLng([p.last_lat, p.last_lon]);
        existing.setIcon(icon);
        existing.unbindTooltip();
        existing.bindTooltip(label, tooltipOpts);
      } else {
        const m = L.marker([p.last_lat, p.last_lon], { icon });
        m._perId = p.id;
        m.bindTooltip(label, tooltipOpts);
        m.addTo(personnelLayer);
      }
    }
    for (const m of [...personnelLayer.getLayers()]) {
      if (!personnel.some(p => p.id === m._perId)) personnelLayer.removeLayer(m);
    }
  }

  // ── Route polyline ────────────────────────────────────────────────────────
  // routeLayerRef: { layer } — mutated in place so the caller's reference stays
  // valid (mirrors the stationMarkers in-place-mutation pattern above).
  function renderRoute(trackPoints, map, routeLayerRef, opts = {}) {
    const { fitBounds = true, skipFitIfSelected = false } = opts;
    if (routeLayerRef.layer) { map.removeLayer(routeLayerRef.layer); routeLayerRef.layer = null; }
    if (!trackPoints || trackPoints.length < 2) return;
    routeLayerRef.layer = L.polyline(trackPoints, { color: '#f5a623', weight: 5, opacity: 0.85 }).addTo(map);
    if (fitBounds && !skipFitIfSelected) map.fitBounds(routeLayerRef.layer.getBounds(), { padding: [40, 40] });
  }

  return {
    haversine, clamp01, isInfraStationType,
    ensureDistCache, computeTotalDist, getStationAlongMap, getManualFix,
    computePercent, computePace,
    stationMarkerStyle, renderStationMarkers,
    INFRA_COLORS, INFRA_LETTERS, updateInfraMarkers, toggleInfra,
    updatePersonnelMarkers,
    renderRoute,
  };
})();
