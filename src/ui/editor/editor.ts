/**
 * The editor shell: input in, `dispatch` out.
 *
 * Every change to the document goes through history `dispatch` (the plan's one
 * rule that makes undo cheap). Nothing here mutates a document; tools build
 * edits from `core/model` and hand them over.
 *
 * What lives where:
 *   history     the document and its undo stack
 *   viewport    pan and zoom, deliberately *not* undoable
 *   selection   transient, not part of the document
 *   tool state  transient (the line tool's chain in progress)
 *
 * v0 tools are select (with drag), line and arc. Relations and dimensions are
 * commands on the current selection rather than modal tools, which is how the
 * mockup's relation buttons and its "select first" shortcuts work.
 *
 * The drawing tools live in `line-tool.ts` and `arc-tool.ts`, each owning its
 * own transient state behind the `DrawingTool` interface, and the keyboard map
 * lives in `keymap.ts`. What is left here is the shell they share: history,
 * viewport, selection, the pointer state machine, and `apply`.
 */
import {
  compose,
  createEmptyDocument,
  documentIds,
  generatorPast,
  pruneOrphanPoints,
  removeConstraint,
  removeEntity,
  removePoint,
  type Id,
  type IdGenerator,
  type SketchDocument,
} from '../../core/model';
import {
  canRedo,
  canUndo,
  createHistory,
  current,
  dispatch,
  redo,
  undo,
  type History,
} from '../../core/history';
import { applySolution, solve, type SolveResult } from '../../core/solver';
import {
  IDENTITY_VIEWPORT,
  fitTo,
  snapToGrid,
  panBy,
  render,
  screenToWorld,
  sketchBounds,
  zoomAt,
  type Point2,
  type Viewport,
} from '../render';
import {
  canApplyRelation,
  dimensionEdit,
  dimensionPlan,
  relationEdit,
  crossLayerConstraints,
  setDimensionValue,
  setReference,
  setSuspended,
  suspendCrossLayer,
  type DimensionPlan,
  type RelationKind,
} from './commands';
import { hitTest, type Hit } from './hit-test';
import { inferSegment, relationIcon, type InferredRelation } from './inference';
import { createArcTool } from './arc-tool';
import { createLineTool } from './line-tool';
import { RELATION_LABELS, handleKey } from './keymap';
import type { DrawingTool, InferenceGuess, ToolContext } from './tool-context';

export type ToolName = 'select' | 'line' | 'arc';

/** Pick radius in screen px, so it feels the same at any zoom. */
const PICK_TOLERANCE = 8;
const WHEEL_ZOOM_STEP = 1.0015;

export interface EditorOptions {
  readonly root: Element;
  readonly document?: SketchDocument;
  /** Where key handlers attach. Defaults to the root's owner document. */
  readonly keyboardTarget?: EventTarget;
  /**
   * Where new ids come from. Injected in tests for predictable ids. Opening a
   * file replaces it with one that starts past the loaded document's ids, so
   * an injected generator does not survive a `load`.
   */
  readonly nextId?: IdGenerator;
  /** Canvas size, for `zoomToFit` and for how much grid to draw. */
  readonly size?: () => { width: number; height: number };
  /** Grid spacing in world px. */
  readonly gridSpacing?: number;
  /** Draw the grid. Default true. */
  readonly showGrid?: boolean;
  /** Draw dimension annotations. Default true. */
  readonly showDimensions?: boolean;
  /**
   * Round new points to the grid. Default **false**: snapping changes where a
   * click lands, so it is opt-in and the app turns it on rather than every
   * caller inheriting it.
   */
  readonly snapToGrid?: boolean;
  /**
   * Infer relations while drawing. Default **false** for the same reason as
   * snapping: it changes both where a point lands and what the document ends
   * up containing.
   */
  readonly inferRelations?: boolean;
}

