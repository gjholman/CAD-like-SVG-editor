/**
 * Dimension annotations: extension lines, a dimension line with arrowheads,
 * and the value, following the mockup's conventions.
 *
 * Placement is *derived*, not stored. The model has nowhere to keep a
 * user-chosen offset, and inventing a schema field for it belongs with the
 * dimension-placement work rather than here. So v0 puts each dimension on the
 * far side of the sketch from its centre — measuring a shape's top edge sends
 * the annotation up and out, not down through the middle of the shape — and
 * stacks repeats so they do not overlap. Dragging a dimension to place it
 * comes later.
 *
 * Geometry is computed in world units but offsets are screen units divided by
 * the zoom, so annotations keep their size as you zoom, like the line weights.
 */
import {
  constraintRefs,
  isDimensionConstraint,
  type Constraint,
  type Entity,
  type Id,
  type SketchDocument,
} from '../../core/model';
import { arcPoint, normalizeAngle, type ArcShape } from '../../core/geometry';
import type { Point2, Viewport } from './viewport';

/** Distance from the geometry to the dimension line, in screen px. */
const OFFSET = 34;
/** Extra offset per additional dimension on the same pair, in screen px. */
const STACK = 22;
const ARROW = 7;
const TEXT_GAP = 5;
/** Radius of an angle's arc, in screen px. */
const ANGLE_RADIUS = 46;

/** How an annotation is drawn. Three shapes cover all seven dimension kinds. */
export type DimensionShape =
  /** Extension lines out to an offset dimension line, arrows at both ends. */
  | 'linear'
  /** A leader straight to the geometry: a radius, a diameter, a gap. */
  | 'radial'
  /** An arc swept between two lines. */
  | 'angular';

export interface DimensionGeometry {
  readonly id: Id;
  readonly shape: DimensionShape;
  readonly suspended: boolean;
  /**
   * A reference dimension measures without constraining. Drawn the same way
   * but bracketed, which is the drawing convention and the only thing telling
   * a reader that this number is an output rather than an input.
   */
  readonly reference: boolean;
  /** The two points being measured. */
  readonly from: Point2;
  readonly to: Point2;
  /** Ends of the dimension line itself, offset clear of the geometry. */
  readonly lineFrom: Point2;
  readonly lineTo: Point2;
  /** Extension lines are drawn only where the dimension line stands off. */
  readonly extensions: boolean;
  /** One for a radius (the centre end is not a measured edge), two otherwise. */
  readonly arrows: 1 | 2;
  /** Set on an angular dimension: the arc the annotation sweeps. */
  readonly arc?: ArcShape;
  readonly label: string;
  readonly labelAt: Point2;
  /** Degrees; keeps a vertical dimension's text running along its line. */
  readonly labelRotation: number;
}

/** Every dimension in the document, driving or reference, laid out for drawing. */
export function dimensionGeometry(
  doc: SketchDocument,
  givenPositions: Readonly<Record<Id, Point2>>,
  viewport: Viewport,
): DimensionGeometry[] {
  const out: DimensionGeometry[] = [];
  // Two dimensions on the same geometry would land on top of each other,
  // which is exactly the over-defined case a user most needs to see.
  const stacked = new Map<string, number>();
  // Merged once, so every lookup below is total (Pitfalls §7).
  const positions =
    givenPositions === doc.points ? doc.points : { ...doc.points, ...givenPositions };
  // One pass over every point, not one per dimension: this is the same answer
  // each time round the loop below.
  const middle = centre(doc, positions);

  for (const id of Object.keys(doc.constraints).sort()) {
    const constraint = doc.constraints[id]!;
    if (!isDimensionConstraint(constraint)) continue;

    const refs = constraintRefs(constraint);
    const key = [...refs.points, ...refs.entities].sort().join('~');
    const depth = stacked.get(key) ?? 0;

    const laid = layoutFor(constraint, doc, positions, viewport, middle, depth);
    if (laid === undefined) continue;

    stacked.set(key, depth + 1);
    out.push(laid);
  }

  return out;
}

