import { describe, expect, it } from 'vitest';
import { createRng } from '../../../tests/fixtures/random-edits';
import { validate, type Constraint, type Id, type SketchDocument } from '../model';
import { assemble, constraintRows } from './residuals';
import { at } from './linalg';
import { initialVector, mapVariables } from './variables';

/** Minimal document holding the given points, entities and one constraint. */
function sketch(
  points: Record<Id, [number, number]>,
  constraint: Constraint,
  entities: SketchDocument['entities'] = {},
): SketchDocument {
  return {
    version: 1,
    points: Object.fromEntries(
      Object.entries(points).map(([id, [x, y]]) => [id, { id, x, y }]),
    ),
    entities,
    constraints: { [constraint.id]: constraint },
    paths: {},
    layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
    layerOrder: ['layer1'],
  };
}

/**
 * Central differences on the residuals. Comparing the hand-derived analytic
 * Jacobian against this is the test that a wrong derivative cannot survive —
 * a solver with a bad Jacobian still often converges, just slowly, so
 * convergence tests alone would not catch it.
 */
function numericJacobian(doc: SketchDocument, constraint: Constraint): number[][] {
  const variables = mapVariables(doc);
  const x = initialVector(doc, variables);
  const height = constraintRows(constraint, doc, variables, x).length;
  const step = 1e-6;

  return Array.from({ length: height }, (_, row) =>
    Array.from({ length: variables.count }, (_, column) => {
      const forward = Float64Array.from(x);
      const backward = Float64Array.from(x);
      forward[column] = forward[column]! + step;
      backward[column] = backward[column]! - step;
      const plus = constraintRows(constraint, doc, variables, forward)[row]!.residual;
      const minus = constraintRows(constraint, doc, variables, backward)[row]!.residual;
      return (plus - minus) / (2 * step);
    }),
  );
}

function analyticJacobian(doc: SketchDocument, constraint: Constraint): number[][] {
  const variables = mapVariables(doc);
  const x = initialVector(doc, variables);
  const { jacobian } = assemble(constraintRows(constraint, doc, variables, x), variables.count);
  return Array.from({ length: jacobian.rows }, (_, row) =>
    Array.from({ length: jacobian.cols }, (_, column) => at(jacobian, row, column)),
  );
}

function expectJacobiansAgree(doc: SketchDocument, constraint: Constraint, where: string): void {
  expect(validate(doc), `${where}: fixture document`).toEqual([]);
  const analytic = analyticJacobian(doc, constraint);
  const numeric = numericJacobian(doc, constraint);

  expect(analytic.length, `${where}: row count`).toBe(numeric.length);
  for (const [row, values] of analytic.entries()) {
    for (const [column, value] of values.entries()) {
      expect(value, `${where}: d(row ${row})/d(var ${column})`).toBeCloseTo(numeric[row]![column]!, 5);
    }
  }
}

const line = (id: Id, p1: Id, p2: Id) =>
  ({ [id]: { id, kind: 'line' as const, p1, p2, layer: 'layer1', construction: false } });
const circle = (id: Id, center: Id, radius: number) =>
  ({ [id]: { id, kind: 'circle' as const, center, radius, layer: 'layer1', construction: false } });