export interface Editor {
  readonly root: Element;
  getDocument(): SketchDocument;
  getHistory(): History;
  getResult(): SolveResult;
  getViewport(): Viewport;
  getSelection(): readonly Id[];
  setSelection(ids: Iterable<Id>): void;
  /** Whether a relation button should be enabled for the current selection. */
  canApply(kind: RelationKind): boolean;
  applyRelation(kind: RelationKind): void;
  /** What a smart dimension would add right now, for previewing in the UI. */
  planDimension(): DimensionPlan | undefined;
  addDimension(): void;
  setDimensionValue(id: Id, value: number): void;
  /** Turns a dimension into a measurement that drives nothing, or back. */
  setReference(id: Id, reference: boolean): void;
  /** Relations tying the selection to geometry on another layer. */
  getCrossLayer(): readonly Id[];
  /** Suspends or resumes all of those, as one undo step. */
  suspendCrossLayer(suspended: boolean): void;
  setSuspended(id: Id, suspended: boolean): void;
  getTool(): ToolName;
  setTool(tool: ToolName): void;
  isGridVisible(): boolean;
  setGridVisible(visible: boolean): void;
  isSnapping(): boolean;
  setSnapping(snapping: boolean): void;
  isInferring(): boolean;
  setInferring(inferring: boolean): void;
  /** Relations the next click would add, for showing in the chrome. */
  getInferred(): readonly InferredRelation[];
  areDimensionsVisible(): boolean;
  setDimensionsVisible(visible: boolean): void;
  getGridSpacing(): number;
  /** Removes whatever is selected, and anything that cannot survive without it. */
  deleteSelection(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  zoomToFit(): void;
  /**
   * Replaces the document, as opening a file does. History starts fresh: the
   * steps that built the previous sketch mean nothing in this one.
   */
  load(doc: SketchDocument): void;
  /** Redraws from current state; every mutation already calls it. */
  refresh(): void;
  destroy(): void;
}

interface DragState {
  readonly pointId: Id;
  /** One token for the whole gesture, so the drag is a single undo step. */
  readonly gesture: string;
  /** Where the last move solved to, so a repeat of it can be skipped. */
  lastTarget: Point2 | undefined;
}

interface PanState {
  lastX: number;
  lastY: number;
}

export function createEditor(options: EditorOptions): Editor {
  const root = options.root;
  const keyboardTarget = options.keyboardTarget ?? root.ownerDocument ?? undefined;
  const initialDocument = options.document ?? createEmptyDocument();
  // Past the starting document's ids, not from zero: a document handed in at
  // construction is as much a loaded sketch as one opened from a file.
  let nextId = options.nextId ?? generatorPast(documentIds(initialDocument));

  let history = createHistory(initialDocument);
  let viewport: Viewport = IDENTITY_VIEWPORT;
  let tool: ToolName = 'select';
  let showGrid = options.showGrid ?? true;
  let snapping = options.snapToGrid ?? false;
  let showDimensions = options.showDimensions ?? true;
  let inferring = options.inferRelations ?? false;
  const gridSpacing = options.gridSpacing ?? 10;
  let selection: Id[] = [];
  let result: SolveResult = solve(current(history));

  let drag: DragState | undefined;
  let pan: PanState | undefined;
  let cursor: Point2 | undefined;
  let gestureCounter = 0;

  /**
   * What the tools are given: look the document up, hand an edit over. They
   * hold their own in-progress state and nothing else.
   */
  const context: ToolContext = {
    doc: () => current(history),
    pointAt,
    pick: (at) => pick(at),
    place,
    nextId: (prefix) => nextId(prefix),
    apply: (edit, label) => apply(edit, label),
    infer: (anchor, at, hit) => inferFrom(anchor, at, hit),
  };

  const lineTool = createLineTool(context);
  const arcTool = createArcTool(context);

  /** The tool a click goes to, or undefined for the select tool. */
  function drawingTool(): DrawingTool | undefined {
    if (tool === 'line') return lineTool;
    if (tool === 'arc') return arcTool;
    return undefined;
  }

  /** Relations the pending click would add; only the line tool infers. */
  function hints(): readonly InferredRelation[] {
    return tool === 'line' ? lineTool.hints() : [];
  }

  function draw(): void {
    const preview = cursor === undefined ? undefined : drawingTool()?.preview(cursor);
    const icons = hints();
    render(root, current(history), {
      viewport,
      result,
      selection,
      preview,
      showDimensions,
      hints:
        cursor === undefined || icons.length === 0
          ? undefined
          : { at: cursor, icons: icons.map(relationIcon) },
      grid: showGrid ? { spacing: gridSpacing, size: options.size?.() ?? measure(root) } : undefined,
    });
  }

  /**
   * Where a *new* point should land.
   *
   * Snapping cannot override an existing point, because a click that hits one
   * reuses its id and never creates a point at all — the callers below decide
   * that, so there is no guard for it here. Joining to real geometry matters
   * more than landing on a round number, and shared points are what keep the
   * topology explicit.
   */
  function place(at: Point2): Point2 {
    return snapping ? snapToGrid(at, gridSpacing) : at;
  }

  /**
   * What drawing from `anchor` to the cursor would infer, after snapping.
   *
   * Returns the adjusted point as well as the relations: inference moves the
   * point onto the axis so the geometry is right at the moment of the click,
   * rather than leaving a kink for the solver to pull out.
   */
  function inferFrom(anchor: Id | undefined, at: Point2, hit: Hit | undefined): InferenceGuess {
    const placed = place(at);
    const from = pointAt(anchor);
    if (!inferring || from === undefined) return { point: placed, relations: [] };

    const guess = inferSegment(from, placed, {
      scale: viewport.scale,
      joined: hit?.kind === 'point',
    });
    return { point: guess.point, relations: [...guess.relations] };
  }

  interface ApplyOptions {
    /** One token for a whole gesture, so a drag is a single undo step. */
    readonly gesture?: string;
    /** Points held at a position for this solve, as a drag does. */
    readonly pinned?: Readonly<Record<Id, Point2>>;
  }

  /**
   * The single place a change lands: edit, solve, commit the solved geometry,
   * redraw.
   *
   * The solve is committed *inside* the transaction because the plan keeps
   * solved positions in the snapshot: undo then restores the exact previous
   * state without re-solving. A solve that did not converge is left out, so a
   * contradictory constraint shows the user their own geometry in red rather
   * than a least-squares compromise they never asked for.
   */
  function apply(
    edit: (doc: SketchDocument) => SketchDocument,
    label: string,
    options: ApplyOptions = {},
  ): void {
    const before = history;
    let solved: SolveResult | undefined;

    history = dispatch(
      history,
      (doc) => {
        const edited = edit(doc);
        if (edited === doc && options.pinned === undefined) return doc;
        solved = solve(edited, options.pinned === undefined ? {} : { pinned: options.pinned });
        return solved.converged ? applySolution(edited, solved) : edited;
      },
      { label, gesture: options.gesture },
    );

    if (history === before) return;
    // The solve computed inside the transaction is the one to display, pinned
    // or not: pins are a pull toward the cursor, not constraints, so they
    // change no status and re-solving would only cost a second solve on every
    // single pointer move of a drag.
    result = solved ?? solve(current(history));
    draw();
  }

  function toWorld(event: { clientX: number; clientY: number }): Point2 {
    const box = root.getBoundingClientRect();
    return screenToWorld(viewport, { x: event.clientX - box.left, y: event.clientY - box.top });
  }

  function pick(at: Point2, ignore?: ReadonlySet<Id>): Hit | undefined {
    return hitTest({
      doc: current(history),
      positions: result.positions,
      radii: result.radii,
      at,
      tolerance: PICK_TOLERANCE / viewport.scale,
      ignorePoints: ignore,
    });
  }

  /** True when the entity or point sits on a locked layer. */
  function isLocked(hit: Hit): boolean {
    const doc = current(history);
    if (hit.kind !== 'entity') return false;
    const entity = doc.entities[hit.id];
    return entity !== undefined && doc.layers[entity.layer]?.locked === true;
  }

  function onPointerDown(event: Event): void {
    const mouse = event as MouseEvent;
    const at = toWorld(mouse);
    cursor = at;

    // Middle button, or space held, pans instead of editing.
    if (mouse.button === 1) {
      pan = { lastX: mouse.clientX, lastY: mouse.clientY };
      event.preventDefault();
      return;
    }
    if (mouse.button !== 0) return;

    const drawing = drawingTool();
    if (drawing !== undefined) {
      drawing.placePoint(at);
      draw();
      return;
    }

    const additive = mouse.shiftKey;
    const hit = pick(at);

    if (hit === undefined) {
      // Dimensions sit outside the geometry, so they are picked from the DOM
      // rather than by the geometric hit test.
      const dimension = dimensionUnder(mouse);
      selection = dimension === undefined ? (additive ? selection : []) : toggle(selection, dimension, additive);
      draw();
      return;
    }
    if (isLocked(hit)) return;

    selection = toggle(selection, hit.id, additive);

    // Dragging starts only on a plain click: shift-clicking is how a user
    // builds the pair a relation needs, and it must not move anything.
    if (hit.kind === 'point' && !additive) {
      gestureCounter += 1;
      drag = { pointId: hit.id, gesture: `drag-${gestureCounter}`, lastTarget: undefined };
    }
    draw();
  }

  function onPointerMove(event: Event): void {
    const mouse = event as MouseEvent;

    if (pan !== undefined) {
      viewport = panBy(viewport, mouse.clientX - pan.lastX, mouse.clientY - pan.lastY);
      pan.lastX = mouse.clientX;
      pan.lastY = mouse.clientY;
      draw();
      return;
    }

    const at = toWorld(mouse);
    cursor = at;

    if (drag !== undefined) {
      // The solver runs during the drag with the point pinned to the cursor,
      // so the rest of the sketch follows along whatever freedom it has.
      const dragged = drag;
      // A drag ignores the point under the cursor (it is the one being moved),
      // so snapping applies whenever it is on.
      const target = snapping ? snapToGrid(at, gridSpacing) : at;
      // Snapping makes most moves land on the same world position as the last
      // one, and a pinned solve runs whether or not the document changed, so
      // without this every pixel of cursor travel costs a full solve.
      const last = dragged.lastTarget;
      if (last !== undefined && last.x === target.x && last.y === target.y) return;
      dragged.lastTarget = target;
      apply((doc) => doc, 'Move point', {
        gesture: dragged.gesture,
        pinned: { [dragged.pointId]: target },
      });
      return;
    }

    if (drawingTool()?.trackCursor(at) === true) draw();
  }

  function onPointerUp(event: Event): void {
    const mouse = event as MouseEvent;
    if (pan !== undefined && mouse.button === 1) {
      pan = undefined;
      return;
    }
    // Ending the gesture is simply forgetting its token: the next dispatch
    // starts a fresh undo step.
    drag = undefined;
  }

  /** Which dimension, if any, the event landed on. */
  function dimensionUnder(mouse: MouseEvent): Id | undefined {
    const target = mouse.target;
    if (!(target instanceof Element)) return undefined;
    return target.closest('[data-dimension]')?.getAttribute('data-dimension') ?? undefined;
  }

  function toggle(current: readonly Id[], id: Id, additive: boolean): Id[] {
    if (!additive) return [id];
    return current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id];
  }

