#!/usr/bin/env node
'use strict';

/**
 * RaceTracker TNC Relay — GUI Application
 *
 * Bundles to a self-contained Windows exe:
 *   cd tools/relay-app && npm install && npm run build
 *
 * The exe starts a local web server and opens your browser to a config/status
 * page.  No Node.js or npm required on the end-user machine.
 */

const http    = require('http');
const https   = require('https');
const net     = require('net');
const { exec } = require('child_process');
const fs      = require('fs');
const path    = require('path');

let SerialPort = null, WebSocket = null;
let _startupError = null;

try { ({ SerialPort } = require('serialport')); }
catch (e) {
  // Usually means the exe was built on a different OS and the native
  // serialport binding doesn't match this platform's architecture.
  _startupError = `serialport native module failed to load: ${e.message}\n\n` +
    'This copy of RaceTrackerTNC.exe was likely built on Linux and cannot run ' +
    'on Windows.\nPlease ask the server administrator to rebuild it using the ' +
    'GitHub Actions workflow (runs on Windows automatically).';
  console.error('[ERROR]', _startupError);
}

try { WebSocket = require('ws'); }
catch (e) {
  if (!_startupError) _startupError = `ws module failed to load: ${e.message}`;
  console.error('[ERROR] ws:', e.message);
}

// ── Config persistence ────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(
  process.env.APPDATA || path.dirname(process.execPath || process.argv[1]),
  'RaceTrackerTNC'
);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { server: '', username: '', port: '', baud: '9600', race: '' }; }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch {}
}

// ── App state ─────────────────────────────────────────────────────────────
const appState = {
  phase:     'idle',      // idle | connecting | connected | error
  role:      '',          // 'TX Primary' | 'RX Only' | ''
  rxCount:   0,
  txCount:   0,
  raceInfo:  '',
  log:       [],          // capped at 200 entries
};

