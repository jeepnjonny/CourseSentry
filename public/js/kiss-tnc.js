'use strict';
/**
 * KissTnc — browser-side KISS TNC module
 *
 * Connects to a serial KISS TNC via the Web Serial API, decodes incoming
 * AX.25 UI frames into APRS packets, and encodes outbound APRS packets
 * back into AX.25/KISS for transmission.
 *
 * Supported browsers: Chrome 89+, Edge 89+, Opera 75+ (WebSerial required).
 * Not supported: Firefox, Safari, iOS.
 *
 * Usage:
 *   KissTnc.onFrame(({ from, to, via, text }) => { ... });
 *   KissTnc.onStatus(({ connected, rxCount, txCount, portInfo }) => { ... });
 *   await KissTnc.connect(9600);
 *   await KissTnc.transmit({ from, to, via, text });
 *   await KissTnc.disconnect();
 */
const KissTnc = (() => {
  // ── KISS framing constants ──────────────────────────────────────────────────
  const FEND  = 0xC0; // Frame delimiter
  const FESC  = 0xDB; // Escape character
  const TFEND = 0xDC; // Transposed FEND (after FESC)
  const TFESC = 0xDD; // Transposed FESC (after FESC)

  // ── State ───────────────────────────────────────────────────────────────────
  let _port    = null;
  let _reader  = null;
  let _writer  = null;
  let _onFrame = null;
  let _onStatus = null;

  let _rxBuf     = [];
  let _inEscape  = false;
  let _inFrame   = false;
  let _rxCount   = 0;
  let _txCount   = 0;
  let _connected = false;

  // ── Status emission ─────────────────────────────────────────────────────────
  function _emit(extra = {}) {
    _onStatus?.({ connected: _connected, rxCount: _rxCount, txCount: _txCount, ...extra });
  }

  // ── KISS RX state machine ───────────────────────────────────────────────────
  function _processBytes(bytes) {
    for (const b of bytes) {
      if (b === FEND) {
        if (_inFrame && _rxBuf.length > 0) _decodeKissFrame(new Uint8Array(_rxBuf));
        _inFrame  = true;
        _inEscape = false;
        _rxBuf    = [];
        continue;
      }
      if (!_inFrame) continue;
      if (b === FESC)        { _inEscape = true; continue; }
      if (_inEscape) {
        _inEscape = false;
        _rxBuf.push(b === TFEND ? FEND : b === TFESC ? FESC : b);
        continue;
      }
      _rxBuf.push(b);
    }
  }

  function _decodeKissFrame(frame) {
    if (frame.length < 2) return;
    // Command byte: low nibble 0 = data frame, high nibble = port number
    if ((frame[0] & 0x0F) !== 0x00) return;
    const packet = _decodeAX25(frame.subarray(1));
    if (packet) {
      _rxCount++;
      _emit();
      _onFrame?.(packet);
    }
  }

  // ── AX.25 decode ────────────────────────────────────────────────────────────
  // Each AX.25 address is 7 bytes: 6 ASCII chars (each shifted left 1) + SSID byte
  function _decodeAddr(frame, offset) {
    if (offset + 7 > frame.length) return null;
    let call = '';
    for (let i = 0; i < 6; i++) call += String.fromCharCode(frame[offset + i] >> 1);
    call = call.trimEnd();
    const ssidByte = frame[offset + 6];
    const ssid   = (ssidByte >> 1) & 0x0F;
    const isLast = (ssidByte & 0x01) !== 0;
    return { call: ssid > 0 ? `${call}-${ssid}` : call, isLast };
  }

  function _decodeAX25(frame) {
    let offset = 0;
    const addrs = [];
    // Address chain: up to 10 entries (AX.25 allows 8 digipeaters + dest + src)
    for (let i = 0; i < 10 && offset + 7 <= frame.length; i++) {
      const a = _decodeAddr(frame, offset);
      if (!a) break;
      addrs.push(a.call);
      offset += 7;
      if (a.isLast) break;
    }
    if (addrs.length < 2 || offset + 2 > frame.length) return null;

    const ctrl = frame[offset++];
    if ((ctrl & 0x03) !== 0x03) return null; // UI frames only (0x03)
    const pid  = frame[offset++];
    if (pid !== 0xF0) return null;            // No Layer 3 protocol (APRS)

    const text = new TextDecoder('ascii', { fatal: false }).decode(frame.subarray(offset));
    return { to: addrs[0], from: addrs[1], via: addrs.slice(2), text };
  }

  // ── AX.25 encode ────────────────────────────────────────────────────────────
  function _encodeAddr(addrStr, isLast) {
    const dash = addrStr.indexOf('-');
    const base  = (dash >= 0 ? addrStr.slice(0, dash) : addrStr).toUpperCase().slice(0, 6).padEnd(6, ' ');
    const ssid  = Math.min(15, parseInt(dash >= 0 ? addrStr.slice(dash + 1) : '0') || 0);
    const bytes = [];
    for (const ch of base) bytes.push(ch.charCodeAt(0) << 1);
    let ssidByte = 0x60 | ((ssid & 0x0F) << 1); // bits 6,5 always set per spec
    if (isLast) ssidByte |= 0x01;               // address extension bit
    bytes.push(ssidByte);
    return bytes;
  }

  function _encodeAX25(from, to, via, text) {
    const allAddrs = [to, from, ...(via || [])];
    const addrBytes = [];
    allAddrs.forEach((a, i) => addrBytes.push(..._encodeAddr(a, i === allAddrs.length - 1)));
    const info = Array.from(new TextEncoder().encode(text));
    // UI frame: 0x03 control, 0xF0 PID (no layer 3)
    return [...addrBytes, 0x03, 0xF0, ...info];
  }

  // ── KISS TX encode ──────────────────────────────────────────────────────────
  function _encodeKiss(ax25Bytes) {
    const out = [FEND, 0x00]; // FEND + data command byte (port 0)
    for (const b of ax25Bytes) {
      if      (b === FEND) out.push(FESC, TFEND);
      else if (b === FESC) out.push(FESC, TFESC);
      else                 out.push(b);
    }
    out.push(FEND);
    return new Uint8Array(out);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** True if WebSerial is available in this browser */
  function isSupported() { return 'serial' in navigator; }

  /** True if a port is currently open and reading */
  function isConnected() { return _connected; }

  /** Register callback for decoded frames: fn({ from, to, via, text }) */
  function onFrame(cb) { _onFrame = cb; }

  /** Register callback for status changes: fn({ connected, rxCount, txCount, portInfo? }) */
  function onStatus(cb) { _onStatus = cb; }

  /**
   * Open WebSerial port picker and connect.
   * @param {number} [baud=9600] - Serial baud rate (1200 for RF, 9600 for most TNCs)
   */
  async function connect(baud = 9600) {
    if (!isSupported()) throw new Error('WebSerial is not supported in this browser');
    if (_connected) await disconnect();

    _port = await navigator.serial.requestPort();
    await _port.open({ baudRate: baud });
    _writer = _port.writable.getWriter();
    _connected = true;
    _emit({ portInfo: _port.getInfo() });

    // Async read loop — runs until port is closed or cancelled
    (async () => {
      _reader = _port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await _reader.read();
          if (done) break;
          if (value) _processBytes(value);
        }
      } catch { /* port closed or cancelled */ } finally {
        _reader = null;
        _connected = false;
        _emit();
      }
    })();
  }

  /** Close the serial port and clean up. */
  async function disconnect() {
    try { await _reader?.cancel(); }  catch {}
    try { _writer?.releaseLock(); }   catch {}
    try { await _port?.close(); }     catch {}
    _port = null; _reader = null; _writer = null;
    _connected = false;
    _rxCount = 0; _txCount = 0;
    _emit();
  }

  /**
   * Encode and transmit an AX.25 APRS frame over the serial port.
   * @param {{ from: string, to: string, via: string[], text: string }} frame
   * @returns {Promise<boolean>} true if write succeeded
   */
  async function transmit({ from, to, via, text }) {
    if (!_writer || !_connected) return false;
    try {
      const ax25  = _encodeAX25(from, to, via, text);
      const frame = _encodeKiss(ax25);
      await _writer.write(frame);
      _txCount++;
      _emit();
      return true;
    } catch (e) {
      console.error('[kiss-tnc] TX error:', e.message);
      return false;
    }
  }

  return { isSupported, isConnected, onFrame, onStatus, connect, disconnect, transmit };
})();
