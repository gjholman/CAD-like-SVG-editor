import { describe, expect, it } from 'vitest';
import { createRng } from '../../../tests/fixtures/random-edits';
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
  type SketchDocument,
} from '../model';
import { at } from './linalg';
import { assemble, constraintRows } from './residuals';
import { initialVector, mapVariables } from './variables';

/** Two lines, two circles and an arc, all at untidy coordinates. */
function sandbox(rng?: () => number): SketchDocument {
  const c = rng === undefined
    ? [13.7, -42.1, -88.25, 19.6, 56.4, 71.9, -31.2, 64.4, 22.5, -9.75, 91.3, 18.2, -7.4, 55.1]
    : Array.from({ length: 14 }, () => Math.round((rng() * 300 - 150) * 100) / 100);

  return compose(
    addPoint('a1', c[0]!, c[1]!),
    addPoint('a2', c[2]!, c[3]!),
    addPoint('b1', c[4]!, c[5]!),
    addPoint('b2', c[6]!, c[7]!),
    addPoint('ca', c[8]!, c[9]!),
    addPoint('cb', c[10]!, c[11]!),
    addPoint('as', c[12]!, c[13]!),
    addLine('lineA', 'a1', 'a2', 'layer1'),
    addLine('lineB', 'b1', 'b2', 'layer1'),
    addEntity({ id: 'circA', kind: 'circle', center: 'ca', radius: 37.5, layer: 'layer1', construction: false }),
    addEntity({ id: 'circB', kind: 'circle', center: 'cb', radius: 21.25, layer: 'layer1', construction: false }),
    addArc('arcA', 'cb', 'as', 'b1', 'layer1'),
  )(createEmptyDocument());
}

/**
 * The autodiff gives exact derivatives by construction, so this is the check
 * that the *expression* is right — the same finite-difference test the
 * hand-derived v1 residuals get.
 */
function expectJacobianMatchesNumeric(doc: SketchDocument, constraint: Constraint, where: string): void {
  const withConstraint = addConstraint(constraint)(doc);
  expect(validate(withConstraint), `${where}: fixture`).toEqual([]);

  const variables = mapVariables(withConstraint);
  const x = initialVector(withConstraint, variables);
  const rowsAt = (values: Float64Array) => constraintRows(constraint, withConstraint, variables, values);
  const { jacobian } = assemble(rowsAt(x), variables.count);
  const step = 1e-6;

  for (let row = 0; row < jacobian.rows; row += 1) {
    for (let column = 0; column < variables.count; column += 1) {
      const forward = Float64Array.from(x);
      const backward = Float64Array.from(x);
      forward[column] = forward[column]! + step;
      backward[column] = backward[column]! - step;
      const numeric =
        (rowsAt(forward)[row]!.residual - rowsAt(backward)[row]!.residual) / (2 * step);

      expect(at(jacobian, row, column), `${where}: d(row ${row})/d(var ${column})`).toBeCloseTo(
        numeric,
        4,
      );
    }
  }
}

