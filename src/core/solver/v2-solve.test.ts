import { describe, expect, it } from 'vitest';
import {
  addArc,
  addConstraint,
  addEntity,
  addLine,
  addPoint,
  compose,
  createEmptyDocument,
  validate,
  type Constraint,
  type DocumentEdit,
  type SketchDocument,
} from '../model';
import { applySolution, solve } from './solve';

const build = (...edits: DocumentEdit[]) => compose(...edits)(createEmptyDocument());

/** Two lines sharing nothing, so each relation is tested on its own. */
function twoLines(constraints: Constraint[] = []): SketchDocument {
  return build(
    addPoint('a1', 0, 0),
    addPoint('a2', 100, 0),
    addPoint('b1', 0, 50),
    addPoint('b2', 90, 70),
    addLine('lineA', 'a1', 'a2', 'layer1'),
    addLine('lineB', 'b1', 'b2', 'layer1'),
    addConstraint({ id: 'fixA1', kind: 'fix', point: 'a1' }),
    addConstraint({ id: 'fixA2', kind: 'fix', point: 'a2' }),
    ...constraints.map((c) => addConstraint(c)),
  );
}

const angleOf = (doc: SketchDocument, p: string, q: string) =>
  Math.atan2(doc.points[q]!.y - doc.points[p]!.y, doc.points[q]!.x - doc.points[p]!.x);

describe('parallel', () => {
  it('turns the second line to match the first', () => {
    const doc = twoLines([{ id: 'c1', kind: 'parallel', a: 'lineA', b: 'lineB' }]);
    const solved = applySolution(doc, solve(doc));

    expect(angleOf(solved, 'b1', 'b2')).toBeCloseTo(0, 6);
    expect(validate(solved)).toEqual([]);
  });

  it('removes exactly one degree of freedom', () => {
    // Four points is 8; both ends of A are fixed, so 4 remain.
    expect(solve(twoLines()).dof).toBe(4);
    expect(solve(twoLines([{ id: 'c1', kind: 'parallel', a: 'lineA', b: 'lineB' }])).dof).toBe(3);
  });
});

describe('perpendicular', () => {
  it('brings the second line to a right angle', () => {
    const doc = twoLines([{ id: 'c1', kind: 'perpendicular', a: 'lineA', b: 'lineB' }]);
    const solved = applySolution(doc, solve(doc));

    expect(Math.abs(angleOf(solved, 'b1', 'b2'))).toBeCloseTo(Math.PI / 2, 6);
  });

  it('removes one degree of freedom', () => {
    expect(solve(twoLines([{ id: 'c1', kind: 'perpendicular', a: 'lineA', b: 'lineB' }])).dof).toBe(3);
  });
});

describe('collinear', () => {
  it('lays the second line along the first', () => {
    const doc = twoLines([{ id: 'c1', kind: 'collinear', a: 'lineA', b: 'lineB' }]);
    const solved = applySolution(doc, solve(doc));

    expect(solved.points['b1']!.y).toBeCloseTo(0, 6);
    expect(solved.points['b2']!.y).toBeCloseTo(0, 6);
  });

  it('removes two degrees of freedom, as the plan\'s table says', () => {
    expect(solve(twoLines([{ id: 'c1', kind: 'collinear', a: 'lineA', b: 'lineB' }])).dof).toBe(2);
  });
});

describe('equal', () => {
  it('matches two line lengths', () => {
    const doc = twoLines([{ id: 'c1', kind: 'equal', a: 'lineA', b: 'lineB' }]);
    const solved = applySolution(doc, solve(doc));
    const length = (p: string, q: string) =>
      Math.hypot(solved.points[q]!.x - solved.points[p]!.x, solved.points[q]!.y - solved.points[p]!.y);

    expect(length('b1', 'b2')).toBeCloseTo(100, 5);
  });

  it('matches two radii', () => {
    const doc = build(
      addPoint('ca', 0, 0),
      addPoint('cb', 300, 0),
      addEntity({ id: 'circA', kind: 'circle', center: 'ca', radius: 40, layer: 'layer1', construction: false }),
      addEntity({ id: 'circB', kind: 'circle', center: 'cb', radius: 90, layer: 'layer1', construction: false }),
      addConstraint({ id: 'fa', kind: 'fix', point: 'ca' }),
      addConstraint({ id: 'fb', kind: 'fix', point: 'cb' }),
      addConstraint({ id: 'da', kind: 'distance', p1: 'ca', p2: 'cb', value: 300 }),
      addConstraint({ id: 'c1', kind: 'equal', a: 'circA', b: 'circB' }),
    );
    const result = solve(doc);
    expect(result.radii['circA']).toBeCloseTo(result.radii['circB']!, 5);
  });
});

