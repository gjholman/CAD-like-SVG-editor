/**
 * Constraint equations: one residual per row, with its analytic derivatives.
 *
 * Every residual is in px, including point-on-line, which divides the cross
 * product by the line's length to give a signed distance rather than an area.
 * Keeping one unit throughout matters: Levenberg-Marquardt damps all residuals
 * with the same lambda, so a row in different units would be weighted wrongly.
 *
 * A residual of zero means the constraint is satisfied. `solve` drives the
 * whole vector to zero; `rank` of the assembled Jacobian says how many of the
 * rows are actually independent.
 */
import { createMatrix, setAt, type Matrix } from './linalg';
import { pointVariable, radiusVariable, type VariableMap } from './variables';
import type { Constraint, Id, SketchDocument } from '../model';

/** Below this length a line or radius is too degenerate to differentiate. */
const DEGENERATE = 1e-12;

export interface ConstraintRow {
  /** The constraint this row came from, so conflicts can name it. */
  readonly constraint: Id;
  readonly residual: number;
  /** Sparse derivatives as [variableIndex, value]. Repeats are summed. */
  readonly partials: readonly (readonly [number, number])[];
}

/**
 * Rows for one constraint at the current variable values.
 *
 * `fix` anchors to the document's stored position: the solver starts there, so
 * the residual starts at zero and the point stays put.
 */
export function constraintRows(
  constraint: Constraint,
  doc: SketchDocument,
  variables: VariableMap,
  x: Float64Array,
): ConstraintRow[] {
  const id = constraint.id;

  switch (constraint.kind) {
    case 'fix': {
      const p = pointVariable(variables, constraint.point);
      const anchor = doc.points[constraint.point]!;
      return [
        { constraint: id, residual: x[p]! - anchor.x, partials: [[p, 1]] },
        { constraint: id, residual: x[p + 1]! - anchor.y, partials: [[p + 1, 1]] },
      ];
    }

    case 'coincident': {
      const a = pointVariable(variables, constraint.p1);
      const b = pointVariable(variables, constraint.p2);
      return [
        { constraint: id, residual: x[b]! - x[a]!, partials: [[a, -1], [b, 1]] },
        { constraint: id, residual: x[b + 1]! - x[a + 1]!, partials: [[a + 1, -1], [b + 1, 1]] },
      ];
    }

    case 'horizontal': {
      const a = pointVariable(variables, constraint.p1);
      const b = pointVariable(variables, constraint.p2);
      return [{ constraint: id, residual: x[b + 1]! - x[a + 1]!, partials: [[a + 1, -1], [b + 1, 1]] }];
    }

    case 'vertical': {
      const a = pointVariable(variables, constraint.p1);
      const b = pointVariable(variables, constraint.p2);
      return [{ constraint: id, residual: x[b]! - x[a]!, partials: [[a, -1], [b, 1]] }];
    }

    case 'horizontal-distance': {
      const a = pointVariable(variables, constraint.p1);
      const b = pointVariable(variables, constraint.p2);
      return [
        {
          constraint: id,
          residual: x[b]! - x[a]! - constraint.value,
          partials: [[a, -1], [b, 1]],
        },
      ];
    }

    case 'vertical-distance': {
      const a = pointVariable(variables, constraint.p1);
      const b = pointVariable(variables, constraint.p2);
      return [
        {
          constraint: id,
          residual: x[b + 1]! - x[a + 1]! - constraint.value,
          partials: [[a + 1, -1], [b + 1, 1]],
        },
      ];
    }

    case 'distance': {
      const a = pointVariable(variables, constraint.p1);
      const b = pointVariable(variables, constraint.p2);
      const dx = x[b]! - x[a]!;
      const dy = x[b + 1]! - x[a + 1]!;
      const distance = Math.hypot(dx, dy);

      // Coincident points have no defined direction to separate along. Pick x
      // arbitrarily so the step goes somewhere instead of stalling on a zero row.
      const [ux, uy] = distance < DEGENERATE ? [1, 0] : [dx / distance, dy / distance];
      return [
        {
          constraint: id,
          residual: distance - constraint.value,
          partials: [[a, -ux], [a + 1, -uy], [b, ux], [b + 1, uy]],
        },
      ];
    }

    case 'point-on':
      return pointOnRows(constraint.id, constraint.point, constraint.entity, doc, variables, x);
  }
}

