'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const express = require('express');
const session = require('express-session');
const db = require('./src/db');
const wsManager = require('./src/websocket');
const mqttClient = require('./src/mqtt-client');

const logger = require('./src/logger');
const aprsClient = require('./src/aprs-client');
const localTnc = require('./src/local-tnc');
const beacon        = require('./src/beacon');
const inreachPoller = require('./src/inreach-poller');
const PORT = process.env.PORT || 3000;

// ── Global error safety net ───────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  try { logger.log('system', 'error', `UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`); } catch {}
  console.error('[FATAL] uncaughtException:', err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack : String(reason);
  try { logger.log('system', 'error', `UNHANDLED REJECTION: ${msg}`); } catch {}
  console.error('[FATAL] unhandledRejection:', msg);
});

// Pipe all console output to the UI logs tab (console channel)
const _fmtArg = x => typeof x === 'string' ? x : x instanceof Error ? x.message : (() => { try { return JSON.stringify(x); } catch { return String(x); } })();
const _cLog = console.log.bind(console), _cWarn = console.warn.bind(console), _cErr = console.error.bind(console);
console.log   = (...a) => { _cLog(...a);  logger.log('console', 'info',  a.map(_fmtArg).join(' ')); };
console.warn  = (...a) => { _cWarn(...a); logger.log('console', 'warn',  a.map(_fmtArg).join(' ')); };
console.error = (...a) => { _cErr(...a);  logger.log('console', 'error', a.map(_fmtArg).join(' ')); };
const SESSION_SECRET = process.env.SESSION_SECRET || 'racetracker-secret-' + Math.random().toString(36);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }, // no maxAge = session cookie
});
app.use(sessionMiddleware);

// Tunnel DELETE via POST + X-HTTP-Method-Override header (avoids ISP DPI blocks on DELETE method)
app.use((req, res, next) => {
  if (req.method === 'POST' && req.headers['x-http-method-override'] === 'DELETE')
    req.method = 'DELETE';
  next();
});

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── TNC relay exe — download helper ──────────────────────────────────────────
const RELAY_EXE_URL  = 'https://github.com/jeepnjonny/RaceTracker/releases/download/tnc-relay-latest/RaceTrackerTNC.exe';
const RELAY_EXE_PATH = path.join(__dirname, 'public', 'downloads', 'RaceTrackerTNC.exe');

function downloadRelayExe(cb) {
  function get(url, hops) {
    if (hops > 8) return cb(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'RaceTracker-Server/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        res.resume();
        return get(res.headers.location, hops + 1);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return cb(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      fs.mkdirSync(path.dirname(RELAY_EXE_PATH), { recursive: true });
      const tmp = RELAY_EXE_PATH + '.tmp';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => fs.rename(tmp, RELAY_EXE_PATH, cb)));
      out.on('error', err => { fs.unlink(tmp, () => {}); cb(err); });
    }).on('error', cb);
  }
  get(RELAY_EXE_URL, 0);
}

// Fall back to GitHub Release redirect when file not present locally
app.get('/downloads/RaceTrackerTNC.exe', (req, res) => {
  res.redirect(302, RELAY_EXE_URL);
});

// ── Admin: sync relay exe from GitHub Release ─────────────────────────────────
app.post('/api/admin/relay-exe/sync', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  console.log('[server] Downloading TNC relay exe from GitHub Release...');
  downloadRelayExe(err => {
    if (err) {
      console.error('[server] relay-exe download failed:', err.message);
      return res.json({ ok: false, error: err.message });
    }
    const { size } = fs.statSync(RELAY_EXE_PATH);
    console.log(`[server] relay-exe saved (${(size / 1024 / 1024).toFixed(1)} MB)`);
    res.json({ ok: true, size });
  });
});

app.get('/api/admin/relay-exe/status', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  try {
    const stat = fs.statSync(RELAY_EXE_PATH);
    res.json({ ok: true, present: true, size: stat.size, mtime: stat.mtime });
  } catch {
    res.json({ ok: true, present: false });
  }
});

