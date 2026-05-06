'use strict';
// One-shot MQTT diagnostic — reads broker settings from the app DB,
// subscribes to all Meshtastic topics, and decrypts/decodes every packet.
// Run with: node mqtt-diag.js
// Ctrl+C to stop.

const mqtt     = require('mqtt');
const crypto   = require('crypto');
const protobuf = require('protobufjs');
const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH   = path.join(__dirname, 'data', 'db.sqlite');
const PROTO_PATH = path.join(__dirname, 'src', 'proto', 'meshtastic.proto');

const MESH_DEFAULT_KEY = Buffer.from([
  0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59,
  0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x73,
]);

const PORTNUM = { TEXT: 1, POSITION: 3, NODEINFO: 4, ROUTING: 5, TELEMETRY: 67 };
const PORTNUM_NAMES = Object.fromEntries(Object.entries(PORTNUM).map(([k,v]) => [v, k]));

function derivePskKey(pskB64) {
  if (!pskB64) return null;
  const raw = Buffer.from(pskB64, 'base64');
  if (raw.length === 0) return null;
  if (raw.length === 1 && raw[0] === 1) return MESH_DEFAULT_KEY;
  const keyLen = raw.length >= 32 ? 32 : 16;
  const key = Buffer.alloc(keyLen, 0);
  raw.copy(key, 0, 0, Math.min(raw.length, keyLen));
  return key;
}

function aesNonce(packetId, fromNode) {
  const n = Buffer.alloc(16, 0);
  n.writeUInt32LE(packetId >>> 0, 0);
  n.writeUInt32LE(fromNode  >>> 0, 8);
  return n;
}

