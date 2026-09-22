/**
 * Relations inferred while drawing.
 *
 * This is what the plan calls "inference while drawing", and the reason it
 * matters is design intent: a line the user meant to be horizontal should
 * *say* it is horizontal, not merely happen to be. Adding the relation is the
 * point; without it the sketch looks right and falls apart the moment anything
 * moves.
 *
 * Inference does two things at once, and both matter:
 *
 *   1. it **moves the point** onto the axis, so a nearly-horizontal drag lands
 *      exactly level rather than one pixel off, and
 *   2. it **records the relation**, so the solver keeps it level afterwards.
 *
 * Doing only the second would leave a visible kink the constraint then has to
 * pull out; doing only the first is the mistake the plan is warning about.
 *
 * Pure geometry: no DOM, no document.
 */
import type { Point2 } from '../../core/geometry';

/** Only the v1 relations can be inferred; tangent waits for Step 10. */
export type InferredRelation = 'horizontal' | 'vertical';

/** Within this many degrees of an axis, the user meant the axis. */
const ANGLE_TOLERANCE_DEGREES = 5;

/**
 * Below this screen length, the angle of a segment is mostly cursor noise, so
 * nothing is inferred and a short nudge cannot silently add a relation.
 */
const MIN_SCREEN_LENGTH = 12;

export interface InferenceOptions {
  /** Screen px per world px, for the length guard. */
  readonly scale: number;
  /** Set when the point is being joined to existing geometry. */
  readonly joined?: boolean;
  readonly angleTolerance?: number;
}

export interface Inference {
  /** Where the point should actually go. */
  readonly point: Point2;
  readonly relations: readonly InferredRelation[];
}

/**
 * What to infer for a segment from `from` to the cursor.
 *
 * A point being joined to existing geometry is left exactly where that
 * geometry is: the join is the stronger statement, and nudging a shared point
 * onto an axis would move the geometry it is shared with.
 */
export function inferSegment(from: Point2, cursor: Point2, options: InferenceOptions): Inference {
  if (options.joined === true) return { point: cursor, relations: [] };

  const dx = cursor.x - from.x;
  const dy = cursor.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length * options.scale < MIN_SCREEN_LENGTH) return { point: cursor, relations: [] };

  const tolerance = Math.tan(((options.angleTolerance ?? ANGLE_TOLERANCE_DEGREES) * Math.PI) / 180);
  const fromHorizontal = Math.abs(dy) / length;
  const fromVertical = Math.abs(dx) / length;

  // Whichever axis it is closer to wins; a segment cannot be both.
  if (fromHorizontal <= tolerance && fromHorizontal <= fromVertical) {
    return { point: { x: cursor.x, y: from.y }, relations: ['horizontal'] };
  }
  if (fromVertical <= tolerance) {
    return { point: { x: from.x, y: cursor.y }, relations: ['vertical'] };
  }

  return { point: cursor, relations: [] };
}

/** Icon for a hint glyph, matching the relation buttons. */
export function relationIcon(relation: InferredRelation): string {
  return relation === 'horizontal' ? '#i-horizontal' : '#i-vertical';
}
