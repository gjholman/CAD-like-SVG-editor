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
 * v0 tools are select (with drag) and line. Dimensions and relations arrive in
 * Step 6.
 */
import {
  addLine,
  addPoint,
  compose,
  createEmptyDocument,
  createIdGenerator,
  extendPath,
  startPath,
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
  panBy,
  render,
  screenToWorld,
  sketchBounds,
  zoomAt,
  type Point2,
  type Viewport,
} from '../render';
import { hitTest, type Hit } from './hit-test';

export type ToolName = 'select' | 'line';

/** Pick radius in screen px, so it feels the same at any zoom. */
const PICK_TOLERANCE = 8;
const WHEEL_ZOOM_STEP = 1.0015;

export interface EditorOptions {
  readonly root: Element;
  readonly document?: SketchDocument;
  /** Where key handlers attach. Defaults to the root's owner document. */
  readonly keyboardTarget?: EventTarget;
  readonly nextId?: IdGenerator;
  /** Canvas size, for `zoomToFit`. Defaults to reading the root's box. */
  readonly size?: () => { width: number; height: number };
}

export interface Editor {
  readonly root: Element;
  getDocument(): SketchDocument;
  getHistory(): History;
  getResult(): SolveResult;
  getViewport(): Viewport;
  getSelection(): readonly Id[];
  setSelection(ids: Iterable<Id>): void;
  getTool(): ToolName;
  setTool(tool: ToolName): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  zoomToFit(): void;
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
  let selection: Id[] = [];
  let result: SolveResult = solve(current(history));

  let drag: DragState | undefined;
  let pan: PanState | undefined;
  /** The line tool's chain: where the next segment starts, and its path. */
  let chainPoint: Id | undefined;
  let chainPath: Id | undefined;
  let cursor: Point2 | undefined;
  let gestureCounter = 0;

  function draw(): void {
    const preview =
      tool === 'line' && chainPoint !== undefined && cursor !== undefined
        ? { from: result.positions[chainPoint] ?? current(history).points[chainPoint]!, to: cursor }
        : undefined;
    render(root, current(history), { viewport, result, selection, preview });
  }

  /** The single place a change lands: dispatch, re-solve, redraw. */
  function apply(edit: (doc: SketchDocument) => SketchDocument, label: string, gesture?: string): void {
    const before = history;
    history = dispatch(history, edit, { label, gesture });
    if (history === before) return;
    result = solve(current(history));
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

    const hit = pick(at);
    if (hit === undefined) {
      selection = [];
      draw();
      return;
    }
    if (isLocked(hit)) return;

    selection = [hit.id];
    if (hit.kind === 'point') {
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
      apply(
        (doc) => applySolution(doc, solve(doc, { pinned: { [dragged.pointId]: at } })),
        'Move point',
        dragged.gesture,
      );
      dragged.moved = true;
      return;
    }

    if (tool === 'line' && chainPoint !== undefined) draw();
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
    const createPoint = hit?.kind === 'point' ? undefined : addPoint(pointId, at.x, at.y);

    if (chainPoint === undefined) {
      if (createPoint !== undefined) apply(createPoint, 'Start line');
      chainPoint = pointId;
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

    apply(
      compose(
        ...(createPoint === undefined ? [] : [createPoint]),
        addLine(lineId, from, pointId, layer),
        continuing === undefined ? startPath(pathId, lineId) : extendPath(pathId, lineId),
      ),
      'Draw line',
    );

    chainPoint = pointId;
    chainPath = pathId;
    draw();
  }

  function endChain(): void {
    if (chainPoint === undefined) return;
    chainPoint = undefined;
    chainPath = undefined;
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

    switch (key.key) {
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
    getTool: () => tool,
    setTool(next) {
      if (next === tool) return;
      endChain();
      tool = next;
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