  function pointAt(id: Id | undefined): Point2 | undefined {
    if (id === undefined) return undefined;
    return result.positions[id] ?? current(history).points[id];
  }

  /** Abandons whatever a drawing tool had in progress. */
  function endTools(): void {
    const ended = [lineTool.end(), arcTool.end()].some(Boolean);
    if (ended) draw();
  }

  function onWheel(event: Event): void {
    const wheel = event as WheelEvent;
    event.preventDefault();
    const box = root.getBoundingClientRect();
    const screen = { x: wheel.clientX - box.left, y: wheel.clientY - box.top };
    viewport = zoomAt(viewport, screen, WHEEL_ZOOM_STEP ** -wheel.deltaY);
    draw();
  }

  function onKeyDown(event: Event): void {
    handleKey(event as KeyboardEvent, {
      undo: () => editor.undo(),
      redo: () => editor.redo(),
      applyRelation: (kind) => editor.applyRelation(kind),
      addDimension: () => editor.addDimension(),
      toggleGrid: () => editor.setGridVisible(!showGrid),
      deleteSelection: () => editor.deleteSelection(),
      cancel() {
        endTools();
        selection = [];
        draw();
      },
      setTool: (next) => editor.setTool(next),
    });
  }

  function afterHistoryMove(): void {
    // Undo can remove the geometry a chain was building on, so drop it.
    endTools();
    selection = [];
    result = solve(current(history));
    draw();
  }

