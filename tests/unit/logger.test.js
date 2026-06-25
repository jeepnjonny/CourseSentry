'use strict';

const logger = require('../../src/logger');

describe('logger.log()', () => {
  test('returns entry with required fields', () => {
    const entry = logger.log('system', 'info', 'hello world');
    expect(entry).toMatchObject({
      channel: 'system',
      level: 'info',
      msg: 'hello world',
      source: 'SYS',
    });
    expect(typeof entry.id).toBe('number');
    expect(entry.id).toBeGreaterThan(0);
    expect(typeof entry.ts).toBe('number');
    expect(entry.ts).toBeGreaterThan(0);
  });

  test('sequential calls produce increasing IDs', () => {
    const a = logger.log('system', 'info', 'a');
    const b = logger.log('system', 'info', 'b');
    expect(b.id).toBeGreaterThan(a.id);
  });

  test('unknown channel falls back to "system"', () => {
    const entry = logger.log('bogus_channel', 'warn', 'msg');
    expect(entry.channel).toBe('system');
  });

  test('all valid channels are accepted and stored under their own key', () => {
    for (const ch of logger.CHANNELS) {
      const entry = logger.log(ch, 'info', `test ${ch}`);
      expect(entry.channel).toBe(ch);
    }
  });

  test('logs with correct source label per channel', () => {
    const expected = { mqtt: 'MQTT', aprs: 'APRS-IS', tnc: 'TNC', race: 'RACE', system: 'SYS', console: 'CON' };
    for (const [ch, src] of Object.entries(expected)) {
      const entry = logger.log(ch, 'info', 'x');
      expect(entry.source).toBe(src);
    }
  });

  test('level field is stored as-is', () => {
    expect(logger.log('system', 'warn',  'w').level).toBe('warn');
    expect(logger.log('system', 'error', 'e').level).toBe('error');
    expect(logger.log('system', 'debug', 'd').level).toBe('debug');
  });
});

describe('logger.getLogs()', () => {
  test('returns only entries for the requested channel', () => {
    logger.log('mqtt', 'info', 'mqtt-only');
    const logs = logger.getLogs('mqtt');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every(e => e.channel === 'mqtt')).toBe(true);
  });

  test('"all" returns entries from multiple channels', () => {
    logger.log('mqtt',   'info', 'x');
    logger.log('aprs',   'warn', 'y');
    logger.log('system', 'info', 'z');
    const all = logger.getLogs('all');
    const channels = new Set(all.map(e => e.channel));
    expect(channels.size).toBeGreaterThan(1);
  });

  test('null/undefined channel treated as "all"', () => {
    logger.log('race',   'info', 'r');
    logger.log('system', 'info', 's');
    const withNull      = logger.getLogs(null);
    const withUndefined = logger.getLogs(undefined);
    expect(withNull.length).toBeGreaterThan(0);
    expect(withUndefined.length).toBeGreaterThan(0);
  });

  test('unknown channel returns []', () => {
    expect(logger.getLogs('nonexistent')).toEqual([]);
  });

  test('limit caps the number of returned entries', () => {
    for (let i = 0; i < 30; i++) logger.log('system', 'info', `bulk ${i}`);
    const capped = logger.getLogs('system', 5);
    expect(capped.length).toBeLessThanOrEqual(5);
  });

  test('"all" result is sorted ascending by id', () => {
    const all = logger.getLogs('all', 500);
    for (let i = 1; i < all.length; i++) {
      expect(all[i].id).toBeGreaterThanOrEqual(all[i - 1].id);
    }
  });

  test('returns most-recent entries when limit is smaller than total', () => {
    // Log 10 entries with distinct messages
    for (let i = 0; i < 10; i++) logger.log('tnc', 'info', `msg-${i}`);
    const last3 = logger.getLogs('tnc', 3);
    expect(last3.length).toBe(3);
    // The last entry should have message "msg-9"
    expect(last3[last3.length - 1].msg).toBe('msg-9');
  });
});

describe('circular buffer limit', () => {
  test('channel never exceeds 1000 entries', () => {
    // Log 1100 entries on 'console' channel
    for (let i = 0; i < 1100; i++) logger.log('console', 'info', `overflow-${i}`);
    const logs = logger.getLogs('console', 2000);
    expect(logs.length).toBeLessThanOrEqual(1000);
  });

  test('oldest entries are evicted when buffer is full', () => {
    // The 'console' channel now has 1000 recent entries from the test above.
    // Add one more and check the oldest is gone.
    logger.log('console', 'info', 'the-latest');
    const logs = logger.getLogs('console', 2000);
    expect(logs.some(e => e.msg === 'overflow-0')).toBe(false);
    expect(logs[logs.length - 1].msg).toBe('the-latest');
  });
});
