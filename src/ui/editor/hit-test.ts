/**
 * What is under the cursor. Pure geometry, so it tests without a DOM.
 *
 * Points win over entities at equal distance: in a sketcher you reach for an
 * endpoint far more often than for the line it belongs to, and snapping to an
 * existing point is how shared geometry (and so implicit coincidence) gets
 * built.
 */
import type { Id, SketchDocument } from '../../core/model';
import type { Point2 } from '../render';

export type Hit =
  | { readonly kind: 'point'; readonly id: Id; readonly distance: number }
  | { readonly kind: 'entity'; readonly id: Id; readonly distance: number };

export interface HitTestInput {
  readonly doc: SketchDocument;
  readonly positions: Readonly<Record<Id, Point2>>;
  readonly radii?: Readonly<Record<Id, number>>;
  /** Cursor, in world coordinates. */
  readonly at: Point2;
  /** Pick radius, in world units (screen tolerance divided by the zoom). */
  readonly tolerance: number;
  /** Points to ignore, such as the one already being dragged. */
  readonly ignorePoints?: ReadonlySet<Id>;
}

export function hitTest(input: HitTestInput): Hit | undefined {
  return hitTestPoint(input) ?? hitTestEntity(input);
}

/** Nearest point within tolerance, or undefined. */
export function hitTestPoint(input: HitTestInput): Hit | undefined {
  const { doc, positions, at, tolerance, ignorePoints } = input;
  let best: Hit | undefined;

  for (const id of Object.keys(doc.points)) {
    if (ignorePoints?.has(id)) continue;
    const point = positions[id] ?? doc.points[id]!;
    const distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (distance <= tolerance && (best === undefined || distance < best.distance)) {
      best = { kind: 'point', id, distance };
    }
  }

  return best;
}

/** Nearest entity within tolerance, or undefined. */
export function hitTestEntity(input: HitTestInput): Hit | undefined {
  const { doc, positions, radii, at, tolerance } = input;
  let best: Hit | undefined;

  for (const id of Object.keys(doc.entities)) {
    const entity = doc.entities[id]!;
    const layer = doc.layers[entity.layer];
    // Hidden geometry cannot be clicked; locked geometry cannot be edited, so
    // the tools check that, not the hit test.
    if (layer === undefined || !layer.visible) continue;

    let distance: number | undefined;
    // Arcs become pickable in Step 9, along with their rendering.
    if (entity.kind === 'arc') continue;
    if (entity.kind === 'line') {
      const a = positions[entity.p1] ?? doc.points[entity.p1];
      const b = positions[entity.p2] ?? doc.points[entity.p2];
      if (a === undefined || b === undefined) continue;
      distance = distanceToSegment(at, a, b);
    } else {
      const centre = positions[entity.center] ?? doc.points[entity.center];
      if (centre === undefined) continue;
      const radius = radii?.[entity.id] ?? entity.radius;
      // Distance to the rim, not the disc: a circle is an outline, so clicking
      // the middle of a big one should not select it.
      distance = Math.abs(Math.hypot(at.x - centre.x, at.y - centre.y) - radius);
    }

    if (distance <= tolerance && (best === undefined || distance < best.distance)) {
      best = { kind: 'entity', id, distance };
    }
  }

  return best;
}

/** Perpendicular distance to a segment, clamped to its ends. */
export function distanceToSegment(p: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
