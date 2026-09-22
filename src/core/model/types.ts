/**
 * The document model: the single source of truth for a sketch.
 *
 * Two domains live here, linked only by IDs (see docs/svg-cad-plan.md,
 * "Compound paths"):
 *
 *   constraint domain  points, entities, constraints   <- all the solver sees
 *   output domain      paths, layers, styles           <- all that becomes SVG
 *
 * Documents are treated as immutable: every edit produces a new document, and
 * history keeps the old ones (docs/EXECUTION.md, Step 2). Nothing in here
 * mutates, so the `Readonly` markers are the contract, not a suggestion.
 *
 * Coordinates are y-down and in px, matching SVG.
 */
import type { Id } from './ids';

/** A free point. Points are first-class and shared between entities. */
export interface Point {
  readonly id: Id;
  readonly x: number;
  readonly y: number;
}

interface EntityBase {
  readonly id: Id;
  readonly layer: Id;
  /** Construction geometry constrains other geometry but is never exported. */
  readonly construction: boolean;
}

/** Line segment between two points. 4 DOF. */
export interface LineEntity extends EntityBase {
  readonly kind: 'line';
  readonly p1: Id;
  readonly p2: Id;
}

/** Circle. Centre point plus a radius variable, so 3 DOF. */
export interface CircleEntity extends EntityBase {
  readonly kind: 'circle';
  readonly center: Id;
  readonly radius: number;
}

/**
 * Circular arc, stored as three points plus a direction.
 *
 * The plan's DOF table describes an arc as centre, radius and two angles. Kept
 * that way its endpoints would be derived values, so a line could never share
 * a point with an arc — and shared points are how this model keeps topology
 * explicit. Storing the endpoints instead makes them ordinary points that any
 * relation can act on, and the solver adds one implicit constraint per arc
 * (both endpoints equidistant from the centre) so the arithmetic still lands
 * on 5 DOF: 6 variables minus 1.
 *
 * Radius is therefore derived, not stored: `|start - centre|`.
 */
export interface ArcEntity extends EntityBase {
  readonly kind: 'arc';
  readonly center: Id;
  readonly start: Id;
  readonly end: Id;
  /**
   * Which way round the arc sweeps, as it appears on screen. Coordinates are
   * y-down, so clockwise on screen is SVG's sweep-flag 1. Not a variable: it
   * picks one of two arcs through the same points, it does not move them.
   */
  readonly clockwise: boolean;
}

/** Bézier chains join this union in Phase 4. */
export type Entity = LineEntity | CircleEntity | ArcEntity;

export type EntityKind = Entity['kind'];

interface ConstraintBase {
  readonly id: Id;
  /**
   * Suspended constraints stay in the document, greyed in the UI, and are
   * skipped by the solver until resumed. This is how the cross-layer toggle
   * works, and the suspension is persistent (a plan decision).
   */
  readonly suspended?: boolean;
}

/** Two points occupy the same location. Removes 2 DOF. */
export interface CoincidentConstraint extends ConstraintBase {
  readonly kind: 'coincident';
  readonly p1: Id;
  readonly p2: Id;
}

/** A point lies somewhere on an entity. Removes 1 DOF. */
export interface PointOnConstraint extends ConstraintBase {
  readonly kind: 'point-on';
  readonly point: Id;
  readonly entity: Id;
}

/**
 * Two points share a y (horizontal) or an x (vertical). Removes 1 DOF.
 *
 * The plan lists these as applying to "a line or two points"; v1 stores only
 * the point pair, and the UI resolves a picked line to its endpoints. That
 * keeps every v1 constraint referencing points alone, which the solver likes.
 */
export interface HorizontalConstraint extends ConstraintBase {
  readonly kind: 'horizontal';
  readonly p1: Id;
  readonly p2: Id;
}

export interface VerticalConstraint extends ConstraintBase {
  readonly kind: 'vertical';
  readonly p1: Id;
  readonly p2: Id;
}

/** Pins a point where it stands. Removes 2 DOF. */
export interface FixConstraint extends ConstraintBase {
  readonly kind: 'fix';
  readonly point: Id;
}

