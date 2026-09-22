import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import { validate, type Constraint, type Id, type SketchDocument } from '../model';
import { applySolution, solve } from './solve';

/** The fixture with one constraint removed. */
function without(doc: SketchDocument, ...ids: Id[]): SketchDocument {
  const constraints = { ...doc.constraints };
  for (const id of ids) delete constraints[id];
  return { ...doc, constraints };
}

function withConstraint(doc: SketchDocument, constraint: Constraint): SketchDocument {
  return { ...doc, constraints: { ...doc.constraints, [constraint.id]: constraint } };
}

function withValue(doc: SketchDocument, id: Id, value: number): SketchDocument {
  const constraint = doc.constraints[id]!;
  return { ...doc, constraints: { ...doc.constraints, [id]: { ...constraint, value } as Constraint } };
}

describe('solve: the rectangle from the plan', () => {
  it('reports zero DOF and fully defined once every constraint is in', () => {
    const { doc } = rectangleFixture();
    const result = solve(doc);

    expect(result.dof).toBe(0);
    expect(result.status).toBe('fully-defined');
    expect(result.conflicts).toEqual([]);
    expect(result.converged).toBe(true);
    expect(result.residual).toBeLessThan(1e-9);
  });

  it('leaves an already-solved sketch where it is', () => {
    const { doc, corners } = rectangleFixture(480, 240);
    const { positions } = solve(doc);

    expect(positions[corners[0]]!.x).toBeCloseTo(0, 9);
    expect(positions[corners[1]]!.x).toBeCloseTo(480, 9);
    expect(positions[corners[2]]!.y).toBeCloseTo(240, 9);
    expect(positions[corners[3]]!.x).toBeCloseTo(0, 9);
  });

  it('marks every entity fully defined', () => {
    const { doc, lines } = rectangleFixture();
    const { entityStatus } = solve(doc);

    for (const id of lines) expect(entityStatus[id], id).toBe('fully-defined');
  });

  it('loses one DOF when the width dimension goes', () => {
    const { doc, widthDimension } = rectangleFixture();
    const result = solve(without(doc, widthDimension));

    expect(result.dof).toBe(1);
    expect(result.status).toBe('under-defined');
  });

  it('knows which lines are still loose without the width dimension', () => {
    const { doc, widthDimension, lines } = rectangleFixture();
    const { entityStatus } = solve(without(doc, widthDimension));

    // Width is free, so the two right-hand corners can slide; only the left
    // edge touches neither of them.
    expect(entityStatus[lines[0]]).toBe('under-defined');
    expect(entityStatus[lines[1]]).toBe('under-defined');
    expect(entityStatus[lines[2]]).toBe('under-defined');
    expect(entityStatus[lines[3]]).toBe('fully-defined');
  });

  it('has two DOF with neither dimension', () => {
    const { doc, widthDimension, heightDimension } = rectangleFixture();
    expect(solve(without(doc, widthDimension, heightDimension)).dof).toBe(2);
  });

  it('has eight DOF with no constraints at all', () => {
    const { doc } = rectangleFixture();
    const result = solve({ ...doc, constraints: {} });

    expect(result.dof).toBe(8);
    expect(result.status).toBe('under-defined');
  });
});

describe('solve: editing a dimension moves the geometry', () => {
  it('widens the rectangle when the width dimension changes', () => {
    const { doc, widthDimension, corners } = rectangleFixture(480, 240);
    const result = solve(withValue(doc, widthDimension, 600));

    expect(result.status).toBe('fully-defined');
    expect(result.positions[corners[1]]!.x).toBeCloseTo(600, 6);
    expect(result.positions[corners[2]]!.x).toBeCloseTo(600, 6);
    // The fixed corner and the left edge stay put.
    expect(result.positions[corners[0]]!.x).toBeCloseTo(0, 6);
    expect(result.positions[corners[3]]!.x).toBeCloseTo(0, 6);
    expect(result.positions[corners[2]]!.y).toBeCloseTo(240, 6);
  });

  it('shortens it too, including to a smaller height', () => {
    const { doc, heightDimension, corners } = rectangleFixture(480, 240);
    const result = solve(withValue(doc, heightDimension, 90));

    expect(result.positions[corners[3]]!.y).toBeCloseTo(90, 6);
    expect(result.positions[corners[2]]!.y).toBeCloseTo(90, 6);
    expect(result.positions[corners[1]]!.y).toBeCloseTo(0, 6);
  });
});

