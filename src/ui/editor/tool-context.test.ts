import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createIdGenerator,
  validate,
  type DocumentEdit,
  type Id,
  type SketchDocument,
} from '../../core/model';
import { createArcTool } from './arc-tool';
import { createLineTool } from './line-tool';
import type { Hit } from './hit-test';
import type { ToolContext } from './tool-context';

/**
 * The tools behind their context, with no DOM and no solver.
 *
 * This is the point of the interface: a tool is a small state machine over
 * clicks, and driving it directly says what the machine does without a canvas,
 * a viewport or a real hit test in the way. The editor's own tests cover the
 * wiring; these cover the states.
 */
interface Harness extends ToolContext {
  document: SketchDocument;
  /** Undo labels in order, which is also the transaction boundaries. */
  readonly labels: string[];
  /** What `pick` should report next. */
  hit: Hit | undefined;
}

function harness(): Harness {
  const nextId = createIdGenerator();
  const labels: string[] = [];
  const state: Harness = {
    document: createEmptyDocument(),
    labels,
    hit: undefined,
    doc: () => state.document,
    pointAt(id) {
      const point = id === undefined ? undefined : state.document.points[id];
      // A position, not the stored record: the editor reads these out of the
      // solve result, and only falls back to the document.
      return point === undefined ? undefined : { x: point.x, y: point.y };
    },
    pick: () => state.hit,
    place: (at) => at,
    nextId: (prefix) => nextId(prefix),
    apply(edit: DocumentEdit, label: string) {
      state.document = edit(state.document);
      labels.push(label);
    },
    infer: (_anchor, at) => ({ point: at, relations: [] }),
  };
  return state;
}

/** The hit a click on an existing point would report. */
const onPoint = (id: Id): Hit => ({ kind: 'point', id, distance: 0 });

describe('the line tool, driven directly', () => {
  let ctx: Harness;

  beforeEach(() => {
    ctx = harness();
  });

  it('places a point on the first click and draws nothing yet', () => {
    const tool = createLineTool(ctx);
    tool.placePoint({ x: 0, y: 0 });

    expect(Object.keys(ctx.document.points)).toHaveLength(1);
    expect(Object.keys(ctx.document.entities)).toHaveLength(0);
    expect(ctx.labels).toEqual(['Start line']);
  });

  it('draws a segment on the second, as one transaction', () => {
    const tool = createLineTool(ctx);
    tool.placePoint({ x: 0, y: 0 });
    tool.placePoint({ x: 100, y: 0 });

    expect(Object.keys(ctx.document.entities)).toHaveLength(1);
    expect(Object.keys(ctx.document.paths)).toHaveLength(1);
    // The point, the line and the path all land in the one 'Draw line' step.
    expect(ctx.labels).toEqual(['Start line', 'Draw line']);
    expect(validate(ctx.document)).toEqual([]);
  });

  it('collects a chain into one path record', () => {
    const tool = createLineTool(ctx);
    tool.placePoint({ x: 0, y: 0 });
    tool.placePoint({ x: 100, y: 0 });
    tool.placePoint({ x: 100, y: 80 });

    expect(Object.keys(ctx.document.entities)).toHaveLength(2);
    expect(Object.keys(ctx.document.paths)).toHaveLength(1);
  });

  it('closes the loop when a click lands back on the start', () => {
    const tool = createLineTool(ctx);
    tool.placePoint({ x: 0, y: 0 });
    const start = Object.keys(ctx.document.points)[0]!;
    tool.placePoint({ x: 100, y: 0 });
    tool.placePoint({ x: 100, y: 80 });

    ctx.hit = onPoint(start);
    tool.placePoint({ x: 0, y: 0 });

    const path = Object.values(ctx.document.paths)[0]!;
    expect(path.subpaths[0]!.closed).toBe(true);
    expect(ctx.labels.at(-1)).toBe('Close shape');
    // Closing ends the chain, so the next click starts a new one.
    expect(tool.end()).toBe(false);
  });

  it('refuses a second click on the point it just placed', () => {
    const tool = createLineTool(ctx);
    tool.placePoint({ x: 0, y: 0 });
    const only = Object.keys(ctx.document.points)[0]!;

    ctx.hit = onPoint(only);
    tool.placePoint({ x: 0, y: 0 });

    expect(Object.keys(ctx.document.entities)).toHaveLength(0);
  });

  it('reports whether a cursor move needs a redraw', () => {
    const tool = createLineTool(ctx);
    // Nothing in progress, so nothing to preview.
    expect(tool.trackCursor({ x: 10, y: 10 })).toBe(false);
    tool.placePoint({ x: 0, y: 0 });
    expect(tool.trackCursor({ x: 10, y: 10 })).toBe(true);
  });

  it('previews from the anchor to the cursor once a chain is going', () => {
    const tool = createLineTool(ctx);
    expect(tool.preview({ x: 10, y: 10 })).toBeUndefined();

    tool.placePoint({ x: 0, y: 0 });
    expect(tool.preview({ x: 10, y: 10 })).toEqual({
      kind: 'line',
      from: { x: 0, y: 0 },
      to: { x: 10, y: 10 },
    });
  });

  it('ends a chain in progress and reports that it did', () => {
    const tool = createLineTool(ctx);
    tool.placePoint({ x: 0, y: 0 });
    expect(tool.end()).toBe(true);
    expect(tool.end()).toBe(false);
    expect(tool.preview({ x: 10, y: 10 })).toBeUndefined();
  });
});