  const editor: Editor = {
    root,
    getDocument: () => current(history),
    getHistory: () => history,
    getResult: () => result,
    getViewport: () => viewport,
    getSelection: () => [...selection],
    setSelection(ids) {
      selection = [...ids];
      draw();
    },
    canApply: (kind) => canApplyRelation(kind, current(history), selection),
    applyRelation(kind) {
      const edit = relationEdit(kind, current(history), selection, nextId);
      if (edit === undefined) return;
      apply(edit, RELATION_LABELS[kind]);
    },
    planDimension: () => dimensionPlan(current(history), selection, result.positions),
    addDimension() {
      const edit = dimensionEdit(current(history), selection, nextId, result.positions);
      if (edit === undefined) return;
      apply(edit, 'Add dimension');
    },
    setDimensionValue(id, value) {
      apply(setDimensionValue(id, value), 'Change dimension');
    },
    setReference(id, reference) {
      apply(setReference(id, reference), reference ? 'Make reference' : 'Make driving');
    },
    getCrossLayer: () => crossLayerConstraints(current(history), selection),
    suspendCrossLayer(suspended) {
      const edit = suspendCrossLayer(current(history), selection, suspended);
      if (edit === undefined) return;
      apply(edit, suspended ? 'Suspend across layers' : 'Resume across layers');
    },
    setSuspended(id, suspended) {
      apply(setSuspended(id, suspended), suspended ? 'Suspend relation' : 'Resume relation');
    },
    getTool: () => tool,
    isGridVisible: () => showGrid,
    setGridVisible(visible) {
      if (visible === showGrid) return;
      showGrid = visible;
      draw();
    },
    isSnapping: () => snapping,
    setSnapping(next) {
      snapping = next;
    },
    isInferring: () => inferring,
    setInferring(next) {
      if (next === inferring) return;
      inferring = next;
      // Recompute rather than clear: turning inference off drops the hints,
      // and turning it on with the cursor parked over the canvas shows them
      // without waiting for a move.
      if (cursor !== undefined) drawingTool()?.trackCursor(cursor);
      draw();
    },
    getInferred: () => [...hints()],
    areDimensionsVisible: () => showDimensions,
    setDimensionsVisible(visible) {
      if (visible === showDimensions) return;
      showDimensions = visible;
      draw();
    },
    getGridSpacing: () => gridSpacing,
    setTool(next) {
      if (next === tool) return;
      endTools();
      tool = next;
      draw();
    },
    deleteSelection() {
      const doc = current(history);
      if (selection.length === 0) return;

      const edits = selection.map((id) => {
        if (Object.hasOwn(doc.points, id)) return removePoint(id);
        if (Object.hasOwn(doc.entities, id)) return removeEntity(id);
        return removeConstraint(id);
      });

      // Geometry that was only there to hold a deleted entity goes too, or the
      // canvas fills with stray dots.
      apply(compose(...edits, pruneOrphanPoints()), 'Delete');
      selection = [];
      draw();
    },
    undo() {
      if (!canUndo(history)) return;
      history = undo(history);
      afterHistoryMove();
    },
    redo() {
      if (!canRedo(history)) return;
      history = redo(history);
      afterHistoryMove();
    },
    canUndo: () => canUndo(history),
    canRedo: () => canRedo(history),
    load(doc) {
      // Before anything else: a generator still counting from the *previous*
      // sketch mints ids the new one already uses, and since every edit is
      // keyed by id, the next point drawn replaces a loaded one instead of
      // colliding loudly.
      nextId = generatorPast(documentIds(doc));
      history = createHistory(doc);
      endTools();
      selection = [];
      result = solve(doc);
      draw();
    },
    zoomToFit() {
      const bounds = sketchBounds(current(history), result.positions, result.radii);
      if (bounds === undefined) return;
      viewport = fitTo(bounds, options.size?.() ?? measure(root));
      draw();
    },
    refresh: draw,
    destroy() {
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('wheel', onWheel);
      const view = root.ownerDocument?.defaultView;
      view?.removeEventListener('pointermove', onPointerMove);
      view?.removeEventListener('pointerup', onPointerUp);
      keyboardTarget?.removeEventListener('keydown', onKeyDown);
    },
  };

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('wheel', onWheel, { passive: false });
  // Move and release go on the window so a drag survives leaving the canvas.
  const view = root.ownerDocument?.defaultView;
  view?.addEventListener('pointermove', onPointerMove);
  view?.addEventListener('pointerup', onPointerUp);
  keyboardTarget?.addEventListener('keydown', onKeyDown);

  draw();
  return editor;
}

function measure(root: Element): { width: number; height: number } {
  const box = root.getBoundingClientRect();
  return { width: box.width || 800, height: box.height || 600 };
}
