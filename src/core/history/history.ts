/**
 * Undo/redo: the single entry point through which every document change flows.
 *
 * The plan's decision is snapshots, not inverse commands: each transaction
 * returns a whole new document, and history keeps the old references. Because
 * documents are immutable and share structure, keeping them is cheap, and undo
 * restores the exact previous state without re-solving (solved positions are
 * part of the snapshot).
 *
 * A `History` is itself an immutable value: `dispatch`, `undo` and `redo`
 * return a new one rather than mutating. The UI holds the latest in a store.
 *
 * What is deliberately *not* here: the viewport (pan and zoom are not undoable),
 * and any cap on stack depth (structural sharing makes snapshots cheap; the
 * plan names inverse patches as the answer if memory ever becomes a concern).
 */
import type { SketchDocument } from '../model';

/**
 * A pure document edit. Returning the document unchanged means "nothing
 * happened", and `dispatch` then records no undo step.
 */
export type Transaction = (doc: SketchDocument) => SketchDocument;

export interface DispatchOptions {
  /** Shown in the UI, as in "Undo Move Point". */
  readonly label?: string;
  /**
   * Groups a gesture into one undo step. Consecutive dispatches carrying the
   * same token replace each other instead of stacking, so a drag undoes in one
   * go. The caller mints a fresh token per gesture (on pointer-down), which is
   * what keeps two drags of the same point from merging.
   */
  readonly gesture?: string;
}

export interface HistoryEntry {
  readonly doc: SketchDocument;
  readonly label?: string;
  readonly gesture?: string;
}

export interface History {
  readonly past: readonly HistoryEntry[];
  readonly present: HistoryEntry;
  readonly future: readonly HistoryEntry[];
}

export function createHistory(doc: SketchDocument): History {
  return { past: [], present: { doc }, future: [] };
}

/** The document as it stands now. */
export function current(history: History): SketchDocument {
  return history.present.doc;
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

/** Label of the step undo would reverse, for menu and tooltip text. */
export function undoLabel(history: History): string | undefined {
  return canUndo(history) ? history.present.label : undefined;
}

/** Label of the step redo would re-apply. */
export function redoLabel(history: History): string | undefined {
  return history.future[0]?.label;
}

/**
 * Applies a transaction and records it. Any new edit clears the redo stack.
 */
export function dispatch(
  history: History,
  transaction: Transaction,
  options: DispatchOptions = {},
): History {
  const next = transaction(history.present.doc);

  // A transaction that changed nothing is not an undo step.
  if (next === history.present.doc) return history;

  const entry: HistoryEntry = { doc: next, label: options.label, gesture: options.gesture };

  // Continuing a gesture replaces the present instead of stacking a step. The
  // pre-gesture document is already on `past`, so undo lands before the drag.
  const continuesGesture =
    options.gesture !== undefined && history.present.gesture === options.gesture;

  return continuesGesture
    ? { past: history.past, present: entry, future: [] }
    : { past: [...history.past, history.present], present: entry, future: [] };
}

export function undo(history: History): History {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
  };
}