describe('solve: redundant and conflicting constraints', () => {
  it('calls a consistent but redundant constraint over defined', () => {
    // The same width, dimensioned twice. Satisfiable, but the arithmetic
    // double-counts: nine rows that only pin down eight directions.
    const { doc, corners } = rectangleFixture(480, 240);
    const duplicate: Constraint = {
      id: 'c-dup',
      kind: 'horizontal-distance',
      p1: corners[0],
      p2: corners[1],
      value: 480,
    };
    const result = solve(withConstraint(doc, duplicate));

    expect(result.status).toBe('over-defined');
    expect(result.converged).toBe(true);
    expect(result.conflicts).toContain('c-dup');
  });

  it('calls a contradiction over defined and names both culprits', () => {
    const { doc, corners, widthDimension } = rectangleFixture(480, 240);
    const contradiction: Constraint = {
      id: 'c-bad',
      kind: 'horizontal-distance',
      p1: corners[0],
      p2: corners[1],
      value: 300,
    };
    const result = solve(withConstraint(doc, contradiction));

    expect(result.status).toBe('over-defined');
    expect(result.converged).toBe(false);
    // Either dimension could be the wrong one, so both are named.
    expect(result.conflicts).toContain('c-bad');
    expect(result.conflicts).toContain(widthDimension);
  });

  it('does not blame constraints that are pulling their weight', () => {
    const { doc, corners, heightDimension } = rectangleFixture(480, 240);
    const contradiction: Constraint = {
      id: 'c-bad',
      kind: 'horizontal-distance',
      p1: corners[0],
      p2: corners[1],
      value: 300,
    };
    const { conflicts } = solve(withConstraint(doc, contradiction));

    expect(conflicts).not.toContain(heightDimension);
  });

  it('leaves conflicts empty for a healthy sketch', () => {
    expect(solve(rectangleFixture().doc).conflicts).toEqual([]);
  });

  it('ignores a row that carries no gradient at all', () => {
    // Tangency between two lines is meaningless, so its residual row is all
    // zeros on purpose. Counting it as a constraint made the arithmetic read
    // "one more row than the rank" and call a perfectly healthy sketch over
    // defined — with nothing the user could remove to fix it, because the
    // row removes no freedom either.
    const { doc, lines } = rectangleFixture(480, 240);
    const nonsense: Constraint = { id: 'c-noop', kind: 'tangent', a: lines[0], b: lines[1] };
    const result = solve(withConstraint(doc, nonsense));

    expect(result.status).toBe('fully-defined');
    expect(result.dof).toBe(0);
    expect(result.conflicts).toEqual([]);
  });

  it('still blames a real duplicate when a no-op row is also present', () => {
    // The zero row must not mask a genuine dependency sitting next to it.
    const { doc, corners, lines, widthDimension } = rectangleFixture(480, 240);
    const nonsense: Constraint = { id: 'c-noop', kind: 'tangent', a: lines[0], b: lines[1] };
    const duplicate: Constraint = {
      id: 'c-dup',
      kind: 'horizontal-distance',
      p1: corners[0],
      p2: corners[1],
      value: 480,
    };
    const result = solve(withConstraint(withConstraint(doc, nonsense), duplicate));

    expect(result.status).toBe('over-defined');
    expect(result.conflicts).toContain('c-dup');
    expect(result.conflicts).toContain(widthDimension);
    expect(result.conflicts).not.toContain('c-noop');
  });
});

describe('solve: suspended constraints', () => {
  it('skips them, so geometry that relied on one goes back to under defined', () => {
    const { doc, widthDimension } = rectangleFixture();
    const suspended = { ...doc.constraints[widthDimension]!, suspended: true };
    const result = solve({ ...doc, constraints: { ...doc.constraints, [widthDimension]: suspended } });

    expect(result.dof).toBe(1);
    expect(result.status).toBe('under-defined');
  });
});

