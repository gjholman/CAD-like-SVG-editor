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
 * v0 tools are select (with drag) and line. Relations and dimensions are
 * commands on the current selection rather than modal tools, which is how the
 * mockup's relation buttons and its "select first" shortcuts work.
 */
import {
  addArc,
  addConstraint,
  addLine,
  addPoint,
  closePath,
  compose,
  createEmptyDocument,
  createIdGenerator,
  extendPath,
  pruneOrphanPoints,
  removeConstraint,
  removeEntity,
  removePoint,
  startPath,
  type Constraint,
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
  angleOf,
  arcPoint,
  fitTo,
  normalizeAngle,
  snapToGrid,
  panBy,
  render,
  screenToWorld,
  sketchBounds,
  zoomAt,
  type Point2,
  type Preview,
  type Viewport,
} from '../render';
import {
  canApplyRelation,
  dimensionEdit,
  dimensionPlan,
  relationEdit,
  setDimensionValue,
  setSuspended,
  type DimensionPlan,
  type RelationKind,
} from './commands';
import { hitTest, type Hit } from './hit-test';
import { inferSegment, relationIcon, type InferredRelation } from './inference';

export type ToolName = 'select' | 'line' | 'arc';

/** Shift-plus-letter applies a relation to the selection, as in the mockup. */
const RELATION_KEYS: Readonly<Record<string, RelationKind>> = {
  h: 'horizontal',
  v: 'vertical',
  c: 'coincident',
  f: 'fix',
};

const RELATION_LABELS: Readonly<Record<RelationKind, string>> = {
  horizontal: 'Add horizontal',
  vertical: 'Add vertical',
  coincident: 'Add coincident',
  fix: 'Fix point',
};

/** Pick radius in screen px, so it feels the same at any zoom. */
const PICK_TOLERANCE = 8;
const WHEEL_ZOOM_STEP = 1.0015;

export interface EditorOptions {
  readonly root: Element;
  readonly document?: SketchDocument;
  /** Where key handlers attach. Defaults to the root's owner document. */
  readonly keyboardTarget?: EventTarget;
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
  moved: boolean;
}

interface PanState {
  lastX: number;
  lastY: number;
}