// ── Viewer page (token-gated, no login) ──────────────────────────────────────
app.get('/view/:token', (req, res) => {
  const race = db.prepare('SELECT id FROM races WHERE viewer_token=?').get(req.params.token);
  if (!race) return res.status(404).send('Race not found or viewer link has been revoked.');
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./src/routes/auth'));
app.use('/api/users',     require('./src/routes/users'));
app.use('/api/races',     require('./src/routes/races'));
app.use('/api/courses',   require('./src/routes/courses'));
app.use('/api/csv-files', require('./src/routes/csv-files'));
app.use('/api/tiles',     require('./src/routes/tiles'));

// Race-scoped routes
const raceRouter = express.Router({ mergeParams: true });
raceRouter.use('/tracks',       require('./src/routes/tracks'));
raceRouter.use('/stations',     require('./src/routes/stations'));
raceRouter.use('/participants', require('./src/routes/participants'));
raceRouter.use('/personnel',    require('./src/routes/personnel'));
raceRouter.use('/heats',        require('./src/routes/heats'));
raceRouter.use('/classes',      require('./src/routes/classes'));
raceRouter.use('/events',       require('./src/routes/events'));
raceRouter.use('/messages',     require('./src/routes/messages'));
raceRouter.use('/weather',      require('./src/routes/weather'));
raceRouter.use('/rf-analysis',  require('./src/routes/rf-analysis'));
app.use('/api/races/:raceId', raceRouter);

// ── MQTT test ─────────────────────────────────────────────────────────────────
app.post('/api/settings/mqtt-test', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  const connected = mqttClient.connectFromSettings(db);
  if (!connected) return res.status(400).json({ ok: false, error: 'No MQTT host configured in settings' });
  // Give the client 2.5s to connect then report status
  setTimeout(() => {
    const status = mqttClient.getStatus();
    res.json({ ok: true, data: status });
  }, 2500);
});

// ── APRS-IS ──────────────────────────────────────────────────────────────────
app.get('/api/aprs/status', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false });
  res.json({ ok: true, data: aprsClient.getStatus() });
});

app.post('/api/aprs/connect', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  const ok = aprsClient.connectFromSettings(db);
  setTimeout(() => res.json({ ok: true, data: aprsClient.getStatus() }), 2000);
});

app.post('/api/aprs/disconnect', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  aprsClient.disconnect();
  res.json({ ok: true });
});

app.get('/api/aprs/filter-preview', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false });
  const type = req.query.type || 'location';
  res.json({ ok: true, filter: aprsClient.previewFilter(type) });
});

// ── Global settings ───────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const data = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({ ok: true, data });
});

app.put('/api/settings', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  const upsert = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction(entries => { for (const [k, v] of entries) upsert.run(k, v ?? null); });
  tx(Object.entries(req.body));
  const keys = Object.keys(req.body).join(', ');
  logger.log('system', 'info', `Settings saved by ${req.session.user.username}: ${keys}`);
  res.json({ ok: true });
});

// MQTT status & control
app.get('/api/mqtt/status', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  res.json({ ok: true, data: mqttClient.getStatus() });
});

// Tracker registry (infrastructure view)
app.get('/api/trackers', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const trackers = db.prepare('SELECT * FROM tracker_registry ORDER BY last_seen DESC').all();
  res.json({ ok: true, data: trackers });
});

app.delete('/api/trackers', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  const hours = parseFloat(req.query.olderThan);
  if (!hours || hours <= 0) return res.status(400).json({ ok: false, error: 'olderThan must be > 0' });
  const cutoff = Math.floor(Date.now() / 1000) - Math.round(hours * 3600);
  const info = db.prepare('DELETE FROM tracker_registry WHERE last_seen < ? OR last_seen IS NULL').run(cutoff);
  logger.log('system', 'info', `Purged ${info.changes} tracker node(s) older than ${hours}h`);
  res.json({ ok: true, deleted: info.changes });
});

// Latest positions for active race
app.get('/api/live', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const race = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
  if (!race) return res.json({ ok: true, data: [] });
  const positions = db.prepare(`
    SELECT tp.*, p.bib, p.name as participant_name, p.status as participant_status
    FROM tracker_positions tp
    JOIN (
      SELECT node_id, MAX(timestamp) as max_ts FROM tracker_positions WHERE race_id=? GROUP BY node_id
    ) latest ON tp.node_id = latest.node_id AND tp.timestamp = latest.max_ts
    LEFT JOIN participants p ON p.race_id=? AND (p.tracker_id = tp.node_id OR p.tracker_id IN (
      SELECT long_name FROM tracker_registry WHERE node_id = tp.node_id
    ))
    WHERE tp.race_id=?
  `).all(race.id, race.id, race.id);
  res.json({ ok: true, data: positions });
});

