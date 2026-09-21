import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import type { SketchDocument } from '../../core/model';
import { distanceToSegment, hitTest, hitTestEntity, hitTestPoint } from './hit-test';

const { doc, corners, lines, layer } = rectangleFixture(480, 240);
const base = { doc, positions: doc.points, tolerance: 8 };

describe('distanceToSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };

  it('is perpendicular in the middle', () => {
    expect(distanceToSegment({ x: 50, y: 12 }, a, b)).toBeCloseTo(12, 9);
  });

  it('clamps past the ends rather than measuring to the infinite line', () => {
    expect(distanceToSegment({ x: -30, y: 0 }, a, b)).toBeCloseTo(30, 9);
    expect(distanceToSegment({ x: 140, y: 30 }, a, b)).toBeCloseTo(50, 9);
  });

  it('handles a zero-length segment', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, a, a)).toBeCloseTo(5, 9);
  });
});

describe('hitTestPoint', () => {
  it('finds a point within tolerance', () => {
    expect(hitTestPoint({ ...base, at: { x: 3, y: 2 } })?.id).toBe(corners[0]);
  });

  it('finds nothing beyond tolerance', () => {
    expect(hitTestPoint({ ...base, at: { x: 40, y: 40 } })).toBeUndefined();
  });

  it('prefers the nearer of two points', () => {
    // Just inside tolerance of the origin corner, far from the others.
    expect(hitTestPoint({ ...base, at: { x: 6, y: 0 } })?.id).toBe(corners[0]);
  });

  it('can be told to ignore a point', () => {
    const ignored = hitTestPoint({ ...base, at: { x: 0, y: 0 }, ignorePoints: new Set([corners[0]]) });
    expect(ignored).toBeUndefined();
  });
});

describe('hitTestEntity', () => {
  it('finds a line along its length', () => {
    expect(hitTestEntity({ ...base, at: { x: 240, y: 3 } })?.id).toBe(lines[0]);
  });

  it('finds nothing in open space', () => {
    expect(hitTestEntity({ ...base, at: { x: 240, y: 120 } })).toBeUndefined();
  });

  it('ignores entities on a hidden layer', () => {
    const hidden: SketchDocument = {
      ...doc,
      layers: { ...doc.layers, [layer]: { ...doc.layers[layer]!, visible: false } },
    };
    expect(hitTestEntity({ ...base, doc: hidden, at: { x: 240, y: 0 } })).toBeUndefined();
  });

  it('measures a circle to its rim, not its centre', () => {
    const circleDoc: SketchDocument = {
      ...doc,
      points: { c: { id: 'c', x: 100, y: 100 } },
      entities: {
        circle1: { id: 'circle1', kind: 'circle', center: 'c', radius: 50, layer, construction: false },
      },
      paths: {},
    };
    const input = { doc: circleDoc, positions: circleDoc.points, tolerance: 8 };

    expect(hitTestEntity({ ...input, at: { x: 152, y: 100 } })?.id).toBe('circle1');
    // The middle of the disc is not on the circle.
    expect(hitTestEntity({ ...input, at: { x: 100, y: 100 } })).toBeUndefined();
  });
});

describe('hitTest', () => {
  it('prefers a point over the line it belongs to', () => {
    // The origin corner sits on two lines; grabbing there must give the point.
    const hit = hitTest({ ...base, at: { x: 1, y: 1 } });
    expect(hit?.kind).toBe('point');
    expect(hit?.id).toBe(corners[0]);
  });

  it('falls through to the entity when no point is close', () => {
    const hit = hitTest({ ...base, at: { x: 240, y: 2 } });
    expect(hit?.kind).toBe('entity');
    expect(hit?.id).toBe(lines[0]);
  });

  it('uses solved positions when given them', () => {
    const moved = { ...doc.points, [corners[1]]: { id: corners[1], x: 900, y: 0 } };
    expect(hitTest({ ...base, positions: moved, at: { x: 900, y: 0 } })?.id).toBe(corners[1]);

    // The point has left its stored position. The line it belongs to now runs
    // through that spot, so the entity is still hit there -- but the point is not.
    expect(hitTestPoint({ ...base, positions: moved, at: { x: 480, y: 0 } })).toBeUndefined();
    expect(hitTest({ ...base, positions: moved, at: { x: 480, y: 0 } })?.kind).toBe('entity');
  });
});
