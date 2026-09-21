/**
 * Turning a selection into a constraint.
 *
 * Each command answers two questions: is this selection the right shape for
 * this relation, and what edit does it produce. The UI asks the first to
 * enable or disable a button, and the second when the button is pressed.
 *
 * Duplicates are refused. Adding a second identical relation is pure
 * redundancy: the solver would correctly report the sketch over defined, and
 * the user would have no idea why.
 */
import {
  addConstraint,
  compose,
  type Constraint,
  type DocumentEdit,
  type Id,
  type IdGenerator,
  type SketchDocument,
} from '../../core/model';
import type { Point2 } from '../render';

export type RelationKind = 'horizontal' | 'vertical' | 'coincident' | 'fix';

export interface Selection {
  readonly points: readonly Id[];
  readonly entities: readonly Id[];
}

/** Splits a flat selection into the points and entities it holds. */
export function describeSelection(doc: SketchDocument, selection: Iterable<Id>): Selection {
  const points: Id[] = [];
  const entities: Id[] = [];
  for (const id of selection) {
    if (Object.hasOwn(doc.points, id)) points.push(id);
    else if (Object.hasOwn(doc.entities, id)) entities.push(id);
  }
  return { points, entities };
}

/**
 * The two points a relation should act on.
 *
 * A selected line resolves to its endpoints: the plan allows a relation to
 * name a line or a point pair, and v1 stores the pair, so this is where the
 * translation happens.
 */
export function pointPair(doc: SketchDocument, selection: Iterable<Id>): readonly [Id, Id] | undefined {
  const { points, entities } = describeSelection(doc, selection);

  if (points.length === 2 && entities.length === 0) return [points[0]!, points[1]!];

  if (points.length === 0 && entities.length === 1) {
    const entity = doc.entities[entities[0]!];
    if (entity?.kind === 'line') return [entity.p1, entity.p2];
  }

  return undefined;
}

export function canApplyRelation(kind: RelationKind, doc: SketchDocument, selection: Iterable<Id>): boolean {
  return relationEdit(kind, doc, selection, () => 'probe') !== undefined;
}

/**
 * The edit a relation button performs, or undefined when the selection does
 * not suit it (or the relation is already there).
 */
export function relationEdit(
  kind: RelationKind,
  doc: SketchDocument,
  selection: Iterable<Id>,
  nextId: IdGenerator,
): DocumentEdit | undefined {
  if (kind === 'fix') {
    const { points } = describeSelection(doc, selection);
    const unfixed = points.filter((id) => !hasConstraint(doc, { kind: 'fix', point: id }));
    if (unfixed.length === 0) return undefined;
    return compose(
      ...unfixed.map((id) => addConstraint({ id: nextId('c'), kind: 'fix', point: id })),
    );
  }

  const pair = pointPair(doc, selection);
  if (pair === undefined) return undefined;
  const [p1, p2] = pair;
  if (p1 === p2) return undefined;
  if (hasConstraint(doc, { kind, p1, p2 })) return undefined;

  return addConstraint({ id: nextId('c'), kind, p1, p2 } as Constraint);
}

export type DimensionKind = 'horizontal-distance' | 'vertical-distance' | 'distance';

export interface DimensionPlan {
  readonly kind: DimensionKind;
  readonly p1: Id;
  readonly p2: Id;
  readonly value: number;
}

/**
 * What a smart dimension would add for this selection: the axis the two points
 * are most separated along, measured at their current positions.
 *
 * Picking the dominant axis is what makes one tool serve width and height, the
 * way SolidWorks' smart dimension does. A pair that is neither clearly
 * horizontal nor vertical gets a straight-line distance.
 */
export function dimensionPlan(
  doc: SketchDocument,
  selection: Iterable<Id>,
  positions: Readonly<Record<Id, Point2>> = doc.points,
): DimensionPlan | undefined {
  const pair = pointPair(doc, selection);
  if (pair === undefined) return undefined;
  const [p1, p2] = pair;
  if (p1 === p2) return undefined;

  const a = positions[p1] ?? doc.points[p1];
  const b = positions[p2] ?? doc.points[p2];
  if (a === undefined || b === undefined) return undefined;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // A generous margin, so a nearly-horizontal pair still reads as horizontal.
  const ratio = 3;

  if (Math.abs(dx) > Math.abs(dy) * ratio) {
    return { kind: 'horizontal-distance', p1, p2, value: round(dx) };
  }
  if (Math.abs(dy) > Math.abs(dx) * ratio) {
    return { kind: 'vertical-distance', p1, p2, value: round(dy) };
  }
  return { kind: 'distance', p1, p2, value: round(Math.hypot(dx, dy)) };
}

export function dimensionEdit(
  doc: SketchDocument,
  selection: Iterable<Id>,
  nextId: IdGenerator,
  positions?: Readonly<Record<Id, Point2>>,
): DocumentEdit | undefined {
  const plan = dimensionPlan(doc, selection, positions);
  if (plan === undefined) return undefined;
  if (hasConstraint(doc, { kind: plan.kind, p1: plan.p1, p2: plan.p2 })) return undefined;

  return addConstraint({
    id: nextId('dim'),
    kind: plan.kind,
    p1: plan.p1,
    p2: plan.p2,
    value: plan.value,
  });
}

/** Changes a driving dimension's number, which is what moves the geometry. */
export function setDimensionValue(id: Id, value: number): DocumentEdit {
  return (doc) => {
    const constraint = doc.constraints[id];
    if (constraint === undefined || !('value' in constraint)) return doc;
    if (constraint.value === value || !Number.isFinite(value)) return doc;
    return { ...doc, constraints: { ...doc.constraints, [id]: { ...constraint, value } } };
  };
}

/** Suspending keeps a relation but takes it out of the solve (a plan decision). */
export function setSuspended(id: Id, suspended: boolean): DocumentEdit {
  return (doc) => {
    const constraint = doc.constraints[id];
    if (constraint === undefined || (constraint.suspended ?? false) === suspended) return doc;
    return { ...doc, constraints: { ...doc.constraints, [id]: { ...constraint, suspended } } };
  };
}

/** Is an equivalent relation already present? Point order does not matter. */
function hasConstraint(
  doc: SketchDocument,
  probe: { kind: Constraint['kind']; point?: Id; p1?: Id; p2?: Id },
): boolean {
  return Object.values(doc.constraints).some((constraint) => {
    if (constraint.kind !== probe.kind) return false;
    if (probe.point !== undefined) return 'point' in constraint && constraint.point === probe.point;
    if (!('p1' in constraint)) return false;
    return (
      (constraint.p1 === probe.p1 && constraint.p2 === probe.p2) ||
      (constraint.p1 === probe.p2 && constraint.p2 === probe.p1)
    );
  });
}

/** Dimensions are px; a hair of solver noise should not show up as 479.9999. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
