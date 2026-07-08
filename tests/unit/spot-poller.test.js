'use strict';

// spot-poller.js imports src/db.js (and mqtt-client/websocket) at module level.
// tests/setup.js sets DB_PATH=':memory:' before Jest loads any module, so the
// import is safe. We only exercise the pure helpers exposed on `_internal`.
const { _internal } = require('../../src/spot-poller');
const { normalizeFeedId, buildFeedUrl, parseFeed, newestPerDevice, spotNodeId, batteryStateToPct } = _internal;

const API_BASE = 'https://api.findmespot.com/spot-main-web/consumer/rest-api/2.0/public/feed';

describe('normalizeFeedId', () => {
  test('extracts glId from a Shared Page URL', () => {
    expect(normalizeFeedId('http://share.findmespot.com/shared/faces/viewspots.jsp?glId=ABC123'))
      .toBe('ABC123');
  });

  test('extracts feed ID from a full API message URL', () => {
    expect(normalizeFeedId(`${API_BASE}/ABC123/message.json`)).toBe('ABC123');
  });

  test('extracts feed ID from a full API latest URL', () => {
    expect(normalizeFeedId(`${API_BASE}/ABC123/latest.xml`)).toBe('ABC123');
  });

  test('passes through a bare feed ID', () => {
    expect(normalizeFeedId('ABC123')).toBe('ABC123');
  });

  test('trims whitespace', () => {
    expect(normalizeFeedId('  ABC123  ')).toBe('ABC123');
  });

  test('empty / null → null', () => {
    expect(normalizeFeedId('')).toBeNull();
    expect(normalizeFeedId(null)).toBeNull();
    expect(normalizeFeedId(undefined)).toBeNull();
  });
});

describe('buildFeedUrl', () => {
  test('builds message.json endpoint', () => {
    expect(buildFeedUrl('ABC123')).toBe(`${API_BASE}/ABC123/message.json`);
  });

  test('appends feedPassword when provided', () => {
    expect(buildFeedUrl('ABC123', 'secret'))
      .toBe(`${API_BASE}/ABC123/message.json?feedPassword=secret`);
  });
});

describe('parseFeed', () => {
  test('multi-message array', () => {
    const body = JSON.stringify({
      response: { feedMessageResponse: { count: 2, messages: { message: [
        { id: 1, messengerId: '0-111', latitude: 40.1, longitude: -105.2, unixTime: 1700000000, messageType: 'TRACK' },
        { id: 2, messengerId: '0-222', latitude: 41.0, longitude: -106.0, unixTime: 1700000100, messageType: 'OK' },
      ] } } },
    });
    const msgs = parseFeed(body);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].messengerId).toBe('0-111');
  });

  test('single message object is coerced to a one-element array', () => {
    const body = JSON.stringify({
      response: { feedMessageResponse: { count: 1, messages: { message:
        { id: 1, messengerId: '0-111', latitude: 40.1, longitude: -105.2, unixTime: 1700000000, messageType: 'TRACK' },
      } } },
    });
    const msgs = parseFeed(body);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].messengerId).toBe('0-111');
  });

  test('error response yields empty list', () => {
    const body = JSON.stringify({
      response: { errors: { error: { code: 'E-0195', text: 'No Messages to display', description: '' } } },
    });
    expect(parseFeed(body)).toEqual([]);
  });

  test('malformed JSON yields empty list', () => {
    expect(parseFeed('not json')).toEqual([]);
    expect(parseFeed('')).toEqual([]);
  });
});

describe('newestPerDevice', () => {
  test('keeps the newest fix per messengerId', () => {
    const out = newestPerDevice([
      { messengerId: '0-111', messengerName: 'Alpha', latitude: 40.1, longitude: -105.2, unixTime: 1700000000, messageType: 'TRACK' },
      { messengerId: '0-111', messengerName: 'Alpha', latitude: 40.5, longitude: -105.9, unixTime: 1700000500, messageType: 'TRACK' },
      { messengerId: '0-222', messengerName: 'Bravo', latitude: 41.0, longitude: -106.0, unixTime: 1700000100, messageType: 'OK' },
    ]);
    expect(out).toHaveLength(2);
    const alpha = out.find(d => d.messengerId === '0-111');
    expect(alpha.timestamp).toBe(1700000500);
    expect(alpha.lat).toBeCloseTo(40.5);
    expect(alpha.name).toBe('Alpha');
  });

  test('skips messages missing coordinates, id, or time', () => {
    const out = newestPerDevice([
      { messengerId: '0-111', latitude: 'x', longitude: -105.2, unixTime: 1700000000 },
      { messengerId: null, latitude: 40.1, longitude: -105.2, unixTime: 1700000000 },
      { messengerId: '0-333', latitude: 40.1, longitude: -105.2, unixTime: null },
    ]);
    expect(out).toEqual([]);
  });
});

describe('batteryStateToPct', () => {
  test('GOOD → 100', () => expect(batteryStateToPct('GOOD')).toBe(100));
  test('LOW → 10',   () => expect(batteryStateToPct('LOW')).toBe(10));
  test('case-insensitive', () => expect(batteryStateToPct('good')).toBe(100));
  test('unknown / absent → null', () => {
    expect(batteryStateToPct('FULL')).toBeNull();
    expect(batteryStateToPct('')).toBeNull();
    expect(batteryStateToPct(null)).toBeNull();
    expect(batteryStateToPct(undefined)).toBeNull();
  });
});

describe('newestPerDevice battery mapping', () => {
  test('maps batteryState on the newest fix', () => {
    const out = newestPerDevice([
      { messengerId: '0-1', latitude: 40, longitude: -105, unixTime: 1700000000, batteryState: 'GOOD' },
      { messengerId: '0-2', latitude: 41, longitude: -106, unixTime: 1700000000, batteryState: 'LOW' },
      { messengerId: '0-3', latitude: 42, longitude: -107, unixTime: 1700000000 },
    ]);
    expect(out.find(d => d.messengerId === '0-1').battery).toBe(100);
    expect(out.find(d => d.messengerId === '0-2').battery).toBe(10);
    expect(out.find(d => d.messengerId === '0-3').battery).toBeNull();
  });
});

describe('spotNodeId', () => {
  test('prefers the SPOT ESN (messengerId)', () => {
    expect(spotNodeId('0-1234567', 42)).toBe('spot-0-1234567');
  });

  test('falls back to participant ID when ESN is null', () => {
    expect(spotNodeId(null, 42)).toBe('spot-p42');
  });

  test('falls back to participant ID when ESN is empty string', () => {
    expect(spotNodeId('', 7)).toBe('spot-p7');
  });
});
