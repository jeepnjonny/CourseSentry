'use strict';

/**
 * Weather Routes
 *
 * This module provides weather-related endpoints for races, integrating with OpenWeatherMap API
 * for current conditions and forecasts, and NWS (National Weather Service) for weather alerts.
 *
 * Key Features:
 * - Current weather conditions using race location
 * - 24-hour weather forecast
 * - Weather alerts for US locations (NWS)
 * - Automatic location resolution from tracks, courses, or stations
 * - Fallback API versions for compatibility
 * - Graceful handling of missing API keys or locations
 */

const express = require('express');
const https = require('https');
const fs = require('fs');
const db = require('../db');
const { requireAuth } = require('../auth');
const { parseTrack } = require('./tracks');

const router = express.Router({ mergeParams: true });

// HTTP headers for NWS API (required by their terms of service)
const NWS_HEADERS = {
  'User-Agent': 'CourseSentry/1.0 (race safety monitoring)',
  'Accept': 'application/geo+json'
};

// Severity levels for sorting weather alerts
const ALERT_SEVERITY = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

/**
 * Performs an HTTPS GET request and parses JSON response
 * Rejects on non-2xx status codes for proper error handling
 * @param {string|Object} url - URL string or options object
 * @param {Object} [headers] - Optional headers
 * @returns {Promise<Object>} Parsed JSON response
 */
function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const options = typeof url === 'string' ? { ...require('url').parse(url), headers } : url;

    https.get(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(json.message || json.title || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch (error) {
          reject(new Error('Invalid JSON response'));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Gets the first point from a race's track or course
 * Used as a fallback location for weather queries
 * @param {Object} race - Race object
 * @returns {Object|null} Location object with lat/lon or null
 */
function getTrackFirstPoint(race) {
  try {
    // Try course first
    if (race.course_id) {
      const { parseCourse } = require('./courses');
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);

      if (course) {
        const text = fs.readFileSync(course.file_path, 'utf8');
        const { trackPoints } = parseCourse(text, course.file_path, course.path_index);

        if (trackPoints?.length) {
          return { lat: trackPoints[0][0], lon: trackPoints[0][1] };
        }
      }
    }

    // Fall back to race track file
    if (!race.track_file) return null;

    const text = fs.readFileSync(race.track_file, 'utf8');
    const points = parseTrack(text, race.track_file, race.track_path_index || 0);

    return points?.length ? { lat: points[0][0], lon: points[0][1] } : null;
  } catch (error) {
    return null;
  }
}

/**
 * Gets the location of the first station for a race
 * Prefers start/start_finish type stations
 * @param {number} raceId - Race ID
 * @returns {Object|null} Location object with lat/lon or null
 */
function getStationPoint(raceId) {
  const station = db.prepare(
    "SELECT lat, lon FROM stations WHERE race_id=? AND type IN ('start','start_finish') LIMIT 1"
  ).get(raceId) || db.prepare(
    "SELECT lat, lon FROM stations WHERE race_id=? LIMIT 1"
  ).get(raceId);

  return station ? { lat: station.lat, lon: station.lon } : null;
}

/**
 * Resolves the best location for weather queries for a race
 * Priority: track/course first point > race weather_lat/lon > station location
 * @param {Object} race - Race object
 * @returns {Object|null} Location object with lat/lon or null
 */
function resolveLocation(race) {
  return getTrackFirstPoint(race)
    || (race.weather_lat ? { lat: race.weather_lat, lon: race.weather_lon } : null)
    || getStationPoint(race.id);
}

/**
 * Retrieves the OpenWeatherMap API key from settings
 * @returns {string|null} API key or null if not configured
 */
function resolveKey() {
  return db.prepare("SELECT value FROM settings WHERE key='weather_api_key'").get()?.value || null;
}

/**
 * GET / - Retrieves current weather conditions for a race location
 * Requires authentication. Uses OpenWeatherMap API with fallback versions.
 * @param {string} req.params.raceId - Race ID from URL
 * @returns {Object} JSON response with current weather data
 */
router.get('/', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  const apiKey = resolveKey();
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: 'No OpenWeather API key configured in Settings' });
  }

  const location = resolveLocation(race);
  if (!location) {
    return res.status(400).json({
      ok: false,
      error: 'No location for this race — add a course, track file, or at least one station'
    });
  }

  const { lat, lon } = location;

  // Try current weather API first
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
    const data = await httpGet(url);
    return res.json({ ok: true, data });
  } catch (error) {
    // Ignore and try fallback
  }

  // Fallback to One Call API 3.0
  try {
    const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,daily&appid=${apiKey}&units=imperial`;
    const data = await httpGet(url);
    return res.json({ ok: true, data });
  } catch (error) {
    return res.status(502).json({ ok: false, error: `OpenWeather API error: ${error.message}` });
  }
});

/**
 * GET /forecast - Retrieves 24-hour weather forecast
 * Requires authentication. Uses OpenWeatherMap 2.5 forecast API.
 * @param {string} req.params.raceId - Race ID from URL
 * @returns {Object} JSON response with forecast data array
 */
router.get('/forecast', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  const apiKey = resolveKey();
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: 'No OpenWeather API key configured in Settings' });
  }

  const location = resolveLocation(race);
  if (!location) {
    return res.status(400).json({ ok: false, error: 'No location for this race' });
  }

  const { lat, lon } = location;

  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial&cnt=8`;
    const data = await httpGet(url);
    return res.json({ ok: true, data: data.list || [] });
  } catch (error) {
    return res.status(502).json({ ok: false, error: `OpenWeather API error: ${error.message}` });
  }
});

/**
 * GET /alerts - Retrieves active weather alerts from NWS (US only)
 * Requires authentication. No API key required. Returns empty array for non-US locations.
 * @param {string} req.params.raceId - Race ID from URL
 * @returns {Object} JSON response with sorted alerts array
 */
router.get('/alerts', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) {
    return res.status(404).json({ ok: false, error: 'Race not found' });
  }

  const location = resolveLocation(race);
  if (!location) {
    return res.status(400).json({ ok: false, error: 'No location for this race' });
  }

  const { lat, lon } = location;

  try {
    const url = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`;
    const data = await httpGet(url, NWS_HEADERS);

    const alerts = (data.features || [])
      .map(feature => ({
        event: feature.properties.event,
        severity: feature.properties.severity,
        urgency: feature.properties.urgency,
        certainty: feature.properties.certainty,
        headline: feature.properties.headline,
        description: feature.properties.description,
        effective: feature.properties.effective,
        expires: feature.properties.expires,
      }))
      .sort((a, b) => (ALERT_SEVERITY[b.severity] || 0) - (ALERT_SEVERITY[a.severity] || 0));

    return res.json({ ok: true, data: alerts });
  } catch (error) {
    // NWS only covers US; return empty array instead of error for non-US races
    return res.json({ ok: true, data: [], warning: error.message });
  }
});

module.exports = router;