const CASES: ReadonlyArray<readonly [string, Constraint]> = [
  ['parallel', { id: 'c1', kind: 'parallel', a: 'lineA', b: 'lineB' }],
  ['perpendicular', { id: 'c1', kind: 'perpendicular', a: 'lineA', b: 'lineB' }],
  ['collinear', { id: 'c1', kind: 'collinear', a: 'lineA', b: 'lineB' }],
  ['equal lines', { id: 'c1', kind: 'equal', a: 'lineA', b: 'lineB' }],
  ['equal circles', { id: 'c1', kind: 'equal', a: 'circA', b: 'circB' }],
  ['equal circle and arc', { id: 'c1', kind: 'equal', a: 'circA', b: 'arcA' }],
  ['concentric circles', { id: 'c1', kind: 'concentric', a: 'circA', b: 'circB' }],
  ['concentric circle and arc', { id: 'c1', kind: 'concentric', a: 'circA', b: 'arcA' }],
  ['midpoint', { id: 'c1', kind: 'midpoint', point: 'ca', entity: 'lineA' }],
  ['symmetric', { id: 'c1', kind: 'symmetric', p1: 'ca', p2: 'cb', entity: 'lineA' }],
  ['tangent line and circle', { id: 'c1', kind: 'tangent', a: 'lineA', b: 'circA' }],
  ['tangent circle and line', { id: 'c1', kind: 'tangent', a: 'circA', b: 'lineA' }],
  ['tangent line and arc', { id: 'c1', kind: 'tangent', a: 'lineA', b: 'arcA' }],
  ['tangent two circles', { id: 'c1', kind: 'tangent', a: 'circA', b: 'circB' }],
  ['tangent circle and arc', { id: 'c1', kind: 'tangent', a: 'circA', b: 'arcA' }],
  ['angle', { id: 'c1', kind: 'angle', a: 'lineA', b: 'lineB', value: 37 }],
  ['angle, target near the wrap', { id: 'c1', kind: 'angle', a: 'lineA', b: 'lineB', value: 179.5 }],
  ['radius of a circle', { id: 'c1', kind: 'radius', entity: 'circA', value: 41 }],
  ['radius of an arc', { id: 'c1', kind: 'radius', entity: 'arcA', value: 41 }],
  ['diameter of a circle', { id: 'c1', kind: 'diameter', entity: 'circA', value: 82 }],
  ['diameter of an arc', { id: 'c1', kind: 'diameter', entity: 'arcA', value: 82 }],
  ['point to line distance', { id: 'c1', kind: 'point-line-distance', point: 'ca', entity: 'lineA', value: 30 }],
];

describe('v2 Jacobians match finite differences', () => {
  it.each(CASES)('%s', (name, constraint) => {
    expectJacobianMatchesNumeric(sandbox(), constraint, name);
  });

  it('holds at many random configurations', () => {
    const rng = createRng(97);
    for (let trial = 0; trial < 12; trial += 1) {
      const doc = sandbox(rng);
      for (const [name, constraint] of CASES) {
        expectJacobianMatchesNumeric(doc, constraint, `trial ${trial} ${name}`);
      }
    }
  });
});

describe('row counts match the plan\'s DOF table', () => {
  const rowsFor = (constraint: Constraint) => {
    const doc = addConstraint(constraint)(sandbox());
    const variables = mapVariables(doc);
    return constraintRows(constraint, doc, variables, initialVector(doc, variables)).length;
  };

  it.each([
    ['parallel', { id: 'c1', kind: 'parallel', a: 'lineA', b: 'lineB' } as Constraint, 1],
    ['perpendicular', { id: 'c1', kind: 'perpendicular', a: 'lineA', b: 'lineB' } as Constraint, 1],
    ['collinear', { id: 'c1', kind: 'collinear', a: 'lineA', b: 'lineB' } as Constraint, 2],
    ['tangent', { id: 'c1', kind: 'tangent', a: 'lineA', b: 'circA' } as Constraint, 1],
    ['equal', { id: 'c1', kind: 'equal', a: 'lineA', b: 'lineB' } as Constraint, 1],
    ['concentric', { id: 'c1', kind: 'concentric', a: 'circA', b: 'circB' } as Constraint, 2],
    ['midpoint', { id: 'c1', kind: 'midpoint', point: 'ca', entity: 'lineA' } as Constraint, 2],
    ['symmetric', { id: 'c1', kind: 'symmetric', p1: 'ca', p2: 'cb', entity: 'lineA' } as Constraint, 2],
    ['angle', { id: 'c1', kind: 'angle', a: 'lineA', b: 'lineB', value: 37 } as Constraint, 1],
    ['radius', { id: 'c1', kind: 'radius', entity: 'circA', value: 41 } as Constraint, 1],
    ['diameter', { id: 'c1', kind: 'diameter', entity: 'circA', value: 82 } as Constraint, 1],
    ['point-line-distance', { id: 'c1', kind: 'point-line-distance', point: 'ca', entity: 'lineA', value: 30 } as Constraint, 1],
  ])('%s produces %i row(s)', (_name, constraint, expected) => {
    expect(rowsFor(constraint)).toBe(expected);
  });
});

