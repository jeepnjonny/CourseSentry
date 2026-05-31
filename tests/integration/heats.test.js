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

describe('Heats API', () => {
  let app;
  let admin;
  let raceId;

  beforeAll(async () => {
    app   = createApp();
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin' });

    const r = await admin.post('/api/races').send({ name: 'Heat Race', date: '2026-10-01' });
    raceId = r.body.data.id;
  });

  // ── GET / ─────────────────────────────────────────────────────────────────

  describe('GET /api/races/:raceId/heats', () => {
    test('returns ok:true with data array', async () => {
      const res = await admin.get(`/api/races/${raceId}/heats`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // ── POST / ────────────────────────────────────────────────────────────────

  describe('POST /api/races/:raceId/heats', () => {
    test('creates a heat with a name', async () => {
      const res = await admin.post(`/api/races/${raceId}/heats`).send({ name: 'Wave A' });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Wave A');
    });

    test('defaults color to #58a6ff and shape to circle', async () => {
      const res = await admin.post(`/api/races/${raceId}/heats`).send({ name: 'Default Heat' });
      expect(res.body.data.color).toBe('#58a6ff');
      expect(res.body.data.shape).toBe('circle');
    });

    test('accepts custom color and shape', async () => {
      const res = await admin.post(`/api/races/${raceId}/heats`).send({
        name: 'Custom', color: '#ff0000', shape: 'triangle',
      });
      expect(res.body.data.color).toBe('#ff0000');
      expect(res.body.data.shape).toBe('triangle');
    });

    test('missing name → 400', async () => {
      const res = await admin.post(`/api/races/${raceId}/heats`).send({ color: '#ff0000' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    test('returned heat has an integer id', async () => {
      const res = await admin.post(`/api/races/${raceId}/heats`).send({ name: 'ID Heat' });
      expect(Number.isInteger(res.body.data.id)).toBe(true);
    });
  });

  // ── PUT /:id ──────────────────────────────────────────────────────────────

  describe('PUT /api/races/:raceId/heats/:id', () => {
    let heatId;

    beforeAll(async () => {
      const r = await admin.post(`/api/races/${raceId}/heats`).send({ name: 'Mutable Heat' });
      heatId = r.body.data.id;
    });

    test('updates heat name', async () => {
      const res = await admin.put(`/api/races/${raceId}/heats/${heatId}`).send({ name: 'Renamed Heat' });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed Heat');
    });

    test('updates heat color', async () => {
      const res = await admin.put(`/api/races/${raceId}/heats/${heatId}`).send({ color: '#00ff00' });
      expect(res.body.data.color).toBe('#00ff00');
    });

    test('nonexistent heat → 404', async () => {
      const res = await admin.put(`/api/races/${raceId}/heats/999999`).send({ name: 'x' });
      expect(res.status).toBe(404);
    });

    test('heat in wrong race → 404', async () => {
      const r2 = await admin.post('/api/races').send({ name: 'Other', date: '2026-10-02' });
      const rid2 = r2.body.data.id;
      const res = await admin.put(`/api/races/${rid2}/heats/${heatId}`).send({ name: 'Steal' });
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /:id ───────────────────────────────────────────────────────────

  describe('DELETE /api/races/:raceId/heats/:id', () => {
    test('deletes a heat', async () => {
      const r = await admin.post(`/api/races/${raceId}/heats`).send({ name: 'To Delete' });
      const id = r.body.data.id;
      const del = await admin.delete(`/api/races/${raceId}/heats/${id}`);
      expect(del.status).toBe(200);
      expect(del.body.ok).toBe(true);
    });

    test('nonexistent heat → 404', async () => {
      const res = await admin.delete(`/api/races/${raceId}/heats/999999`);
      expect(res.status).toBe(404);
    });
  });

  // ── Heat + participant integration ────────────────────────────────────────

  describe('heat assignment on participants', () => {
    let heatId, participantId;

    beforeAll(async () => {
      const h = await admin.post(`/api/races/${raceId}/heats`).send({ name: 'Sprint' });
      heatId = h.body.data.id;

      const p = await admin.post(`/api/races/${raceId}/participants`).send({ bib: '10', name: 'Sprinter' });
      participantId = p.body.data.id;
    });

    test('assigning heat_id to participant reflects in enriched response', async () => {
      const res = await admin.put(`/api/races/${raceId}/participants/${participantId}`).send({
        heat_id: heatId,
      });
      expect(res.body.data.heat).toBeTruthy();
      expect(res.body.data.heat.name).toBe('Sprint');
    });

    test('deleting a heat nullifies heat_id on participants', async () => {
      await admin.delete(`/api/races/${raceId}/heats/${heatId}`);
      const p = await admin.get(`/api/races/${raceId}/participants/${participantId}`);
      expect(p.body.data.heat_id).toBeNull();
    });
  });
});