// ── Weather status/test ───────────────────────────────────────────────────────
app.get('/api/weather/status', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false });
  const keyRow = db.prepare("SELECT value FROM settings WHERE key='weather_api_key'").get();
  res.json({ ok: true, data: { configured: !!(keyRow?.value) } });
});

// Returns the OWM API key for authenticated users (respects viewer+weather_enabled gate)
app.get('/api/weather/key', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false });
  const keyRow = db.prepare("SELECT value FROM settings WHERE key='weather_api_key'").get();
  const race = db.prepare("SELECT weather_enabled FROM races WHERE status='active'").get();
  const user = req.session.user;
  if (user.role === 'viewer' && !race?.weather_enabled)
    return res.json({ ok: true, data: { key: null } });
  res.json({ ok: true, data: { key: keyRow?.value || null } });
});

app.post('/api/weather/test', async (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  const keyRow = db.prepare("SELECT value FROM settings WHERE key='weather_api_key'").get();
  const apiKey = keyRow?.value;
  if (!apiKey) return res.json({ ok: false, error: 'No API key configured' });
  const https = require('https');
  // Test with a known fixed location (London) — we just need to validate the key
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=51.5&lon=-0.1&appid=${apiKey}`;
  try {
    await new Promise((resolve, reject) => {
      https.get(url, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          const j = JSON.parse(d);
          if (r.statusCode === 200) resolve(j);
          else reject(new Error(j.message || `HTTP ${r.statusCode}`));
        });
      }).on('error', reject);
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── System health / diagnostics ───────────────────────────────────────────────
app.get('/api/system/health', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });

  const mem = process.memoryUsage();
  const fds = (() => {
    try {
      const fs = require('fs');
      return fs.readdirSync(`/proc/${process.pid}/fd`).length;
    } catch { return null; }
  })();
  const uptime = process.uptime();

  res.json({
    ok: true,
    data: {
      pid: process.pid,
      uptime_s: Math.floor(uptime),
      heap_used_mb:  Math.round(mem.heapUsed  / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      rss_mb:        Math.round(mem.rss       / 1024 / 1024),
      external_mb:   Math.round(mem.external  / 1024 / 1024),
      open_fds:      fds,
      node_version:  process.version,
    },
  });
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  const { channel, limit } = req.query;
  res.json({ ok: true, data: logger.getLogs(channel, limit ? parseInt(limit) : 500) });
});

// ── SPA fallback — send index.html for unknown routes (except /api, /view, /downloads) ─
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') ||
      req.path.startsWith('/view/') ||
      req.path.startsWith('/downloads/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ── HTTP server + WebSocket ───────────────────────────────────────────────────
const server = http.createServer(app);
const wss = wsManager.init(server, sessionMiddleware);
mqttClient.setWs(wsManager);
aprsClient.setWs(wsManager);
localTnc.setWs(wsManager);
logger.setWs(wsManager);

// ── Auto-connect on startup ───────────────────────────────────────────────────
const mqttOk = mqttClient.connectFromSettings(db);
if (mqttOk) console.log('[server] MQTT connecting from global settings');
else console.log('[server] No MQTT settings configured yet');

const aprsOk = aprsClient.connectFromSettings(db);
if (aprsOk) console.log('[server] APRS-IS connecting from global settings');
else console.log('[server] APRS-IS not configured');

beacon.start();
inreachPoller.start();

server.listen(PORT, () => {
  console.log(`[server] RaceTracker listening on port ${PORT}`);
  logger.log('system', 'info', `RaceTracker started on port ${PORT}`);

  // Download TNC relay exe from GitHub Release if not already present locally
  if (!fs.existsSync(RELAY_EXE_PATH)) {
    console.log('[server] TNC relay exe not found — downloading from GitHub Release...');
    downloadRelayExe(err => {
      if (err) console.warn('[server] relay-exe auto-download failed:', err.message,
                            '(operators can still download via GitHub redirect)');
      else     console.log('[server] TNC relay exe ready for offline distribution');
    });
  }
});
