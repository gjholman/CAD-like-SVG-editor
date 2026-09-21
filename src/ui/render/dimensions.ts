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
import type { Constraint, Id, SketchDocument } from '../../core/model';
import type { Point2, Viewport } from './viewport';

/** Distance from the geometry to the dimension line, in screen px. */
const OFFSET = 34;
/** Extra offset per additional dimension on the same pair, in screen px. */
const STACK = 22;
const ARROW = 7;
const TEXT_GAP = 5;

export interface DimensionGeometry {
  readonly id: Id;
  readonly suspended: boolean;
  /** The two points being measured. */
  readonly from: Point2;
  readonly to: Point2;
  /** Ends of the dimension line itself, offset clear of the geometry. */
  readonly lineFrom: Point2;
  readonly lineTo: Point2;
  readonly label: string;
  readonly labelAt: Point2;
  /** Degrees; keeps a vertical dimension's text running along its line. */
  readonly labelRotation: number;
}

/** Every driving dimension in the document, laid out for drawing. */
export function dimensionGeometry(
  doc: SketchDocument,
  positions: Readonly<Record<Id, Point2>>,
  viewport: Viewport,
): DimensionGeometry[] {
  const out: DimensionGeometry[] = [];
  // Two dimensions on the same pair would land on top of each other, which is
  // exactly the over-defined case a user most needs to see.
  const stacked = new Map<string, number>();

  for (const id of Object.keys(doc.constraints).sort()) {
    const constraint = doc.constraints[id]!;
    if (!isDimension(constraint)) continue;

    const from = positions[constraint.p1] ?? doc.points[constraint.p1];
    const to = positions[constraint.p2] ?? doc.points[constraint.p2];
    if (from === undefined || to === undefined) continue;

    const key = [constraint.p1, constraint.p2].sort().join('~');
    const depth = stacked.get(key) ?? 0;
    stacked.set(key, depth + 1);

    const offset = (OFFSET + depth * STACK) / viewport.scale;
    out.push(layout(constraint, from, to, offset, viewport, centre(doc, positions)));
  }

  return out;
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
  const label = formatValue(constraint.value);
  const suspended = constraint.suspended === true;
  const gap = TEXT_GAP / viewport.scale;

  if (constraint.kind === 'horizontal-distance') {
    // Outward from the middle of the drawing: a top edge is dimensioned above
    // it, a bottom edge below, so the annotation never crosses the shape.
    const above = (from.y + to.y) / 2 <= middle.y;
    const y = above ? Math.min(from.y, to.y) - offset : Math.max(from.y, to.y) + offset;
    return {
      id: constraint.id,
      suspended,
      from,
      to,
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
      id: constraint.id,
      suspended,
      from,
      to,
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
    id: constraint.id,
    suspended,
    from,
    to,
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

export function isDimension(
  constraint: Constraint,
): constraint is Constraint & { value: number; p1: Id; p2: Id } {
  return (
    constraint.kind === 'distance' ||
    constraint.kind === 'horizontal-distance' ||
    constraint.kind === 'vertical-distance'
  );
}

/**
 * A signed dimension reads oddly on a drawing: a width of -480 just means the
 * points were picked right to left. Show the magnitude.
 */
export function formatValue(value: number): string {
  const magnitude = Math.abs(value);
  return Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(2);
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