/** Everything collapsed onto one spot: zero-length lines, zero-radius circles. */
function degenerate(): SketchDocument {
  return compose(
    addPoint('a1', 0, 0),
    addPoint('a2', 0, 0),
    addPoint('b1', 0, 0),
    addPoint('b2', 0, 0),
    addPoint('ca', 0, 0),
    addPoint('cb', 0, 0),
    addPoint('as', 0, 0),
    addLine('lineA', 'a1', 'a2', 'layer1'),
    addLine('lineB', 'b1', 'b2', 'layer1'),
    addEntity({ id: 'circA', kind: 'circle', center: 'ca', radius: 0, layer: 'layer1', construction: false }),
    addEntity({ id: 'circB', kind: 'circle', center: 'cb', radius: 0, layer: 'layer1', construction: false }),
    addArc('arcA', 'cb', 'as', 'b1', 'layer1'),
  )(createEmptyDocument());
}

describe('degenerate geometry never reaches a divide by zero', () => {
  // `div` throws on a zero divisor on purpose, so that a missing guard shows
  // up as a crash rather than as a constraint that quietly removes no
  // freedom. That contract only holds if every residual checks its lengths
  // first — this is the test that says they do.
  it.each(CASES)('%s survives a fully collapsed sketch', (_name, constraint) => {
    const doc = addConstraint(constraint)(degenerate());
    const variables = mapVariables(doc);
    const x = initialVector(doc, variables);
    expect(() => constraintRows(constraint, doc, variables, x)).not.toThrow();
  });
});

describe('nonsense combinations produce a harmless row', () => {
  const rowsFor = (constraint: Constraint) => {
    const doc = addConstraint(constraint)(sandbox());
    const variables = mapVariables(doc);
    return constraintRows(constraint, doc, variables, initialVector(doc, variables));
  };

  it.each([
    ['parallel to a circle', { id: 'c1', kind: 'parallel', a: 'lineA', b: 'circA' } as Constraint],
    ['tangent between two lines', { id: 'c1', kind: 'tangent', a: 'lineA', b: 'lineB' } as Constraint],
    ['concentric with a line', { id: 'c1', kind: 'concentric', a: 'lineA', b: 'circA' } as Constraint],
    ['midpoint on a circle', { id: 'c1', kind: 'midpoint', point: 'ca', entity: 'circA' } as Constraint],
    ['symmetric about a circle', { id: 'c1', kind: 'symmetric', p1: 'ca', p2: 'cb', entity: 'circA' } as Constraint],
    ['angle between a line and a circle', { id: 'c1', kind: 'angle', a: 'lineA', b: 'circA', value: 30 } as Constraint],
    ['radius of a line', { id: 'c1', kind: 'radius', entity: 'lineA', value: 30 } as Constraint],
    ['diameter of a line', { id: 'c1', kind: 'diameter', entity: 'lineA', value: 30 } as Constraint],
    ['distance from a point to a circle', { id: 'c1', kind: 'point-line-distance', point: 'ca', entity: 'circA', value: 30 } as Constraint],
  ])('%s removes no freedom instead of throwing', (_name, constraint) => {
    // The commands layer refuses these; the solver still must not blow up on
    // a hand-edited file, and a row with no gradient removes nothing.
    const rows = rowsFor(constraint);
    expect(rows.every((r) => r.partials.length === 0)).toBe(true);
  });
});

