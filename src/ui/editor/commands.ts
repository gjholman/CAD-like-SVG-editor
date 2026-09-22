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
  entityPointIds,
  isDimensionConstraint,
  type Constraint,
  type DimensionKind,
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

export type { DimensionKind } from '../../core/model';

/**
 * What a smart dimension would add for the current selection.
 *
 * `points` and `entities` are what the constraint will reference, so the
 * duplicate check and the edit can both be built from the plan alone.
 */
export interface DimensionPlan {
  readonly kind: DimensionKind;
  readonly points: readonly Id[];
  readonly entities: readonly Id[];
  readonly value: number;
  /** What the annotation will read, for previewing before the click. */
  readonly label: string;
}

/**
 * What a smart dimension would add for this selection, measured where the
 * geometry currently sits.
 *
 * One tool serves every kind, the way SolidWorks' smart dimension does — what
 * you pick decides what you get:
 *
 *   two points, or a line       length, or width/height if it is nearly axial
 *   two lines                   the angle between them
 *   a circle                    diameter (the drawing convention for a circle)
 *   an arc                      radius (the drawing convention for an arc)
 *   a point and a line          the perpendicular distance between them
 */
export function dimensionPlan(
  doc: SketchDocument,
  selection: Iterable<Id>,
  positions: Readonly<Record<Id, Point2>> = doc.points,
): DimensionPlan | undefined {
  const at = (id: Id): Point2 | undefined => positions[id] ?? doc.points[id];
  const { points, entities } = describeSelection(doc, selection);

  // Two lines: the angle between them, as they currently stand.
  if (points.length === 0 && entities.length === 2) {
    const [a, b] = entities as [Id, Id];
    if (a === b) return undefined;
    const da = lineDirection(doc, a, at);
    const db = lineDirection(doc, b, at);
    if (da === undefined || db === undefined) return undefined;

    const degrees = round(normalizeDegrees(((Math.atan2(db.y, db.x) - Math.atan2(da.y, da.x)) * 180) / Math.PI));
    return { kind: 'angle', points: [], entities: [a, b], value: degrees, label: `${degrees}°` };
  }

  // One round entity: diameter for a circle, radius for an arc.
  if (points.length === 0 && entities.length === 1) {
    const entity = doc.entities[entities[0]!];
    if (entity !== undefined && entity.kind !== 'line') {
      const radius = radiusOf(entity, at);
      if (radius === undefined) return undefined;
      return entity.kind === 'circle'
        ? { kind: 'diameter', points: [], entities: [entity.id], value: round(radius * 2), label: `⌀${round(radius * 2)}` }
        : { kind: 'radius', points: [], entities: [entity.id], value: round(radius), label: `R${round(radius)}` };
    }
  }

  // A point and a line: the perpendicular distance between them.
  if (points.length === 1 && entities.length === 1) {
    const point = at(points[0]!);
    const line = doc.entities[entities[0]!];
    if (point === undefined || line?.kind !== 'line') return undefined;
    const a = at(line.p1);
    const b = at(line.p2);
    if (a === undefined || b === undefined) return undefined;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) return undefined;
    const distance = round(Math.abs(dx * (point.y - a.y) - dy * (point.x - a.x)) / length);
    return {
      kind: 'point-line-distance',
      points: [points[0]!],
      entities: [line.id],
      value: distance,
      label: String(distance),
    };
  }

  // Otherwise the v1 behaviour: a point pair, or a line read as its endpoints.
  const pair = pointPair(doc, selection);
  if (pair === undefined) return undefined;
  const [p1, p2] = pair;
  if (p1 === p2) return undefined;

  const a = at(p1);
  const b = at(p2);
  if (a === undefined || b === undefined) return undefined;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // A generous margin, so a nearly-horizontal pair still reads as horizontal.
  const ratio = 3;

  if (Math.abs(dx) > Math.abs(dy) * ratio) {
    return { kind: 'horizontal-distance', points: [p1, p2], entities: [], value: round(dx), label: String(Math.abs(round(dx))) };
  }
  if (Math.abs(dy) > Math.abs(dx) * ratio) {
    return { kind: 'vertical-distance', points: [p1, p2], entities: [], value: round(dy), label: String(Math.abs(round(dy))) };
  }
  const length = round(Math.hypot(dx, dy));
  return { kind: 'distance', points: [p1, p2], entities: [], value: length, label: String(length) };
}

export function dimensionEdit(
  doc: SketchDocument,
  selection: Iterable<Id>,
  nextId: IdGenerator,
  positions?: Readonly<Record<Id, Point2>>,
  options: { readonly reference?: boolean } = {},
): DocumentEdit | undefined {
  const plan = dimensionPlan(doc, selection, positions);
  if (plan === undefined) return undefined;
  // A reference dimension is a read-out, so a second one saying the same thing
  // is merely clutter rather than an over-defined sketch — but it is still
  // clutter, so the same duplicate check applies.
  if (hasConstraint(doc, { kind: plan.kind, points: plan.points, entities: plan.entities })) {
    return undefined;
  }
  // A radius and a diameter on the same circle say the same thing, and the
  // solver would correctly but unhelpfully call the sketch over defined.
  const twin = plan.kind === 'radius' ? 'diameter' : plan.kind === 'diameter' ? 'radius' : undefined;
  if (twin !== undefined && hasConstraint(doc, { kind: twin, points: [], entities: plan.entities })) {
    return undefined;
  }

  const reference = options.reference === true ? { reference: true } : {};
  return addConstraint({
    id: nextId('dim'),
    kind: plan.kind,
    value: plan.value,
    ...shapeOf(plan),
    ...reference,
  } as Constraint);
}