/** Dispatches on kind; each branch returns undefined if its geometry is gone. */
function layoutFor(
  constraint: Constraint,
  doc: SketchDocument,
  positions: Readonly<Record<Id, Point2>>,
  viewport: Viewport,
  middle: Point2,
  depth: number,
): DimensionGeometry | undefined {
  const offset = (OFFSET + depth * STACK) / viewport.scale;

  if (isPointPairDimension(constraint)) {
    const from = positions[constraint.p1];
    const to = positions[constraint.p2];
    if (from === undefined || to === undefined) return undefined;
    return layout(constraint, from, to, offset, viewport, middle);
  }

  if (constraint.kind === 'radius' || constraint.kind === 'diameter') {
    return layoutRadial(constraint, doc.entities[constraint.entity], positions, viewport, depth);
  }

  if (constraint.kind === 'point-line-distance') {
    return layoutToLine(constraint, doc.entities[constraint.entity], positions, viewport);
  }

  if (constraint.kind === 'angle') {
    return layoutAngle(constraint, doc, positions, viewport, depth);
  }

  return undefined;
}

/**
 * A radius or diameter: a leader straight through the geometry, no offset.
 *
 * The angle it is drawn at steps round with the stack depth, so a circle
 * carrying two annotations shows both rather than one on top of the other.
 */
function layoutRadial(
  constraint: Constraint & { kind: 'radius' | 'diameter'; value: number },
  entity: Entity | undefined,
  positions: Readonly<Record<Id, Point2>>,
  viewport: Viewport,
  depth: number,
): DimensionGeometry | undefined {
  if (entity === undefined || entity.kind === 'line') return undefined;
  const centrePoint = positions[entity.center];
  if (centrePoint === undefined) return undefined;

  const radius = radiusOf(entity, positions);
  if (radius === undefined || radius === 0) return undefined;

  // Out at a readable angle, stepped so a stack fans out instead of overlapping.
  const angle = -Math.PI / 4 + depth * (Math.PI / 6);
  const rim = arcPoint(centrePoint, radius, angle);
  const diameter = constraint.kind === 'diameter';
  const lineFrom = diameter ? arcPoint(centrePoint, radius, angle + Math.PI) : centrePoint;
  const gap = TEXT_GAP / viewport.scale;

  return {
    id: constraint.id,
    shape: 'radial',
    suspended: constraint.suspended === true,
    reference: constraint.reference === true,
    from: lineFrom,
    to: rim,
    lineFrom,
    lineTo: rim,
    extensions: false,
    // A radius has one measured end; its other end is the centre, which is a
    // construction point rather than an edge, so it gets no arrowhead.
    arrows: diameter ? 2 : 1,
    label: labelFor(constraint),
    labelAt: {
      x: (lineFrom.x + rim.x) / 2,
      y: (lineFrom.y + rim.y) / 2 - gap,
    },
    labelRotation: 0,
  };
}

/** A point-to-line distance: the perpendicular gap itself, drawn where it is. */
function layoutToLine(
  constraint: Constraint & { kind: 'point-line-distance'; point: Id; value: number },
  line: Entity | undefined,
  positions: Readonly<Record<Id, Point2>>,
  viewport: Viewport,
): DimensionGeometry | undefined {
  if (line?.kind !== 'line') return undefined;
  const point = positions[constraint.point];
  const a = positions[line.p1];
  const b = positions[line.p2];
  if (point === undefined || a === undefined || b === undefined) return undefined;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return undefined;

  // The foot of the perpendicular: where the measurement is actually taken.
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length);
  const foot = { x: a.x + dx * t, y: a.y + dy * t };
  const gap = TEXT_GAP / viewport.scale;

  return {
    id: constraint.id,
    shape: 'radial',
    suspended: constraint.suspended === true,
    reference: constraint.reference === true,
    from: point,
    to: foot,
    lineFrom: point,
    lineTo: foot,
    // The foot may sit off the end of the segment, so the line gets an
    // extension out to meet it rather than a dimension line hanging in space.
    extensions: t < 0 || t > 1,
    arrows: 2,
    label: labelFor(constraint),
    labelAt: { x: (point.x + foot.x) / 2, y: (point.y + foot.y) / 2 - gap },
    labelRotation: 0,
  };
}