describe('solve: dragging', () => {
  it('moves a dragged point and takes its neighbours along', () => {
    // Width is free, so dragging the top-right corner in x widens the
    // rectangle; the vertical relation carries the bottom-right corner with it.
    const { doc, widthDimension, corners } = rectangleFixture(480, 240);
    const loose = without(doc, widthDimension);
    const result = solve(loose, { pinned: { [corners[1]]: { x: 600, y: 0 } } });

    expect(result.converged).toBe(true);
    expect(result.positions[corners[1]]!.x).toBeCloseTo(600, 6);
    expect(result.positions[corners[2]]!.x).toBeCloseTo(600, 6);
    expect(result.positions[corners[0]]!.x).toBeCloseTo(0, 6);
    expect(result.positions[corners[3]]!.x).toBeCloseTo(0, 6);
  });

  it('only moves along directions that are still free', () => {
    // Dragging in y as well: the horizontal relation to the fixed corner wins,
    // so y does not follow the cursor.
    const { doc, widthDimension, corners } = rectangleFixture(480, 240);
    const loose = without(doc, widthDimension);
    const result = solve(loose, { pinned: { [corners[1]]: { x: 600, y: 75 } } });

    expect(result.positions[corners[1]]!.x).toBeCloseTo(600, 6);
    expect(result.positions[corners[1]]!.y).toBeCloseTo(0, 6);
  });

  it('will not break a constraint to reach the cursor', () => {
    // The fixed corner must stay fixed however far the cursor is dragged.
    const { doc, widthDimension, corners } = rectangleFixture(480, 240);
    const loose = without(doc, widthDimension);
    const result = solve(loose, { pinned: { [corners[1]]: { x: 600, y: 75 } } });

    expect(result.positions[corners[0]]!.x).toBeCloseTo(0, 6);
    expect(result.positions[corners[0]]!.y).toBeCloseTo(0, 6);
    expect(result.converged).toBe(true);
    expect(result.residual).toBeLessThan(1e-9);
  });

  it('moves fully defined geometry not at all, and still calls it fully defined', () => {
    // A pin is a goal, not a constraint: it must not turn a healthy sketch red.
    const { doc, corners } = rectangleFixture(480, 240);
    const result = solve(doc, { pinned: { [corners[1]]: { x: 600, y: 90 } } });

    expect(result.status).toBe('fully-defined');
    expect(result.conflicts).toEqual([]);
    expect(result.positions[corners[1]]!.x).toBeCloseTo(480, 6);
    expect(result.positions[corners[1]]!.y).toBeCloseTo(0, 6);
  });

  it('keeps the height dimension while dragging in x', () => {
    const { doc, widthDimension, corners } = rectangleFixture(480, 240);
    const loose = without(doc, widthDimension);
    const result = solve(loose, { pinned: { [corners[1]]: { x: 600, y: 0 } } });

    expect(result.positions[corners[3]]!.y).toBeCloseTo(240, 6);
    expect(result.positions[corners[2]]!.y).toBeCloseTo(240, 6);
  });

  it('does not write the pin into the document', () => {
    const { doc, widthDimension, corners } = rectangleFixture(480, 240);
    const loose = without(doc, widthDimension);
    solve(loose, { pinned: { [corners[1]]: { x: 600, y: 0 } } });

    expect(loose.points[corners[1]]!.x).toBe(480);
    expect(Object.keys(loose.constraints)).toHaveLength(6);
  });
});

describe('solve: nonlinear constraints', () => {
  function twoPoints(constraints: Constraint[]): SketchDocument {
    return {
      version: 1,
      points: { p1: { id: 'p1', x: 0, y: 0 }, p2: { id: 'p2', x: 30, y: 40 } },
      entities: {},
      constraints: Object.fromEntries(constraints.map((c) => [c.id, c])),
      paths: {},
      layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
      layerOrder: ['layer1'],
    };
  }

  it('satisfies a straight-line distance', () => {
    const doc = twoPoints([
      { id: 'c1', kind: 'fix', point: 'p1' },
      { id: 'c2', kind: 'distance', p1: 'p1', p2: 'p2', value: 100 },
    ]);
    const { positions, converged, dof } = solve(doc);

    expect(converged).toBe(true);
    expect(Math.hypot(positions['p2']!.x, positions['p2']!.y)).toBeCloseTo(100, 6);
    expect(dof).toBe(1); // p2 can still swing around p1
  });

  it('pins a point with distance plus horizontal', () => {
    const doc = twoPoints([
      { id: 'c1', kind: 'fix', point: 'p1' },
      { id: 'c2', kind: 'distance', p1: 'p1', p2: 'p2', value: 100 },
      { id: 'c3', kind: 'horizontal', p1: 'p1', p2: 'p2' },
    ]);
    const result = solve(doc);

    expect(result.status).toBe('fully-defined');
    expect(result.positions['p2']!.x).toBeCloseTo(100, 6);
    expect(result.positions['p2']!.y).toBeCloseTo(0, 6);
  });

  it('converges from a poor starting guess', () => {
    const doc = twoPoints([
      { id: 'c1', kind: 'fix', point: 'p1' },
      { id: 'c2', kind: 'distance', p1: 'p1', p2: 'p2', value: 5000 },
      { id: 'c3', kind: 'vertical', p1: 'p1', p2: 'p2' },
    ]);
    const result = solve(doc);

    expect(result.converged).toBe(true);
    expect(Math.abs(result.positions['p2']!.y)).toBeCloseTo(5000, 4);
    expect(result.iterations).toBeLessThan(50);
  });
});

