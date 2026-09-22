import { describe, expect, it } from 'vitest';
import { inferSegment, relationIcon } from './inference';

const origin = { x: 0, y: 0 };
const at1 = { scale: 1 };

describe('inferSegment', () => {
  it('infers nothing for a clearly diagonal segment', () => {
    const result = inferSegment(origin, { x: 100, y: 100 }, at1);
    expect(result.relations).toEqual([]);
    expect(result.point).toEqual({ x: 100, y: 100 });
  });

  it('infers horizontal for a nearly level segment, and levels it exactly', () => {
    // 3px off over 200 is under a degree.
    const result = inferSegment(origin, { x: 200, y: 3 }, at1);
    expect(result.relations).toEqual(['horizontal']);
    expect(result.point).toEqual({ x: 200, y: 0 });
  });

  it('infers vertical and plumbs it exactly', () => {
    const result = inferSegment(origin, { x: -4, y: 200 }, at1);
    expect(result.relations).toEqual(['vertical']);
    expect(result.point).toEqual({ x: 0, y: 200 });
  });

  it('works away from the origin, levelling to the anchor', () => {
    const result = inferSegment({ x: 40, y: 90 }, { x: 240, y: 94 }, at1);
    expect(result.relations).toEqual(['horizontal']);
    expect(result.point).toEqual({ x: 240, y: 90 });
  });

  it('respects the tolerance at the boundary', () => {
    // 5 degrees over 100 is about 8.75px.
    expect(inferSegment(origin, { x: 100, y: 7 }, at1).relations).toEqual(['horizontal']);
    expect(inferSegment(origin, { x: 100, y: 12 }, at1).relations).toEqual([]);
  });

  it('never infers both axes at once', () => {
    for (const cursor of [{ x: 100, y: 1 }, { x: 1, y: 100 }, { x: 60, y: 60 }]) {
      expect(inferSegment(origin, cursor, at1).relations.length).toBeLessThanOrEqual(1);
    }
  });

  it('infers nothing for a segment too short to have a meaningful angle', () => {
    // A few pixels of cursor noise must not silently add a relation.
    expect(inferSegment(origin, { x: 6, y: 1 }, at1).relations).toEqual([]);
    expect(inferSegment(origin, { x: 6, y: 1 }, at1).point).toEqual({ x: 6, y: 1 });
  });

  it('measures the length guard in screen px, not world px', () => {
    // The same short world segment is long enough on screen when zoomed in.
    const cursor = { x: 6, y: 0.2 };
    expect(inferSegment(origin, cursor, { scale: 1 }).relations).toEqual([]);
    expect(inferSegment(origin, cursor, { scale: 8 }).relations).toEqual(['horizontal']);
  });

  it('leaves a joined point exactly where the geometry is', () => {
    // Nudging a shared point onto an axis would move the geometry it is
    // shared with, so the join wins.
    const result = inferSegment(origin, { x: 200, y: 3 }, { scale: 1, joined: true });
    expect(result.relations).toEqual([]);
    expect(result.point).toEqual({ x: 200, y: 3 });
  });

  it('takes a wider or narrower tolerance when asked', () => {
    const cursor = { x: 100, y: 12 };
    expect(inferSegment(origin, cursor, { scale: 1, angleTolerance: 10 }).relations).toEqual(['horizontal']);
    expect(inferSegment(origin, cursor, { scale: 1, angleTolerance: 1 }).relations).toEqual([]);
  });

  it('handles a zero-length segment without dividing by zero', () => {
    const result = inferSegment(origin, origin, at1);
    expect(result.relations).toEqual([]);
    expect(Number.isFinite(result.point.x)).toBe(true);
  });
});

describe('relationIcon', () => {
  it('matches the relation buttons', () => {
    expect(relationIcon('horizontal')).toBe('#i-horizontal');
    expect(relationIcon('vertical')).toBe('#i-vertical');
  });
});