describe('concentric', () => {
  it('brings two centres together and removes two degrees of freedom', () => {
    const doc = build(
      addPoint('ca', 0, 0),
      addPoint('cb', 120, 40),
      addEntity({ id: 'circA', kind: 'circle', center: 'ca', radius: 40, layer: 'layer1', construction: false }),
      addEntity({ id: 'circB', kind: 'circle', center: 'cb', radius: 90, layer: 'layer1', construction: false }),
      addConstraint({ id: 'fa', kind: 'fix', point: 'ca' }),
      addConstraint({ id: 'c1', kind: 'concentric', a: 'circA', b: 'circB' }),
    );
    const result = solve(doc);

    expect(result.positions['cb']!.x).toBeCloseTo(0, 6);
    expect(result.positions['cb']!.y).toBeCloseTo(0, 6);
    // 4 point variables + 2 radii = 6; fix takes 2, concentric 2.
    expect(result.dof).toBe(2);
  });
});

describe('midpoint', () => {
  it('puts the point halfway along the line', () => {
    const doc = twoLines([{ id: 'c1', kind: 'midpoint', point: 'b1', entity: 'lineA' }]);
    const solved = applySolution(doc, solve(doc));

    expect(solved.points['b1']!.x).toBeCloseTo(50, 6);
    expect(solved.points['b1']!.y).toBeCloseTo(0, 6);
  });

  it('removes two degrees of freedom', () => {
    expect(solve(twoLines([{ id: 'c1', kind: 'midpoint', point: 'b1', entity: 'lineA' }])).dof).toBe(2);
  });
});

describe('symmetric', () => {
  it('mirrors two points about a line', () => {
    const doc = build(
      addPoint('a1', 0, 0),
      addPoint('a2', 0, 200),
      addPoint('p', 60, 40),
      addPoint('q', -90, 150),
      addLine('axis', 'a1', 'a2', 'layer1'),
      addConstraint({ id: 'f1', kind: 'fix', point: 'a1' }),
      addConstraint({ id: 'f2', kind: 'fix', point: 'a2' }),
      addConstraint({ id: 'fp', kind: 'fix', point: 'p' }),
      addConstraint({ id: 'c1', kind: 'symmetric', p1: 'p', p2: 'q', entity: 'axis' }),
    );
    const result = solve(doc);

    // The axis is the y axis, so the mirror of (60, 40) is (-60, 40).
    expect(result.converged).toBe(true);
    expect(result.positions['q']!.x).toBeCloseTo(-60, 5);
    expect(result.positions['q']!.y).toBeCloseTo(40, 5);
    expect(result.dof).toBe(0);
  });
});

describe('tangent', () => {
  it('brings a line to touch a circle', () => {
    const doc = build(
      addPoint('a1', -200, 100),
      addPoint('a2', 200, 100),
      addPoint('c', 0, 0),
      addLine('lineA', 'a1', 'a2', 'layer1'),
      addEntity({ id: 'circA', kind: 'circle', center: 'c', radius: 40, layer: 'layer1', construction: false }),
      addConstraint({ id: 'f1', kind: 'fix', point: 'a1' }),
      addConstraint({ id: 'fc', kind: 'fix', point: 'c' }),
      addConstraint({ id: 'h', kind: 'horizontal', p1: 'a1', p2: 'a2' }),
      addConstraint({ id: 'c1', kind: 'tangent', a: 'lineA', b: 'circA' }),
    );
    const result = solve(doc);

    // The line can only move by growing the radius to reach it, or... the
    // radius is free, so it grows to 100.
    expect(result.converged).toBe(true);
    expect(result.radii['circA']).toBeCloseTo(100, 5);
  });

  it('moves the line when the radius is pinned instead', () => {
    const doc = build(
      addPoint('a1', -200, 100),
      addPoint('a2', 200, 100),
      addPoint('c', 0, 0),
      addPoint('rim', 40, 0),
      addLine('lineA', 'a1', 'a2', 'layer1'),
      addEntity({ id: 'circA', kind: 'circle', center: 'c', radius: 40, layer: 'layer1', construction: false }),
      addConstraint({ id: 'fc', kind: 'fix', point: 'c' }),
      addConstraint({ id: 'fr', kind: 'fix', point: 'rim' }),
      addConstraint({ id: 'on', kind: 'point-on', point: 'rim', entity: 'circA' }),
      addConstraint({ id: 'h', kind: 'horizontal', p1: 'a1', p2: 'a2' }),
      addConstraint({ id: 'v', kind: 'vertical', p1: 'c', p2: 'a1' }),
      addConstraint({ id: 'c1', kind: 'tangent', a: 'lineA', b: 'circA' }),
    );
    const result = solve(doc);

    expect(result.converged).toBe(true);
    // Radius pinned at 40 by the fixed rim point, so the line settles there.
    expect(Math.abs(result.positions['a1']!.y)).toBeCloseTo(40, 4);
  });

  it('holds two circles at a sum of radii apart when they start outside', () => {
    const doc = build(
      addPoint('ca', 0, 0),
      addPoint('cb', 200, 0),
      addEntity({ id: 'circA', kind: 'circle', center: 'ca', radius: 40, layer: 'layer1', construction: false }),
      addEntity({ id: 'circB', kind: 'circle', center: 'cb', radius: 30, layer: 'layer1', construction: false }),
      addConstraint({ id: 'fa', kind: 'fix', point: 'ca' }),
      addConstraint({ id: 'h', kind: 'horizontal', p1: 'ca', p2: 'cb' }),
      addConstraint({ id: 'ra', kind: 'distance', p1: 'ca', p2: 'cb', value: 70 }),
      addConstraint({ id: 'c1', kind: 'tangent', a: 'circA', b: 'circB' }),
    );
    const result = solve(doc);

    expect(result.converged).toBe(true);
    expect(result.radii['circA']! + result.radii['circB']!).toBeCloseTo(70, 4);
  });
});

