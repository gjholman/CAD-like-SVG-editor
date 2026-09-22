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
  ])('%s removes no freedom instead of throwing', (_name, constraint) => {
    // The commands layer refuses these; the solver still must not blow up on
    // a hand-edited file, and a row with no gradient removes nothing.
    const rows = rowsFor(constraint);
    expect(rows.every((r) => r.partials.length === 0)).toBe(true);
  });
});
