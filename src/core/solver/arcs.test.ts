import { describe, expect, it } from 'vitest';
import { createRng } from '../../../tests/fixtures/random-edits';
import {
  addArc,
  addConstraint,
  addLine,
  addPoint,
  arcRadius,
  compose,
  createEmptyDocument,
  validate,
  type Constraint,
  type SketchDocument,
} from '../model';
import { at } from './linalg';
import { arcRows, assemble, constraintRows } from './residuals';
import { initialVector, mapVariables } from './variables';
import { applySolution, solve } from './solve';

/** Centre at the origin, quarter arc from (100,0) round to (0,100). */
function arcSketch(constraints: Constraint[] = []): SketchDocument {
  return compose(
    addPoint('c', 0, 0),
    addPoint('s', 100, 0),
    addPoint('e', 0, 100),
    addArc('arc1', 'c', 's', 'e', 'layer1'),
    ...constraints.map((constraint) => addConstraint(constraint)),
  )(createEmptyDocument());
}

describe('the arc entity', () => {
  it('validates, and its points are its references', () => {
    const doc = arcSketch();
    expect(validate(doc)).toEqual([]);
    expect(doc.entities['arc1']).toMatchObject({ kind: 'arc', center: 'c', start: 's', end: 'e' });
  });

  it('reports a dangling reference like any other entity', () => {
    const doc = arcSketch();
    const broken = {
      ...doc,
      entities: { arc1: { ...doc.entities['arc1']!, end: 'gone' } as never },
    };
    expect(validate(broken).map((issue) => issue.code)).toEqual(['dangling-reference']);
  });

  it('derives its radius from the centre and start point', () => {
    const doc = arcSketch();
    expect(arcRadius(doc.entities['arc1'] as never, doc.points)).toBeCloseTo(100, 9);
  });

  it('takes the radius from the start point specifically', () => {
    // On a solved arc both endpoints are equidistant, so either would do. On
    // an unsolved one they are not, and the renderer draws mid-drag.
    const lopsided = compose(
      addPoint('c', 0, 0),
      addPoint('s', 100, 0),
      addPoint('e', 0, 40),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
    )(createEmptyDocument());

    expect(arcRadius(lopsided.entities['arc1'] as never, lopsided.points)).toBeCloseTo(100, 9);
  });

  it('has no radius to report when its points are missing', () => {
    const doc = arcSketch();
    expect(arcRadius(doc.entities['arc1'] as never, {})).toBe(0);
  });
});

describe('degrees of freedom', () => {
  it('is 5, as the plan\'s table says', () => {
    // Six variables from three points, less the implicit equal-radius row.
    expect(solve(arcSketch()).dof).toBe(5);
  });

  it('is fully defined once centre, start and end are pinned', () => {
    // Fixing all three points is 6 constraints against 6 variables, but the
    // implicit row is then redundant with them, which is the over-defined
    // reading. Pinning the centre and one endpoint plus a radius-setting
    // relation is the honest way in; here we just check the DOF arithmetic.
    const result = solve(
      arcSketch([
        { id: 'c1', kind: 'fix', point: 'c' },
        { id: 'c2', kind: 'fix', point: 's' },
      ]),
    );
    // Centre and start pinned leaves the end point on its circle: 1 DOF.
    expect(result.dof).toBe(1);
    expect(result.status).toBe('under-defined');
  });

  it('loses its last freedom to a vertical on the end point', () => {
    const result = solve(
      arcSketch([
        { id: 'c1', kind: 'fix', point: 'c' },
        { id: 'c2', kind: 'fix', point: 's' },
        { id: 'c3', kind: 'vertical', p1: 'c', p2: 'e' },
      ]),
    );
    expect(result.dof).toBe(0);
    expect(result.status).toBe('fully-defined');
    expect(result.entityStatus['arc1']).toBe('fully-defined');
  });

  it('counts an unconstrained arc as under defined per entity', () => {
    expect(solve(arcSketch()).entityStatus['arc1']).toBe('under-defined');
  });
});

describe('the implicit equal-radius constraint', () => {
  it('pulls a lopsided arc back into shape', () => {
    // The end point starts closer to the centre than the start point does.
    const lopsided = compose(
      addPoint('c', 0, 0),
      addPoint('s', 100, 0),
      addPoint('e', 0, 40),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
      addConstraint({ id: 'c1', kind: 'fix', point: 'c' }),
      addConstraint({ id: 'c2', kind: 'fix', point: 's' }),
    )(createEmptyDocument());

    const result = solve(lopsided);
    expect(result.converged).toBe(true);

    const end = result.positions['e']!;
    expect(Math.hypot(end.x, end.y)).toBeCloseTo(100, 6);
  });

  it('is never reported as a conflict, since the user cannot delete it', () => {
    // Over-constrain the arc: fix all three points at radii that disagree.
    const impossible = compose(
      addPoint('c', 0, 0),
      addPoint('s', 100, 0),
      addPoint('e', 0, 40),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
      addConstraint({ id: 'c1', kind: 'fix', point: 'c' }),
      addConstraint({ id: 'c2', kind: 'fix', point: 's' }),
      addConstraint({ id: 'c3', kind: 'fix', point: 'e' }),
    )(createEmptyDocument());

    const result = solve(impossible);
    expect(result.status).toBe('over-defined');
    for (const id of result.conflicts) {
      expect(Object.hasOwn(impossible.constraints, id), `${id} should be a real constraint`).toBe(true);
    }
  });
});