/**
 * The step's "done when": a slot — two straight sides joined by two arcs,
 * tangent at every join — driven to fully defined.
 */
describe('a slot can be fully defined', () => {
  /** Length between arc centres, and the slot's radius. */
  function slot(length = 300, radius = 50): SketchDocument {
    return build(
      // Arc centres, on the slot's axis.
      addPoint('c1', 0, 0),
      addPoint('c2', length, 0),
      // Where the straight sides meet the arcs.
      addPoint('t1', 0, -radius),
      addPoint('t2', length, -radius),
      addPoint('b1', 0, radius),
      addPoint('b2', length, radius),

      addLine('top', 't1', 't2', 'layer1'),
      addLine('bottom', 'b1', 'b2', 'layer1'),
      // The left arc runs from the top side round to the bottom; the right
      // arc comes back. Endpoints are shared with the lines.
      addArc('left', 'c1', 't1', 'b1', 'layer1', false),
      addArc('right', 'c2', 'b2', 't2', 'layer1', false),

      addConstraint({ id: 'fix1', kind: 'fix', point: 'c1' }),
      addConstraint({ id: 'axis', kind: 'horizontal', p1: 'c1', p2: 'c2' }),
      addConstraint({ id: 'len', kind: 'horizontal-distance', p1: 'c1', p2: 'c2', value: length }),
      addConstraint({ id: 'rad', kind: 'distance', p1: 'c1', p2: 't1', value: radius }),
      addConstraint({ id: 'same', kind: 'equal', a: 'left', b: 'right' }),
      addConstraint({ id: 'tan1', kind: 'tangent', a: 'top', b: 'left' }),
      addConstraint({ id: 'tan2', kind: 'tangent', a: 'top', b: 'right' }),
      addConstraint({ id: 'tan3', kind: 'tangent', a: 'bottom', b: 'left' }),
      addConstraint({ id: 'tan4', kind: 'tangent', a: 'bottom', b: 'right' }),
    );
  }

  it('validates and solves', () => {
    const doc = slot();
    expect(validate(doc)).toEqual([]);

    const result = solve(doc);
    expect(result.converged).toBe(true);
    expect(result.residual).toBeLessThan(1e-8);
  });

  it('is fully defined', () => {
    const result = solve(slot());
    expect(result.status).toBe('fully-defined');
    expect(result.dof).toBe(0);
  });

  it('every entity reads as fully defined', () => {
    const { entityStatus } = solve(slot());
    for (const id of ['top', 'bottom', 'left', 'right']) {
      expect(entityStatus[id], id).toBe('fully-defined');
    }
  });

  it('is driven by its length dimension', () => {
    const doc = slot(300, 50);
    const longer = {
      ...doc,
      constraints: { ...doc.constraints, len: { ...doc.constraints['len']!, value: 460 } as Constraint },
    };
    const result = solve(longer);

    expect(result.status).toBe('fully-defined');
    expect(result.positions['c2']!.x).toBeCloseTo(460, 4);
    expect(result.positions['t2']!.x).toBeCloseTo(460, 4);
    // The radius is untouched by a change of length.
    expect(Math.abs(result.positions['t1']!.y)).toBeCloseTo(50, 4);
  });

  it('is driven by its radius dimension, keeping the sides tangent', () => {
    const doc = slot(300, 50);
    const fatter = {
      ...doc,
      constraints: { ...doc.constraints, rad: { ...doc.constraints['rad']!, value: 80 } as Constraint },
    };
    const result = solve(fatter);

    expect(result.status).toBe('fully-defined');
    expect(Math.abs(result.positions['t1']!.y)).toBeCloseTo(80, 4);
    expect(Math.abs(result.positions['b2']!.y)).toBeCloseTo(80, 4);
    // Still a slot: both sides run straight along the axis.
    expect(result.positions['t1']!.y).toBeCloseTo(result.positions['t2']!.y, 4);
  });
});