describe('solve: circles', () => {
  function circleSketch(constraints: Constraint[]): SketchDocument {
    return {
      version: 1,
      points: { p1: { id: 'p1', x: 10, y: 20 }, p2: { id: 'p2', x: 60, y: 20 } },
      entities: {
        circle1: { id: 'circle1', kind: 'circle', center: 'p1', radius: 30, layer: 'layer1', construction: false },
      },
      constraints: Object.fromEntries(constraints.map((c) => [c.id, c])),
      paths: {},
      layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
      layerOrder: ['layer1'],
    };
  }

  it('counts the radius as a degree of freedom', () => {
    // Two points (4) plus one radius = 5 variables, nothing constraining them.
    expect(solve(circleSketch([])).dof).toBe(5);
  });

  it('leaves the radius free once the centre is fixed', () => {
    const result = solve(circleSketch([{ id: 'c1', kind: 'fix', point: 'p1' }]));
    expect(result.dof).toBe(3); // p2 (2) + radius (1)
    expect(result.entityStatus['circle1']).toBe('under-defined');
  });

  it('resizes the circle to pass through a fixed point', () => {
    const result = solve(
      circleSketch([
        { id: 'c1', kind: 'fix', point: 'p1' },
        { id: 'c2', kind: 'fix', point: 'p2' },
        { id: 'c3', kind: 'point-on', point: 'p2', entity: 'circle1' },
      ]),
    );

    expect(result.status).toBe('fully-defined');
    expect(result.radii['circle1']).toBeCloseTo(50, 6);
    expect(result.entityStatus['circle1']).toBe('fully-defined');
  });
});

describe('applySolution', () => {
  it('writes solved positions into a new, valid document', () => {
    const { doc, widthDimension, corners } = rectangleFixture(480, 240);
    const widened = withValue(doc, widthDimension, 600);
    const next = applySolution(widened, solve(widened));

    expect(validate(next)).toEqual([]);
    expect(next.points[corners[1]]!.x).toBeCloseTo(600, 6);
    expect(doc.points[corners[1]]!.x).toBe(480); // original untouched
  });

  it('writes solved radii too', () => {
    const doc: SketchDocument = {
      version: 1,
      points: { p1: { id: 'p1', x: 0, y: 0 }, p2: { id: 'p2', x: 50, y: 0 } },
      entities: {
        circle1: { id: 'circle1', kind: 'circle', center: 'p1', radius: 30, layer: 'layer1', construction: false },
      },
      constraints: {
        c1: { id: 'c1', kind: 'fix', point: 'p1' },
        c2: { id: 'c2', kind: 'fix', point: 'p2' },
        c3: { id: 'c3', kind: 'point-on', point: 'p2', entity: 'circle1' },
      },
      paths: {},
      layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
      layerOrder: ['layer1'],
    };
    const next = applySolution(doc, solve(doc));
    const solved = next.entities['circle1']!;

    expect(validate(next)).toEqual([]);
    expect(solved.kind === 'circle' && solved.radius).toBeCloseTo(50, 6);
  });

  it('is idempotent on an already-solved document', () => {
    const { doc } = rectangleFixture();
    const once = applySolution(doc, solve(doc));
    const twice = applySolution(once, solve(once));

    for (const id of Object.keys(doc.points)) {
      expect(twice.points[id]!.x).toBeCloseTo(once.points[id]!.x, 9);
      expect(twice.points[id]!.y).toBeCloseTo(once.points[id]!.y, 9);
    }
  });
});