describe('analytic Jacobian matches finite differences', () => {
  // Deliberately untidy coordinates: axis-aligned or symmetric ones can hide a
  // derivative that is wrong only in the general case.
  const a: [number, number] = [13.7, -42.1];
  const b: [number, number] = [-88.25, 19.6];
  const c: [number, number] = [56.4, 71.9];

  it('fix', () => {
    expectJacobiansAgree(
      sketch({ p1: a }, { id: 'c1', kind: 'fix', point: 'p1' }),
      { id: 'c1', kind: 'fix', point: 'p1' },
      'fix',
    );
  });

  it.each([
    ['coincident', { id: 'c1', kind: 'coincident' as const, p1: 'p1', p2: 'p2' }],
    ['horizontal', { id: 'c1', kind: 'horizontal' as const, p1: 'p1', p2: 'p2' }],
    ['vertical', { id: 'c1', kind: 'vertical' as const, p1: 'p1', p2: 'p2' }],
    ['distance', { id: 'c1', kind: 'distance' as const, p1: 'p1', p2: 'p2', value: 37 }],
    ['horizontal-distance', { id: 'c1', kind: 'horizontal-distance' as const, p1: 'p1', p2: 'p2', value: 37 }],
    ['vertical-distance', { id: 'c1', kind: 'vertical-distance' as const, p1: 'p1', p2: 'p2', value: 37 }],
  ])('%s', (name, constraint) => {
    expectJacobiansAgree(sketch({ p1: a, p2: b }, constraint), constraint, name);
  });

  it('point-on a line', () => {
    const constraint: Constraint = { id: 'c1', kind: 'point-on', point: 'p3', entity: 'line1' };
    const doc = sketch({ p1: a, p2: b, p3: c }, constraint, line('line1', 'p1', 'p2'));
    expectJacobiansAgree(doc, constraint, 'point-on line');
  });

  it('point-on a line, with the point already close to it', () => {
    // Near-zero residual is where a sloppy derivative of cross/len shows up.
    const constraint: Constraint = { id: 'c1', kind: 'point-on', point: 'p3', entity: 'line1' };
    const doc = sketch({ p1: [0, 0], p2: [100, 50], p3: [40.0001, 20] }, constraint, line('line1', 'p1', 'p2'));
    expectJacobiansAgree(doc, constraint, 'point-on line, near');
  });

  it('point-on a line whose endpoint is the constrained point', () => {
    // Shared variables mean repeated indices in one row, which assemble sums.
    const constraint: Constraint = { id: 'c1', kind: 'point-on', point: 'p1', entity: 'line1' };
    const doc = sketch({ p1: a, p2: b, p3: c }, constraint, line('line1', 'p1', 'p3'));
    expectJacobiansAgree(doc, constraint, 'point-on line, shared endpoint');
  });

  it('point-on a circle', () => {
    const constraint: Constraint = { id: 'c1', kind: 'point-on', point: 'p2', entity: 'circle1' };
    const doc = sketch({ p1: a, p2: b }, constraint, circle('circle1', 'p1', 64.3));
    expectJacobiansAgree(doc, constraint, 'point-on circle');
  });

  it('holds at many random configurations', () => {
    const rng = createRng(11);
    const coordinate = () => Math.round((rng() * 400 - 200) * 100) / 100;

    for (let trial = 0; trial < 40; trial += 1) {
      const points: Record<Id, [number, number]> = {
        p1: [coordinate(), coordinate()],
        p2: [coordinate(), coordinate()],
        p3: [coordinate(), coordinate()],
      };
      const onLine: Constraint = { id: 'c1', kind: 'point-on', point: 'p3', entity: 'line1' };
      expectJacobiansAgree(sketch(points, onLine, line('line1', 'p1', 'p2')), onLine, `trial ${trial} line`);

      const onCircle: Constraint = { id: 'c1', kind: 'point-on', point: 'p2', entity: 'circle1' };
      const radius = 1 + rng() * 200;
      expectJacobiansAgree(
        sketch(points, onCircle, circle('circle1', 'p1', radius)),
        onCircle,
        `trial ${trial} circle`,
      );

      const span: Constraint = { id: 'c1', kind: 'distance', p1: 'p1', p2: 'p2', value: 1 + rng() * 100 };
      expectJacobiansAgree(sketch(points, span), span, `trial ${trial} distance`);
    }
  });
});

describe('assemble', () => {
  it('sums repeated variables within a row', () => {
    // A zero-length "line" from p1 to p1 would otherwise silently overwrite.
    const constraint: Constraint = { id: 'c1', kind: 'coincident', p1: 'p1', p2: 'p1' };
    const doc = sketch({ p1: [5, 9] }, constraint);
    const variables = mapVariables(doc);
    const { jacobian } = assemble(constraintRows(constraint, doc, variables, initialVector(doc, variables)), 2);

    // -1 and +1 on the same variable cancel, leaving a row that removes no DOF.
    expect(at(jacobian, 0, 0)).toBe(0);
    expect(at(jacobian, 1, 1)).toBe(0);
  });
});