function pointOnRows(
  id: Id,
  pointId: Id,
  entityId: Id,
  doc: SketchDocument,
  variables: VariableMap,
  x: Float64Array,
): ConstraintRow[] {
  const entity = doc.entities[entityId];
  if (entity === undefined) throw new Error(`solver: point-on "${id}" references unknown entity "${entityId}"`);
  const p = pointVariable(variables, pointId);

  if (entity.kind === 'circle') {
    const c = pointVariable(variables, entity.center);
    const rIndex = radiusVariable(variables, entity.id);
    const dx = x[p]! - x[c]!;
    const dy = x[p + 1]! - x[c + 1]!;
    const distance = Math.hypot(dx, dy);
    if (distance < DEGENERATE) {
      // The point sits on the centre: every direction is equally wrong, so the
      // row carries the error but no usable gradient except in the radius.
      return [{ constraint: id, residual: -x[rIndex]!, partials: [[rIndex, -1]] }];
    }
    const ux = dx / distance;
    const uy = dy / distance;
    return [
      {
        constraint: id,
        residual: distance - x[rIndex]!,
        partials: [[p, ux], [p + 1, uy], [c, -ux], [c + 1, -uy], [rIndex, -1]],
      },
    ];
  }

  // Signed distance from the point to the infinite line through p1 and p2.
  const a = pointVariable(variables, entity.p1);
  const b = pointVariable(variables, entity.p2);
  const ux = x[p]! - x[a]!;
  const uy = x[p + 1]! - x[a + 1]!;
  const dx = x[b]! - x[a]!;
  const dy = x[b + 1]! - x[a + 1]!;
  const length = Math.hypot(dx, dy);
  if (length < DEGENERATE) {
    return [{ constraint: id, residual: 0, partials: [] }];
  }

  const cross = dx * uy - dy * ux;
  const cube = length ** 3;
  return [
    {
      constraint: id,
      residual: cross / length,
      partials: [
        [p, -dy / length],
        [p + 1, dx / length],
        [a, (dy - uy) / length + (cross * dx) / cube],
        [a + 1, (ux - dx) / length + (cross * dy) / cube],
        [b, uy / length - (cross * dx) / cube],
        [b + 1, -ux / length - (cross * dy) / cube],
      ],
    },
  ];
}

/** Holding a point at a cursor position during a drag, without touching the document. */
export function pinRows(
  pointId: Id,
  target: { readonly x: number; readonly y: number },
  variables: VariableMap,
  x: Float64Array,
): ConstraintRow[] {
  const p = pointVariable(variables, pointId);
  const id = `pin:${pointId}`;
  return [
    { constraint: id, residual: x[p]! - target.x, partials: [[p, 1]] },
    { constraint: id, residual: x[p + 1]! - target.y, partials: [[p + 1, 1]] },
  ];
}

export interface System {
  readonly jacobian: Matrix;
  readonly residual: number[];
  /** Which constraint produced each row. */
  readonly owners: Id[];
}

/**
 * Packs rows into a dense Jacobian. Repeated variable indices within one row
 * are added, which is what makes a constraint between a point and an entity
 * that shares it (say, point-on-line where the point is an endpoint) come out
 * right.
 */
export function assemble(rows: readonly ConstraintRow[], variableCount: number): System {
  const jacobian = createMatrix(rows.length, variableCount);
  const residual: number[] = [];
  const owners: Id[] = [];

  for (const [row, entry] of rows.entries()) {
    residual.push(entry.residual);
    owners.push(entry.constraint);
    for (const [column, value] of entry.partials) {
      setAt(jacobian, row, column, jacobian.data[row * variableCount + column]! + value);
    }
  }

  return { jacobian, residual, owners };
}

/** Largest absolute residual: the measure `solve` drives to zero. */
export function worstResidual(residual: readonly number[]): number {
  return residual.length === 0 ? 0 : Math.max(...residual.map(Math.abs));
}
