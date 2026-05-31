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

describe('Stations API', () => {
  let app;
  let admin;
  let raceId;

  beforeAll(async () => {
    app   = createApp();
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin' });

    const r = await admin.post('/api/races').send({ name: 'Station Race', date: '2026-09-01' });
    raceId = r.body.data.id;
  });

  // ── GET / ─────────────────────────────────────────────────────────────────

  describe('GET /api/races/:raceId/stations', () => {
    test('unauthenticated → 401', async () => {
      const res = await request(app).get(`/api/races/${raceId}/stations`);
      expect(res.status).toBe(401);
    });

    test('returns ok:true with data array', async () => {
      const res = await admin.get(`/api/races/${raceId}/stations`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    test('each station includes personnel_count', async () => {
      await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'With Count', lat: 47.0, lon: -122.0, type: 'aid',
      });
      const res = await admin.get(`/api/races/${raceId}/stations`);
      expect(res.body.data.every(s => 'personnel_count' in s)).toBe(true);
    });
  });

  // ── POST / ────────────────────────────────────────────────────────────────

  describe('POST /api/races/:raceId/stations', () => {
    test('creates an aid station', async () => {
      const res = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'Aid 1', lat: 47.1, lon: -122.1, type: 'aid',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Aid 1');
      expect(res.body.data.type).toBe('aid');
      expect(res.body.data.lat).toBeCloseTo(47.1, 4);
    });

    test('creates a start station', async () => {
      const res = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'Start', lat: 47.0, lon: -122.0, type: 'start',
      });
      expect(res.body.data.type).toBe('start');
    });

    test('creates a finish station', async () => {
      const res = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'Finish', lat: 47.9, lon: -122.0, type: 'finish',
      });
      expect(res.body.data.type).toBe('finish');
    });

    test('creates a checkpoint', async () => {
      const res = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'CP1', lat: 47.5, lon: -122.0, type: 'checkpoint',
      });
      expect(res.body.data.type).toBe('checkpoint');
    });

    test('creates a turnaround', async () => {
      const res = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'Turn', lat: 47.6, lon: -122.0, type: 'turnaround',
      });
      expect(res.status).toBe(200);
    });

    test('missing name → 400', async () => {
      const res = await admin.post(`/api/races/${raceId}/stations`).send({
        lat: 47.0, lon: -122.0,
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    test('missing lat/lon for non-rover type → 400', async () => {
      const res = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'No Coords', type: 'aid',
      });
      expect(res.status).toBe(400);
    });

    test('rover station does not require lat/lon', async () => {
      const res = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'Rover 1', type: 'rover',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.type).toBe('rover');
    });

    test('station gets an integer id', async () => {
      const res = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'ID Test', lat: 47.2, lon: -122.2, type: 'aid',
      });
      expect(Number.isInteger(res.body.data.id)).toBe(true);
    });
  });

  // ── PUT /:id ──────────────────────────────────────────────────────────────

  describe('PUT /api/races/:raceId/stations/:id', () => {
    let sid;

    beforeAll(async () => {
      const r = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'Mutable', lat: 47.3, lon: -122.3, type: 'aid',
      });
      sid = r.body.data.id;
    });

    test('updates station name', async () => {
      const res = await admin.put(`/api/races/${raceId}/stations/${sid}`).send({ name: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed');
    });

    test('updates station coordinates', async () => {
      const res = await admin.put(`/api/races/${raceId}/stations/${sid}`).send({
        lat: 47.35, lon: -122.35,
      });
      expect(res.body.data.lat).toBeCloseTo(47.35, 4);
      expect(res.body.data.lon).toBeCloseTo(-122.35, 4);
    });

    test('nonexistent station → 404', async () => {
      const res = await admin.put(`/api/races/${raceId}/stations/999999`).send({ name: 'x' });
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /:id ───────────────────────────────────────────────────────────

  describe('DELETE /api/races/:raceId/stations/:id', () => {
    test('deletes an existing station', async () => {
      const r = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'To Delete', lat: 47.4, lon: -122.4, type: 'checkpoint',
      });
      const sid = r.body.data.id;
      const del = await admin.delete(`/api/races/${raceId}/stations/${sid}`);
      expect(del.status).toBe(200);
      expect(del.body.ok).toBe(true);
    });

    test('nonexistent station → 404', async () => {
      const res = await admin.delete(`/api/races/${raceId}/stations/999999`);
      expect(res.status).toBe(404);
    });
  });

  // ── Station isolation between races ───────────────────────────────────────

  describe('cross-race isolation', () => {
    test('station not accessible from wrong race id → 404 on update', async () => {
      const r2 = await admin.post('/api/races').send({ name: 'Other Race', date: '2026-09-02' });
      const rid2 = r2.body.data.id;

      const s = await admin.post(`/api/races/${raceId}/stations`).send({
        name: 'Belongs to Race 1', lat: 47.0, lon: -122.0, type: 'aid',
      });
      const sid = s.body.data.id;

      // Try to update the station using race 2's URL
      const res = await admin.put(`/api/races/${rid2}/stations/${sid}`).send({ name: 'Hijack' });
      expect(res.status).toBe(404);
    });
  });
});
