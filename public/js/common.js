'use strict';
// Shared utilities for all dashboard pages

const RT = (() => {
  // Detect sub-path prefix (e.g. /CourseSentry/ when proxied via nginx)
  const BASE = (() => {
    const p = location.pathname;
    // The viewer lives at <root>/view/:token — the app root is everything
    // before "/view/", so we don't mistake "view" for a proxy prefix.
    const vi = p.indexOf('/view/');
    if (vi !== -1) return p.slice(0, vi + 1);
    const seg = p.split('/')[1];
    return seg && !seg.includes('.') ? '/' + seg + '/' : '/';
  })();

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function getMe() {
    const res = await fetch(BASE + 'api/auth/me');
    if (!res.ok) return null;
    const j = await res.json();
    return j.ok ? j.data : null;
  }

  async function logout() {
    await fetch(BASE + 'api/auth/logout', { method: 'POST' });
    window.location.href = BASE;
  }

  async function requireLogin(allowedRoles) {
    const user = await getMe();
    if (!user) { window.location.href = BASE; return null; }
    if (allowedRoles) {
      const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
      // admin is implicitly allowed on any operator-tier page
      const effective = roles.includes('operator') ? [...roles, 'admin'] : roles;
      if (!effective.includes(user.role)) {
        window.location.href = BASE;
        return null;
      }
    }
    return user;
  }

  // ── API helpers ───────────────────────────────────────────────────────────
  async function api(method, url, body, methodOverride) {
    const opts = { method, headers: {} };
    if (methodOverride) opts.headers['X-HTTP-Method-Override'] = methodOverride;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + url.replace(/^\//, ''), opts);
    return res.json();
  }

  const get  = url        => api('GET',  url);
  const post = (url, b)   => api('POST', url, b);
  const put  = (url, b)   => api('PUT',  url, b);
  const del  = url        => api('POST', url, undefined, 'DELETE');

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function connectWS(onMessage, tokenParam, raceParam) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const parts = [];
    if (tokenParam) parts.push(`token=${tokenParam}`);
    if (raceParam)  parts.push(`race=${raceParam}`);
    const qs = parts.length ? '?' + parts.join('&') : '';
    const url = `${proto}://${location.host}${BASE}ws${qs}`;
    let ws, reconnectTimer;

    function connect() {
      ws = new WebSocket(url);
      ws.onopen  = () => { console.log('[ws] connected'); clearTimeout(reconnectTimer); };
      ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch {} };
      ws.onclose = () => { reconnectTimer = setTimeout(connect, 2000 + Math.random() * 4000); };
      ws.onerror = () => ws.close();
    }
    connect();
    return { send: d => ws?.readyState === 1 && ws.send(JSON.stringify(d)) };
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  /**
   * Format a full name as "Firstname L." for compact map labels / tooltips.
   * "John Smith" → "John S."   "Mary Jane Watson" → "Mary W."   "John" → "John"
   */
  function fmtLabel(name) {
    if (!name) return '';
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2) return parts[0] || '';
    return parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase() + '.';
  }

  function fmtTime(unixSec, fmt24) {
    if (!unixSec) return '--';
    const d = new Date(unixSec * 1000);
    if (fmt24) return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  function fmtElapsed(seconds, showSecs = true) {
    if (seconds == null || isNaN(seconds)) return '--';
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    if (!showSecs) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function fmtDist(meters, units) {
    if (meters == null) return '--';
    if (units === 'metric') {
      return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
    }
    const feet = meters * 3.28084;
    return feet >= 5280 ? `${(feet / 5280).toFixed(2)} mi` : `${Math.round(feet)} ft`;
  }

  function fmtSpeed(mPerSec, units) {
    if (!mPerSec || mPerSec <= 0) return '--';
    switch (units) {
      case 'kmh': return `${(mPerSec * 3.6).toFixed(1)} km/h`;
      case 'mph': return `${(mPerSec * 2.23694).toFixed(1)} mph`;
      case 'min_km': {
        const mpk = 1000 / mPerSec / 60;
        const m = Math.floor(mpk), s = Math.round((mpk - m) * 60);
        return `${m}:${String(s).padStart(2,'0')}/km`;
      }
      default: { // min_mile
        const mpm = 26.8224 / mPerSec;
        const m = Math.floor(mpm), s = Math.round((mpm - m) * 60);
        return `${m}:${String(s).padStart(2,'0')}/mi`;
      }
    }
  }

  function fmtPace(mPerSec) { return fmtSpeed(mPerSec, 'min_mile'); }

  function fmtBattery(pct) {
    if (pct == null) return '--';
    const color = pct > 50 ? '#3fb950' : pct > 20 ? '#d2a679' : '#f78166';
    return `<span style="color:${color}">${pct}%</span>`;
  }

  function timeAgo(unixSec) {
    if (!unixSec) return '--';
    const diff = Math.floor(Date.now() / 1000) - unixSec;
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    return `${Math.floor(diff/3600)}h ago`;
  }

  // ── SVG tracker icon shapes ───────────────────────────────────────────────
  const SHAPES = {
    circle:   (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`,
    triangle: (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><polygon points="10,2 18,18 2,18" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`,
    square:   (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`,
    diamond:  (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><polygon points="10,2 18,10 10,18 2,10" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`,
    star:     (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><polygon points="10,1 12.9,7.6 20,8.2 14.7,13 16.2,20 10,16.3 3.8,20 5.3,13 0,8.2 7.1,7.6" fill="${c}" stroke="#fff" stroke-width="1"/></svg>`,
    pentagon: (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><polygon points="10,2 18.1,7.9 14.9,17.6 5.1,17.6 1.9,7.9" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`,
  };

  // Preferred marker source: a participant's class icon wins over their heat
  // icon; either supplies { color, shape }. Returns null when neither is set.
  function iconSource(cls, heat) { return cls || heat || null; }

  function trackerIcon(src, alerting, missing) {
    const color = missing ? '#484f58' : (src?.color || '#58a6ff');
    const shape = src?.shape || 'circle';
    const svg = (SHAPES[shape] || SHAPES.circle)(color);
    const cls = alerting ? 'tracker-icon-alert' : '';
    return { svg, cls };
  }

  // ── Status helpers ────────────────────────────────────────────────────────
  const STATUS_COLORS = { dns:'#484f58', active:'#58a6ff', dnf:'#f78166', finished:'#3fb950' };

  function statusBadge(status) {
    const c = STATUS_COLORS[status] || '#484f58';
    return `<span class="badge" style="background:${c}22;color:${c}">${(status||'--').toUpperCase()}</span>`;
  }

  // ── Theme ─────────────────────────────────────────────────────────────────
  const THEMES = [
    { id: 'dark',             label: 'Dark' },
    { id: 'high-vis-dark',    label: 'High-Vis Dark' },
    { id: 'high-vis-day',     label: 'High-Vis Day' },
    { id: 'amber',            label: 'Amber' },
    { id: 'eclipse',          label: 'Eclipse' },
    { id: 'midnight-purple',  label: 'Purple' },
    { id: 'terminal-green',   label: 'Terminal' },
  ];

  // Migrate old single-letter IDs from localStorage
  const _legacyMap = { a: 'dark', b: 'high-vis-dark', c: 'high-vis-day', d: 'amber' };

  function applyTheme(id) {
    id = _legacyMap[id] || id || 'dark';
    let link = document.getElementById('rt-theme-css');
    if (!link) {
      link = document.createElement('link');
      link.id = 'rt-theme-css';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = BASE + 'css/theme-' + id + '.css';
    localStorage.setItem('rt-theme', id);
    document.querySelectorAll('.rt-theme-sel').forEach(s => { s.value = id; });
  }

  // Apply immediately to avoid flash
  applyTheme(localStorage.getItem('rt-theme') || 'dark');

  function injectThemeSelector() {
    // Inject into operator/admin topbar-right, or viewer-topbar
    const right = document.getElementById('topbar-right') || document.getElementById('viewer-topbar');
    if (!right) return;
    const saved = localStorage.getItem('rt-theme') || 'dark';
    const id = _legacyMap[saved] || saved;
    const sel = document.createElement('select');
    sel.className = 'rt-theme-sel';
    sel.title = 'Display theme';
    const inViewer = !!document.getElementById('viewer-topbar');
    sel.style.cssText = 'font-size:13px;padding:3px 6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:4px;font-family:var(--font);cursor:pointer;flex-shrink:0;width:auto';
    sel.innerHTML = THEMES.map(t => `<option value="${t.id}"${t.id === id ? ' selected' : ''}>${t.label}</option>`).join('');
    sel.onchange = () => applyTheme(sel.value);
    // Insert before the toggle button (into its direct parent so it works regardless of nesting)
    const toggle = document.getElementById('view-toggle');
    if (toggle) toggle.parentNode.insertBefore(sel, toggle);
    else if (document.getElementById('topbar-right')) right.prepend(sel);
    else right.appendChild(sel);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectThemeSelector);
  else injectThemeSelector();

  // ── Toast notifications ───────────────────────────────────────────────────
  let toastContainer;
  function toast(msg, type = 'info', duration = 4000) {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:6px;';
      document.body.appendChild(toastContainer);
    }
    const colors = { info: 'var(--accent)', ok: 'var(--accent2)', warn: 'var(--accent3)', alert: 'var(--accent3)' };
    const el = document.createElement('div');
    el.style.cssText = `background:var(--surface);border:1px solid ${colors[type]||colors.info};color:${colors[type]||colors.info};padding:8px 14px;border-radius:6px;font-family:var(--font);font-size:16px;max-width:320px;box-shadow:0 4px 12px rgba(0,0,0,.4);`;
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  /**
   * Make `panel` horizontally resizable by dragging a grip inserted as a sibling
   * flex-item next to it (the panel's parent must be a horizontal flex container).
   * Width is persisted to localStorage and restored on load.
   *
   * @param {HTMLElement} panel      Panel whose width changes.
   * @param {Object}   opts
   * @param {'e'|'w'}   opts.side    Grip edge: 'e' = grip on panel's right (panel is
   *                                 left of it), 'w' = grip on panel's left. Default 'e'.
   * @param {number}    opts.min     Min width px (default 220).
   * @param {number}    opts.max     Max width px (default 640).
   * @param {string}    opts.key     localStorage key for persisting width (optional).
   * @param {string}    opts.cssVar  If set, width is written to this CSS custom
   *                                 property (e.g. '--lb-w') instead of style.width —
   *                                 lets media queries override it on mobile.
   * @param {Function}  opts.onResize Called live during drag and on release
   *                                 (e.g. () => leafletMap.invalidateSize()).
   * @returns {HTMLElement|null} the grip element, or null if panel missing.
   */
  function initPanelResizer(panel, opts = {}) {
    if (!panel || !panel.parentNode) return null;
    const side = opts.side === 'w' ? 'w' : 'e';
    const min = opts.min ?? 220, max = opts.max ?? 640;
    const clamp = v => Math.max(min, Math.min(max, v));
    const setW = opts.cssVar
      ? px => panel.style.setProperty(opts.cssVar, px + 'px')
      : px => { panel.style.width = px + 'px'; };

    if (opts.key) {
      const saved = parseInt(localStorage.getItem(opts.key), 10);
      if (saved) setW(clamp(saved));
    }

    const grip = document.createElement('div');
    grip.className = 'panel-resizer';
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'vertical');
    if (side === 'e') panel.after(grip); else panel.before(grip);

    grip.addEventListener('pointerdown', e => {
      e.preventDefault();
      grip.classList.add('dragging');
      grip.setPointerCapture(e.pointerId);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const rect = panel.getBoundingClientRect();
      let w = rect.width;
      const move = ev => {
        w = clamp(side === 'e' ? ev.clientX - rect.left : rect.right - ev.clientX);
        setW(w);
        opts.onResize && opts.onResize();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (opts.key) localStorage.setItem(opts.key, Math.round(w));
        opts.onResize && opts.onResize();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
      grip.addEventListener('lostpointercapture', up, { once: true });
    });
    return grip;
  }

  return { BASE, getMe, logout, requireLogin, api, get, post, put, del, connectWS,
           fmtTime, fmtElapsed, fmtDist, fmtPace, fmtSpeed, fmtBattery, timeAgo, fmtLabel,
           trackerIcon, iconSource, SHAPES, statusBadge, toast, STATUS_COLORS, applyTheme, THEMES,
           initPanelResizer };
})();
