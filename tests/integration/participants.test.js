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

describe('Participants API', () => {
  let app;
  let admin;
  let raceId;

  beforeAll(async () => {
    app  = createApp();
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin' });

    const r = await admin.post('/api/races').send({ name: 'Participant Race', date: '2026-08-01' });
    raceId = r.body.data.id;
  });

  // ── GET / ─────────────────────────────────────────────────────────────────

  describe('GET /api/races/:raceId/participants', () => {
    test('unauthenticated → 401', async () => {
      const res = await request(app).get(`/api/races/${raceId}/participants`);
      expect(res.status).toBe(401);
    });

    test('returns ok:true with data array', async () => {
      const res = await admin.get(`/api/races/${raceId}/participants`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // ── POST / ────────────────────────────────────────────────────────────────

  describe('POST /api/races/:raceId/participants', () => {
    test('missing bib → 400', async () => {
      const res = await admin.post(`/api/races/${raceId}/participants`).send({ name: 'No Bib' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    test('missing name → 400', async () => {
      const res = await admin.post(`/api/races/${raceId}/participants`).send({ bib: '999' });
      expect(res.status).toBe(400);
    });

    test('creates participant with bib and name', async () => {
      const res = await admin.post(`/api/races/${raceId}/participants`).send({
        bib: '1', name: 'Alice',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.bib).toBe('1');
      expect(res.body.data.name).toBe('Alice');
    });

    test('new participant defaults to dns status', async () => {
      const res = await admin.post(`/api/races/${raceId}/participants`).send({
        bib: '2', name: 'Bob',
      });
      expect(res.body.data.status).toBe('dns');
    });

    test('stores optional fields', async () => {
      const res = await admin.post(`/api/races/${raceId}/participants`).send({
        bib: '3', name: 'Carol', age: 35, phone: '555-1234', tracker_id: 'ab12cd34',
      });
      expect(res.body.data.age).toBe(35);
      expect(res.body.data.phone).toBe('555-1234');
      expect(res.body.data.tracker_id).toBe('ab12cd34');
    });

    test('duplicate bib in same race → 409', async () => {
      await admin.post(`/api/races/${raceId}/participants`).send({ bib: '77', name: 'First' });
      const res = await admin.post(`/api/races/${raceId}/participants`).send({ bib: '77', name: 'Dupe' });
      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
    });

    test('same bib in different race is allowed', async () => {
      const r2 = await admin.post('/api/races').send({ name: 'Race 2', date: '2026-08-02' });
      const res = await admin.post(`/api/races/${r2.body.data.id}/participants`).send({
        bib: '1', name: 'Another Alice',
      });
      expect(res.status).toBe(200);
    });
  });

  // ── GET /:id ──────────────────────────────────────────────────────────────

  describe('GET /api/races/:raceId/participants/:id', () => {
    let pid;

    beforeAll(async () => {
      const r = await admin.post(`/api/races/${raceId}/participants`).send({ bib: '50', name: 'Detail' });
      pid = r.body.data.id;
    });

    test('returns participant with events array', async () => {
      const res = await admin.get(`/api/races/${raceId}/participants/${pid}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(pid);
      expect(Array.isArray(res.body.data.events)).toBe(true);
    });

    test('nonexistent participant → 404', async () => {
      const res = await admin.get(`/api/races/${raceId}/participants/999999`);
      expect(res.status).toBe(404);
    });
  });

  // ── PUT /:id ──────────────────────────────────────────────────────────────

  describe('PUT /api/races/:raceId/participants/:id', () => {
    let pid;

    beforeAll(async () => {
      const r = await admin.post(`/api/races/${raceId}/participants`).send({ bib: '60', name: 'Editable' });
      pid = r.body.data.id;
    });

    test('updates participant fields', async () => {
      const res = await admin.put(`/api/races/${raceId}/participants/${pid}`).send({ phone: '555-9999' });
      expect(res.status).toBe(200);
      expect(res.body.data.phone).toBe('555-9999');
    });

    test('setting status to dnf is persisted', async () => {
      const res = await admin.put(`/api/races/${raceId}/participants/${pid}`).send({ status: 'dnf' });
      expect(res.body.data.status).toBe('dnf');
    });

    test('setting a past start_time on a dns participant auto-activates', async () => {
      const r = await admin.post(`/api/races/${raceId}/participants`).send({ bib: '61', name: 'AutoActivate' });
      const id = r.body.data.id;
      const pastTs = Math.floor(Date.now() / 1000) - 3600;
      const res = await admin.put(`/api/races/${raceId}/participants/${id}`).send({ start_time: pastTs });
      expect(res.body.data.status).toBe('active');
    });

    test('nonexistent participant → 404', async () => {
      const res = await admin.put(`/api/races/${raceId}/participants/999999`).send({ phone: 'x' });
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /:id ───────────────────────────────────────────────────────────

  describe('DELETE /api/races/:raceId/participants/:id', () => {
    test('deletes a participant', async () => {
      const r = await admin.post(`/api/races/${raceId}/participants`).send({ bib: '88', name: 'To Delete' });
      const pid = r.body.data.id;
      const del = await admin.delete(`/api/races/${raceId}/participants/${pid}`);
      expect(del.status).toBe(200);
      const check = await admin.get(`/api/races/${raceId}/participants/${pid}`);
      expect(check.status).toBe(404);
    });

    test('nonexistent participant → 404', async () => {
      const res = await admin.delete(`/api/races/${raceId}/participants/999999`);
      expect(res.status).toBe(404);
    });
  });

  // ── PUT / (bulk update) ───────────────────────────────────────────────────

  describe('PUT /api/races/:raceId/participants (bulk)', () => {
    let p1, p2;

    beforeAll(async () => {
      const r1 = await admin.post(`/api/races/${raceId}/participants`).send({ bib: '201', name: 'Bulk1' });
      const r2 = await admin.post(`/api/races/${raceId}/participants`).send({ bib: '202', name: 'Bulk2' });
      p1 = r1.body.data.id;
      p2 = r2.body.data.id;
    });

    test('updates a permitted field on multiple ids', async () => {
      const res = await admin.put(`/api/races/${raceId}/participants`).send({
        ids: [p1, p2], field: 'status', value: 'dnf',
      });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(2);
    });

    test('disallowed field → 400', async () => {
      const res = await admin.put(`/api/races/${raceId}/participants`).send({
        ids: [p1], field: 'name', value: 'x',
      });
      expect(res.status).toBe(400);
    });

    test('empty ids array → 400', async () => {
      const res = await admin.put(`/api/races/${raceId}/participants`).send({
        ids: [], field: 'status', value: 'active',
      });
      expect(res.status).toBe(400);
    });
  });

  // ── DELETE / (bulk clear) ─────────────────────────────────────────────────

  describe('DELETE /api/races/:raceId/participants (bulk clear)', () => {
    test('clears all participants in a race', async () => {
      const r = await admin.post('/api/races').send({ name: 'Clear Race', date: '2026-08-10' });
      const rid = r.body.data.id;
      await admin.post(`/api/races/${rid}/participants`).send({ bib: '1', name: 'One' });
      await admin.post(`/api/races/${rid}/participants`).send({ bib: '2', name: 'Two' });

      const del = await admin.delete(`/api/races/${rid}/participants`);
      expect(del.status).toBe(200);
      expect(del.body.deleted).toBe(2);

      const list = await admin.get(`/api/races/${rid}/participants`);
      expect(list.body.data).toHaveLength(0);
    });
  });

  // ── POST /import ──────────────────────────────────────────────────────────

  describe('POST /api/races/:raceId/participants/import', () => {
    test('missing csv body → 400', async () => {
      const res = await admin.post(`/api/races/${raceId}/participants/import`).send({});
      expect(res.status).toBe(400);
    });

    test('imports valid CSV rows', async () => {
      const csv = 'bib,name\n301,CSV One\n302,CSV Two';
      const res = await admin.post(`/api/races/${raceId}/participants/import`).send({ csv });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.errors).toHaveLength(0);
      expect(res.body.data.some(p => p.bib === '301')).toBe(true);
    });

    test('rows missing bib or name are reported as errors', async () => {
      const csv = 'bib,name\n,No Bib\n303,Has Bib';
      const res = await admin.post(`/api/races/${raceId}/participants/import`).send({ csv });
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('import is idempotent: second import upserts by bib', async () => {
      const csv1 = 'bib,name\n401,Original Name';
      const csv2 = 'bib,name\n401,Updated Name';
      await admin.post(`/api/races/${raceId}/participants/import`).send({ csv: csv1 });
      await admin.post(`/api/races/${raceId}/participants/import`).send({ csv: csv2 });

      const list = await admin.get(`/api/races/${raceId}/participants`);
      const p = list.body.data.find(x => x.bib === '401');
      expect(p.name).toBe('Updated Name');
    });

    test('CSV with quoted fields is parsed correctly', async () => {
      const csv = 'bib,name\n501,"Smith, Jane"';
      const res = await admin.post(`/api/races/${raceId}/participants/import`).send({ csv });
      expect(res.body.data.some(p => p.name === 'Smith, Jane')).toBe(true);
    });

    test('CSV bib numbers are stored as strings', async () => {
      const csv = 'bib,name\n007,Bond';
      await admin.post(`/api/races/${raceId}/participants/import`).send({ csv });
      const list = await admin.get(`/api/races/${raceId}/participants`);
      const p = list.body.data.find(x => x.bib === '007');
      expect(p).toBeTruthy();
    });
  });
});