/**
 * Why tangency is stated two different ways. This is the distinction that
 * decided whether a slot could be defined at all.
 */
describe('tangency at a join versus tangency by proximity', () => {
  /** A line ending on an arc: the usual join. */
  function join(): SketchDocument {
    return build(
      addPoint('c', 0, 0),
      addPoint('t', 0, -50),
      addPoint('far', 200, -50),
      addPoint('other', 0, 50),
      addLine('side', 't', 'far', 'layer1'),
      addArc('arc', 'c', 't', 'other', 'layer1', false),
      addConstraint({ id: 'fc', kind: 'fix', point: 'c' }),
      addConstraint({ id: 'ft', kind: 'fix', point: 't' }),
      addConstraint({ id: 'tan', kind: 'tangent', a: 'side', b: 'arc' }),
    );
  }

  it('a tangent join removes a degree of freedom', () => {
    // Stated as distance-to-line equals radius it removes none: that residual
    // sits at the boundary of an inequality, so its gradient is zero.
    const withJoin = solve(join());
    const withoutTangent = solve({
      ...join(),
      constraints: Object.fromEntries(
        Object.entries(join().constraints).filter(([id]) => id !== 'tan'),
      ),
    });

    expect(withJoin.dof).toBe(withoutTangent.dof - 1);
  });

  it('holds the line at a right angle to the radius', () => {
    const result = solve(join());
    const t = result.positions['t']!;
    const far = result.positions['far']!;
    const c = result.positions['c']!;

    const alongLine = { x: far.x - t.x, y: far.y - t.y };
    const alongRadius = { x: t.x - c.x, y: t.y - c.y };
    const cosine =
      (alongLine.x * alongRadius.x + alongLine.y * alongRadius.y) /
      (Math.hypot(alongLine.x, alongLine.y) * Math.hypot(alongRadius.x, alongRadius.y));

    expect(result.converged).toBe(true);
    expect(cosine).toBeCloseTo(0, 6);
  });

  it('a line that merely touches a circle uses the distance form', () => {
    // No shared point, so distance-to-line equals radius is correct here and
    // is not degenerate.
    const doc = build(
      addPoint('c', 0, 0),
      addPoint('a1', -100, 90),
      addPoint('a2', 100, 90),
      addLine('line', 'a1', 'a2', 'layer1'),
      addEntity({ id: 'circ', kind: 'circle', center: 'c', radius: 40, layer: 'layer1', construction: false }),
      addConstraint({ id: 'fc', kind: 'fix', point: 'c' }),
      addConstraint({ id: 'f1', kind: 'fix', point: 'a1' }),
      addConstraint({ id: 'h', kind: 'horizontal', p1: 'a1', p2: 'a2' }),
      addConstraint({ id: 'tan', kind: 'tangent', a: 'line', b: 'circ' }),
    );
    const result = solve(doc);

    expect(result.converged).toBe(true);
    // The radius is the only thing free to change, so it reaches the line.
    expect(result.radii['circ']).toBeCloseTo(90, 5);
    // One freedom is left over: how long the line is.
    expect(result.dof).toBe(1);
  });

  it('two arcs meeting at a point line their radii up', () => {
    const doc = build(
      addPoint('c1', 0, 0),
      addPoint('c2', 200, 0),
      addPoint('shared', 100, 20),
      addPoint('e1', 0, 60),
      addPoint('e2', 200, 60),
      addArc('a1', 'c1', 'e1', 'shared', 'layer1'),
      addArc('a2', 'c2', 'shared', 'e2', 'layer1'),
      addConstraint({ id: 'f1', kind: 'fix', point: 'c1' }),
      addConstraint({ id: 'f2', kind: 'fix', point: 'c2' }),
      // The shared point stays free: pinning all three would leave the
      // relation nothing to satisfy it with.
      addConstraint({ id: 'tan', kind: 'tangent', a: 'a1', b: 'a2' }),
    );
    const result = solve(doc);
    const p = result.positions['shared']!;
    const c1 = result.positions['c1']!;
    const c2 = result.positions['c2']!;

    // In line means the cross product of the two radii is zero.
    const cross =
      (p.x - c1.x) * (p.y - c2.y) - (p.y - c1.y) * (p.x - c2.x);
    expect(result.converged).toBe(true);
    expect(cross / (Math.hypot(p.x - c1.x, p.y - c1.y) * Math.hypot(p.x - c2.x, p.y - c2.y))).toBeCloseTo(0, 6);
  });
});