function addLog(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}`;
  appState.log.push(line);
  if (appState.log.length > 200) appState.log.shift();
  process.stdout.write(line + '\n');
}

// ── KISS constants ────────────────────────────────────────────────────────
const FEND = 0xC0, FESC = 0xDB, TFEND = 0xDC, TFESC = 0xDD;

// ── KISS decoder ──────────────────────────────────────────────────────────
class KissDecoder {
  constructor(onPacket) {
    this._onPacket = onPacket;
    this._buf = []; this._esc = false; this._inFrame = false;
  }
  feed(bytes) {
    for (const b of bytes) {
      if (b === FEND) {
        if (this._inFrame && this._buf.length > 0)
          this._onPacket(Buffer.from(this._buf));
        this._inFrame = true; this._esc = false; this._buf = [];
        continue;
      }
      if (!this._inFrame) continue;
      if (b === FESC)  { this._esc = true; continue; }
      if (this._esc) {
        this._esc = false;
        this._buf.push(b === TFEND ? FEND : b === TFESC ? FESC : b);
        continue;
      }
      this._buf.push(b);
    }
  }
}

// ── AX.25 decode ─────────────────────────────────────────────────────────
function decodeAddr(frame, offset) {
  if (offset + 7 > frame.length) return null;
  let call = '';
  for (let i = 0; i < 6; i++) call += String.fromCharCode(frame[offset + i] >> 1);
  call = call.trimEnd();
  const ssidByte = frame[offset + 6];
  const ssid   = (ssidByte >> 1) & 0x0F;
  const isLast = (ssidByte & 0x01) !== 0;
  return { call: ssid > 0 ? `${call}-${ssid}` : call, isLast };
}

function decodeAX25(frame) {
  if (frame.length < 2) return null;
  if ((frame[0] & 0x0F) !== 0x00) return null;
  const data = frame.slice(1);
  let offset = 0;
  const addrs = [];
  for (let i = 0; i < 10 && offset + 7 <= data.length; i++) {
    const a = decodeAddr(data, offset);
    if (!a) break;
    addrs.push(a.call);
    offset += 7;
    if (a.isLast) break;
  }
  if (addrs.length < 2 || offset + 2 > data.length) return null;
  const ctrl = data[offset++];
  if ((ctrl & 0x03) !== 0x03) return null;
  const pid = data[offset++];
  if (pid !== 0xF0) return null;
  const text = data.slice(offset).toString('ascii');
  return { to: addrs[0], from: addrs[1], via: addrs.slice(2), text };
}

// ── AX.25 + KISS encode ───────────────────────────────────────────────────
function encodeAddr(addrStr, isLast) {
  const dash  = addrStr.indexOf('-');
  const base  = (dash >= 0 ? addrStr.slice(0, dash) : addrStr)
                  .toUpperCase().slice(0, 6).padEnd(6, ' ');
  const ssid  = Math.min(15, parseInt(dash >= 0 ? addrStr.slice(dash + 1) : '0') || 0);
  const bytes = [];
  for (const ch of base) bytes.push(ch.charCodeAt(0) << 1);
  let ssidByte = 0x60 | ((ssid & 0x0F) << 1);
  if (isLast) ssidByte |= 0x01;
  bytes.push(ssidByte);
  return bytes;
}

function encodeKiss(from, to, via, text) {
  const allAddrs  = [to, from, ...(via || [])];
  const addrBytes = [];
  allAddrs.forEach((a, i) =>
    addrBytes.push(...encodeAddr(a, i === allAddrs.length - 1)));
  const info = Buffer.from(text, 'ascii');
  const ax25 = Buffer.concat([Buffer.from(addrBytes), Buffer.from([0x03, 0xF0]), info]);
  const out  = [FEND, 0x00];
  for (const b of ax25) {
    if      (b === FEND) out.push(FESC, TFEND);
    else if (b === FESC) out.push(FESC, TFESC);
    else                 out.push(b);
  }
  out.push(FEND);
  return Buffer.from(out);
}

// ── HTTP helper ───────────────────────────────────────────────────────────
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u       = new URL(url);
    const lib     = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      rejectUnauthorized: false,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Relay state ───────────────────────────────────────────────────────────
let ws              = null;
let serial          = null;
let cookie          = null;
let raceId          = null;
let currentConfig   = {};
let shouldReconnect = false;

async function doLogin(serverUrl, username, password) {
  addLog(`Logging in as "${username}"…`);
  const res = await httpPost(`${serverUrl}/api/auth/login`, { username, password });
  if (res.status !== 200 || !res.body?.ok) {
    throw new Error(`Login failed (${res.status}): ${res.body?.error || JSON.stringify(res.body)}`);
  }
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('No session cookie in login response');
  cookie = Array.isArray(setCookie)
    ? setCookie.map(c => c.split(';')[0]).join('; ')
    : setCookie.split(';')[0];
  addLog('Login OK');
}

function openSerial(portPath, baudRate) {
  return new Promise((resolve, reject) => {
    serial = new SerialPort({ path: portPath, baudRate }, err => {
      if (err) { reject(err); return; }
      addLog(`Serial port ${portPath} open at ${baudRate} baud`);
      resolve();
    });

    const decoder = new KissDecoder(frame => {
      const pkt = decodeAX25(frame);
      if (!pkt) return;
      appState.rxCount++;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'local_aprs_rx', data: pkt }));
      }
    });

    serial.on('data', buf => decoder.feed(buf));
    serial.on('error', err => addLog(`Serial error: ${err.message}`));
    serial.on('close', () => {
      addLog('Serial port closed');
      if (shouldReconnect) {
        setTimeout(() =>
          openSerial(portPath, baudRate).catch(e =>
            addLog(`Serial reopen failed: ${e.message}`)), 5000);
      }
    });
  });
}

function connectWs(serverUrl) {
  const wsProto = serverUrl.startsWith('https') ? 'wss' : 'ws';
  const wsBase  = serverUrl.replace(/^https?/, wsProto);
  const qs      = raceId ? `?race=${raceId}` : '';
  const url     = `${wsBase}/ws${qs}`;
  addLog(`Connecting WebSocket → ${url}`);

  ws = new WebSocket(url, { headers: { Cookie: cookie } });

  ws.on('open', () => {
    addLog('WebSocket connected');
    appState.phase = 'connected';
    ws.send(JSON.stringify({ type: 'tnc_connect' }));
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'init') {
      if (!raceId && msg.data?.race?.id) {
        raceId = msg.data.race.id;
        appState.raceInfo = `${msg.data.race.name}`;
        addLog(`Active race: "${msg.data.race.name}" (id=${raceId})`);
      }
    } else if (msg.type === 'tnc_status') {
      const s = msg.data;
      const isPrimary = s.clients?.some(c => c.isPrimary);
      appState.role = isPrimary ? 'TX' : 'RX';
      addLog(`TNC: ${s.count} client(s), role = ${isPrimary ? 'TX Primary' : 'RX Only'}`);
    } else if (msg.type === 'tnc_tx') {
      const { from, to, via, text } = msg.data;
      if (!serial?.isOpen) { addLog('TX requested but serial port not open'); return; }
      const frame = encodeKiss(from, to, via, text);
      serial.write(frame, err => {
        if (err) { addLog(`TX error: ${err.message}`); return; }
        appState.txCount++;
      });
    }
  });

  ws.on('close', code => {
    addLog(`WebSocket closed (${code})`);
    appState.phase    = shouldReconnect ? 'connecting' : 'idle';
    appState.role     = '';
    appState.raceInfo = '';
    if (shouldReconnect) setTimeout(() => reconnectRelay(currentConfig), 5000);
  });

  ws.on('error', err => addLog(`WebSocket error: ${err.message}`));
}

async function reconnectRelay(cfg) {
  if (!shouldReconnect) return;
  try {
    await doLogin(cfg.server, cfg.username, cfg.password);
    connectWs(cfg.server);
  } catch (e) {
    addLog(`Reconnect failed: ${e.message} — retrying in 15s`);
    setTimeout(() => reconnectRelay(cfg), 15000);
  }
}

async function startRelay(cfg) {
  if (_startupError) {
    addLog('Cannot connect — startup error prevents operation. See log above.');
    appState.phase = 'error';
    return;
  }
  if (shouldReconnect) stopRelay(); // stop any existing session
  currentConfig       = cfg;
  shouldReconnect     = true;
  appState.phase      = 'connecting';
  appState.rxCount    = 0;
  appState.txCount    = 0;
  appState.role       = '';
  appState.raceInfo   = '';
  raceId = cfg.race ? parseInt(cfg.race) : null;

  addLog(`--- Starting relay to ${cfg.server} ---`);

  try {
    await doLogin(cfg.server, cfg.username, cfg.password);
  } catch (e) {
    addLog(`Login error: ${e.message}`);
    appState.phase  = 'error';
    shouldReconnect = false;
    return;
  }

  try {
    await openSerial(cfg.port, parseInt(cfg.baud) || 9600);
  } catch (e) {
    addLog(`Serial port error: ${e.message}`);
    appState.phase  = 'error';
    shouldReconnect = false;
    return;
  }

  connectWs(cfg.server);
  saveConfig(cfg);
}

function stopRelay() {
  shouldReconnect   = false;
  appState.phase    = 'idle';
  appState.role     = '';
  appState.raceInfo = '';
  try { ws?.close(); }               catch {}
  try { if (serial?.isOpen) serial.close(); } catch {}
  ws     = null;
  serial = null;
  cookie = null;
  raceId = null;
  addLog('--- Relay stopped ---');
}

// ── Inline UI ─────────────────────────────────────────────────────────────
const UI_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RaceTracker TNC Relay</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
     background:#12172b;color:#dde3f0;min-height:100vh;padding:24px 16px}
.wrap{max-width:520px;margin:0 auto}
h1{font-size:1.25rem;color:#5bc8f5;margin-bottom:2px}
.sub{font-size:.78rem;color:#6b7a99;margin-bottom:20px}
.card{background:#1a2240;border:1px solid #223;border-radius:8px;
      padding:16px;margin-bottom:14px}
.card h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;
         color:#5bc8f5;margin-bottom:12px}
label{display:block;font-size:.78rem;color:#8a9abf;margin-top:10px;margin-bottom:3px}
label:first-of-type{margin-top:0}
input,select{width:100%;padding:7px 10px;background:#0f1a36;
             border:1px solid #2a3a60;border-radius:4px;color:#dde3f0;
             font-size:.83rem;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:#5bc8f5}
input[type=password]{letter-spacing:.1em}
.row{display:flex;gap:8px;align-items:flex-end}
.row>*{flex:1}
.row>.shrink{flex:0 0 auto}
.btn{padding:8px 14px;border:none;border-radius:4px;cursor:pointer;
     font-size:.8rem;font-weight:600;transition:background .15s}
.btn-refresh{background:#0f1a36;color:#5bc8f5;border:1px solid #2a3a60}
.btn-refresh:hover{background:#1a2a50}
.btn-main{width:100%;margin-top:4px;padding:11px;font-size:.95rem;
          background:#5bc8f5;color:#090e1e}
.btn-main:hover{background:#7fd8ff}
.btn-main.live{background:#ef5350;color:#fff}
.btn-main.live:hover{background:#e53935}
.btn-main:disabled{background:#2a3a60;color:#4a5a80;cursor:not-allowed}
/* status */
.s-row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.dot.idle{background:#4a5a80}
.dot.connecting{background:#ffd54f;animation:pulse 1s infinite}
.dot.connected{background:#66bb6a}
.dot.error{background:#ef5350}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.stat{background:#0f1a36;border-radius:5px;padding:9px;text-align:center}
.stat .v{font-size:1.4rem;font-weight:700;color:#5bc8f5;line-height:1.1}
.stat .l{font-size:.66rem;color:#6b7a99;margin-top:2px}
/* log */
.log-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.log-head h2{margin:0}
.btn-clear{background:transparent;color:#4a5a80;border:1px solid #2a3a60;
           font-size:.7rem;padding:3px 8px;border-radius:3px;cursor:pointer}
.btn-clear:hover{color:#8a9abf}
.log{background:#080c1a;border:1px solid #1a2a40;border-radius:4px;
     padding:8px 10px;height:170px;overflow-y:auto;font-family:monospace;
     font-size:.72rem;color:#7a90b8}
.log-line{margin-bottom:1px;white-space:pre-wrap;word-break:break-all}
</style>
</head>
<body>
<div class="wrap">
<h1>&#x1F4E1; RaceTracker TNC Relay</h1>
<p class="sub">Bridges your serial TNC to the RaceTracker server over the network</p>

<div class="card">
  <h2>Server</h2>
  <label>Server URL</label>
  <input id="server" type="text" placeholder="http://192.168.1.50:3000" autocomplete="off">
  <div class="row" style="margin-top:0">
    <div><label>Username</label><input id="username" type="text" autocomplete="username"></div>
    <div><label>Password</label><input id="password" type="password" autocomplete="current-password"></div>
  </div>
  <label>Race ID <small style="color:#4a5a80">(blank = auto-detect active race)</small></label>
  <input id="race" type="text" placeholder="auto">
</div>

<div class="card">
  <h2>TNC Serial Port</h2>
  <div class="row">
    <div>
      <label>COM Port</label>
      <select id="comport"><option value="">— loading… —</option></select>
    </div>
    <div class="shrink">
      <label>&nbsp;</label>
      <button class="btn btn-refresh" onclick="loadPorts()">&#x21BA; Refresh</button>
    </div>
  </div>
  <label>Baud Rate</label>
  <select id="baud">
    <option value="1200">1200</option>
    <option value="4800">4800</option>
    <option value="9600" selected>9600</option>
    <option value="19200">19200</option>
    <option value="38400">38400</option>
    <option value="57600">57600</option>
  </select>
</div>

<div class="card">
  <h2>Status</h2>
  <div class="s-row">
    <div class="dot idle" id="dot"></div>
    <span id="status-text" style="font-size:.85rem">Idle</span>
  </div>
  <div class="stats">
    <div class="stat"><div class="v" id="rx">0</div><div class="l">Received</div></div>
    <div class="stat"><div class="v" id="tx">0</div><div class="l">Transmitted</div></div>
    <div class="stat"><div class="v" id="role">—</div><div class="l">Role</div></div>
  </div>
</div>

<div class="card">
  <div class="log-head">
    <h2>Log</h2>
    <button class="btn-clear" onclick="clearLog()">Clear</button>
  </div>
  <div class="log" id="log"></div>
</div>

<button class="btn btn-main" id="main-btn" onclick="toggle()">Connect</button>
</div>

<script>
'use strict';
let logLen = 0;

async function loadPorts(savedPort) {
  const sel = document.getElementById('comport');
  const cur = savedPort || sel.value;
  try {
    const r = await fetch('/api/ports');
    const ports = await r.json();
    sel.innerHTML = '<option value="">— select port —</option>';
    ports.forEach(p => {
      const o = document.createElement('option');
      o.value = p.path;
      o.textContent = p.path + (p.manufacturer ? '  —  ' + p.manufacturer : '');
      sel.appendChild(o);
    });
    if (cur) {
      const match = Array.from(sel.options).some(o => o.value === cur);
      if (match) {
        sel.value = cur;
      } else if (cur) {
        // Port not currently present but was last used — add placeholder
        const o = document.createElement('option');
        o.value = cur; o.textContent = cur + '  (not detected)';
        sel.appendChild(o); sel.value = cur;
      }
    } else if (ports.length === 1) {
      sel.value = ports[0].path;
    }
  } catch(e) { console.error('loadPorts', e); }
}

async function init() {
  let savedPort = '';
  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    if (cfg.server)   document.getElementById('server').value   = cfg.server;
    if (cfg.username) document.getElementById('username').value = cfg.username;
    if (cfg.password) document.getElementById('password').value = cfg.password;
    if (cfg.baud)     document.getElementById('baud').value     = cfg.baud;
    if (cfg.race)     document.getElementById('race').value     = cfg.race;
    savedPort = cfg.port || '';
  } catch {}
  await loadPorts(savedPort);
  poll();
}

async function toggle() {
  const btn = document.getElementById('main-btn');
  if (btn.classList.contains('live')) {
    await fetch('/api/disconnect', { method: 'POST' });
    return;
  }
  const body = {
    server:   document.getElementById('server').value.trim(),
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
    port:     document.getElementById('comport').value,
    baud:     document.getElementById('baud').value,
    race:     document.getElementById('race').value.trim(),
  };
  if (!body.server || !body.username || !body.password || !body.port) {
    alert('Please fill in Server URL, Username, Password and COM Port before connecting.');
    return;
  }
  btn.disabled = true; btn.textContent = 'Connecting…';
  await fetch('/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function clearLog() {
  fetch('/api/clear-log', { method: 'POST' });
  document.getElementById('log').innerHTML = '';
  logLen = 0;
}

function updateUI(s) {
  const dot = document.getElementById('dot');
  const txt = document.getElementById('status-text');
  const btn = document.getElementById('main-btn');

  dot.className = 'dot ' + s.phase;
  const labels = {
    idle:       'Idle — not connected',
    connecting: 'Connecting…',
    connected:  'Connected' + (s.raceInfo ? '  ·  ' + s.raceInfo : ''),
    error:      'Error — check log below',
  };
  txt.textContent = labels[s.phase] || s.phase;
  document.getElementById('rx').textContent   = s.rxCount;
  document.getElementById('tx').textContent   = s.txCount;
  document.getElementById('role').textContent = s.role || '—';

  if (s.phase === 'connected') {
    btn.disabled = false; btn.classList.add('live'); btn.textContent = 'Disconnect';
  } else if (s.phase === 'connecting') {
    btn.disabled = true; btn.classList.remove('live'); btn.textContent = 'Connecting…';
  } else {
    btn.disabled = false; btn.classList.remove('live'); btn.textContent = 'Connect';
  }

  const logEl = document.getElementById('log');
  if (s.log.length > logLen) {
    s.log.slice(logLen).forEach(line => {
      const d = document.createElement('div');
      d.className = 'log-line'; d.textContent = line;
      logEl.appendChild(d);
    });
    logLen = s.log.length;
    logEl.scrollTop = logEl.scrollHeight;
  } else if (s.log.length < logLen) {
    logEl.innerHTML = ''; logLen = 0;
  }
}

async function poll() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    updateUI(s);
  } catch {}
  setTimeout(poll, 1000);
}

init();
</script>
</body>
</html>`;

