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

describe('Auth API', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  // ── POST /api/auth/login ──────────────────────────────────────────────────

  describe('POST /api/auth/login', () => {
    test('missing credentials → 400', async () => {
      const res = await request(app).post('/api/auth/login').send({});
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/required/i);
    });

    test('missing password → 400', async () => {
      const res = await request(app).post('/api/auth/login').send({ username: 'admin' });
      expect(res.status).toBe(400);
    });

    test('missing username → 400', async () => {
      const res = await request(app).post('/api/auth/login').send({ password: 'admin' });
      expect(res.status).toBe(400);
    });

    test('unknown user → 401', async () => {
      const res = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'x' });
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });

    test('wrong password → 401', async () => {
      const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });

    test('correct credentials → 200 with user data', async () => {
      const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toMatchObject({ username: 'admin', role: 'admin' });
    });

    test('response does not include password hash', async () => {
      const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
      expect(res.body.data.password_hash).toBeUndefined();
    });
  });

  // ── GET /api/auth/me ──────────────────────────────────────────────────────

  describe('GET /api/auth/me', () => {
    test('unauthenticated → 401', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });

    test('authenticated → 200 with session user', async () => {
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ username: 'admin', password: 'admin' });
      const res = await agent.get('/api/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.username).toBe('admin');
      expect(res.body.data.role).toBe('admin');
    });
  });

  // ── POST /api/auth/logout ─────────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {
    test('returns ok:true', async () => {
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ username: 'admin', password: 'admin' });
      const res = await agent.post('/api/auth/logout');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    test('session is destroyed after logout', async () => {
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ username: 'admin', password: 'admin' });
      await agent.post('/api/auth/logout');
      const me = await agent.get('/api/auth/me');
      expect(me.status).toBe(401);
    });

    test('subsequent login after logout works', async () => {
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ username: 'admin', password: 'admin' });
      await agent.post('/api/auth/logout');
      const res = await agent.post('/api/auth/login').send({ username: 'admin', password: 'admin' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── Role-based access ─────────────────────────────────────────────────────

  describe('role-based access (admin vs operator)', () => {
    let adminAgent;

    beforeAll(async () => {
      adminAgent = request.agent(app);
      await adminAgent.post('/api/auth/login').send({ username: 'admin', password: 'admin' });

      // Create an operator user via the DB directly (avoiding users API for simplicity)
      const db = require('../../src/db');
      const bcrypt = require('bcrypt');
      const hash = bcrypt.hashSync('pass', 4); // low rounds for speed
      db.prepare("INSERT OR IGNORE INTO users (username, password_hash, role) VALUES ('op1', ?, 'operator')").run(hash);
    });

    test('operator cannot hit admin-only races endpoint (POST /api/races)', async () => {
      const opAgent = request.agent(app);
      await opAgent.post('/api/auth/login').send({ username: 'op1', password: 'pass' });
      const res = await opAgent.post('/api/races').send({ name: 'Op Race', date: '2026-01-01' });
      expect(res.status).toBe(403);
    });

    test('unauthenticated request to protected route → 401', async () => {
      const res = await request(app).get('/api/races');
      expect(res.status).toBe(401);
    });
  });

  // ── Concurrent-session displacement ──────────────────────────────────────

  describe('single-session enforcement', () => {
    test('second login invalidates first session token on protected routes', async () => {
      const agent1 = request.agent(app);
      const agent2 = request.agent(app);

      await agent1.post('/api/auth/login').send({ username: 'admin', password: 'admin' });
      // Second login displaces first by overwriting active_session_token in DB
      await agent2.post('/api/auth/login').send({ username: 'admin', password: 'admin' });

      // GET /api/races uses requireAuth which validates the token against the DB.
      // agent1's token is now stale, so the next request should be rejected.
      const races1 = await agent1.get('/api/races');
      expect(races1.status).toBe(401);
    });
  });
});
