'use strict';

// downsampleTrack is a pure algorithm — import only what's needed.
// src/utils/course.js also imports src/db.js at module level; since DB_PATH is
// set to ':memory:' in tests/setup.js before Jest loads any module, the import
// is safe (schema is created, no file-system course files are touched).
const { downsampleTrack, TRACK_MIN_SPACING_M } = require('../../src/utils/course');

describe('downsampleTrack', () => {
  test('TRACK_MIN_SPACING_M is 35 m', () => {
    expect(TRACK_MIN_SPACING_M).toBe(35);
  });

  test('null input returns []', () => {
    expect(downsampleTrack(null)).toEqual([]);
  });

  test('undefined input returns []', () => {
    expect(downsampleTrack(undefined)).toEqual([]);
  });

  test('empty array returns []', () => {
    expect(downsampleTrack([])).toEqual([]);
  });

  test('single point returned unchanged', () => {
    expect(downsampleTrack([[47, -122]])).toEqual([[47, -122]]);
  });

  test('two-point array returned intact regardless of distance', () => {
    const pts = [[0, 0], [0, 0.0001]]; // ~11 m apart, below default threshold
    expect(downsampleTrack(pts)).toEqual(pts);
  });

  test('always retains the first point', () => {
    const pts = Array.from({ length: 5 }, (_, i) => [0, i * 0.001]);
    const result = downsampleTrack(pts, 500);
    expect(result[0]).toEqual(pts[0]);
  });

  test('always retains the last point', () => {
    const pts = Array.from({ length: 5 }, (_, i) => [0, i * 0.0001]); // ~11 m each
    const result = downsampleTrack(pts, 200); // 200 m min → middle points dropped
    expect(result[result.length - 1]).toEqual(pts[pts.length - 1]);
  });

  test('removes intermediate points closer than minDistanceM', () => {
    // ~11 m per step at equator; 200 m threshold drops all intermediate points
    const pts = Array.from({ length: 6 }, (_, i) => [0, i * 0.0001]);
    const result = downsampleTrack(pts, 200);
    // Only first and last survive
    expect(result).toEqual([pts[0], pts[pts.length - 1]]);
  });

  test('retains points spaced beyond threshold', () => {
    // ~111 m per step; 50 m threshold keeps all
    const pts = [[0, 0], [0, 0.001], [0, 0.002], [0, 0.003]];
    const result = downsampleTrack(pts, 50);
    expect(result.length).toBe(pts.length);
  });

  test('custom minDistanceM is respected over the default', () => {
    // Two points ~111 m apart; keep everything with 50 m threshold
    const pts = [[0, 0], [0, 0.001], [0, 1]];
    const tight = downsampleTrack(pts, 50);   // retains all 3
    const loose = downsampleTrack(pts, 200);  // drops [0, 0.001]
    expect(tight.length).toBe(3);
    expect(loose.length).toBe(2);
    expect(loose).toEqual([[0, 0], [0, 1]]);
  });

  test('output is always ordered (greedy forward walk preserves order)', () => {
    const pts = [[0, 0], [0, 0.001], [0, 0.002], [0, 0.01], [0, 0.011], [0, 1]];
    const result = downsampleTrack(pts, 50);
    for (let i = 1; i < result.length; i++) {
      expect(result[i][1]).toBeGreaterThanOrEqual(result[i - 1][1]);
    }
  });

  test('result has at least 2 points for a valid multi-point input', () => {
    const pts = [[0, 0], [0, 0.0001], [0, 0.0002], [0, 1]];
    const result = downsampleTrack(pts, 1000);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});