export function createEditor(options: EditorOptions): Editor {
  const root = options.root;
  const keyboardTarget = options.keyboardTarget ?? root.ownerDocument ?? undefined;
  const nextId = options.nextId ?? createIdGenerator();

  let history = createHistory(options.document ?? createEmptyDocument());
  let viewport: Viewport = IDENTITY_VIEWPORT;
  let tool: ToolName = 'select';
  let showGrid = options.showGrid ?? true;
  let snapping = options.snapToGrid ?? false;
  let showDimensions = options.showDimensions ?? true;
  let inferring = options.inferRelations ?? false;
  /** What the pending click would add, recomputed on every move. */
  let inferred: InferredRelation[] = [];
  const gridSpacing = options.gridSpacing ?? 10;
  let selection: Id[] = [];
  let result: SolveResult = solve(current(history));

  let drag: DragState | undefined;
  let pan: PanState | undefined;
  /** The line tool's chain: where the next segment starts, and its path. */
  let chainPoint: Id | undefined;
  let chainPath: Id | undefined;
  /** Where the chain began, so clicking back on it closes the loop. */
  let chainStart: Id | undefined;

  /**
   * The arc tool in progress: centre, then start, then the swept angle the
   * cursor has traced. Direction comes from that sweep rather than from where
   * the last click lands, which is what lets an arc run past half a turn.
   */
  let arcCentre: Id | undefined;
  let arcStart: Id | undefined;
  let arcSweep = 0;
  let arcLastAngle: number | undefined;
  let cursor: Point2 | undefined;
  let gestureCounter = 0;

  /** What the active tool is trailing to the cursor, if anything. */
  function previewFor(): Preview | undefined {
    if (cursor === undefined) return undefined;

    if (tool === 'line' && chainPoint !== undefined) {
      const from = pointAt(chainPoint);
      return from === undefined ? undefined : { kind: 'line', from, to: cursor };
    }

    if (tool === 'arc' && arcCentre !== undefined) {
      const centre = pointAt(arcCentre);
      if (centre === undefined) return undefined;
      const start = pointAt(arcStart);
      // Before the start point is placed, the radius itself is what is being
      // chosen, so show it as a line from the centre.
      if (start === undefined) return { kind: 'line', from: centre, to: cursor };

      const radius = Math.hypot(start.x - centre.x, start.y - centre.y);
      return {
        kind: 'arc',
        centre,
        start,
        end: arcPoint(centre, radius, angleOf(centre, cursor)),
        clockwise: arcSweep > 0,
      };
    }

    return undefined;
  }

  function draw(): void {
    const preview = previewFor();
    render(root, current(history), {
      viewport,
      result,
      selection,
      preview,
      showDimensions,
      hints:
        cursor === undefined || inferred.length === 0
          ? undefined
          : { at: cursor, icons: inferred.map(relationIcon) },
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
  function inferFrom(anchor: Id | undefined, at: Point2, hit: Hit | undefined) {
    const placed = place(at);
    const from = pointAt(anchor);
    if (!inferring || from === undefined) return { point: placed, relations: [] as InferredRelation[] };

    const result = inferSegment(from, placed, {
      scale: viewport.scale,
      joined: hit?.kind === 'point',
    });
    return { point: result.point, relations: [...result.relations] };
  }

  /** Constraints for the relations a click just committed. */
  function inferredEdits(from: Id, to: Id, relations: readonly InferredRelation[]) {
    return relations.map((kind) =>
      addConstraint({ id: nextId('c'), kind, p1: from, p2: to } as Constraint),
    );
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
    result = solved !== undefined && options.pinned === undefined ? solved : solve(current(history));
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

    if (tool === 'line') {
      placeLinePoint(at);
      return;
    }

    if (tool === 'arc') {
      placeArcPoint(at);
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
      drag = { pointId: hit.id, gesture: `drag-${gestureCounter}`, moved: false };
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
      apply((doc) => doc, 'Move point', {
        gesture: dragged.gesture,
        pinned: { [dragged.pointId]: target },
      });
      dragged.moved = true;
      return;
    }

    if (tool === 'line') {
      inferred = chainPoint === undefined ? [] : inferFrom(chainPoint, at, pick(at)).relations;
      if (chainPoint !== undefined) draw();
    }
    if (tool === 'arc' && arcCentre !== undefined) {
      if (arcStart !== undefined) trackArcSweep(at);
      draw();
    }
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

  function placeLinePoint(at: Point2): void {
    const doc = current(history);
    const hit = pick(at);

    // Clicking an existing point reuses it, so the two segments genuinely
    // share a point rather than merely touching.
    const pointId = hit?.kind === 'point' ? hit.id : nextId('p');
    const guess = inferFrom(chainPoint, at, hit);
    const where = guess.point;
    const createPoint = hit?.kind === 'point' ? undefined : addPoint(pointId, where.x, where.y);

    if (chainPoint === undefined) {
      if (createPoint !== undefined) apply(createPoint, 'Start line');
      chainPoint = pointId;
      chainStart = pointId;
      chainPath = undefined;
      draw();
      return;
    }

    if (pointId === chainPoint) return; // a zero-length segment is not a line

    const layer = doc.layerOrder[0];
    if (layer === undefined) return;

    const lineId = nextId('line');
    const from = chainPoint;
    const continuing = chainPath;
    const pathId = continuing ?? nextId('path');
    // Clicking back on the point the chain started from closes the loop, which
    // is what makes the export a closed `<path d>` with a trailing Z.
    const closes = pointId === chainStart;

    apply(
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
      endChain();
      return;
    }

    chainPoint = pointId;
    chainPath = pathId;
    draw();
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

  /**
   * Follows the cursor round, accumulating the angle travelled rather than
   * taking the angle to the current position. Accumulating is what
   * distinguishes a small arc from the large one going the other way.
   */
  function trackArcSweep(at: Point2): void {
    const centre = pointAt(arcCentre);
    if (centre === undefined) return;
    const angle = angleOf(centre, at);
    if (arcLastAngle !== undefined) {
      // The shortest step from the previous angle, signed.
      let delta = normalizeAngle(angle - arcLastAngle);
      if (delta > Math.PI) delta -= Math.PI * 2;
      arcSweep += delta;
    }
    arcLastAngle = angle;
  }

  function pointAt(id: Id | undefined): Point2 | undefined {
    if (id === undefined) return undefined;
    return result.positions[id] ?? current(history).points[id];
  }

  /** Centre, then start, then end. */
  function placeArcPoint(at: Point2): void {
    const doc = current(history);
    const hit = pick(at);
    const existing = hit?.kind === 'point' ? hit.id : undefined;

    if (arcCentre === undefined) {
      const id = existing ?? nextId('p');
      const where = place(at);
      if (existing === undefined) apply(addPoint(id, where.x, where.y), 'Arc centre');
      arcCentre = id;
      draw();
      return;
    }

    if (arcStart === undefined) {
      if (existing === arcCentre) return; // a zero radius is not an arc
      const id = existing ?? nextId('p');
      const where = place(at);
      if (existing === undefined) apply(addPoint(id, where.x, where.y), 'Arc start');
      arcStart = id;
      arcSweep = 0;
      arcLastAngle = pointAt(arcCentre) === undefined ? undefined : angleOf(pointAt(arcCentre)!, at);
      draw();
      return;
    }

    const centre = pointAt(arcCentre);
    const start = pointAt(arcStart);
    const layer = doc.layerOrder[0];
    if (centre === undefined || start === undefined || layer === undefined) return;
    if (Math.abs(arcSweep) < 1e-6) return; // no sweep yet, so no arc

    trackArcSweep(at);
    const radius = Math.hypot(start.x - centre.x, start.y - centre.y);
    // The end point sits on the arc's own circle, so the sketch starts
    // consistent rather than being pulled straight by the implicit constraint.
    const endAt = arcPoint(centre, radius, angleOf(centre, at));

    const endId = existing !== undefined && existing !== arcStart ? existing : nextId('p');
    const arcId = nextId('arc');

    apply(
      compose(
        ...(endId === existing ? [] : [addPoint(endId, endAt.x, endAt.y)]),
        addArc(arcId, arcCentre, arcStart, endId, layer, arcSweep > 0),
      ),
      'Draw arc',
    );

    endArc();
  }

  function endArc(): void {
    arcCentre = undefined;
    arcStart = undefined;
    arcSweep = 0;
    arcLastAngle = undefined;
  }

  function endChain(): void {
    endArc();
    if (chainPoint === undefined) return;
    chainPoint = undefined;
    chainPath = undefined;
    chainStart = undefined;
    draw();
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
    const key = event as KeyboardEvent;
    const accel = key.metaKey || key.ctrlKey;

    if (accel && key.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (key.shiftKey) editor.redo();
      else editor.undo();
      return;
    }
    if (accel && key.key.toLowerCase() === 'y') {
      event.preventDefault();
      editor.redo();
      return;
    }
    if (accel) return;

    if (key.shiftKey) {
      const relation = RELATION_KEYS[key.key.toLowerCase()];
      if (relation !== undefined) {
        event.preventDefault();
        editor.applyRelation(relation);
        return;
      }
    }

    switch (key.key) {
      case 'd':
      case 'D':
        editor.addDimension();
        break;
      case 'g':
      case 'G':
        editor.setGridVisible(!showGrid);
        break;
      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        editor.deleteSelection();
        break;
      case 'Escape':
        endChain();
        selection = [];
        draw();
        break;
      case 'v':
      case 'V':
        editor.setTool('select');
        break;
      case 'l':
      case 'L':
        editor.setTool('line');
        break;
      case 'a':
      case 'A':
        editor.setTool('arc');
        break;
      default:
        break;
    }
  }

  function afterHistoryMove(): void {
    // Undo can remove the geometry a chain was building on, so drop it.
    endChain();
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
      inferred = [];
      draw();
    },
    getInferred: () => [...inferred],
    areDimensionsVisible: () => showDimensions,
    setDimensionsVisible(visible) {
      if (visible === showDimensions) return;
      showDimensions = visible;
      draw();
    },
    getGridSpacing: () => gridSpacing,
    setTool(next) {
      if (next === tool) return;
      endChain();
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
      history = createHistory(doc);
      endChain();
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
