/**
 * What a drawing tool needs from the editor around it.
 *
 * The tools own their transient state (a chain of segments, an arc part way
 * through) and nothing else: they look the document up rather than holding it,
 * and they change it only by handing an edit to `apply`, which is the editor's
 * single route into `dispatch`. That keeps the plan's one-transaction rule
 * intact no matter how many tools there eventually are.
 */
import type { DocumentEdit, Id, SketchDocument } from '../../core/model';
import type { Point2, Preview } from '../render';
import type { Hit } from './hit-test';
import type { InferredRelation } from './inference';

/** What inference makes of a segment that has not been committed yet. */
export interface InferenceGuess {
  /** The point to use, moved onto an inferred axis if there is one. */
  readonly point: Point2;
  readonly relations: readonly InferredRelation[];
}

export interface ToolContext {
  /** The document as it is right now. */
  doc(): SketchDocument;
  /** A point's solved position, falling back to its stored one. */
  pointAt(id: Id | undefined): Point2 | undefined;
  /** What is under `at`, within the pick tolerance. */
  pick(at: Point2): Hit | undefined;
  /** Where a *new* point should land: snapped to the grid if snapping is on. */
  place(at: Point2): Point2;
  nextId(prefix?: string): Id;
  /** Edit, solve, commit, redraw — as one undo step. */
  apply(edit: DocumentEdit, label: string): void;
  /** What drawing from `anchor` to `at` would infer, after snapping. */
  infer(anchor: Id | undefined, at: Point2, hit: Hit | undefined): InferenceGuess;
}

/**
 * A modal drawing tool.
 *
 * Every tool is a small state machine driven by clicks, with a preview
 * trailing the cursor in between. `end` is what a tool switch, an Escape or an
 * undo calls: the geometry a half-finished tool was building on may be gone.
 */
export interface DrawingTool {
  /** A primary click at `at`. */
  placePoint(at: Point2): void;
  /** The cursor moved. True when the view needs redrawing. */
  trackCursor(at: Point2): boolean;
  /** What to draw trailing the cursor, if anything. */
  preview(cursor: Point2): Preview | undefined;
  /** Abandons whatever is in progress. True when something was. */
  end(): boolean;
}
