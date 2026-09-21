/**
 * The constraint solver: Levenberg-Marquardt on the constraint residuals, with
 * definition status read off the Jacobian.
 *
 * Pure and DOM-free. It never mutates the document; it returns solved values
 * and the status information the UI colours geometry with. `applySolution`
 * turns a result into a new document, which is what history records.
 *
 * Dragging is two passes, not one objective. Putting the cursor in with the
 * real constraints at equal weight lets it negotiate with them, and a drag
 * that moves a fixed point is simply wrong. So: pass one pulls toward the
 * cursor, pass two re-solves the real constraints alone until they are
 * satisfied, which lands the sketch back on the constraint manifold at the
 * point nearest the cursor. Pins are never part of the status either, so
 * dragging fully defined geometry moves nothing, as in SolidWorks.
 *
 * The plan's status colours map onto `SketchStatus` as:
 *   black  fully-defined   zero degrees of freedom
 *   blue   under-defined   free degrees of freedom remain
 *   red    over-defined    redundant or conflicting constraints
 *   yellow unsolved        no solution found from this starting point
 */
import { matrixFromRows, nullspace, rank, solveLeastSquares, type Matrix } from './linalg';
import { assemble, constraintRows, pinRows, worstResidual, type ConstraintRow } from './residuals';
import { entityVariables, initialVector, mapVariables, type VariableMap } from './variables';
import type { Id, SketchDocument } from '../model';

export type SketchStatus = 'fully-defined' | 'under-defined' | 'over-defined' | 'unsolved';
export type EntityStatus = 'fully-defined' | 'under-defined';

export interface SolveOptions {
  /**
   * Points pulled toward a position for this solve only, as a drag does. The
   * cursor is a goal, not a constraint: the sketch follows it only as far as
   * its remaining freedom allows, and never by breaking a real constraint or
   * changing its definition status.
   */
  readonly pinned?: Readonly<Record<Id, { readonly x: number; readonly y: number }>>;
  readonly maxIterations?: number;
  /** Convergence threshold on the largest residual, in px. */
  readonly tolerance?: number;
}

export interface SolveResult {
  readonly positions: Readonly<Record<Id, { readonly x: number; readonly y: number }>>;
  readonly radii: Readonly<Record<Id, number>>;
  /** Degrees of freedom left: variables minus the rank of the Jacobian. */
  readonly dof: number;
  readonly status: SketchStatus;
  readonly entityStatus: Readonly<Record<Id, EntityStatus>>;
  /**
   * Constraints that are redundant or conflicting: each one whose removal
   * would not reduce the rank. Empty unless the status is over defined.
   */
  readonly conflicts: readonly Id[];
  readonly converged: boolean;
  readonly iterations: number;
  /** Largest residual at the returned solution, in px. */
  readonly residual: number;
}

const DEFAULT_TOLERANCE = 1e-9;
const DEFAULT_MAX_ITERATIONS = 100;
const INITIAL_LAMBDA = 1e-6;
const MIN_LAMBDA = 1e-12;
const MAX_LAMBDA = 1e12;
/** How many times to re-damp within one iteration before giving up on it. */
const MAX_DAMPING_ATTEMPTS = 12;
/**
 * Iterations spent pulling toward the cursor before the constraints are
 * restored. This pass only has to choose a neighbourhood, so it stays short.
 */
const DRAG_PULL_ITERATIONS = 25;
/** A nullspace component below this counts as "cannot move". */
const FREEDOM_THRESHOLD = 1e-7;

export function solve(doc: SketchDocument, options: SolveOptions = {}): SolveResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const variables = mapVariables(doc);
  const x = initialVector(doc, variables);

  // Suspended constraints stay in the document but are excluded from the
  // solve, so geometry that relied on one correctly goes back to under defined.
  const active = Object.values(doc.constraints).filter((constraint) => constraint.suspended !== true);
  const pinned = Object.entries(options.pinned ?? {});

  const constraintsOnly = (values: Float64Array): ConstraintRow[] =>
    active.flatMap((constraint) => constraintRows(constraint, doc, variables, values));
  const withCursor = (values: Float64Array): ConstraintRow[] => [
    ...constraintsOnly(values),
    ...pinned.flatMap(([pointId, target]) => pinRows(pointId, target, variables, values)),
  ];

  let iterations = 0;

  // Pass one, only while dragging: pull toward the cursor. This is allowed to
  // leave the real constraints violated; it exists to pick which solution pass
  // two should settle into.
  if (pinned.length > 0) {
    iterations += minimise(x, withCursor, variables.count, tolerance, DRAG_PULL_ITERATIONS);
  }

  // Pass two: the real constraints, on their own, to tolerance.
  iterations += minimise(x, constraintsOnly, variables.count, tolerance, maxIterations);

  const final = assemble(constraintsOnly(x), variables.count);
  const residual = worstResidual(final.residual);
  const converged = residual <= tolerance;

  const jacobianRank = rank(final.jacobian);
  const dof = variables.count - jacobianRank;
  const independent = final.jacobian.rows === jacobianRank;
  const conflicts = independent ? [] : findConflicts(final.owners, final.jacobian, jacobianRank, variables.count);

  const status: SketchStatus = !independent
    ? 'over-defined'
    : !converged
      ? 'unsolved'
      : dof === 0
        ? 'fully-defined'
        : 'under-defined';

  return {
    positions: readPositions(doc, variables, x),
    radii: readRadii(doc, variables, x),
    dof,
    status,
    entityStatus: readEntityStatus(doc, variables, final.jacobian),
    conflicts,
    converged,
    iterations,
    residual,
  };
}

