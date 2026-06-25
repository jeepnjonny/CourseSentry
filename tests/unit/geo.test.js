'use strict';

const geo = require('../../src/geo');

// ── haversine ──────────────────────────────────────────────────────────────────

describe('haversine', () => {
  test('same point returns 0', () => {
    expect(geo.haversine(45, -122, 45, -122)).toBe(0);
  });

  test('equatorial degree ≈ 111 195 m', () => {
    expect(geo.haversine(0, 0, 0, 1)).toBeCloseTo(111195, -2);
  });

  test('meridional degree ≈ 111 195 m', () => {
    expect(geo.haversine(0, 0, 1, 0)).toBeCloseTo(111195, -2);
  });

  test('symmetric in both directions', () => {
    const d1 = geo.haversine(47.6062, -122.3321, 37.7749, -122.4194);
    const d2 = geo.haversine(37.7749, -122.4194, 47.6062, -122.3321);
    expect(d1).toBeCloseTo(d2, 0);
  });

  test('Seattle → San Francisco ≈ 1092 km', () => {
    const d = geo.haversine(47.6062, -122.3321, 37.7749, -122.4194);
    expect(d).toBeGreaterThan(1_080_000);
    expect(d).toBeLessThan(1_110_000);
  });

  test('100 m north is ≈ 100 m', () => {
    // ~0.0009 degrees latitude ≈ 100 m
    const d = geo.haversine(47.0, -122.0, 47.0009, -122.0);
    expect(d).toBeGreaterThan(80);
    expect(d).toBeLessThan(120);
  });
});

// ── inGeofence ────────────────────────────────────────────────────────────────

describe('inGeofence', () => {
  const lat = 47.6062, lon = -122.3321;

  test('same coordinates → inside', () => {
    expect(geo.inGeofence(lat, lon, lat, lon, 50)).toBe(true);
  });

  test('point ~50 m away, radius 100 m → inside', () => {
    // ~0.00045 degrees latitude ≈ 50 m
    expect(geo.inGeofence(lat + 0.00045, lon, lat, lon, 100)).toBe(true);
  });

  test('point 1 km away, radius 100 m → outside', () => {
    expect(geo.inGeofence(lat + 0.01, lon, lat, lon, 100)).toBe(false);
  });

  test('exact radius boundary is inside (≤)', () => {
    // The check is dist <= radius, so d=radius should be true
    const d = 100;
    // Construct a point that is exactly ~100 m north
    const offsetDeg = d / 111195;
    const nearLat = lat + offsetDeg;
    // haversine(nearLat, lon, lat, lon) ≈ 100 m
    // inGeofence uses <=, so it should be true
    expect(geo.inGeofence(nearLat, lon, lat, lon, Math.ceil(geo.haversine(nearLat, lon, lat, lon)))).toBe(true);
  });
});

// ── buildTrackMeta ────────────────────────────────────────────────────────────

describe('buildTrackMeta', () => {
  test('single point: dists=[0], total=0', () => {
    const { dists, total } = geo.buildTrackMeta([[47, -122]]);
    expect(dists).toEqual([0]);
    expect(total).toBe(0);
  });

  test('two equatorial points: cumulative distance matches haversine', () => {
    const points = [[0, 0], [0, 1]];
    const expected = geo.haversine(0, 0, 0, 1);
    const { dists, total } = geo.buildTrackMeta(points);
    expect(dists[0]).toBe(0);
    expect(dists[1]).toBeCloseTo(expected, 0);
    expect(total).toBeCloseTo(expected, 0);
  });

  test('three-point route accumulates correctly', () => {
    const points = [[0, 0], [0, 1], [0, 2]];
    const seg = geo.haversine(0, 0, 0, 1);
    const { dists, total } = geo.buildTrackMeta(points);
    expect(dists[0]).toBe(0);
    expect(dists[1]).toBeCloseTo(seg, 0);
    expect(dists[2]).toBeCloseTo(seg * 2, 0);
    expect(total).toBeCloseTo(seg * 2, 0);
  });

  test('monotonically non-decreasing distances', () => {
    const points = [[47.0, -122.0], [47.1, -122.0], [47.2, -122.1], [47.3, -122.1]];
    const { dists } = geo.buildTrackMeta(points);
    for (let i = 1; i < dists.length; i++) {
      expect(dists[i]).toBeGreaterThanOrEqual(dists[i - 1]);
    }
  });
});