describe('solve: edge cases', () => {
  it('handles an empty document', () => {
    const empty: SketchDocument = {
      version: 1,
      points: {},
      entities: {},
      constraints: {},
      paths: {},
      layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
      layerOrder: ['layer1'],
    };
    const result = solve(empty);

    expect(result.dof).toBe(0);
    expect(result.status).toBe('fully-defined');
    expect(result.converged).toBe(true);
  });

  it('does not mutate the document it is given', () => {
    const { doc, widthDimension } = rectangleFixture(480, 240);
    const before = structuredClone(doc);
    solve(withValue(doc, widthDimension, 600));

    expect(doc).toEqual(before);
  });
});

describe('solve: the Step 11 dimensions', () => {
  /**
   * A hinge: one fixed line along +x, and a second line from the same corner
   * whose far end is free. Six variables, minus a fix (2) and a coincidence
   * built in by sharing the corner, leaves the second line free to swing and
   * stretch — exactly 4 DOF, of which an angle removes one and a length
   * another.
   */
  function hinge(constraints: Constraint[] = []): SketchDocument {
    return {
      version: 1,
      points: {
        o: { id: 'o', x: 0, y: 0 },
        a: { id: 'a', x: 100, y: 0 },
        b: { id: 'b', x: 70, y: 70 },
      },
      entities: {
        lineA: { id: 'lineA', kind: 'line', p1: 'o', p2: 'a', layer: 'layer1', construction: false },
        lineB: { id: 'lineB', kind: 'line', p1: 'o', p2: 'b', layer: 'layer1', construction: false },
      },
      constraints: Object.fromEntries(
        [
          { id: 'fix-o', kind: 'fix', point: 'o' },
          { id: 'fix-a', kind: 'fix', point: 'a' },
          ...constraints,
        ].map((c) => [c.id, c as Constraint]),
      ),
      layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
      layerOrder: ['layer1'],
      paths: {},
    };
  }

  /** The angle of lineB below the +x axis, in degrees, clockwise-positive. */
  const angleOfB = (result: ReturnType<typeof solve>) => {
    const b = result.positions['b']!;
    return (Math.atan2(b.y, b.x) * 180) / Math.PI;
  };

  it('drives a line to the angle it is given', () => {
    const doc = hinge([{ id: 'ang', kind: 'angle', a: 'lineA', b: 'lineB', value: 30 } as Constraint]);
    const result = solve(doc);

    expect(result.converged).toBe(true);
    expect(angleOfB(result)).toBeCloseTo(30, 6);
    // The free end can still slide along that direction, so one of the two
    // remaining freedoms is gone.
    expect(result.dof).toBe(1);
  });

  it('turns the geometry when the angle is changed', () => {
    // The point of a parametric sketch: the number is the input.
    const doc = hinge([{ id: 'ang', kind: 'angle', a: 'lineA', b: 'lineB', value: 30 } as Constraint]);
    const turned = withValue(doc, 'ang', 75);
    const result = solve(turned);

    expect(result.converged).toBe(true);
    expect(angleOfB(result)).toBeCloseTo(75, 6);
  });

  it('reaches a target on the far side of the wrap', () => {
    // -170 degrees is ten degrees the other way; the residual has to take the
    // short route or the solver walks nearly all the way round.
    const doc = hinge([{ id: 'ang', kind: 'angle', a: 'lineA', b: 'lineB', value: -170 } as Constraint]);
    const result = solve(doc);

    expect(result.converged).toBe(true);
    expect(Math.abs(angleOfB(result))).toBeCloseTo(170, 4);
  });

  it('pins a circle down with a radius, and again with a diameter', () => {
    const circle = (dimension: Constraint): SketchDocument => ({
      version: 1,
      points: { c: { id: 'c', x: 10, y: 10 } },
      entities: {
        circ: { id: 'circ', kind: 'circle', center: 'c', radius: 20, layer: 'layer1', construction: false },
      },
      constraints: Object.fromEntries([
        ['fix-c', { id: 'fix-c', kind: 'fix', point: 'c' } as Constraint],
        [dimension.id, dimension],
      ]),
      layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
      layerOrder: ['layer1'],
      paths: {},
    });

    const byRadius = solve(circle({ id: 'r', kind: 'radius', entity: 'circ', value: 50 } as Constraint));
    expect(byRadius.radii['circ']).toBeCloseTo(50, 9);
    expect(byRadius.status).toBe('fully-defined');

    const byDiameter = solve(circle({ id: 'd', kind: 'diameter', entity: 'circ', value: 100 } as Constraint));
    expect(byDiameter.radii['circ']).toBeCloseTo(50, 9);
    expect(byDiameter.status).toBe('fully-defined');
  });

  it('calls a radius and a diameter on the same circle redundant', () => {
    // They say the same thing, so the second removes nothing.
    const doc: SketchDocument = {
      version: 1,
      points: { c: { id: 'c', x: 0, y: 0 } },
      entities: {
        circ: { id: 'circ', kind: 'circle', center: 'c', radius: 20, layer: 'layer1', construction: false },
      },
      constraints: {
        'fix-c': { id: 'fix-c', kind: 'fix', point: 'c' },
        r: { id: 'r', kind: 'radius', entity: 'circ', value: 50 },
        d: { id: 'd', kind: 'diameter', entity: 'circ', value: 100 },
      },
      layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
      layerOrder: ['layer1'],
      paths: {},
    };
    const result = solve(doc);

    expect(result.status).toBe('over-defined');
    expect(result.conflicts).toContain('r');
    expect(result.conflicts).toContain('d');
  });

  it('holds a point a set distance off a line', () => {
    const doc = hinge([
      { id: 'pld', kind: 'point-line-distance', point: 'b', entity: 'lineA', value: 40 } as Constraint,
    ]);
    const result = solve(doc);

    expect(result.converged).toBe(true);
    // lineA runs along y = 0, so the distance is just |y|.
    expect(Math.abs(result.positions['b']!.y)).toBeCloseTo(40, 6);
    expect(result.dof).toBe(1);
  });

  it('keeps the point on the side it started', () => {
    const doc = hinge([
      { id: 'pld', kind: 'point-line-distance', point: 'b', entity: 'lineA', value: 40 } as Constraint,
    ]);
    // b starts below the line (y positive, since y is down).
    expect(solve(doc).positions['b']!.y).toBeGreaterThan(0);

    const above = { ...doc, points: { ...doc.points, b: { id: 'b', x: 70, y: -70 } } };
    expect(solve(above).positions['b']!.y).toBeLessThan(0);
  });
});

