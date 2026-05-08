#!/usr/bin/env node
'use strict';

/**
 * RaceTracker TNC Relay Agent
 *
 * Runs on the operator's machine (Windows, macOS, or Linux).
 * Opens a KISS TNC via serial port and bridges it to a RaceTracker
 * server over WebSocket — no HTTPS required.
 *
 * Installation (one time):
 *   cd tools && npm install
 *
 * Usage:
 *   node tnc-relay.js [options]
 *
 * Options:
 *   --server   http://IP:3000          RaceTracker server URL  (required)
 *   --user     operator                Login username           (required)
 *   --pass     password                Login password           (required)
 *   --port     COM3 | /dev/ttyUSB0     Serial port              (required)
 *   --baud     9600                    Baud rate (default 9600)
 *   --race     1                       Race ID (auto-detects active race if omitted)
 *   --list                             List available serial ports and exit
 *
 * Examples:
 *   node tnc-relay.js --server http://192.168.1.50:3000 --user operator --pass secret --port COM3
 *   node tnc-relay.js --server http://192.168.1.50:3000 --user operator --pass secret --port /dev/ttyUSB0 --baud 9600
 *   node tnc-relay.js --list
 */

// ── Dependency check ──────────────────────────────────────────────────────────
let SerialPort, SerialPortList, WebSocket, http, https;
try {
  ({ SerialPort } = require('serialport'));
  SerialPortList = require('serialport').SerialPort.list;
  WebSocket = require('ws');
  http  = require('http');
  https = require('https');
} catch (e) {
  console.error('\n[ERROR] Missing dependencies. Run: cd tools && npm install\n');
  process.exit(1);
}

// ── CLI argument parsing ──────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const out  = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      out[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    }
  }
  return out;
}

const argv = parseArgs();

// ── List ports mode ───────────────────────────────────────────────────────────
if (argv.list) {
  SerialPort.list().then(ports => {
    if (!ports.length) { console.log('No serial ports found.'); process.exit(0); }
    console.log('\nAvailable serial ports:\n');
    ports.forEach(p => console.log(`  ${p.path.padEnd(20)} ${p.manufacturer || ''} ${p.serialNumber || ''}`));
    console.log();
    process.exit(0);
  });
  return;
}

// ── Validate required args ────────────────────────────────────────────────────
const REQUIRED = ['server', 'user', 'pass', 'port'];
const missing  = REQUIRED.filter(k => !argv[k]);
if (missing.length) {
  console.error(`\n[ERROR] Missing required arguments: --${missing.join(' --')}`);
  console.error('\nRun with --list to see available serial ports.\n');
  console.error('Usage: node tnc-relay.js --server http://IP:3000 --user USER --pass PASS --port COM3\n');
  process.exit(1);
}

const SERVER_URL = argv.server.replace(/\/$/, '');
const USERNAME   = argv.user;
const PASSWORD   = argv.pass;
const SERIAL_PORT = argv.port;
const BAUD_RATE  = parseInt(argv.baud) || 9600;
const RACE_ID    = argv.race ? parseInt(argv.race) : null;

// ── KISS framing constants ────────────────────────────────────────────────────
const FEND  = 0xC0;
const FESC  = 0xDB;
const TFEND = 0xDC;
const TFESC = 0xDD;

// ── KISS RX state machine ─────────────────────────────────────────────────────
class KissDecoder {
  constructor(onPacket) {
    this._onPacket = onPacket;
    this._buf      = [];
    this._esc      = false;
    this._inFrame  = false;
  }

  feed(bytes) {
    for (const b of bytes) {
      if (b === FEND) {
        if (this._inFrame && this._buf.length > 0) {
          this._onPacket(Buffer.from(this._buf));
        }
        this._inFrame = true;
        this._esc     = false;
        this._buf     = [];
        continue;
      }
      if (!this._inFrame) continue;
      if (b === FESC)       { this._esc = true; continue; }
      if (this._esc) {
        this._esc = false;
        this._buf.push(b === TFEND ? FEND : b === TFESC ? FESC : b);
        continue;
      }
      this._buf.push(b);
    }
  }
}

// ── AX.25 decode ─────────────────────────────────────────────────────────────
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
  if ((frame[0] & 0x0F) !== 0x00) return null; // data frame only

  const data   = frame.slice(1); // skip KISS command byte
  let offset   = 0;
  const addrs  = [];

  for (let i = 0; i < 10 && offset + 7 <= data.length; i++) {
    const a = decodeAddr(data, offset);
    if (!a) break;
    addrs.push(a.call);
    offset += 7;
    if (a.isLast) break;
  }
  if (addrs.length < 2 || offset + 2 > data.length) return null;

  const ctrl = data[offset++];
  if ((ctrl & 0x03) !== 0x03) return null; // UI frames only
  const pid  = data[offset++];
  if (pid !== 0xF0) return null;           // No Layer 3

  const text = data.slice(offset).toString('ascii');
  return { to: addrs[0], from: addrs[1], via: addrs.slice(2), text };
}

// ── AX.25 + KISS encode ───────────────────────────────────────────────────────
function encodeAddr(addrStr, isLast) {
  const dash  = addrStr.indexOf('-');
  const base  = (dash >= 0 ? addrStr.slice(0, dash) : addrStr).toUpperCase().slice(0, 6).padEnd(6, ' ');
  const ssid  = Math.min(15, parseInt(dash >= 0 ? addrStr.slice(dash + 1) : '0') || 0);
  const bytes = [];
  for (const ch of base) bytes.push(ch.charCodeAt(0) << 1);
  let ssidByte = 0x60 | ((ssid & 0x0F) << 1);
  if (isLast) ssidByte |= 0x01;
  bytes.push(ssidByte);
  return bytes;
}

