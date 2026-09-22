/**
 * The line tool: click, click, click — a chain of segments.
 *
 * Consecutive clicks share their joining point rather than placing two
 * coincident ones, which is what makes the join real instead of something the
 * solver has to hold together. The chain also accumulates into one path
 * record, so a shape drawn in five clicks exports as one `<path d>`; clicking
 * back on where the chain started closes it, and that is the only way a
 * trailing `Z` is ever written.
 *
 * All of its state is transient: nothing here is in the document, and an
 * undo that removes the geometry underneath simply ends the chain.
 */
import {
  addConstraint,
  addLine,
  addPoint,
  closePath,
  compose,
  extendPath,
  startPath,
  type Constraint,
  type Id,
} from '../../core/model';
import type { Point2, Preview } from '../render';
import type { InferredRelation } from './inference';
import type { DrawingTool, ToolContext } from './tool-context';

export interface LineTool extends DrawingTool {
  /** The relations the pending click would add, for the cursor hints. */
  hints(): readonly InferredRelation[];
}

export function createLineTool(ctx: ToolContext): LineTool {
  /** Where the next segment starts, and the path collecting the chain. */
  let chainPoint: Id | undefined;
  let chainPath: Id | undefined;
  /** Where the chain began, so clicking back on it closes the loop. */
  let chainStart: Id | undefined;
  /** What the pending click would add, recomputed on every move. */
  let inferred: readonly InferredRelation[] = [];

  function placePoint(at: Point2): void {
    const doc = ctx.doc();
    const hit = ctx.pick(at);

    // Clicking an existing point reuses it, so the two segments genuinely
    // share a point rather than merely touching.
    const pointId = hit?.kind === 'point' ? hit.id : ctx.nextId('p');
    const guess = ctx.infer(chainPoint, at, hit);
    const where = guess.point;
    const createPoint = hit?.kind === 'point' ? undefined : addPoint(pointId, where.x, where.y);

    if (chainPoint === undefined) {
      if (createPoint !== undefined) ctx.apply(createPoint, 'Start line');
      chainPoint = pointId;
      chainStart = pointId;
      chainPath = undefined;
      return;
    }

    if (pointId === chainPoint) return; // a zero-length segment is not a line

    const layer = doc.layerOrder[0];
    if (layer === undefined) return;

    const lineId = ctx.nextId('line');
    const from = chainPoint;
    const continuing = chainPath;
    const pathId = continuing ?? ctx.nextId('path');
    // Clicking back on the point the chain started from closes the loop, which
    // is what makes the export a closed `<path d>` with a trailing Z.
    const closes = pointId === chainStart;

    ctx.apply(
      compose(
        ...(createPoint === undefined ? [] : [createPoint]),
        addLine(lineId, from, pointId, layer),
        continuing === undefined ? startPath(pathId, lineId) : extendPath(pathId, lineId),
        ...(closes ? [closePath(pathId)] : []),
        // The relations go in the same transaction as the geometry, so the
        // segment and what it means are one undo step.
        ...inferredEdits(from, pointId, guess.relations),
      ),
      closes ? 'Close shape' : 'Draw line',
    );

    inferred = [];

    if (closes) {
      end();
      return;
    }

    chainPoint = pointId;
    chainPath = pathId;
  }

  /** Constraints for the relations a click just committed. */
  function inferredEdits(from: Id, to: Id, relations: readonly InferredRelation[]) {
    return relations.map((kind) =>
      addConstraint({ id: ctx.nextId('c'), kind, p1: from, p2: to } as Constraint),
    );
  }

  function trackCursor(at: Point2): boolean {
    inferred = chainPoint === undefined ? [] : ctx.infer(chainPoint, at, ctx.pick(at)).relations;
    return chainPoint !== undefined;
  }

  function preview(cursor: Point2): Preview | undefined {
    if (chainPoint === undefined) return undefined;
    const from = ctx.pointAt(chainPoint);
    return from === undefined ? undefined : { kind: 'line', from, to: cursor };
  }

  function end(): boolean {
    inferred = [];
    if (chainPoint === undefined) return false;
    chainPoint = undefined;
    chainPath = undefined;
    chainStart = undefined;
    return true;
  }

  return { placePoint, trackCursor, preview, end, hints: () => inferred };
}