describe('the angle residual', () => {
  const rowsFor = (constraint: Constraint, doc = sandbox()) => {
    const withConstraint = addConstraint(constraint)(doc);
    const variables = mapVariables(withConstraint);
    return constraintRows(constraint, withConstraint, variables, initialVector(withConstraint, variables));
  };

  /** Two lines at a known angle: `a` along +x, `b` turned clockwise by `turn`. */
  function wedge(turn: number): SketchDocument {
    const radians = (turn * Math.PI) / 180;
    return compose(
      addPoint('o', 0, 0),
      addPoint('ax', 100, 0),
      addPoint('bx', 100 * Math.cos(radians), 100 * Math.sin(radians)),
      addLine('lineA', 'o', 'ax', 'layer1'),
      addLine('lineB', 'o', 'bx', 'layer1'),
    )(createEmptyDocument());
  }

  it('is zero when the lines already sit at the target angle', () => {
    // y is down, so a positive angle turns clockwise on screen.
    const rows = rowsFor({ id: 'c1', kind: 'angle', a: 'lineA', b: 'lineB', value: 30 }, wedge(30));
    expect(rows[0]!.residual).toBeCloseTo(0, 12);
  });

  it('measures in radians, so a ten degree error is 10 * pi / 180', () => {
    const rows = rowsFor({ id: 'c1', kind: 'angle', a: 'lineA', b: 'lineB', value: 30 }, wedge(40));
    expect(rows[0]!.residual).toBeCloseTo((10 * Math.PI) / 180, 12);
  });

  it('takes the short way round rather than the long one', () => {
    // One degree short of a full turn is a one degree error, not 359.
    const rows = rowsFor({ id: 'c1', kind: 'angle', a: 'lineA', b: 'lineB', value: 0 }, wedge(359));
    expect(rows[0]!.residual).toBeCloseTo((-1 * Math.PI) / 180, 9);
  });

  it('reads a target a whole turn away as the same angle', () => {
    // -190 degrees *is* 170 degrees. Geometry already sitting at 170 must
    // report no error at all — without the wrap the residual is a full turn,
    // which is a large false error on a sketch that is already right.
    const rows = rowsFor({ id: 'c1', kind: 'angle', a: 'lineA', b: 'lineB', value: -190 }, wedge(170));
    expect(rows[0]!.residual).toBeCloseTo(0, 9);
  });

  it('never reports an error bigger than half a turn', () => {
    // Whatever the geometry and whatever the target, the error is the short
    // way round: at most pi.
    for (const turn of [-350, -170, -5, 0, 5, 170, 350]) {
      for (const value of [-540, -190, -30, 0, 30, 190, 540]) {
        const rows = rowsFor({ id: 'c1', kind: 'angle', a: 'lineA', b: 'lineB', value }, wedge(turn));
        expect(Math.abs(rows[0]!.residual), `turn ${turn}, value ${value}`).toBeLessThanOrEqual(
          Math.PI + 1e-9,
        );
      }
    }
  });

  it('keeps a usable gradient a quarter turn from the target', () => {
    // This is why the residual is the angle and not its sine: the sine's
    // derivative vanishes exactly here, so a line 90 degrees out would sit
    // still forever.
    const rows = rowsFor({ id: 'c1', kind: 'angle', a: 'lineA', b: 'lineB', value: 0 }, wedge(90));
    const largest = Math.max(...rows[0]!.partials.map(([, weight]) => Math.abs(weight)));
    expect(largest).toBeGreaterThan(1e-3);
  });

  it('says nothing about a line with no length', () => {
    const collapsed = compose(
      addPoint('o', 0, 0),
      addPoint('ax', 0, 0),
      addPoint('bx', 100, 0),
      addLine('lineA', 'o', 'ax', 'layer1'),
      addLine('lineB', 'o', 'bx', 'layer1'),
    )(createEmptyDocument());
    const rows = rowsFor({ id: 'c1', kind: 'angle', a: 'lineA', b: 'lineB', value: 30 }, collapsed);
    expect(rows[0]!.partials).toEqual([]);
  });
});

describe('radius and diameter', () => {
  const residualOf = (constraint: Constraint) => {
    const doc = addConstraint(constraint)(sandbox());
    const variables = mapVariables(doc);
    return constraintRows(constraint, doc, variables, initialVector(doc, variables))[0]!.residual;
  };

  it('measure the same circle, one at twice the other\'s number', () => {
    // circA has radius 37.5 in the sandbox.
    expect(residualOf({ id: 'c1', kind: 'radius', entity: 'circA', value: 37.5 })).toBeCloseTo(0, 12);
    expect(residualOf({ id: 'c1', kind: 'diameter', entity: 'circA', value: 75 })).toBeCloseTo(0, 12);
  });

  it('are both in px, so the error is a length either way', () => {
    expect(residualOf({ id: 'c1', kind: 'radius', entity: 'circA', value: 27.5 })).toBeCloseTo(10, 12);
    // A diameter ten px too small is a radius five px too small.
    expect(residualOf({ id: 'c1', kind: 'diameter', entity: 'circA', value: 65 })).toBeCloseTo(5, 12);
  });
});
