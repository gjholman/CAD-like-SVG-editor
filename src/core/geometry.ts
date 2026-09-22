/**
 * Plain geometry over a document: no DOM, no solver, no rendering.
 *
 * This lives in `core` because both `io` and `ui` need it. Export has to size
 * a viewBox and lay out arc commands; the canvas has to fit the view and draw
 * the same arcs. Putting it in `ui` and importing it from `io` would invert
 * the dependency rule (`ui -> io -> core`), which is exactly what happened
 * before this module existed.
 *
 * Coordinates are y-down, matching SVG. That inverts the usual sense of
 * rotation: increasing `atan2` angle runs **clockwise on screen**, which is
 * also what SVG's sweep flag of 1 means. Every angle here follows that.
 */
import { arcRadius, type ArcEntity, type Id, type SketchDocument } from './model';

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const TWO_PI = Math.PI * 2;

/** Endpoints closer than this count as the same point. */
export const COINCIDENT = 1e-9;

/** Angle from a centre to a point, y-down, so larger is clockwise on screen. */
export function angleOf(centre: Point2, point: Point2): number {
  return Math.atan2(point.y - centre.y, point.x - centre.x);
}

/** Wraps an angle into [0, 2π). */
export function normalizeAngle(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * How far the arc sweeps, in [0, 2π), travelling in its own direction.
 *
 * Coincident endpoints are read as a whole circle rather than as nothing: an
 * arc whose ends have been dragged together is still an arc, and drawing it as
 * a zero-length stub would make it vanish.
 */
export function sweepAngle(startAngle: number, endAngle: number, clockwise: boolean): number {
  const delta = normalizeAngle(clockwise ? endAngle - startAngle : startAngle - endAngle);
  return delta < COINCIDENT ? TWO_PI : delta;
}

/** Is this angle on the drawn part of the arc, rather than the missing part? */
export function arcContainsAngle(
  startAngle: number,
  endAngle: number,
  clockwise: boolean,
  angle: number,
): boolean {
  const total = sweepAngle(startAngle, endAngle, clockwise);
  const travelled = normalizeAngle(clockwise ? angle - startAngle : startAngle - angle);
  return travelled <= total;
}

export function arcPoint(centre: Point2, radius: number, angle: number): Point2 {
  return { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) };
}

export interface ArcShape {
  readonly centre: Point2;
  readonly start: Point2;
  readonly end: Point2;
  readonly radius: number;
  readonly clockwise: boolean;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly sweep: number;
}

/** Resolves an arc entity against a set of positions, or undefined if it cannot. */
export function arcShape(
  arc: ArcEntity,
  positions: Readonly<Record<Id, Point2>>,
): ArcShape | undefined {
  const centre = positions[arc.center];
  const start = positions[arc.start];
  const end = positions[arc.end];
  if (centre === undefined || start === undefined || end === undefined) return undefined;

  const radius = arcRadius(arc, positions);
  if (!(radius > 0)) return undefined;

  const startAngle = angleOf(centre, start);
  const endAngle = angleOf(centre, end);
  return {
    centre,
    start,
    end,
    radius,
    clockwise: arc.clockwise,
    startAngle,
    endAngle,
    sweep: sweepAngle(startAngle, endAngle, arc.clockwise),
  };
}

/**
 * Extent of the drawing. Circles and arcs count the space they actually
 * occupy, not just their points, so fitting the view or sizing a viewBox does
 * not clip them.
 */
export function sketchBounds(
  doc: SketchDocument,
  givenPositions: Readonly<Record<Id, Point2>> = doc.points,
  radii: Readonly<Record<Id, number>> = {},
): Bounds | undefined {
  // Merged once, so every lookup below is safe. The arc branch goes through
  // `arcShape`, which does its own lookups and cannot fall back on its own —
  // a partial map used to drop arcs out of the bounds entirely, and with them
  // out of zoom-to-fit and the exported viewBox.
  const positions =
    givenPositions === doc.points ? doc.points : { ...doc.points, ...givenPositions };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;

  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    seen = true;
  };

  for (const id of Object.keys(doc.points)) {
    const point = positions[id]!;
    include(point.x, point.y);
  }

  for (const entity of Object.values(doc.entities)) {
    if (entity.kind === 'circle') {
      const centre = positions[entity.center];
      if (centre === undefined) continue;
      const radius = radii[entity.id] ?? entity.radius;
      include(centre.x - radius, centre.y - radius);
      include(centre.x + radius, centre.y + radius);
      continue;
    }

    if (entity.kind !== 'arc') continue;
    const shape = arcShape(entity, positions);
    if (shape === undefined) continue;
    // Only the compass points the arc actually passes through push the box
    // out; a quarter arc must not be boxed like a whole circle.
    for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      if (!arcContainsAngle(shape.startAngle, shape.endAngle, shape.clockwise, angle)) continue;
      const extreme = arcPoint(shape.centre, shape.radius, angle);
      include(extreme.x, extreme.y);
    }
  }

  return seen ? { minX, minY, maxX, maxY } : undefined;
}
