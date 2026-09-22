import { describe, expect, it } from 'vitest';
import { addArc, addPoint, compose, createEmptyDocument } from './model';
import {
  angleOf,
  arcContainsAngle,
  arcPoint,
  arcShape,
  normalizeAngle,
  sketchBounds,
  sweepAngle,
} from './geometry';

const QUARTER = Math.PI / 2;
const origin = { x: 0, y: 0 };

describe('angles, y-down', () => {
  it('measures clockwise on screen as increasing', () => {
    // y-down: (0,100) is *below* the centre, a quarter turn clockwise from (100,0).
    expect(angleOf(origin, { x: 100, y: 0 })).toBeCloseTo(0, 9);
    expect(angleOf(origin, { x: 0, y: 100 })).toBeCloseTo(QUARTER, 9);
    expect(angleOf(origin, { x: 0, y: -100 })).toBeCloseTo(-QUARTER, 9);
  });

  it('wraps into a single turn', () => {
    expect(normalizeAngle(-QUARTER)).toBeCloseTo(3 * QUARTER, 9);
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(Math.PI * 5)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngle(-Math.PI * 3)).toBeCloseTo(Math.PI, 9);
  });

  it('places a point back at the angle it came from', () => {
    const p = arcPoint(origin, 50, QUARTER);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(50, 9);
  });
});

describe('sweepAngle', () => {
  it('measures the short way round when travelling that way', () => {
    expect(sweepAngle(0, QUARTER, true)).toBeCloseTo(QUARTER, 9);
  });

  it('measures the long way round when travelling the other way', () => {
    expect(sweepAngle(0, QUARTER, false)).toBeCloseTo(3 * QUARTER, 9);
  });

  it('reads coincident ends as a whole turn, not as nothing', () => {
    // An arc whose ends have been dragged together is still an arc; drawing it
    // as a zero-length stub would make it vanish.
    expect(sweepAngle(QUARTER, QUARTER, true)).toBeCloseTo(Math.PI * 2, 9);
  });
});

describe('arcContainsAngle', () => {
  it('includes the swept side and excludes the rest', () => {
    // Quarter arc clockwise from angle 0 to a quarter turn.
    expect(arcContainsAngle(0, QUARTER, true, QUARTER / 2)).toBe(true);
    expect(arcContainsAngle(0, QUARTER, true, -QUARTER / 2)).toBe(false);
    expect(arcContainsAngle(0, QUARTER, true, Math.PI)).toBe(false);
  });

  it('includes both ends', () => {
    expect(arcContainsAngle(0, QUARTER, true, 0)).toBe(true);
    expect(arcContainsAngle(0, QUARTER, true, QUARTER)).toBe(true);
  });

  it('covers the other three quarters when travelling the other way', () => {
    expect(arcContainsAngle(0, QUARTER, false, Math.PI)).toBe(true);
    expect(arcContainsAngle(0, QUARTER, false, QUARTER / 2)).toBe(false);
  });
});

describe('arcShape', () => {
  const doc = compose(
    addPoint('c', 0, 0),
    addPoint('s', 100, 0),
    addPoint('e', 0, 100),
    addArc('arc1', 'c', 's', 'e', 'layer1'),
  )(createEmptyDocument());

  it('resolves radius, angles and sweep', () => {
    const shape = arcShape(doc.entities['arc1'] as never, doc.points)!;
    expect(shape.radius).toBeCloseTo(100, 9);
    expect(shape.startAngle).toBeCloseTo(0, 9);
    expect(shape.endAngle).toBeCloseTo(QUARTER, 9);
    expect(shape.sweep).toBeCloseTo(QUARTER, 9);
  });

  it('is undefined when a point is missing or the radius is zero', () => {
    expect(arcShape(doc.entities['arc1'] as never, {})).toBeUndefined();
    const degenerate = { ...doc.points, s: { id: 's', x: 0, y: 0 } };
    expect(arcShape(doc.entities['arc1'] as never, degenerate)).toBeUndefined();
  });
});

describe('sketchBounds with arcs', () => {
  /** Compass points come from cos and sin, so a zero is only nearly zero. */
  const expectBounds = (
    actual: ReturnType<typeof sketchBounds>,
    expected: { minX: number; minY: number; maxX: number; maxY: number },
  ) => {
    expect(actual).toBeDefined();
    for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const) {
      expect(actual![key], key).toBeCloseTo(expected[key], 9);
    }
  };

  it('boxes a quarter arc to the quarter, not to the whole circle', () => {
    const doc = compose(
      addPoint('c', 0, 0),
      addPoint('s', 100, 0),
      addPoint('e', 0, 100),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
    )(createEmptyDocument());

    // The arc runs from (100,0) clockwise to (0,100), passing no compass point
    // beyond its ends, so the box is just the points themselves.
    expectBounds(sketchBounds(doc), { minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });

  it('pushes the box out to a compass point the arc actually crosses', () => {
    // Clockwise from (0,-100) round to (0,100) passes through (100,0).
    const doc = compose(
      addPoint('c', 0, 0),
      addPoint('s', 0, -100),
      addPoint('e', 0, 100),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
    )(createEmptyDocument());

    expectBounds(sketchBounds(doc), { minX: 0, minY: -100, maxX: 100, maxY: 100 });
  });

  it('boxes an arc even when the positions map only mentions other points', () => {
    // `arcShape` does its own lookups and has nothing to fall back on, so a
    // partial map used to drop the arc out of the bounds — and with it out of
    // zoom-to-fit and the exported viewBox.
    const doc = compose(
      addPoint('c', 0, 0),
      addPoint('s', 0, -100),
      addPoint('e', 0, 100),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
      addPoint('loose', 5, 5),
    )(createEmptyDocument());

    expectBounds(sketchBounds(doc, { loose: { x: 5, y: 5 } }), {
      minX: 0,
      minY: -100,
      maxX: 100,
      maxY: 100,
    });
  });

  it('boxes the other way round to the other side', () => {
    const doc = compose(
      addPoint('c', 0, 0),
      addPoint('s', 0, -100),
      addPoint('e', 0, 100),
      addArc('arc1', 'c', 's', 'e', 'layer1', false),
    )(createEmptyDocument());

    expectBounds(sketchBounds(doc), { minX: -100, minY: -100, maxX: 0, maxY: 100 });
  });
});