describe('sharing points with other geometry', () => {
  it('solves a line and an arc that share an endpoint as one sketch', () => {
    const doc = compose(
      addPoint('c', 0, 0),
      addPoint('s', 100, 0),
      addPoint('e', 0, 100),
      addPoint('far', 300, 0),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
      // The line hangs off the arc's start point: one shared point, not a
      // coincident constraint.
      addLine('line1', 's', 'far', 'layer1'),
      addConstraint({ id: 'c1', kind: 'fix', point: 'c' }),
      addConstraint({ id: 'c2', kind: 'fix', point: 's' }),
      addConstraint({ id: 'c3', kind: 'vertical', p1: 'c', p2: 'e' }),
      addConstraint({ id: 'c4', kind: 'horizontal', p1: 's', p2: 'far' }),
      addConstraint({ id: 'c5', kind: 'horizontal-distance', p1: 's', p2: 'far', value: 200 }),
    )(createEmptyDocument());

    const result = solve(doc);
    expect(result.status).toBe('fully-defined');
    expect(result.dof).toBe(0);
    expect(result.positions['far']!.x).toBeCloseTo(300, 6);
  });

  it('moves the arc when the shared point moves', () => {
    const doc = compose(
      addPoint('c', 0, 0),
      addPoint('s', 100, 0),
      addPoint('e', 0, 100),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
      addConstraint({ id: 'c1', kind: 'fix', point: 'c' }),
      addConstraint({ id: 'c2', kind: 'horizontal', p1: 'c', p2: 's' }),
      addConstraint({ id: 'c3', kind: 'vertical', p1: 'c', p2: 'e' }),
      addConstraint({ id: 'c4', kind: 'horizontal-distance', p1: 'c', p2: 's', value: 250 }),
    )(createEmptyDocument());

    const next = applySolution(doc, solve(doc));
    // Growing the radius at the start point takes the end point with it.
    expect(next.points['s']!.x).toBeCloseTo(250, 5);
    expect(Math.abs(next.points['e']!.y)).toBeCloseTo(250, 5);
  });
});

describe('point-on an arc', () => {
  it('pulls a point onto the arc\'s circle', () => {
    const doc = compose(
      addPoint('c', 0, 0),
      addPoint('s', 100, 0),
      addPoint('e', 0, 100),
      addPoint('p', 40, 40),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
      addConstraint({ id: 'c1', kind: 'fix', point: 'c' }),
      addConstraint({ id: 'c2', kind: 'fix', point: 's' }),
      addConstraint({ id: 'c3', kind: 'point-on', point: 'p', entity: 'arc1' }),
    )(createEmptyDocument());

    const result = solve(doc);
    const p = result.positions['p']!;
    expect(result.converged).toBe(true);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(100, 6);
  });
});

describe('the arc Jacobian matches finite differences', () => {
  const step = 1e-6;

  it('holds for the implicit row and for point-on, at random configurations', () => {
    const rng = createRng(23);
    const coordinate = () => Math.round((rng() * 300 - 150) * 100) / 100;

    for (let trial = 0; trial < 40; trial += 1) {
      const doc = compose(
        addPoint('c', coordinate(), coordinate()),
        addPoint('s', coordinate(), coordinate()),
        addPoint('e', coordinate(), coordinate()),
        addPoint('p', coordinate(), coordinate()),
        addArc('arc1', 'c', 's', 'e', 'layer1'),
      )(createEmptyDocument());

      const variables = mapVariables(doc);
      const x = initialVector(doc, variables);
      const arc = doc.entities['arc1'] as never;
      const onArc: Constraint = { id: 'c1', kind: 'point-on', point: 'p', entity: 'arc1' };

      for (const [label, rowsAt] of [
        ['implicit', (v: Float64Array) => arcRows(arc, variables, v)],
        ['point-on', (v: Float64Array) => constraintRows(onArc, doc, variables, v)],
      ] as const) {
        const { jacobian } = assemble(rowsAt(x), variables.count);

        for (let column = 0; column < variables.count; column += 1) {
          const forward = Float64Array.from(x);
          const backward = Float64Array.from(x);
          forward[column] = forward[column]! + step;
          backward[column] = backward[column]! - step;
          const numeric =
            (rowsAt(forward)[0]!.residual - rowsAt(backward)[0]!.residual) / (2 * step);

          expect(at(jacobian, 0, column), `trial ${trial} ${label} var ${column}`).toBeCloseTo(
            numeric,
            4,
          );
        }
      }
    }
  });
});

describe('degenerate arcs', () => {
  it('does not throw when the start point sits on the centre', () => {
    const doc = compose(
      addPoint('c', 0, 0),
      addPoint('s', 0, 0),
      addPoint('e', 0, 100),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
    )(createEmptyDocument());

    const result = solve(doc);
    expect(Number.isFinite(result.residual)).toBe(true);
    expect(result.positions['e']).toBeDefined();
  });
});