/** Driving dimension: straight-line distance between two points. */
export interface DistanceConstraint extends ConstraintBase {
  readonly kind: 'distance';
  readonly p1: Id;
  readonly p2: Id;
  readonly value: number;
}

/** Driving dimension: signed x offset from p1 to p2. */
export interface HorizontalDistanceConstraint extends ConstraintBase {
  readonly kind: 'horizontal-distance';
  readonly p1: Id;
  readonly p2: Id;
  readonly value: number;
}

/** Driving dimension: signed y offset from p1 to p2. */
export interface VerticalDistanceConstraint extends ConstraintBase {
  readonly kind: 'vertical-distance';
  readonly p1: Id;
  readonly p2: Id;
  readonly value: number;
}

/**
 * Relations between two entities rather than between points.
 *
 * The v1 set deliberately referenced points only, which kept the solver's
 * variable mapping simple. These cannot: "parallel" is a statement about two
 * lines' directions, and resolving it to a point pair would lose that.
 */
interface EntityPairBase {
  readonly id: Id;
  readonly suspended?: boolean;
  readonly a: Id;
  readonly b: Id;
}

/** Two lines point the same way. Removes 1 DOF. */
export interface ParallelConstraint extends EntityPairBase {
  readonly kind: 'parallel';
}

/** Two lines meet at a right angle. Removes 1 DOF. */
export interface PerpendicularConstraint extends EntityPairBase {
  readonly kind: 'perpendicular';
}

/** Two lines lie along the same infinite line. Removes 2 DOF. */
export interface CollinearConstraint extends EntityPairBase {
  readonly kind: 'collinear';
}

/**
 * A line touches a circle or arc, or two circles/arcs touch each other.
 * Removes 1 DOF.
 */
export interface TangentConstraint extends EntityPairBase {
  readonly kind: 'tangent';
}

/** Equal length (two lines) or equal radius (two circles/arcs). Removes 1 DOF. */
export interface EqualConstraint extends EntityPairBase {
  readonly kind: 'equal';
}

/** Two circles or arcs share a centre. Removes 2 DOF. */
export interface ConcentricConstraint extends EntityPairBase {
  readonly kind: 'concentric';
}

/** A point sits halfway along a line. Removes 2 DOF. */
export interface MidpointConstraint {
  readonly id: Id;
  readonly suspended?: boolean;
  readonly point: Id;
  readonly entity: Id;
  readonly kind: 'midpoint';
}

/** Two points mirror each other about a line. Removes 2 DOF. */
export interface SymmetricConstraint {
  readonly id: Id;
  readonly suspended?: boolean;
  readonly p1: Id;
  readonly p2: Id;
  /** The line they are symmetric about. */
  readonly entity: Id;
  readonly kind: 'symmetric';
}

/** The v1 set, plus the v2 relations from Phase 2. */
export type Constraint =
  | CoincidentConstraint
  | PointOnConstraint
  | HorizontalConstraint
  | VerticalConstraint
  | FixConstraint
  | DistanceConstraint
  | HorizontalDistanceConstraint
  | VerticalDistanceConstraint
  | ParallelConstraint
  | PerpendicularConstraint
  | CollinearConstraint
  | TangentConstraint
  | EqualConstraint
  | ConcentricConstraint
  | MidpointConstraint
  | SymmetricConstraint;

export type ConstraintKind = Constraint['kind'];

/** Constraints that carry a driving number. */
export type DimensionConstraint =
  | DistanceConstraint
  | HorizontalDistanceConstraint
  | VerticalDistanceConstraint;

/**
 * Presentation attributes carried through import and export untouched.
 * Styling isn't designed yet, so this stays an opaque bag (a plan decision).
 */
export type StyleBag = Readonly<Record<string, string>>;

/**
 * One entity's place in a subpath. `reversed` means the path walks the entity
 * from its end to its start, which is how an imported `d` string's direction
 * survives a round trip.
 */
export interface PathMember {
  readonly entity: Id;
  readonly reversed: boolean;
}