function decrypt(encBytes, packetId, fromNode, pskB64) {
  try {
    const key = derivePskKey(pskB64);
    if (!key) return { ok: false, reason: 'no-psk (no-encryption channel)' };
    const algo = key.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr';
    const d = crypto.createDecipheriv(algo, key, aesNonce(packetId, fromNode));
    return { ok: true, data: Buffer.concat([d.update(encBytes), d.final()]) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function nodeIdHex(n) { return `!${(n >>> 0).toString(16).padStart(8, '0')}`; }

function ts() { return new Date().toISOString().replace('T',' ').slice(0,19); }

function log(tag, msg) { console.log(`[${ts()}] ${tag.padEnd(6)} ${msg}`); }

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'mqtt_%'").all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  db.close();

  if (!s.mqtt_host) { console.error('No mqtt_host in settings — is the app configured?'); process.exit(1); }

  const protocol    = s.mqtt_protocol || 'tcp';
  const defaultPort = protocol === 'ws' ? 9001 : 1883;
  const port        = parseInt(s.mqtt_port || s.mqtt_port_ws) || defaultPort;
  const region      = s.mqtt_region  || 'US';
  const channel     = s.mqtt_channel || 'LongFast';
  const psk         = s.mqtt_psk ?? 'AQ==';
  const url         = `${protocol === 'ws' ? 'ws' : 'mqtt'}://${s.mqtt_host}:${port}`;

  const pskKey = derivePskKey(psk);
  let chHash = 0;
  for (const c of channel) chHash ^= c.charCodeAt(0);
  if (pskKey) for (const b of pskKey) chHash ^= b;
  chHash &= 0xFF;
  log('CFG', `broker  : ${url}`);
  log('CFG', `channel : ${channel}  region: ${region}`);
  log('CFG', `psk     : ${psk}  →  key: ${pskKey ? pskKey.toString('hex') : '(none — no encryption)'}`);
  log('CFG', `ch hash : 0x${chHash.toString(16).padStart(2, '0')}  (MeshPacket.channel = XOR(name bytes) ^ XOR(psk bytes))`);

  const root = await protobuf.load(PROTO_PATH);
  const ServiceEnvelope = root.lookupType('meshtastic.ServiceEnvelope');
  const Data            = root.lookupType('meshtastic.Data');
  const Position        = root.lookupType('meshtastic.Position');
  const User            = root.lookupType('meshtastic.User');
  const Telemetry       = root.lookupType('meshtastic.Telemetry');
  const Routing         = root.lookupType('meshtastic.Routing');

  const topics = [
    `msh/${region}/2/e/${channel}/#`,
    `msh/${region}/2/json/${channel}/#`,
  ];

  const client = mqtt.connect(url, {
    username: s.mqtt_user || undefined,
    password: s.mqtt_pass || undefined,
    connectTimeout: 8000,
  });

  client.on('connect', () => {
    log('CONN', `connected to ${url}`);
    topics.forEach(t => {
      client.subscribe(t, err => {
        if (err) log('ERR', `subscribe ${t}: ${err.message}`);
        else     log('SUB', t);
      });
    });
    console.log('\nWaiting for packets (Ctrl+C to stop)...\n');
  });

  client.on('error', e => log('ERR', e.message));

  client.on('message', (topic, payload) => {
    const isEnc  = /\/2\/e\//.test(topic);
    const isJson = /\/2\/json\//.test(topic);

    if (isEnc) {
      let envelope, packet;
      try {
        envelope = ServiceEnvelope.decode(payload);
        packet   = envelope.packet;
      } catch (e) {
        log('PROTO', `❌ ServiceEnvelope parse failed: ${e.message}`);
        log('PROTO', `   raw(hex): ${payload.slice(0,40).toString('hex')}`);
        return;
      }
      if (!packet) { log('PROTO', '❌ no packet in envelope'); return; }

      const fromHex = nodeIdHex(packet.from >>> 0);
      const toHex   = (packet.to >>> 0) === 0xffffffff ? 'broadcast' : nodeIdHex(packet.to >>> 0);
      const encLen  = packet.encrypted?.length ?? 0;
      const hasDecoded = !!(packet.decoded && packet.decoded.portnum != null);
      const chHash  = `ch=0x${(packet.channel >>> 0).toString(16).padStart(2, '0')}`;

      log('PKT', `from=${fromHex} → to=${toHex}  id=${packet.id}  ${chHash}  ${hasDecoded ? '[decoded]' : `[encrypted ${encLen}B]`}`);

      let data = null;
      if (hasDecoded) {
        data = packet.decoded;
        log('CRYPT', `✅ plain (no-encryption or already decoded)`);
      } else if (encLen > 0) {
        const result = decrypt(Buffer.from(packet.encrypted), packet.id, packet.from, psk);
        if (!result.ok) {
          log('CRYPT', `❌ decrypt failed: ${result.reason}`);
          log('CRYPT', `   nonce: ${aesNonce(packet.id, packet.from).toString('hex')}`);
          log('CRYPT', `   key  : ${pskKey ? pskKey.toString('hex') : 'null'}`);
          log('CRYPT', `   enc  : ${Buffer.from(packet.encrypted).slice(0,16).toString('hex')}...`);
          return;
        }
        try {
          data = Data.decode(result.data);
          log('CRYPT', `✅ decrypted ok  portnum=${data.portnum} (${PORTNUM_NAMES[data.portnum] ?? 'unknown'})  payloadLen=${data.payload?.length ?? 0}`);
        } catch (e) {
          log('CRYPT', `❌ Data.decode failed (wrong key?): ${e.message}`);
          log('CRYPT', `   decrypted hex: ${result.data.slice(0,24).toString('hex')}`);
          return;
        }
      } else {
        log('PROTO', '⚠️  packet has neither decoded nor encrypted field');
        return;
      }

      // Decode payload by portnum
      try {
        if (data.portnum === PORTNUM.POSITION && data.payload?.length) {
          const pos = Position.decode(data.payload);
          log('POS', `  lat=${(pos.latitudeI/1e7).toFixed(5)}  lon=${(pos.longitudeI/1e7).toFixed(5)}  alt=${pos.altitude}m  time=${pos.time}`);
        } else if (data.portnum === PORTNUM.NODEINFO && data.payload?.length) {
          const u = User.decode(data.payload);
          log('NODE', `  longName="${u.longName}"  shortName="${u.shortName}"  id=${u.id}  hw=${u.hwModel}`);
        } else if (data.portnum === PORTNUM.TELEMETRY && data.payload?.length) {
          const tel = Telemetry.decode(data.payload);
          if (tel.deviceMetrics) log('TEL', `  battery=${tel.deviceMetrics.batteryLevel}%  voltage=${tel.deviceMetrics.voltage?.toFixed(2)}V`);
        } else if (data.portnum === PORTNUM.ROUTING) {
          let errReason = 0;
          try { errReason = Routing.decode(data.payload).errorReason ?? 0; } catch (_) {}
          const replyId = data.replyId ? `replyId=${data.replyId >>> 0}` : '';
          log('ACK', `  err=${errReason} ${replyId} (${errReason === 0 ? 'DELIVERED' : 'FAILED'})`);
        } else if (data.portnum === PORTNUM.TEXT) {
          log('TEXT', `  "${Buffer.from(data.payload).toString('utf8')}"`);
        } else {
          log('DATA', `  portnum=${data.portnum} (${PORTNUM_NAMES[data.portnum] ?? 'unknown'})`);
        }
      } catch (e) {
        log('DATA', `  payload decode error: ${e.message}`);
      }

    } else if (isJson) {
      try {
        const msg = JSON.parse(payload.toString());
        log('JSON', `from=${msg.from || msg.sender}  type=${msg.type}  to=${msg.to}`);
      } catch {
        log('JSON', `parse error: ${payload.slice(0,60)}`);
      }
    }
  });
}

main().catch(e => { console.error(e); process.exit(1); });