describe('the arc tool, driven directly', () => {
  let ctx: Harness;

  beforeEach(() => {
    ctx = harness();
  });

  /** Centre, start, then a sweep the caller describes with cursor moves. */
  function sweepTo(tool: ReturnType<typeof createArcTool>, through: readonly [number, number][]) {
    tool.placePoint({ x: 0, y: 0 });
    tool.placePoint({ x: 100, y: 0 });
    for (const [x, y] of through) tool.trackCursor({ x, y });
  }

  it('takes three clicks, and the third is the arc', () => {
    const tool = createArcTool(ctx);
    sweepTo(tool, [[71, 71]]);
    expect(Object.keys(ctx.document.entities)).toHaveLength(0);

    tool.placePoint({ x: 0, y: 100 });
    expect(Object.keys(ctx.document.entities)).toHaveLength(1);
    expect(ctx.labels).toEqual(['Arc centre', 'Arc start', 'Draw arc']);
    expect(validate(ctx.document)).toEqual([]);
  });

  it('takes its direction from the sweep, not from the final click', () => {
    const clockwise = createArcTool(ctx);
    sweepTo(clockwise, [[71, 71]]);
    clockwise.placePoint({ x: 0, y: 100 });
    const arcA = Object.values(ctx.document.entities)[0]!;
    expect(arcA.kind === 'arc' && arcA.clockwise).toBe(true);

    ctx = harness();
    const anticlockwise = createArcTool(ctx);
    // The same end point, reached the other way round — which is the whole
    // point: the direction is in the path the cursor took, and the final
    // click is identical in both cases.
    sweepTo(anticlockwise, [
      [71, -71],
      [0, -100],
      [-71, -71],
      [-100, 0],
      [-71, 71],
      [0, 100],
    ]);
    anticlockwise.placePoint({ x: 0, y: 100 });
    const arcB = Object.values(ctx.document.entities)[0]!;
    expect(arcB.kind === 'arc' && arcB.clockwise).toBe(false);
  });

  it('refuses a start on the centre', () => {
    const tool = createArcTool(ctx);
    tool.placePoint({ x: 0, y: 0 });
    const centre = Object.keys(ctx.document.points)[0]!;

    ctx.hit = onPoint(centre);
    tool.placePoint({ x: 0, y: 0 });

    expect(ctx.labels).toEqual(['Arc centre']);
  });

  it('refuses an end with no sweep behind it', () => {
    const tool = createArcTool(ctx);
    sweepTo(tool, []);
    tool.placePoint({ x: 0, y: 100 });
    expect(Object.keys(ctx.document.entities)).toHaveLength(0);
  });

  it('refuses an end on the centre, and stays armed', () => {
    const tool = createArcTool(ctx);
    sweepTo(tool, [[71, 71], [0, 100]]);
    const centre = Object.keys(ctx.document.points)[0]!;

    ctx.hit = onPoint(centre);
    tool.placePoint({ x: 0, y: 0 });
    expect(Object.keys(ctx.document.entities)).toHaveLength(0);

    ctx.hit = undefined;
    tool.placePoint({ x: 0, y: 100 });
    expect(Object.keys(ctx.document.entities)).toHaveLength(1);
  });

  it('puts the end point on the arc\'s own circle, not under the cursor', () => {
    const tool = createArcTool(ctx);
    sweepTo(tool, [[71, 71]]);
    // A click well inside the circle still ends on the rim.
    tool.placePoint({ x: 0, y: 20 });

    const arc = Object.values(ctx.document.entities)[0]!;
    expect(arc.kind).toBe('arc');
    const end = ctx.document.points[arc.kind === 'arc' ? arc.end : '']!;
    expect(Math.hypot(end.x, end.y)).toBeCloseTo(100, 9);
  });

  it('previews the radius before the start point and the arc after it', () => {
    const tool = createArcTool(ctx);
    expect(tool.preview({ x: 10, y: 10 })).toBeUndefined();

    tool.placePoint({ x: 0, y: 0 });
    expect(tool.preview({ x: 50, y: 0 })?.kind).toBe('line');

    tool.placePoint({ x: 100, y: 0 });
    expect(tool.preview({ x: 0, y: 100 })?.kind).toBe('arc');
  });

  it('ends an arc in progress and reports that it did', () => {
    const tool = createArcTool(ctx);
    expect(tool.end()).toBe(false);
    tool.placePoint({ x: 0, y: 0 });
    expect(tool.end()).toBe(true);
    expect(tool.preview({ x: 10, y: 10 })).toBeUndefined();
  });
});