export interface SubPath {
  readonly members: readonly PathMember[];
  /** A closed subpath exports with a trailing `Z`. */
  readonly closed: boolean;
}

/**
 * An SVG path element: where structure, direction, fill rule and style live.
 * The solver never sees these.
 */
export interface PathRecord {
  readonly id: Id;
  readonly layer: Id;
  readonly subpaths: readonly SubPath[];
  readonly fillRule: 'nonzero' | 'evenodd';
  readonly style: StyleBag;
}

export interface Layer {
  readonly id: Id;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
}

/** Bumped when the on-disk shape changes; migrations are still an open question. */
export const DOCUMENT_VERSION = 1;

export interface SketchDocument {
  readonly version: typeof DOCUMENT_VERSION;
  readonly points: Readonly<Record<Id, Point>>;
  readonly entities: Readonly<Record<Id, Entity>>;
  readonly constraints: Readonly<Record<Id, Constraint>>;
  readonly paths: Readonly<Record<Id, PathRecord>>;
  readonly layers: Readonly<Record<Id, Layer>>;
  /** Draw order, back to front. Must list every layer exactly once. */
  readonly layerOrder: readonly Id[];
}

/** A document with a single empty layer, ready to draw into. */
export function createEmptyDocument(layerId: Id = 'layer1', name = 'Layer 1'): SketchDocument {
  return {
    version: DOCUMENT_VERSION,
    points: {},
    entities: {},
    constraints: {},
    paths: {},
    layers: { [layerId]: { id: layerId, name, visible: true, locked: false } },
    layerOrder: [layerId],
  };
}

/**
 * The points and entities a constraint refers to.
 *
 * One definition, used by `validate`, the solver and the UI alike. Listing
 * these fields by hand at each call site is how an arc's endpoints came to be
 * treated as unreferenced: `center` exists on a circle *and* an arc, so a
 * branch that assumed the wrong one still typechecked.
 */
export function constraintRefs(constraint: Constraint): {
  readonly points: readonly Id[];
  readonly entities: readonly Id[];
} {
  switch (constraint.kind) {
    case 'fix':
      return { points: [constraint.point], entities: [] };
    case 'point-on':
    case 'midpoint':
      return { points: [constraint.point], entities: [constraint.entity] };
    case 'symmetric':
      return { points: [constraint.p1, constraint.p2], entities: [constraint.entity] };
    case 'coincident':
    case 'horizontal':
    case 'vertical':
    case 'distance':
    case 'horizontal-distance':
    case 'vertical-distance':
      return { points: [constraint.p1, constraint.p2], entities: [] };
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'tangent':
    case 'equal':
    case 'concentric':
      return { points: [], entities: [constraint.a, constraint.b] };
  }
}

/**
 * Every id a document uses, across all five collections.
 *
 * Ids must be unique document-wide, not per collection, so anything asking
 * "is this id taken?" has to look at all of them.
 */
export function documentIds(doc: SketchDocument): Id[] {
  return [
    ...Object.keys(doc.points),
    ...Object.keys(doc.entities),
    ...Object.keys(doc.constraints),
    ...Object.keys(doc.paths),
    ...Object.keys(doc.layers),
  ];
}

/** The point IDs an entity is built from, in a stable order. */
export function entityPointIds(entity: Entity): readonly Id[] {
  switch (entity.kind) {
    case 'line':
      return [entity.p1, entity.p2];
    case 'circle':
      return [entity.center];
    case 'arc':
      return [entity.center, entity.start, entity.end];
  }
}

/**
 * An arc's radius, which is derived rather than stored: the distance from its
 * centre to its start point. The implicit constraint keeps the end point the
 * same distance away, so either endpoint would do once the sketch is solved.
 */
export function arcRadius(
  arc: ArcEntity,
  positions: Readonly<Record<Id, { readonly x: number; readonly y: number }>>,
): number {
  const centre = positions[arc.center];
  const start = positions[arc.start];
  if (centre === undefined || start === undefined) return 0;
  return Math.hypot(start.x - centre.x, start.y - centre.y);
}