/** An angle: an arc swept from the first line's direction to the second's. */
function layoutAngle(
  constraint: Constraint & { kind: 'angle'; a: Id; b: Id; value: number },
  doc: SketchDocument,
  positions: Readonly<Record<Id, Point2>>,
  viewport: Viewport,
  depth: number,
): DimensionGeometry | undefined {
  const a = doc.entities[constraint.a];
  const b = doc.entities[constraint.b];
  if (a?.kind !== 'line' || b?.kind !== 'line') return undefined;

  const a1 = positions[a.p1];
  const a2 = positions[a.p2];
  const b1 = positions[b.p1];
  const b2 = positions[b.p2];
  if (a1 === undefined || a2 === undefined || b1 === undefined || b2 === undefined) return undefined;

  const vertex = intersection(a1, a2, b1, b2);
  if (vertex === undefined) return undefined; // parallel lines have no angle to draw

  const startAngle = Math.atan2(a2.y - a1.y, a2.x - a1.x);
  const endAngle = Math.atan2(b2.y - b1.y, b2.x - b1.x);
  // The short way round, matching the number the dimension carries.
  let sweep = normalizeAngle(endAngle - startAngle);
  if (sweep > Math.PI) sweep -= Math.PI * 2;
  const clockwise = sweep >= 0;

  const radius = (ANGLE_RADIUS + depth * STACK) / viewport.scale;
  const start = arcPoint(vertex, radius, startAngle);
  const end = arcPoint(vertex, radius, endAngle);
  const gap = TEXT_GAP / viewport.scale;
  const labelAngle = startAngle + sweep / 2;

  return {
    id: constraint.id,
    shape: 'angular',
    suspended: constraint.suspended === true,
    reference: constraint.reference === true,
    from: start,
    to: end,
    lineFrom: start,
    lineTo: end,
    extensions: false,
    arrows: 2,
    arc: {
      centre: vertex,
      start,
      end,
      radius,
      clockwise,
      startAngle,
      endAngle,
      sweep: Math.abs(sweep),
    },
    label: labelFor(constraint),
    labelAt: arcPoint(vertex, radius + gap * 2, labelAngle),
    labelRotation: 0,
  };
}

/**
 * Where two infinite lines cross, or undefined when they are parallel.
 *
 * Parallel lines have no vertex to draw an angle around. The constraint is
 * still perfectly legal — zero degrees is a fine thing to ask for — so this
 * returns undefined and the annotation is simply not drawn, rather than
 * inventing a vertex somewhere off at infinity.
 */
function intersection(a1: Point2, a2: Point2, b1: Point2, b2: Point2): Point2 | undefined {
  const ax = a2.x - a1.x;
  const ay = a2.y - a1.y;
  const bx = b2.x - b1.x;
  const by = b2.y - b1.y;
  const denominator = ax * by - ay * bx;
  if (Math.abs(denominator) < 1e-9) return undefined;

  const t = ((b1.x - a1.x) * by - (b1.y - a1.y) * bx) / denominator;
  return { x: a1.x + ax * t, y: a1.y + ay * t };
}

function radiusOf(entity: Entity, positions: Readonly<Record<Id, Point2>>): number | undefined {
  if (entity.kind === 'circle') return entity.radius;
  if (entity.kind !== 'arc') return undefined;
  const centrePoint = positions[entity.center];
  const start = positions[entity.start];
  if (centrePoint === undefined || start === undefined) return undefined;
  return Math.hypot(start.x - centrePoint.x, start.y - centrePoint.y);
}

/** Dimensions that measure between two points, which is the original set. */
function isPointPairDimension(
  constraint: Constraint,
): constraint is Constraint & { value: number; p1: Id; p2: Id } {
  return (
    constraint.kind === 'distance' ||
    constraint.kind === 'horizontal-distance' ||
    constraint.kind === 'vertical-distance'
  );
}

/** Middle of the drawing, used to push annotations outward rather than across it. */
function centre(doc: SketchDocument, positions: Readonly<Record<Id, Point2>>): Point2 {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const id of Object.keys(doc.points)) {
    const point = positions[id] ?? doc.points[id]!;
    sumX += point.x;
    sumY += point.y;
    count += 1;
  }
  return count === 0 ? { x: 0, y: 0 } : { x: sumX / count, y: sumY / count };
}

