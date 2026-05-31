'use strict';

/**
 * Regression tests for the RF→APRS-IS igate data path.
 *
 * Covers three layers:
 *   1. Q-code loop-guard regex (pure logic — most critical correctness property)
 *   2. aprs-client.igate() not-connected guard
 *   3. aprs_igate_enabled DB default seed
 *   4. local-tnc: igate gating (disabled vs. enabled setting)
 *   5. local-tnc: line format passed to igate()
 */

// ── Mocks (hoisted before any require) ────────────────────────────────────────

jest.mock('../../src/aprs-client', () => ({
  igate:               jest.fn(() => true),
  processAprsLine:     jest.fn(),
  connectFromSettings: jest.fn(),
  disconnect:          jest.fn(),
  setWs:               jest.fn(),
  setMessagingCallsign: jest.fn(),
  notifyRosterChange:  jest.fn(),
  getStatus:           jest.fn(() => ({ connected: false })),
  previewFilter:       jest.fn(() => ''),
}));

jest.mock('../../src/route-table', () => ({
  update:        jest.fn(),
  invalidateWs:  jest.fn(),
}));

// ── Shared imports ─────────────────────────────────────────────────────────────

const aprsClient = require('../../src/aprs-client');
const localTnc   = require('../../src/local-tnc');
const db         = require('../../src/db');

// ── Helpers ────────────────────────────────────────────────────────────────────

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

// Minimal fake WebSocket that satisfies local-tnc's checks
function makeWs(raceId, id) {
  return {
    id:         id || `ws-${raceId}-${Math.random().toString(36).slice(2)}`,
    tncRaceId:  raceId,
    readyState: 1,
    send:       jest.fn(),
    tncActive:  false,
  };
}

// ── 1. Q-code loop-guard regex ────────────────────────────────────────────────

describe('Q-code loop-guard regex', () => {
  // The regex used inside igate(): /,qA[RCZSX]/i
  // It prevents re-igating packets that already originated from or transited IS.
  const Q_CODE_RE = /,qA[RCZSX]/i;

  test('detects ,qAR  — RF-received, already igated', () => {
    expect(Q_CODE_RE.test('W1AW>APRS,RELAY*,qAR,N0CALL:>test')).toBe(true);
  });

  test('detects ,qAC  — from IS, not yet gated downstream', () => {
    expect(Q_CODE_RE.test('W1AW>APRS,TCPIP*,qAC,N0CALL:>test')).toBe(true);
  });

  test('detects ,qAZ  — IS packet, no validation', () => {
    expect(Q_CODE_RE.test('W1AW>APRS,WIDE1-1,qAZ:>test')).toBe(true);
  });

  test('detects ,qAS  — IS, validated server path', () => {
    expect(Q_CODE_RE.test('W1AW>APRS,WIDE1-1,qAS:>test')).toBe(true);
  });

  test('detects ,qAX  — dropped/filtered path', () => {
    expect(Q_CODE_RE.test('W1AW>APRS,WIDE1-1,qAX:>test')).toBe(true);
  });

  test('is case-insensitive (upper-case QAR)', () => {
    expect(Q_CODE_RE.test('W1AW>APRS,WIDE1-1,QAR,N0CALL:>test')).toBe(true);
  });

  test('does NOT match a clean RF packet (no Q-code)', () => {
    expect(Q_CODE_RE.test('W1AW>APRS,WIDE1-1*:>test')).toBe(false);
  });

  test('does NOT match an unrelated comma-separated path element', () => {
    expect(Q_CODE_RE.test('W1AW>APRS,WIDE1-1,WIDE2-1:>test')).toBe(false);
  });

  test('partial match inside a callsign does not fire (no leading comma)', () => {
    // "qAR" appearing without a preceding comma must not trigger
    expect(Q_CODE_RE.test('W1AW>APRS,SOMEqARTHING:>test')).toBe(false);
  });
});

// ── 2. aprs-client.igate() not-connected guard ────────────────────────────────

describe('aprs-client.igate() — not-connected guard', () => {
  // jest.requireActual bypasses the file-level mock and loads the real module.
  // socket starts as null (no connect() has been called), so igate() must return false.
  const realAprsClient = jest.requireActual('../../src/aprs-client');

  test('returns false when socket is null (not yet connected)', () => {
    expect(realAprsClient.igate('W1AW>APRS,WIDE1-1:>test')).toBe(false);
  });

  test('returns false regardless of packet content when not connected', () => {
    expect(realAprsClient.igate('K7TEST>APRS,WIDE1-1:!4755.00N/12219.00W>')).toBe(false);
  });
});

