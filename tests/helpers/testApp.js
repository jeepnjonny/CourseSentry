'use strict';

/**
 * Minimal Express app for integration tests.
 * No MQTT/APRS auto-connect; external services must be mocked by the test file
 * with jest.mock() before calling createApp().
 */

const express = require('express');
const session = require('express-session');

function createApp() {
  const app = express();

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true },
  }));

  // Mirror server.js method-override middleware
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.headers['x-http-method-override'] === 'DELETE')
      req.method = 'DELETE';
    next();
  });

  app.use('/api/auth',  require('../../src/routes/auth'));
  app.use('/api/races', require('../../src/routes/races'));

  const raceRouter = express.Router({ mergeParams: true });
  raceRouter.use('/stations',     require('../../src/routes/stations'));
  raceRouter.use('/participants', require('../../src/routes/participants'));
  raceRouter.use('/heats',        require('../../src/routes/heats'));
  raceRouter.use('/classes',      require('../../src/routes/classes'));
  raceRouter.use('/events',       require('../../src/routes/events'));
  app.use('/api/races/:raceId', raceRouter);

  app.use((err, req, res, _next) => {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