// ── HTTP server helpers ────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

// ── HTTP server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS for any local client
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = req.url.split('?')[0];

  if ((url === '/' || url === '/index.html') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(UI_HTML);
  }

  if (url === '/api/ports' && req.method === 'GET') {
    try { return json(res, await SerialPort.list()); }
    catch (e) { return json(res, { error: e.message }, 500); }
  }

  if (url === '/api/config' && req.method === 'GET') {
    return json(res, loadConfig());
  }

  if (url === '/api/status' && req.method === 'GET') {
    return json(res, appState);
  }

  if (url === '/api/connect' && req.method === 'POST') {
    const body = await readBody(req);
    startRelay(body).catch(e => addLog(`Start error: ${e.message}`));
    return json(res, { ok: true });
  }

  if (url === '/api/disconnect' && req.method === 'POST') {
    stopRelay();
    return json(res, { ok: true });
  }

  if (url === '/api/clear-log' && req.method === 'POST') {
    appState.log = [];
    return json(res, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

// ── Find free port & start ────────────────────────────────────────────────
function findFreePort(preferred, cb) {
  const s = net.createServer();
  s.once('error', () => findFreePort(preferred + 1, cb));
  s.once('listening', () => { const { port } = s.address(); s.close(() => cb(port)); });
  s.listen(preferred, '127.0.0.1');
}

// Surface any startup error in the UI immediately (don't silently die)
if (_startupError) {
  appState.phase = 'error';
  addLog('STARTUP ERROR: ' + _startupError);
}

findFreePort(9753, port => {
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   RaceTracker TNC Relay (GUI)        ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`\n  UI → ${url}\n`);
    if (_startupError) console.error('  STARTUP ERROR — see browser UI for details\n');
    // Open browser (Windows, macOS, Linux)
    const open = process.platform === 'win32'  ? `start "" "${url}"` :
                 process.platform === 'darwin' ? `open "${url}"` :
                                                 `xdg-open "${url}"`;
    exec(open, err => {
      if (err) console.log(`  Open your browser to: ${url}\n`);
    });
  });
});

process.on('SIGINT', () => {
  stopRelay();
  server.close();
  process.exit(0);
});