function layout(
  constraint: Constraint & { value: number; p1: Id; p2: Id },
  from: Point2,
  to: Point2,
  offset: number,
  viewport: Viewport,
  middle: Point2,
): DimensionGeometry {
  const label = labelFor(constraint);
  const suspended = constraint.suspended === true;
  const gap = TEXT_GAP / viewport.scale;

  const common = {
    id: constraint.id,
    shape: 'linear' as const,
    suspended,
    reference: constraint.reference === true,
    extensions: true,
    arrows: 2 as const,
    from,
    to,
  };

  if (constraint.kind === 'horizontal-distance') {
    // Outward from the middle of the drawing: a top edge is dimensioned above
    // it, a bottom edge below, so the annotation never crosses the shape.
    const above = (from.y + to.y) / 2 <= middle.y;
    const y = above ? Math.min(from.y, to.y) - offset : Math.max(from.y, to.y) + offset;
    return {
      ...common,
      lineFrom: { x: from.x, y },
      lineTo: { x: to.x, y },
      label,
      labelAt: { x: (from.x + to.x) / 2, y: y - gap },
      labelRotation: 0,
    };
  }

  if (constraint.kind === 'vertical-distance') {
    // Same outward rule, with the text rotated to run along the dimension line.
    const left = (from.x + to.x) / 2 <= middle.x;
    const x = left ? Math.min(from.x, to.x) - offset : Math.max(from.x, to.x) + offset;
    return {
      ...common,
      lineFrom: { x, y: from.y },
      lineTo: { x, y: to.y },
      label,
      labelAt: { x: x - gap, y: (from.y + to.y) / 2 },
      labelRotation: -90,
    };
  }

  // Straight-line distance: offset perpendicular to the pair, on whichever
  // side faces away from the middle of the drawing.
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  let nx = -dy / length;
  let ny = dx / length;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  if (nx * (midX - middle.x) + ny * (midY - middle.y) < 0) {
    nx = -nx;
    ny = -ny;
  }
  const lineFrom = { x: from.x + nx * offset, y: from.y + ny * offset };
  const lineTo = { x: to.x + nx * offset, y: to.y + ny * offset };

  return {
    ...common,
    lineFrom,
    lineTo,
    label,
    labelAt: {
      x: (lineFrom.x + lineTo.x) / 2 + nx * gap,
      y: (lineFrom.y + lineTo.y) / 2 + ny * gap,
    },
    labelRotation: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}

/** Arrowhead outline pointing along the dimension line, in world units. */
export function arrowPath(tip: Point2, towards: Point2, viewport: Viewport): string {
  const dx = tip.x - towards.x;
  const dy = tip.y - towards.y;
  const length = Math.hypot(dx, dy) || 1;
  const size = ARROW / viewport.scale;
  const ux = dx / length;
  const uy = dy / length;
  // Base of the head, then two corners either side of the shaft.
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const half = size * 0.34;
  return [
    `M${round(tip.x)} ${round(tip.y)}`,
    `L${round(bx - uy * half)} ${round(by + ux * half)}`,
    `L${round(bx + uy * half)} ${round(by - ux * half)}`,
    'Z',
  ].join('');
}

/**
 * A signed dimension reads oddly on a drawing: a width of -480 just means the
 * points were picked right to left. Show the magnitude.
 */
export function formatValue(value: number): string {
  const magnitude = Math.abs(value);
  return Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(2);
}

/**
 * What a dimension reads on the drawing, prefix and all.
 *
 * The prefixes are the drawing conventions, and they carry real information:
 * `R25` and `⌀25` are different circles, and a bare `25` beside a circle does
 * not say which was meant. Brackets mark a reference dimension, whose number
 * is an output — that is the only thing distinguishing it from a driving one.
 */
export function labelFor(constraint: Constraint): string {
  const body = dimensionText(constraint);
  return constraint.reference === true ? `(${body})` : body;
}

function dimensionText(constraint: Constraint): string {
  if (!isDimensionConstraint(constraint)) return '';
  switch (constraint.kind) {
    case 'angle':
      // Signed: an angle's sign is its direction, not a pick order, and
      // -30° and 30° are mirror images rather than the same wedge.
      return `${formatAngle(constraint.value)}°`;
    case 'radius':
      return `R${formatValue(constraint.value)}`;
    case 'diameter':
      return `⌀${formatValue(constraint.value)}`;
    default:
      return formatValue(constraint.value);
  }
}

function formatAngle(degrees: number): string {
  return Number.isInteger(degrees) ? String(degrees) : degrees.toFixed(1);
}

/**
 * The value to store when the user types `typed` into a field showing
 * `stored`'s magnitude.
 *
 * Because the field shows a magnitude, the sign belongs to the pick order and
 * not to what was typed: a width stored as -480 (picked right to left) edited
 * to 300 must become -300. Re-applying the stored sign with a bare negation
 * did that, but inverted a *typed* negative — typing -300 into that same
 * field flipped the dimension's orientation instead of being read as the 300
 * the field would have shown it as.
 */
export function signedDimensionValue(stored: number, typed: number): number {
  const magnitude = Math.abs(typed);
  return stored < 0 ? -magnitude : magnitude;
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