function encodeKiss(from, to, via, text) {
  const allAddrs = [to, from, ...(via || [])];
  const addrBytes = [];
  allAddrs.forEach((a, i) => addrBytes.push(...encodeAddr(a, i === allAddrs.length - 1)));
  const info = Buffer.from(text, 'ascii');
  const ax25 = Buffer.concat([Buffer.from(addrBytes), Buffer.from([0x03, 0xF0]), info]);

  const out = [FEND, 0x00];
  for (const b of ax25) {
    if      (b === FEND) out.push(FESC, TFEND);
    else if (b === FESC) out.push(FESC, TFESC);
    else                 out.push(b);
  }
  out.push(FEND);
  return Buffer.from(out);
}

// ── HTTP helper (login, works with http:// and https://) ─────────────────────
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
      rejectUnauthorized: false, // allow self-signed certs
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

// ── Main relay logic ──────────────────────────────────────────────────────────
let ws       = null;
let serial   = null;
let rxCount  = 0;
let txCount  = 0;
let cookie   = null;
let raceId   = RACE_ID;

async function login() {
  console.log(`[relay] Logging in as "${USERNAME}"...`);
  const res = await httpPost(`${SERVER_URL}/api/auth/login`, { username: USERNAME, password: PASSWORD });
  if (res.status !== 200 || !res.body?.ok) {
    throw new Error(`Login failed (HTTP ${res.status}): ${res.body?.error || JSON.stringify(res.body)}`);
  }
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('No session cookie in login response');
  cookie = Array.isArray(setCookie)
    ? setCookie.map(c => c.split(';')[0]).join('; ')
    : setCookie.split(';')[0];
  console.log('[relay] Login OK');
}

function openSerial() {
  return new Promise((resolve, reject) => {
    serial = new SerialPort({ path: SERIAL_PORT, baudRate: BAUD_RATE }, err => {
      if (err) reject(err); else resolve();
    });

    const decoder = new KissDecoder(kissFrame => {
      const packet = decodeAX25(kissFrame);
      if (!packet) return;
      rxCount++;
      process.stdout.write(`\r[relay] RX:${rxCount}  TX:${txCount}  `);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'local_aprs_rx', data: packet }));
      }
    });

    serial.on('data', buf => decoder.feed(buf));
    serial.on('error', err => console.error('\n[serial] error:', err.message));
    serial.on('close', () => {
      console.log('\n[serial] port closed — reconnecting in 5s...');
      setTimeout(openSerial, 5000);
    });
  });
}

function connectWs() {
  const wsProto = SERVER_URL.startsWith('https') ? 'wss' : 'ws';
  const wsBase  = SERVER_URL.replace(/^https?/, wsProto);
  const qs      = raceId ? `?race=${raceId}` : '';
  const url     = `${wsBase}/ws${qs}`;

  console.log(`[relay] Connecting WebSocket → ${url}`);
  ws = new WebSocket(url, { headers: { Cookie: cookie } });

  ws.on('open', () => {
    console.log('[relay] WebSocket connected');
    ws.send(JSON.stringify({ type: 'tnc_connect' }));
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'init') {
      // Pick up the active race if we didn't specify one
      if (!raceId && msg.data?.race?.id) {
        raceId = msg.data.race.id;
        console.log(`[relay] Using race: "${msg.data.race.name}" (id=${raceId})`);
      }
    } else if (msg.type === 'tnc_status') {
      const s = msg.data;
      const role = s.clients?.some(c => c.isPrimary) ? 'TX PRIMARY' : 'RX only';
      console.log(`\n[relay] TNC status: ${s.count} client(s) connected, this relay is ${role}`);
    } else if (msg.type === 'tnc_tx') {
      // Server wants us to transmit over RF
      const { from, to, via, text } = msg.data;
      if (!serial?.isOpen) {
        console.error('\n[relay] TX requested but serial port not open');
        return;
      }
      const frame = encodeKiss(from, to, via, text);
      serial.write(frame, err => {
        if (err) { console.error('\n[relay] TX write error:', err.message); return; }
        txCount++;
        process.stdout.write(`\r[relay] RX:${rxCount}  TX:${txCount}  `);
      });
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`\n[relay] WebSocket closed (${code}) — reconnecting in 5s...`);
    setTimeout(reconnect, 5000);
  });

  ws.on('error', err => {
    console.error('\n[relay] WebSocket error:', err.message);
  });
}

async function reconnect() {
  try {
    // Re-login in case session expired
    await login();
    connectWs();
  } catch (e) {
    console.error('[relay] Reconnect failed:', e.message, '— retrying in 15s...');
    setTimeout(reconnect, 15000);
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   RaceTracker TNC Relay Agent        ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log(`  Server : ${SERVER_URL}`);
  console.log(`  Port   : ${SERIAL_PORT}  @  ${BAUD_RATE} baud`);
  if (RACE_ID) console.log(`  Race   : ${RACE_ID}`);
  console.log();

  try {
    await login();
  } catch (e) {
    console.error('[relay] Login failed:', e.message);
    process.exit(1);
  }

  try {
    console.log(`[relay] Opening serial port ${SERIAL_PORT} at ${BAUD_RATE} baud...`);
    await openSerial();
    console.log('[relay] Serial port open');
  } catch (e) {
    console.error('[relay] Serial port error:', e.message);
    console.error('        Run with --list to see available ports.');
    process.exit(1);
  }

  connectWs();

  process.on('SIGINT', async () => {
    console.log('\n[relay] Shutting down...');
    try { ws?.close(); }    catch {}
    try { serial?.close(); } catch {}
    process.exit(0);
  });
}

main().catch(e => { console.error('[relay] Fatal:', e.message); process.exit(1); });