describe('solve: reference dimensions', () => {
  it('removes no freedom, unlike the driving dimension it looks like', () => {
    const { doc, corners } = rectangleFixture(480, 240);
    const measured: Constraint = {
      id: 'ref',
      kind: 'distance',
      p1: corners[0],
      p2: corners[2],
      value: 999, // deliberately wrong: a reference dimension drives nothing
      reference: true,
    };
    const withReference = withConstraint(doc, measured);
    const result = solve(withReference);

    expect(result.status).toBe('fully-defined');
    expect(result.dof).toBe(0);
    expect(result.converged).toBe(true);
    expect(result.conflicts).toEqual([]);
    // The geometry is exactly where it was: the 999 was never an input.
    expect(result.positions[corners[2]]!.x).toBeCloseTo(480, 9);
    expect(result.positions[corners[2]]!.y).toBeCloseTo(240, 9);
  });

  it('is not the same as suspending the dimension', () => {
    // Both are out of the solve, but a suspended dimension is expected back,
    // so switching one off must still leave the sketch under defined.
    const { doc, widthDimension } = rectangleFixture(480, 240);
    const suspended = {
      ...doc,
      constraints: {
        ...doc.constraints,
        [widthDimension]: { ...doc.constraints[widthDimension]!, suspended: true } as Constraint,
      },
    };
    expect(solve(suspended).dof).toBe(1);

    const referenced = {
      ...doc,
      constraints: {
        ...doc.constraints,
        [widthDimension]: { ...doc.constraints[widthDimension]!, reference: true } as Constraint,
      },
    };
    expect(solve(referenced).dof).toBe(1);
  });

  it('never appears in a conflict, however wrong its number is', () => {
    const { doc, corners, widthDimension } = rectangleFixture(480, 240);
    const contradiction: Constraint = {
      id: 'ref',
      kind: 'horizontal-distance',
      p1: corners[0],
      p2: corners[1],
      value: 300,
      reference: true,
    };
    const result = solve(withConstraint(doc, contradiction));

    expect(result.status).toBe('fully-defined');
    expect(result.conflicts).not.toContain('ref');
    expect(result.conflicts).not.toContain(widthDimension);
  });
});