/** The reference fields a constraint of this kind expects. */
function shapeOf(plan: DimensionPlan): Record<string, Id> {
  switch (plan.kind) {
    case 'angle':
      return { a: plan.entities[0]!, b: plan.entities[1]! };
    case 'radius':
    case 'diameter':
      return { entity: plan.entities[0]! };
    case 'point-line-distance':
      return { point: plan.points[0]!, entity: plan.entities[0]! };
    default:
      return { p1: plan.points[0]!, p2: plan.points[1]! };
  }
}

/** Turns a dimension into a reference measurement, or back into a driving one. */
export function setReference(id: Id, reference: boolean): DocumentEdit {
  return (doc) => {
    const constraint = doc.constraints[id];
    if (constraint === undefined || !isDimensionConstraint(constraint)) return doc;
    if ((constraint.reference ?? false) === reference) return doc;
    return { ...doc, constraints: { ...doc.constraints, [id]: { ...constraint, reference } } };
  };
}

/** A line's direction at the current positions, or undefined if it has none. */
function lineDirection(
  doc: SketchDocument,
  entityId: Id,
  at: (id: Id) => Point2 | undefined,
): Point2 | undefined {
  const entity = doc.entities[entityId];
  if (entity?.kind !== 'line') return undefined;
  const a = at(entity.p1);
  const b = at(entity.p2);
  if (a === undefined || b === undefined) return undefined;
  const direction = { x: b.x - a.x, y: b.y - a.y };
  return Math.hypot(direction.x, direction.y) === 0 ? undefined : direction;
}

function radiusOf(entity: Entity, at: (id: Id) => Point2 | undefined): number | undefined {
  if (entity.kind === 'circle') return entity.radius;
  if (entity.kind !== 'arc') return undefined;
  const centre = at(entity.center);
  const start = at(entity.start);
  if (centre === undefined || start === undefined) return undefined;
  return Math.hypot(start.x - centre.x, start.y - centre.y);
}

/** Into (-180, 180], so the number on the drawing is the one you would read. */
function normalizeDegrees(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
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

/**
 * Which layers a constraint reaches into.
 *
 * A point has no layer of its own — it belongs to whatever entities use it —
 * so a constraint between two points crosses layers when the geometry hanging
 * off those points does. That is the honest reading: suspending it is about
 * letting one layer move without dragging another along.
 */
export function layersTouched(doc: SketchDocument, constraint: Constraint): ReadonlySet<Id> {
  const refs = constraintRefs(constraint);
  const layers = new Set<Id>();

  for (const entityId of refs.entities) {
    const entity = doc.entities[entityId];
    if (entity !== undefined) layers.add(entity.layer);
  }
  for (const pointId of refs.points) {
    for (const entity of Object.values(doc.entities)) {
      if (entityPointIds(entity).includes(pointId)) layers.add(entity.layer);
    }
  }
  return layers;
}

/** Does this relation tie one layer to another? */
export function crossesLayers(doc: SketchDocument, constraint: Constraint): boolean {
  return layersTouched(doc, constraint).size > 1;
}

/**
 * The cross-layer relations the toggle would act on.
 *
 * The plan suspends them *for the geometry being clicked on* rather than
 * document-wide, so a selection narrows this to the crossings that touch it.
 *
 * When the selection touches no crossing at all, this falls back to every
 * crossing in the document rather than to nothing. Returning nothing would
 * make the affordance vanish the moment the user clicked something unrelated,
 * while a relation tying two layers together was still sitting in the panel
 * with its badge on — which reads as the feature breaking. The count on the
 * button always says exactly what a click will do, and it is one undo away.
 */
export function crossLayerConstraints(doc: SketchDocument, selection: Iterable<Id>): Id[] {
  const crossings = Object.keys(doc.constraints)
    .sort()
    .filter((id) => crossesLayers(doc, doc.constraints[id]!));

  const picked = new Set(selection);
  if (picked.size === 0) return crossings;

  const touching = crossings.filter((id) => {
    if (picked.has(id)) return true;
    const refs = constraintRefs(doc.constraints[id]!);
    return [...refs.points, ...refs.entities].some((ref) => picked.has(ref));
  });

  return touching.length > 0 ? touching : crossings;
}

/**
 * Suspends (or resumes) every cross-layer relation on the selection, as one
 * undo step.
 *
 * Suspension is persistent, which is the plan's decision: these stay switched
 * off until someone switches them back on, and the geometry that relied on
 * them correctly reports as under defined in the meantime.
 */
export function suspendCrossLayer(
  doc: SketchDocument,
  selection: Iterable<Id>,
  suspended: boolean,
): DocumentEdit | undefined {
  const ids = crossLayerConstraints(doc, selection).filter(
    (id) => (doc.constraints[id]!.suspended ?? false) !== suspended,
  );
  if (ids.length === 0) return undefined;
  return compose(...ids.map((id) => setSuspended(id, suspended)));
}
