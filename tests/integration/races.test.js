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

jest.mock('../../src/tile-cache', () => ({
  downloadTiles: jest.fn(() => Promise.resolve()),
}));

const request = require('supertest');
const { createApp } = require('../helpers/testApp');

describe('Races API', () => {
  let app;
  let admin; // persistent authenticated admin agent

  beforeAll(async () => {
    app = createApp();
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin' });
  });

  // ── GET /api/races ────────────────────────────────────────────────────────

  describe('GET /api/races', () => {
    test('unauthenticated → 401', async () => {
      const res = await request(app).get('/api/races');
      expect(res.status).toBe(401);
    });

    test('returns ok:true with data array', async () => {
      const res = await admin.get('/api/races');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    test('each race includes participant_count', async () => {
      await admin.post('/api/races').send({ name: 'Count Race', date: '2026-06-01' });
      const res = await admin.get('/api/races');
      expect(res.body.data.every(r => 'participant_count' in r)).toBe(true);
    });
  });

  // ── GET /api/races/active ─────────────────────────────────────────────────

  describe('GET /api/races/active', () => {
    test('returns ok:true (null when no active race)', async () => {
      const res = await admin.get('/api/races/active');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── POST /api/races ───────────────────────────────────────────────────────

  describe('POST /api/races', () => {
    test('missing name → 400', async () => {
      const res = await admin.post('/api/races').send({ date: '2026-06-01' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    test('missing date → 400', async () => {
      const res = await admin.post('/api/races').send({ name: 'Test Race' });
      expect(res.status).toBe(400);
    });

    test('creates race with correct name/date', async () => {
      const res = await admin.post('/api/races').send({ name: 'My Race', date: '2026-06-02' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.name).toBe('My Race');
      expect(res.body.data.date).toBe('2026-06-02');
    });

    test('new race defaults to upcoming status', async () => {
      const res = await admin.post('/api/races').send({ name: 'Status Race', date: '2026-06-03' });
      expect(res.body.data.status).toBe('upcoming');
    });

    test('new race has expected default settings', async () => {
      const res = await admin.post('/api/races').send({ name: 'Defaults Race', date: '2026-06-04' });
      expect(res.body.data).toMatchObject({
        geofence_radius:     15,
        alerts_enabled:      1,
        leaderboard_enabled: 1,
        messaging_enabled:   0,
      });
    });

    test('returned race has an integer id', async () => {
      const res = await admin.post('/api/races').send({ name: 'ID Race', date: '2026-06-05' });
      expect(Number.isInteger(res.body.data.id)).toBe(true);
      expect(res.body.data.id).toBeGreaterThan(0);
    });
  });

  // ── GET /api/races/:id ────────────────────────────────────────────────────

  describe('GET /api/races/:id', () => {
    let raceId;

    beforeAll(async () => {
      const res = await admin.post('/api/races').send({ name: 'Get By ID Race', date: '2026-06-06' });
      raceId = res.body.data.id;
    });

    test('returns race by id', async () => {
      const res = await admin.get(`/api/races/${raceId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(raceId);
    });

    test('nonexistent id → 404', async () => {
      const res = await admin.get('/api/races/999999');
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });
  });

  // ── PUT /api/races/:id ────────────────────────────────────────────────────

  describe('PUT /api/races/:id', () => {
    let raceId;

    beforeAll(async () => {
      const res = await admin.post('/api/races').send({ name: 'Update Race', date: '2026-06-07' });
      raceId = res.body.data.id;
    });

    test('updates a permitted field', async () => {
      const res = await admin.put(`/api/races/${raceId}`).send({ geofence_radius: 25 });
      expect(res.status).toBe(200);
      expect(res.body.data.geofence_radius).toBe(25);
    });

    test('multiple fields in one request', async () => {
      const res = await admin.put(`/api/races/${raceId}`).send({
        off_course_distance: 200,
        alerts_enabled: 0,
      });
      expect(res.body.data.off_course_distance).toBe(200);
      expect(res.body.data.alerts_enabled).toBe(0);
    });

    test('nonexistent race → 404', async () => {
      const res = await admin.put('/api/races/999999').send({ name: 'x' });
      expect(res.status).toBe(404);
    });

    test('invalid tactical_callsign (contains spaces) → 400', async () => {
      const res = await admin.put(`/api/races/${raceId}`).send({
        tactical_callsign: 'NET CTRL',
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    test('valid tactical_callsign with SSID is accepted', async () => {
      const res = await admin.put(`/api/races/${raceId}`).send({ tactical_callsign: 'W1AW-5' });
      expect(res.status).toBe(200);
      expect(res.body.data.tactical_callsign).toBe('W1AW-5');
    });

    test('empty body returns unchanged race', async () => {
      const before = await admin.get(`/api/races/${raceId}`);
      const res    = await admin.put(`/api/races/${raceId}`).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.geofence_radius).toBe(before.body.data.geofence_radius);
    });

    test('unknown fields are silently ignored', async () => {
      const res = await admin.put(`/api/races/${raceId}`).send({ nonexistent_field: 'x' });
      expect(res.status).toBe(200);
    });
  });

  // ── DELETE /api/races/:id ─────────────────────────────────────────────────

  describe('DELETE /api/races/:id', () => {
    test('deletes an upcoming race', async () => {
      const create = await admin.post('/api/races').send({ name: 'To Delete', date: '2026-06-08' });
      const id = create.body.data.id;
      const del = await admin.delete(`/api/races/${id}`);
      expect(del.status).toBe(200);
      expect(del.body.ok).toBe(true);
      const check = await admin.get(`/api/races/${id}`);
      expect(check.status).toBe(404);
    });

    test('cannot delete active race → 400', async () => {
      const create = await admin.post('/api/races').send({ name: 'Active Race', date: '2026-06-09' });
      const id = create.body.data.id;
      await admin.post(`/api/races/${id}/activate`);
      const res = await admin.delete(`/api/races/${id}`);
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    test('nonexistent race → 404', async () => {
      const res = await admin.delete('/api/races/999999');
      expect(res.status).toBe(404);
    });
  });

  // ── Race lifecycle ────────────────────────────────────────────────────────

  describe('race lifecycle', () => {
    let raceId;

    beforeEach(async () => {
      const res = await admin.post('/api/races').send({ name: 'Lifecycle', date: '2026-07-01' });
      raceId = res.body.data.id;
    });

    test('activate sets status to active', async () => {
      await admin.post(`/api/races/${raceId}/activate`);
      const r = await admin.get(`/api/races/${raceId}`);
      expect(r.body.data.status).toBe('active');
    });

    test('activate returns ok:true and activation warnings array', async () => {
      const res = await admin.post(`/api/races/${raceId}/activate`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.warnings)).toBe(true);
    });

    test('deactivate sets status to past', async () => {
      await admin.post(`/api/races/${raceId}/activate`);
      await admin.post(`/api/races/${raceId}/deactivate`);
      const r = await admin.get(`/api/races/${raceId}`);
      expect(r.body.data.status).toBe('past');
    });

    test('end sets status to past', async () => {
      await admin.post(`/api/races/${raceId}/activate`);
      const res = await admin.post(`/api/races/${raceId}/end`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('past');
    });

    test('activate nonexistent race → 404', async () => {
      const res = await admin.post('/api/races/999999/activate');
      expect(res.status).toBe(404);
    });

    test('end nonexistent race → 404', async () => {
      const res = await admin.post('/api/races/999999/end');
      expect(res.status).toBe(404);
    });
  });

  // ── POST /:id/start ───────────────────────────────────────────────────────

  describe('POST /api/races/:id/start', () => {
    let raceId;

    beforeAll(async () => {
      const r = await admin.post('/api/races').send({ name: 'Start Test Race', date: '2026-07-02' });
      raceId = r.body.data.id;
      // Add participants in dns state
      await admin.post(`/api/races/${raceId}/participants`).send({ bib: '10', name: 'Alpha' });
      await admin.post(`/api/races/${raceId}/participants`).send({ bib: '11', name: 'Beta' });
    });

    test('starts all dns participants', async () => {
      const res = await admin.post(`/api/races/${raceId}/start`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.started).toBeGreaterThanOrEqual(2);
    });

    test('second start call does not create duplicate start events', async () => {
      // Grab event count before
      const before = await admin.get(`/api/races/${raceId}/events`);
      const countBefore = before.body.data.length;

      await admin.post(`/api/races/${raceId}/start`);

      // No new start events should have been inserted (no dns participants remain)
      const after = await admin.get(`/api/races/${raceId}/events`);
      expect(after.body.data.length).toBe(countBefore);
    });

    test('nonexistent race → 404', async () => {
      const res = await admin.post('/api/races/999999/start');
      expect(res.status).toBe(404);
    });
  });

  // ── POST /:id/clone ───────────────────────────────────────────────────────

  describe('POST /api/races/:id/clone', () => {
    let sourceId;

    beforeAll(async () => {
      const r = await admin.post('/api/races').send({ name: 'Source', date: '2026-07-03' });
      sourceId = r.body.data.id;
      await admin.put(`/api/races/${sourceId}`).send({ geofence_radius: 50, off_course_distance: 300 });
    });

    test('clones race with new name and date', async () => {
      const res = await admin.post(`/api/races/${sourceId}/clone`).send({
        name: 'Cloned', date: '2027-07-03',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Cloned');
      expect(res.body.data.date).toBe('2027-07-03');
      expect(res.body.data.status).toBe('upcoming');
    });

    test('clone records cloned_from reference', async () => {
      const res = await admin.post(`/api/races/${sourceId}/clone`).send({
        name: 'CloneRef', date: '2027-07-04',
      });
      expect(res.body.data.cloned_from).toBe(sourceId);
    });

    test('clone inherits source settings', async () => {
      const res = await admin.post(`/api/races/${sourceId}/clone`).send({
        name: 'CloneSettings', date: '2027-07-05',
      });
      expect(res.body.data.geofence_radius).toBe(50);
      expect(res.body.data.off_course_distance).toBe(300);
    });

    test('clone requires name and date → 400 if missing', async () => {
      const res = await admin.post(`/api/races/${sourceId}/clone`).send({ name: 'Only Name' });
      expect(res.status).toBe(400);
    });

    test('cloning a race with heats copies the heats', async () => {
      await admin.post(`/api/races/${sourceId}/heats`).send({ name: 'Wave A', color: '#ff0000' });
      const res = await admin.post(`/api/races/${sourceId}/clone`).send({
        name: 'CloneHeats', date: '2027-07-06',
      });
      const newId = res.body.data.id;
      const heats = await admin.get(`/api/races/${newId}/heats`);
      expect(heats.body.data.some(h => h.name === 'Wave A')).toBe(true);
    });

    test('clone nonexistent source → 404', async () => {
      const res = await admin.post('/api/races/999999/clone').send({ name: 'X', date: '2027-01-01' });
      expect(res.status).toBe(404);
    });
  });

  // ── Viewer token ──────────────────────────────────────────────────────────

  describe('viewer token', () => {
    let raceId;

    beforeAll(async () => {
      const r = await admin.post('/api/races').send({ name: 'Viewer Race', date: '2026-07-07' });
      raceId = r.body.data.id;
    });

    test('generates a 16-character hex token', async () => {
      const res = await admin.post(`/api/races/${raceId}/viewer-token`);
      expect(res.status).toBe(200);
      expect(res.body.data.token).toMatch(/^[0-9a-f]{16}$/);
    });

    test('generating again changes the token', async () => {
      const a = await admin.post(`/api/races/${raceId}/viewer-token`);
      const b = await admin.post(`/api/races/${raceId}/viewer-token`);
      expect(a.body.data.token).not.toBe(b.body.data.token);
    });

    test('DELETE removes the viewer token', async () => {
      await admin.post(`/api/races/${raceId}/viewer-token`);
      const res = await admin.delete(`/api/races/${raceId}/viewer-token`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    test('viewer-token for nonexistent race → 404', async () => {
      const res = await admin.post('/api/races/999999/viewer-token');
      expect(res.status).toBe(404);
    });
  });

  // ── Start window ──────────────────────────────────────────────────────────

  describe('start window', () => {
    let raceId;

    beforeAll(async () => {
      const r = await admin.post('/api/races').send({ name: 'Window Race', date: '2026-07-08' });
      raceId = r.body.data.id;
    });

    test('open start window sets flag', async () => {
      const res = await admin.post(`/api/races/${raceId}/start-window`).send({ action: 'open' });
      expect(res.status).toBe(200);
      expect(res.body.data.start_window_open).toBe(1);
    });

    test('close start window clears flag', async () => {
      await admin.post(`/api/races/${raceId}/start-window`).send({ action: 'open' });
      const res = await admin.post(`/api/races/${raceId}/start-window`).send({ action: 'close' });
      expect(res.body.data.start_window_open).toBe(0);
    });
  });
});
