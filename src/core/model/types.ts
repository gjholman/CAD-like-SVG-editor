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

/**
 * What every constraint carries, whatever it relates.
 *
 * Every constraint extends this — three of them once re-declared `id` and
 * `suspended` by hand instead, and adding a field to the base then silently
 * missed them.
 */
interface ConstraintBase {
  readonly id: Id;
  /**
   * Suspended constraints stay in the document, greyed in the UI, and are
   * skipped by the solver until resumed. This is how the cross-layer toggle
   * works, and the suspension is persistent (a plan decision).
   */
  readonly suspended?: boolean;
  /**
   * A *reference* dimension measures without constraining: it is shown, it
   * updates as the geometry moves, and the solver never sees it. Only
   * meaningful on a dimension; everything else ignores it.
   *
   * This is not the same as suspended. A suspended constraint is a driving one
   * temporarily switched off and expected to come back; a reference dimension
   * is permanently a read-out, and drawing the two the same way would hide
   * which is which.
   */
  readonly reference?: boolean;
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
 * Driving dimension: the angle between two lines, in **degrees**.
 *
 * Stored in degrees because that is what the user types; the residual works in
 * radians. The angle is measured from line `a` to line `b`, following each
 * line's own direction (p1 to p2), and is positive clockwise like every other
 * angle in this model, because y is down.
 *
 * Reversing a line therefore changes the angle by 180°. That is a real
 * property of directed lines rather than a wrinkle to paper over: the UI
 * measures the angle as it currently stands and stores that.
 */
export interface AngleConstraint extends ConstraintBase {
  readonly kind: 'angle';
  readonly a: Id;
  readonly b: Id;
  /** Degrees, clockwise-positive. */
  readonly value: number;
}

/** Driving dimension: the radius of a circle or arc, in px. */
export interface RadiusConstraint extends ConstraintBase {
  readonly kind: 'radius';
  readonly entity: Id;
  readonly value: number;
}

/**
 * Driving dimension: the diameter of a circle or arc, in px.
 *
 * Exactly as strong as a radius dimension — it removes the same one degree of
 * freedom — and kept separate only so the drawing reads the way the user meant
 * it. Circles are conventionally dimensioned by diameter and arcs by radius.
 */
export interface DiameterConstraint extends ConstraintBase {
  readonly kind: 'diameter';
  readonly entity: Id;
  readonly value: number;
}

/**
 * Driving dimension: the perpendicular distance from a point to a line, in px.
 *
 * Unsigned, as on a drawing: which side the point sits is not part of the
 * dimension, and the solver keeps it on the side it started.
 */
export interface PointLineDistanceConstraint extends ConstraintBase {
  readonly kind: 'point-line-distance';
  readonly point: Id;
  readonly entity: Id;
  readonly value: number;
}

/**
 * Relations between two entities rather than between points.
 *
 * The v1 set deliberately referenced points only, which kept the solver's
 * variable mapping simple. These cannot: "parallel" is a statement about two
 * lines' directions, and resolving it to a point pair would lose that.
 */
interface EntityPairBase extends ConstraintBase {
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
export interface MidpointConstraint extends ConstraintBase {
  readonly kind: 'midpoint';
  readonly point: Id;
  readonly entity: Id;
}

/** Two points mirror each other about a line. Removes 2 DOF. */
export interface SymmetricConstraint extends ConstraintBase {
  readonly kind: 'symmetric';
  readonly p1: Id;
  readonly p2: Id;
  /** The line they are symmetric about. */
  readonly entity: Id;
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
  | AngleConstraint
  | RadiusConstraint
  | DiameterConstraint
  | PointLineDistanceConstraint
  | ParallelConstraint
  | PerpendicularConstraint
  | CollinearConstraint
  | TangentConstraint
  | EqualConstraint
  | ConcentricConstraint
  | MidpointConstraint
  | SymmetricConstraint;

export type ConstraintKind = Constraint['kind'];

/** Constraints that carry a number, driving or reference. */
export type DimensionConstraint =
  | DistanceConstraint
  | HorizontalDistanceConstraint
  | VerticalDistanceConstraint
  | AngleConstraint
  | RadiusConstraint
  | DiameterConstraint
  | PointLineDistanceConstraint;

export type DimensionKind = DimensionConstraint['kind'];

/** Every kind that carries a number, for the checks that need the list. */
export const DIMENSION_KINDS = [
  'distance',
  'horizontal-distance',
  'vertical-distance',
  'angle',
  'radius',
  'diameter',
  'point-line-distance',
] as const satisfies readonly DimensionKind[];

export function isDimensionConstraint(constraint: Constraint): constraint is DimensionConstraint {
  return (DIMENSION_KINDS as readonly string[]).includes(constraint.kind);
}

/**
 * Does this constraint remove any freedom?
 *
 * Two things make a constraint invisible to the solver, and they mean
 * different things: a suspended constraint is switched off for now, and a
 * reference dimension never constrained anything in the first place.
 */
export function isDriving(constraint: Constraint): boolean {
  return constraint.suspended !== true && constraint.reference !== true;
}

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
    case 'point-line-distance':
      return { points: [constraint.point], entities: [constraint.entity] };
    case 'radius':
    case 'diameter':
      return { points: [], entities: [constraint.entity] };
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
    case 'angle':
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