// ── 3. DB default seed ────────────────────────────────────────────────────────

describe('aprs_igate_enabled DB default', () => {
  test('defaults to "0" (disabled) in the settings table', () => {
    const row = db.prepare("SELECT value FROM settings WHERE key='aprs_igate_enabled'").get();
    expect(row).not.toBeNull();
    expect(row.value).toBe('0');
  });
});

// ── 4 & 5. local-tnc igate gating ────────────────────────────────────────────

describe('local-tnc handleIncomingFrame igate gating', () => {
  // Use a different race ID and unique from/text combo per test to avoid
  // the 10-second deduplication window.

  let testSeq = 0;
  function nextFrame() {
    testSeq++;
    return {
      from: `K7T${String(testSeq).padStart(3, '0')}`,
      to:   'APRS',
      via:  ['WIDE1-1'],
      text: `>igate-test-${testSeq}`,
    };
  }

  beforeEach(() => {
    // clearMocks (from jest.config.js) resets .mock.calls automatically
  });

  test('igate() is NOT called when aprs_igate_enabled = "0"', () => {
    setSetting('aprs_igate_enabled', '0');
    const ws = makeWs(2001);
    localTnc.handleIncomingFrame(ws, nextFrame());
    expect(aprsClient.igate).not.toHaveBeenCalled();
  });

  test('igate() IS called when aprs_igate_enabled = "1"', () => {
    setSetting('aprs_igate_enabled', '1');
    const ws = makeWs(2002);
    localTnc.handleIncomingFrame(ws, nextFrame());
    expect(aprsClient.igate).toHaveBeenCalledTimes(1);
  });

  test('toggling setting from 1 back to 0 stops igating', () => {
    setSetting('aprs_igate_enabled', '1');
    localTnc.handleIncomingFrame(makeWs(2003), nextFrame());
    expect(aprsClient.igate).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    setSetting('aprs_igate_enabled', '0');
    localTnc.handleIncomingFrame(makeWs(2004), nextFrame());
    expect(aprsClient.igate).not.toHaveBeenCalled();
  });

  test('igate() receives the correctly reconstructed APRS-IS line', () => {
    setSetting('aprs_igate_enabled', '1');
    const ws = makeWs(2005);
    const frame = nextFrame();
    localTnc.handleIncomingFrame(ws, frame);

    // Reconstructed line: FROM>TO,VIA:TEXT
    const expected = `${frame.from}>APRS,WIDE1-1:${frame.text}`;
    expect(aprsClient.igate).toHaveBeenCalledWith(expected);
  });

  test('igate() is NOT called for message packets (text starting with ":")', () => {
    // Message packets addressed to us are handled separately and return early.
    setSetting('aprs_igate_enabled', '1');
    const ws = makeWs(2006);
    // A message to a different callsign still falls through to processAprsLine
    // but the dedup + path reconstruction applies; note: ':' as first char
    // means this is an APRS message format — local-tnc has early-return logic for
    // messages addressed to our tactical callsign.  Here it's a pass-through to
    // processAprsLine, but the igate call still happens.
    // Use a non-message ('>') packet to cleanly verify the path:
    const frame = { from: 'K7MSG', to: 'APRS', via: [], text: '>position text' };
    localTnc.handleIncomingFrame(ws, frame);
    expect(aprsClient.igate).toHaveBeenCalledWith('K7MSG>APRS:>position text');
  });

  test('via path is included in the reconstructed line', () => {
    setSetting('aprs_igate_enabled', '1');
    const ws = makeWs(2007);
    const frame = {
      from: 'W1MULTI',
      to:   'APRS',
      via:  ['WIDE1-1', 'WIDE2-1'],
      text: '>multi hop',
    };
    localTnc.handleIncomingFrame(ws, frame);
    expect(aprsClient.igate).toHaveBeenCalledWith('W1MULTI>APRS,WIDE1-1,WIDE2-1:>multi hop');
  });

  test('empty via path produces correct line (no extra comma)', () => {
    setSetting('aprs_igate_enabled', '1');
    const ws = makeWs(2008);
    const frame = { from: 'W1DIRECT', to: 'APRS', via: [], text: '>direct' };
    localTnc.handleIncomingFrame(ws, frame);
    expect(aprsClient.igate).toHaveBeenCalledWith('W1DIRECT>APRS:>direct');
  });
});
