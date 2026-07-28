'use strict';

jest.mock('../../src/mqtt-client', () => ({
  connectFromSettings: jest.fn(),
  setWs: jest.fn(),
  invalidateRouteCache: jest.fn(),
  getStatus: jest.fn(() => ({ connected: false })),
  auditMissedStations: jest.fn(),
}));

jest.mock('../../src/aprs-client', () => ({
  setMessagingCallsign: jest.fn(),
  connectFromSettings: jest.fn(),
  disconnect: jest.fn(),
  getStatus: jest.fn(() => ({ connected: false })),
  setWs: jest.fn(),
  notifyRosterChange: jest.fn(),
  refreshFilter: jest.fn(),
  previewFilter: jest.fn(() => ''),
}));

jest.mock('../../src/websocket', () => ({
  broadcast: jest.fn(),
  broadcastToRole: jest.fn(),
  broadcastToRace: jest.fn(),
  init: jest.fn(),
}));

const request = require('supertest');
const { createApp } = require('../helpers/testApp');

describe('Personnel API', () => {
  let app;
  let admin;
  let raceId;

  beforeAll(async () => {
    app = createApp();
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin' });

    const r = await admin.post('/api/races').send({ name: 'Personnel Race', date: '2026-08-01' });
    raceId = r.body.data.id;
  });

  test('creates a sweep member with SPOT/inReach feeds, station_id forced null', async () => {
    const res = await admin.post(`/api/races/${raceId}/personnel`).send({
      name: 'Sweep 1',
      station_id: 5,
      is_sweep: true,
      spot_feed_id: 'abc123',
      spot_feed_password: 'secret',
      inreach_url: 'https://share.garmin.com/sweep1',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.is_sweep).toBe(1);
    expect(res.body.data.is_rover).toBe(0);
    expect(res.body.data.station_id).toBeNull();
    expect(res.body.data.spot_feed_id).toBe('abc123');
    expect(res.body.data.spot_feed_password).toBe('secret');
    expect(res.body.data.inreach_url).toBe('https://share.garmin.com/sweep1');
  });

  test('rover and sweep are mutually exclusive with a fixed station', async () => {
    const create = await admin.post(`/api/races/${raceId}/personnel`).send({ name: 'Rover 1', is_rover: true, station_id: 3 });
    expect(create.body.data.is_rover).toBe(1);
    expect(create.body.data.is_sweep).toBe(0);
    expect(create.body.data.station_id).toBeNull();

    const id = create.body.data.id;
    const update = await admin.put(`/api/races/${raceId}/personnel/${id}`).send({ is_rover: false, is_sweep: true });
    expect(update.body.data.is_rover).toBe(0);
    expect(update.body.data.is_sweep).toBe(1);
    expect(update.body.data.station_id).toBeNull();
  });

  test('PUT updates SPOT/inReach fields independently of other fields', async () => {
    const create = await admin.post(`/api/races/${raceId}/personnel`).send({ name: 'Sweep 2', is_sweep: true });
    const id = create.body.data.id;

    const update = await admin.put(`/api/races/${raceId}/personnel/${id}`).send({
      spot_feed_id: 'feed-2',
      spot_feed_password: 'pw-2',
      inreach_url: 'https://share.garmin.com/sweep2',
    });
    expect(update.status).toBe(200);
    expect(update.body.data.spot_feed_id).toBe('feed-2');
    expect(update.body.data.spot_feed_password).toBe('pw-2');
    expect(update.body.data.inreach_url).toBe('https://share.garmin.com/sweep2');
    // Untouched fields preserved
    expect(update.body.data.name).toBe('Sweep 2');
    expect(update.body.data.is_sweep).toBe(1);
  });
});