/**
 * Levenberg-Marquardt until the residuals are inside tolerance or damping stops
 * helping. Mutates `x` in place and returns the iterations spent.
 */
function minimise(
  x: Float64Array,
  rowsAt: (values: Float64Array) => ConstraintRow[],
  variableCount: number,
  tolerance: number,
  maxIterations: number,
): number {
  let iterations = 0;
  let lambda = INITIAL_LAMBDA;

  while (iterations < maxIterations) {
    const system = assemble(rowsAt(x), variableCount);
    const worst = worstResidual(system.residual);
    if (worst <= tolerance) break;

    let stepped = false;
    for (let attempt = 0; attempt < MAX_DAMPING_ATTEMPTS; attempt += 1) {
      const candidate = dampedStep(system.jacobian, system.residual, x, lambda, variableCount);
      const candidateWorst = worstResidual(assemble(rowsAt(candidate), variableCount).residual);

      if (candidateWorst < worst) {
        x.set(candidate);
        lambda = Math.max(lambda / 10, MIN_LAMBDA);
        stepped = true;
        break;
      }
      lambda = Math.min(lambda * 10, MAX_LAMBDA);
    }

    iterations += 1;
    // More damping stopped helping: this is as close as this start point gets.
    if (!stepped) break;
  }

  return iterations;
}

/**
 * One Levenberg-Marquardt step: least squares on [J; sqrt(lambda) I] against
 * [-r; 0]. Stacking the damping as extra rows is better conditioned than
 * forming JᵀJ + lambda I, and it makes the system full rank, so the basic
 * solution from `solveLeastSquares` is the one we want.
 */
function dampedStep(
  jacobian: Matrix,
  residual: readonly number[],
  x: Float64Array,
  lambda: number,
  variableCount: number,
): Float64Array {
  const damping = Math.sqrt(lambda);
  const rows: number[][] = [];
  for (let i = 0; i < jacobian.rows; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < variableCount; j += 1) row.push(jacobian.data[i * variableCount + j]!);
    rows.push(row);
  }
  for (let j = 0; j < variableCount; j += 1) {
    const row = new Array<number>(variableCount).fill(0);
    row[j] = damping;
    rows.push(row);
  }

  const b = [...residual.map((value) => -value), ...new Array<number>(variableCount).fill(0)];
  const { solution } = solveLeastSquares(matrixFromRows(rows), b);

  const next = new Float64Array(x);
  for (let j = 0; j < variableCount; j += 1) next[j] = next[j]! + solution[j]!;
  return next;
}

/**
 * Which constraints the redundancy lives in: a constraint is implicated when
 * dropping its rows leaves the rank unchanged, meaning the others already said
 * everything it says. A conflicting pair (two different lengths for one line)
 * implicates both, which is the honest answer — either could be the wrong one.
 */
function findConflicts(owners: readonly Id[], jacobian: Matrix, fullRank: number, variableCount: number): Id[] {
  const conflicts: Id[] = [];
  for (const candidate of [...new Set(owners)]) {
    const rows: number[][] = [];
    for (const [i, owner] of owners.entries()) {
      if (owner === candidate) continue;
      const row: number[] = [];
      for (let j = 0; j < variableCount; j += 1) row.push(jacobian.data[i * variableCount + j]!);
      rows.push(row);
    }
    const remaining = rows.length === 0 ? 0 : rank(matrixFromRows(rows));
    if (remaining === fullRank) conflicts.push(candidate);
  }
  return conflicts;
}

function readPositions(
  doc: SketchDocument,
  variables: VariableMap,
  x: Float64Array,
): Record<Id, { x: number; y: number }> {
  const positions: Record<Id, { x: number; y: number }> = {};
  for (const id of Object.keys(doc.points)) {
    const index = variables.pointIndex.get(id)!;
    positions[id] = { x: x[index]!, y: x[index + 1]! };
  }
  return positions;
}

function readRadii(doc: SketchDocument, variables: VariableMap, x: Float64Array): Record<Id, number> {
  const radii: Record<Id, number> = {};
  for (const [id, index] of variables.radiusIndex) {
    if (Object.hasOwn(doc.entities, id)) radii[id] = x[index]!;
  }
  return radii;
}

/**
 * Per-entity status from the nullspace: an entity is fully defined when none
 * of its variables has a component in any remaining free direction. This is
 * what lets the UI colour one line black while its neighbour is still blue.
 */
function readEntityStatus(
  doc: SketchDocument,
  variables: VariableMap,
  jacobian: Matrix,
): Record<Id, EntityStatus> {
  const freedoms = nullspace(jacobian);
  const status: Record<Id, EntityStatus> = {};

  for (const entity of Object.values(doc.entities)) {
    const indices = entityVariables(entity, variables);
    const free = freedoms.some((direction) =>
      indices.some((index) => Math.abs(direction[index] ?? 0) > FREEDOM_THRESHOLD),
    );
    status[entity.id] = free ? 'under-defined' : 'fully-defined';
  }

  return status;
}

/**
 * The solved values as a new document, for `dispatch` to record. Solved
 * positions live in the snapshot, so undo restores them without re-solving.
 */
export function applySolution(doc: SketchDocument, result: SolveResult): SketchDocument {
  const points = { ...doc.points };
  for (const [id, position] of Object.entries(result.positions)) {
    const point = points[id];
    if (point !== undefined) points[id] = { ...point, x: position.x, y: position.y };
  }

  const entities = { ...doc.entities };
  for (const [id, radius] of Object.entries(result.radii)) {
    const entity = entities[id];
    if (entity !== undefined && entity.kind === 'circle') entities[id] = { ...entity, radius };
  }

  return { ...doc, points, entities };
}
