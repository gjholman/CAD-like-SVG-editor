/**
 * The arc tool: centre, then start, then end.
 *
 * Direction comes from the angle the cursor has *travelled* since the start
 * point, accumulated move by move, not from where the last click happens to
 * land. Taking the angle to the final position cannot tell a small arc from
 * the large one going the other way, so accumulating is what lets an arc run
 * past half a turn.
 *
 * The end point is placed on the arc's own circle rather than under the
 * cursor, so the sketch starts out consistent instead of being yanked into
 * shape by the arc's implicit radius constraint.
 *
 * All of its state is transient; `end` abandons whatever is in progress.
 */
import { addArc, addPoint, compose, type Id } from '../../core/model';
import { angleOf, arcPoint, normalizeAngle, type Point2, type Preview } from '../render';
import type { DrawingTool, ToolContext } from './tool-context';

/** Below this, the cursor has not swept anything worth calling an arc. */
const MIN_SWEEP = 1e-6;

export function createArcTool(ctx: ToolContext): DrawingTool {
  let centreId: Id | undefined;
  let startId: Id | undefined;
  let sweep = 0;
  let lastAngle: number | undefined;

  function placePoint(at: Point2): void {
    const doc = ctx.doc();
    const hit = ctx.pick(at);
    const existing = hit?.kind === 'point' ? hit.id : undefined;

    if (centreId === undefined) {
      const id = existing ?? ctx.nextId('p');
      const where = ctx.place(at);
      if (existing === undefined) ctx.apply(addPoint(id, where.x, where.y), 'Arc centre');
      centreId = id;
      return;
    }

    if (startId === undefined) {
      if (existing === centreId) return; // a zero radius is not an arc
      const id = existing ?? ctx.nextId('p');
      const where = ctx.place(at);
      if (existing === undefined) ctx.apply(addPoint(id, where.x, where.y), 'Arc start');
      startId = id;
      sweep = 0;
      const centre = ctx.pointAt(centreId);
      lastAngle = centre === undefined ? undefined : angleOf(centre, at);
      return;
    }

    const centre = ctx.pointAt(centreId);
    const start = ctx.pointAt(startId);
    const layer = doc.layerOrder[0];
    if (centre === undefined || start === undefined || layer === undefined) return;
    if (Math.abs(sweep) < MIN_SWEEP) return; // no sweep yet, so no arc

    // A click on the centre names no direction: the end angle is measured
    // from the centre, and at the centre there is no angle. It used to build
    // an arc anyway, with `atan2(0, 0)` landing the end back on the start —
    // an arc of no extent, which renders as nothing at all and leaves an
    // invisible entity in the document. Ignore the click; the tool stays
    // armed for a real one.
    if (existing === centreId || (at.x === centre.x && at.y === centre.y)) return;

    trackCursor(at);
    const radius = Math.hypot(start.x - centre.x, start.y - centre.y);
    const endAt = arcPoint(centre, radius, angleOf(centre, at));

    // Reuse a clicked point only if it can be an end: landing back on the
    // start is a zero sweep, which is not an arc.
    const reusable = existing !== undefined && existing !== startId;
    const endId = reusable ? existing : ctx.nextId('p');
    const arcId = ctx.nextId('arc');

    ctx.apply(
      compose(
        ...(reusable ? [] : [addPoint(endId, endAt.x, endAt.y)]),
        addArc(arcId, centreId, startId, endId, layer, sweep > 0),
      ),
      'Draw arc',
    );

    end();
  }

  /**
   * Follows the cursor round, accumulating the angle travelled rather than
   * taking the angle to the current position.
   */
  function trackCursor(at: Point2): boolean {
    if (centreId === undefined) return false;
    const centre = ctx.pointAt(centreId);
    if (centre === undefined) return false;

    const angle = angleOf(centre, at);
    if (startId !== undefined && lastAngle !== undefined) {
      // The shortest step from the previous angle, signed.
      let delta = normalizeAngle(angle - lastAngle);
      if (delta > Math.PI) delta -= Math.PI * 2;
      sweep += delta;
    }
    if (startId !== undefined) lastAngle = angle;
    return true;
  }

  function preview(cursor: Point2): Preview | undefined {
    if (centreId === undefined) return undefined;
    const centre = ctx.pointAt(centreId);
    if (centre === undefined) return undefined;

    const start = ctx.pointAt(startId);
    // Before the start point is placed, the radius itself is what is being
    // chosen, so show it as a line from the centre.
    if (start === undefined) return { kind: 'line', from: centre, to: cursor };

    const radius = Math.hypot(start.x - centre.x, start.y - centre.y);
    return {
      kind: 'arc',
      centre,
      start,
      end: arcPoint(centre, radius, angleOf(centre, cursor)),
      clockwise: sweep > 0,
    };
  }

  function end(): boolean {
    const wasActive = centreId !== undefined;
    centreId = undefined;
    startId = undefined;
    sweep = 0;
    lastAngle = undefined;
    return wasActive;
  }

  return { placePoint, trackCursor, preview, end };
}