// ── findPositionOnRoute ───────────────────────────────────────────────────────

describe('findPositionOnRoute', () => {
  const points = [[0, 0], [0, 1], [0, 2]];
  const meta   = geo.buildTrackMeta(points);

  test('point at start → 0 % complete', () => {
    const { percentComplete, distanceFromRoute } = geo.findPositionOnRoute(0, 0, points, meta);
    expect(percentComplete).toBeCloseTo(0, 1);
    expect(distanceFromRoute).toBeCloseTo(0, 0);
  });

  test('point at end → 100 % complete', () => {
    const { percentComplete } = geo.findPositionOnRoute(0, 2, points, meta);
    expect(percentComplete).toBeCloseTo(100, 1);
  });

  test('point at segment junction → 50 % complete', () => {
    const { percentComplete } = geo.findPositionOnRoute(0, 1, points, meta);
    expect(percentComplete).toBeCloseTo(50, 1);
  });

  test('off-route point has positive distanceFromRoute', () => {
    const { distanceFromRoute } = geo.findPositionOnRoute(0.5, 1, points, meta);
    expect(distanceFromRoute).toBeGreaterThan(0);
  });

  test('returns totalDistance matching meta.total', () => {
    const { totalDistance } = geo.findPositionOnRoute(0, 0, points, meta);
    expect(totalDistance).toBeCloseTo(meta.total, 0);
  });

  test('builds meta automatically when omitted', () => {
    const { percentComplete } = geo.findPositionOnRoute(0, 1, points);
    expect(percentComplete).toBeCloseTo(50, 1);
  });

  test('single-point route returns 0 % (no segments to project onto)', () => {
    const single = [[0, 0]];
    const m = geo.buildTrackMeta(single);
    const { percentComplete } = geo.findPositionOnRoute(0, 0, single, m);
    expect(percentComplete).toBe(0);
  });
});

// ── estimateETA ───────────────────────────────────────────────────────────────

describe('estimateETA', () => {
  test('1000 m at 2 m/s → 500 s', () => {
    expect(geo.estimateETA(1000, 2)).toBe(500);
  });

  test('zero pace → null', () => {
    expect(geo.estimateETA(1000, 0)).toBeNull();
  });

  test('negative pace → null', () => {
    expect(geo.estimateETA(1000, -1)).toBeNull();
  });

  test('null pace → null', () => {
    expect(geo.estimateETA(1000, null)).toBeNull();
  });

  test('zero distance → 0 s', () => {
    expect(geo.estimateETA(0, 5)).toBe(0);
  });

  test('result is rounded to integer', () => {
    const eta = geo.estimateETA(1001, 2);
    expect(Number.isInteger(eta)).toBe(true);
  });
});

// ── orderStationsByRoute ──────────────────────────────────────────────────────

describe('orderStationsByRoute', () => {
  const route = [[0, 0], [0, 1], [0, 2]];

  test('orders three stations by their position along route', () => {
    const stations = [
      { id: 1, lat: 0, lon: 1.8, name: 'Near End'   },
      { id: 2, lat: 0, lon: 0.2, name: 'Near Start' },
      { id: 3, lat: 0, lon: 1.0, name: 'Midpoint'   },
    ];
    const ordered = geo.orderStationsByRoute(stations, route);
    expect(ordered[0].name).toBe('Near Start');
    expect(ordered[1].name).toBe('Midpoint');
    expect(ordered[2].name).toBe('Near End');
  });

  test('assigns course_order starting from 0', () => {
    const stations = [
      { id: 1, lat: 0, lon: 0.5 },
      { id: 2, lat: 0, lon: 1.5 },
    ];
    const ordered = geo.orderStationsByRoute(stations, route);
    expect(ordered[0].course_order).toBe(0);
    expect(ordered[1].course_order).toBe(1);
  });

  test('single station gets course_order 0', () => {
    const stations = [{ id: 1, lat: 0, lon: 1.0 }];
    const ordered = geo.orderStationsByRoute(stations, route);
    expect(ordered[0].course_order).toBe(0);
  });

  test('preserves all original station fields', () => {
    const stations = [{ id: 42, lat: 0, lon: 0.5, name: 'Test', type: 'aid' }];
    const ordered = geo.orderStationsByRoute(stations, route);
    expect(ordered[0].id).toBe(42);
    expect(ordered[0].name).toBe('Test');
    expect(ordered[0].type).toBe('aid');
  });
});
