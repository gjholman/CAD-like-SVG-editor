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
  constraintRefs,
  type Constraint,
  type DocumentEdit,
  type Entity,
  type Id,
  type IdGenerator,
  type SketchDocument,
} from '../../core/model';
import type { Point2 } from '../render';

export type RelationKind =
  | 'horizontal'
  | 'vertical'
  | 'coincident'
  | 'fix'
  | 'parallel'
  | 'perpendicular'
  | 'collinear'
  | 'tangent'
  | 'equal'
  | 'concentric'
  | 'midpoint'
  | 'symmetric';

/** Relations between two whole entities rather than between points. */
const ENTITY_PAIRS = ['parallel', 'perpendicular', 'collinear', 'tangent', 'equal', 'concentric'] as const;

type EntityPairKind = (typeof ENTITY_PAIRS)[number];

const isEntityPair = (kind: RelationKind): kind is EntityPairKind =>
  (ENTITY_PAIRS as readonly string[]).includes(kind);

/** A circle or an arc: the things that have a centre and a radius. */
const isRound = (entity: Entity | undefined): boolean =>
  entity?.kind === 'circle' || entity?.kind === 'arc';

const isLine = (entity: Entity | undefined): boolean => entity?.kind === 'line';

/**
 * Whether a relation makes sense for these two entities.
 *
 * Refusing here is better than letting the solver add a row it cannot read:
 * "parallel to a circle" would sit in the relations list removing no freedom,
 * and the user would have no way to tell why their sketch stayed blue.
 */
function suitsPair(kind: EntityPairKind, a: Entity | undefined, b: Entity | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  switch (kind) {
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
      return isLine(a) && isLine(b);
    case 'concentric':
      return isRound(a) && isRound(b);
    case 'tangent':
      // A line and a round thing, or two round things. Never two lines.
      return (isRound(a) || isRound(b)) && !(isLine(a) && isLine(b));
    case 'equal':
      // Length against length, or radius against radius, never one of each.
      return (isLine(a) && isLine(b)) || (isRound(a) && isRound(b));
  }
}

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
  const { points, entities } = describeSelection(doc, selection);

  if (kind === 'fix') {
    const unfixed = points.filter((id) => !hasConstraint(doc, { kind: 'fix', points: [id], entities: [] }));
    if (unfixed.length === 0) return undefined;
    return compose(...unfixed.map((id) => addConstraint({ id: nextId('c'), kind: 'fix', point: id })));
  }

  if (isEntityPair(kind)) {
    if (points.length > 0 || entities.length !== 2) return undefined;
    const [a, b] = entities as [Id, Id];
    if (a === b) return undefined;
    if (!suitsPair(kind, doc.entities[a], doc.entities[b])) return undefined;
    if (hasConstraint(doc, { kind, points: [], entities: [a, b] })) return undefined;
    return addConstraint({ id: nextId('c'), kind, a, b } as Constraint);
  }

  if (kind === 'midpoint') {
    if (points.length !== 1 || entities.length !== 1) return undefined;
    const [point] = points as [Id];
    const [entity] = entities as [Id];
    if (!isLine(doc.entities[entity])) return undefined;
    if (hasConstraint(doc, { kind, points: [point], entities: [entity] })) return undefined;
    return addConstraint({ id: nextId('c'), kind, point, entity });
  }

  if (kind === 'symmetric') {
    if (points.length !== 2 || entities.length !== 1) return undefined;
    const [p1, p2] = points as [Id, Id];
    const [entity] = entities as [Id];
    if (!isLine(doc.entities[entity])) return undefined;
    if (hasConstraint(doc, { kind, points: [p1, p2], entities: [entity] })) return undefined;
    return addConstraint({ id: nextId('c'), kind, p1, p2, entity });
  }

  // The v1 point-pair relations, which also accept a picked line.
  const pair = pointPair(doc, selection);
  if (pair === undefined) return undefined;
  const [p1, p2] = pair;
  if (p1 === p2) return undefined;
  if (hasConstraint(doc, { kind, points: [p1, p2], entities: [] })) return undefined;

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
  if (hasConstraint(doc, { kind: plan.kind, points: [plan.p1, plan.p2], entities: [] })) return undefined;

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

/**
 * Is an equivalent relation already present?
 *
 * Same kind and same set of references, whichever order they were picked in.
 * Comparing sets rather than fields means a new relation kind cannot be
 * forgotten here — which is the mistake that let an arc's endpoints go
 * unnoticed elsewhere.
 */
function hasConstraint(
  doc: SketchDocument,
  probe: { kind: Constraint['kind']; points: readonly Id[]; entities: readonly Id[] },
): boolean {
  const key = (points: readonly Id[], entities: readonly Id[]) =>
    `${[...points].sort().join(',')}|${[...entities].sort().join(',')}`;
  const wanted = key(probe.points, probe.entities);

  return Object.values(doc.constraints).some((constraint) => {
    if (constraint.kind !== probe.kind) return false;
    const refs = constraintRefs(constraint);
    return key(refs.points, refs.entities) === wanted;
  });
}

/** Dimensions are px; a hair of solver noise should not show up as 479.9999. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
