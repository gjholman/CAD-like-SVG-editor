// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, createIdGenerator, validate } from '../../core/model';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import { createEditor, type Editor } from './editor';

const SVG_NS = 'http://www.w3.org/2000/svg';

let stage: Element;
let editor: Editor;

beforeEach(() => {
  stage = document.createElementNS(SVG_NS, 'svg');
  document.body.replaceChildren(stage);
});

afterEach(() => editor.destroy());

function start(doc = createEmptyDocument()): Editor {
  editor = createEditor({ root: stage, document: doc, nextId: createIdGenerator() });
  return editor;
}

function pointer(type: string, x: number, y: number, init: Partial<MouseEventInit> = {}): void {
  const target = type === 'pointerdown' ? stage : window;
  target.dispatchEvent(
    new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...init }),
  );
}

function click(x: number, y: number, init: Partial<MouseEventInit> = {}): void {
  pointer('pointerdown', x, y, init);
  pointer('pointerup', x, y, init);
}

function key(k: string, modifiers: Partial<KeyboardEventInit> = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...modifiers }));
}

/** Ids of the points, in the order the document holds them. */
const pointIds = () => Object.keys(editor.getDocument().points);

describe('multi-selection', () => {
  beforeEach(() => start(rectangleFixture(480, 240).doc));

  it('replaces the selection on a plain click', () => {
    click(0, 0);
    click(480, 0);
    expect(editor.getSelection()).toHaveLength(1);
  });

  it('adds to the selection on shift-click', () => {
    click(0, 0);
    click(480, 0, { shiftKey: true });
    expect(editor.getSelection()).toHaveLength(2);
  });

  it('removes an already-selected item on shift-click', () => {
    click(0, 0);
    click(480, 0, { shiftKey: true });
    click(480, 0, { shiftKey: true });
    expect(editor.getSelection()).toHaveLength(1);
  });

  it('does not start a drag on shift-click, so building a pair moves nothing', () => {
    const { corners } = rectangleFixture(480, 240);
    pointer('pointerdown', 0, 0, { shiftKey: true });
    pointer('pointermove', 90, 60);
    pointer('pointerup', 90, 60, { shiftKey: true });

    expect(editor.getDocument().points[corners[0]]).toEqual({ id: corners[0], x: 0, y: 0 });
    expect(editor.canUndo()).toBe(false);
  });

  it('keeps the selection when shift-clicking empty space', () => {
    click(0, 0);
    click(240, 120, { shiftKey: true });
    expect(editor.getSelection()).toHaveLength(1);
  });
});

describe('relations from a selection', () => {
  beforeEach(() => {
    start();
    editor.setTool('line');
    click(0, 0);
    click(300, 40);
    key('Escape');
    editor.setTool('select');
  });

  it('is offered only when the selection suits it', () => {
    expect(editor.canApply('horizontal')).toBe(false);

    editor.setSelection(pointIds());
    expect(editor.canApply('horizontal')).toBe(true);
    expect(editor.canApply('vertical')).toBe(true);
    expect(editor.canApply('coincident')).toBe(true);
  });

  it('adds a horizontal and levels the two points', () => {
    editor.setSelection(pointIds());
    editor.applyRelation('horizontal');

    const [p1, p2] = pointIds();
    const doc = editor.getDocument();
    expect(doc.points[p1!]!.y).toBeCloseTo(doc.points[p2!]!.y, 6);
    expect(validate(doc)).toEqual([]);
  });

  it('is one undo step', () => {
    editor.setSelection(pointIds());
    editor.applyRelation('horizontal');
    editor.undo();

    expect(Object.values(editor.getDocument().constraints)).toHaveLength(0);
  });

  it('responds to the mockup\'s shift shortcuts', () => {
    editor.setSelection(pointIds());
    key('H', { shiftKey: true });

    expect(Object.values(editor.getDocument().constraints)[0]).toMatchObject({ kind: 'horizontal' });
  });

  it('does nothing when the selection does not suit the relation', () => {
    // The setup already drew a line, so compare against the step count rather
    // than against an empty history.
    const steps = editor.getHistory().past.length;
    editor.setSelection([pointIds()[0]!]);
    editor.applyRelation('horizontal');

    expect(editor.getHistory().past).toHaveLength(steps);
    expect(Object.values(editor.getDocument().constraints)).toHaveLength(0);
  });

  it('applies a relation to a selected line by its endpoints', () => {
    const lineId = Object.keys(editor.getDocument().entities)[0]!;
    editor.setSelection([lineId]);
    editor.applyRelation('horizontal');

    expect(Object.values(editor.getDocument().constraints)[0]).toMatchObject({ kind: 'horizontal' });
  });
});

describe('dimensions', () => {
  beforeEach(() => {
    start();
    editor.setTool('line');
    click(0, 0);
    click(300, 10);
    key('Escape');
    editor.setTool('select');
    editor.setSelection(pointIds());
  });

  it('plans a width for a mostly-horizontal pair', () => {
    expect(editor.planDimension()).toMatchObject({ kind: 'horizontal-distance', value: 300 });
  });

  it('adds the dimension and fully constrains that axis', () => {
    editor.addDimension();
    const dimension = Object.values(editor.getDocument().constraints)[0]!;

    expect(dimension).toMatchObject({ kind: 'horizontal-distance', value: 300 });
    expect(validate(editor.getDocument())).toEqual([]);
  });

  it('draws the dimension on the canvas', () => {
    editor.addDimension();
    expect(stage.querySelectorAll('[data-dimension]')).toHaveLength(1);
    expect(stage.querySelector('.dim-text')!.textContent).toBe('300');
  });

  it('moves the geometry when the value changes', () => {
    editor.addDimension();
    const id = Object.keys(editor.getDocument().constraints)[0]!;
    const [p1, p2] = pointIds();

    editor.setDimensionValue(id, 500);

    // The dimension says the gap is 500; with nothing anchored, the solver is
    // free to satisfy that by moving either point, and takes the smallest step
    // that does, so both share the change.
    const doc = editor.getDocument();
    expect(doc.points[p2!]!.x - doc.points[p1!]!.x).toBeCloseTo(500, 4);
  });

  it('drives the far point when the near one is anchored', () => {
    const [p1] = pointIds();
    editor.setSelection([p1!]);
    editor.applyRelation('fix');
    editor.setSelection(pointIds());
    editor.addDimension();

    const id = Object.keys(editor.getDocument().constraints).find((key) => key.startsWith('dim'))!;
    editor.setDimensionValue(id, 500);

    const [, p2] = pointIds();
    expect(editor.getDocument().points[p1!]!.x).toBeCloseTo(0, 4);
    expect(editor.getDocument().points[p2!]!.x).toBeCloseTo(500, 4);
  });

  it('responds to D', () => {
    key('d');
    expect(Object.values(editor.getDocument().constraints)).toHaveLength(1);
  });

  it('suspends a relation, which puts the freedom back', () => {
    editor.addDimension();
    const id = Object.keys(editor.getDocument().constraints)[0]!;
    const before = editor.getResult().dof;

    editor.setSuspended(id, true);
    expect(editor.getResult().dof).toBe(before + 1);
    expect(stage.querySelector('[data-dimension] ')).not.toBeNull();
  });
});

/**
 * The step's "done when": build the plan's worked example by hand and watch it
 * go from blue to black as the last constraint lands.
 */
describe('drawing the plan\'s rectangle by hand', () => {
  it('goes from 8 DOF and blue to 0 DOF and black', () => {
    start();
    editor.setTool('line');

    // Four corners, closing back onto the first point so they are shared.
    click(0, 0);
    click(480, 0);
    click(480, 240);
    click(0, 240);
    click(0, 0);
    key('Escape');
    editor.setTool('select');

    const doc = editor.getDocument();
    expect(Object.keys(doc.entities)).toHaveLength(4);
    expect(Object.keys(doc.points)).toHaveLength(4);

    const [c0, c1, c2, c3] = Object.keys(doc.points);
    expect(editor.getResult().dof).toBe(8);
    expect(editor.getResult().status).toBe('under-defined');
    expect(stage.querySelectorAll('[data-entity].is-under')).toHaveLength(4);

    // Horizontal on top and bottom, vertical on left and right: -4.
    editor.setSelection([c0!, c1!]);
    editor.applyRelation('horizontal');
    editor.setSelection([c3!, c2!]);
    editor.applyRelation('horizontal');
    editor.setSelection([c0!, c3!]);
    editor.applyRelation('vertical');
    editor.setSelection([c1!, c2!]);
    editor.applyRelation('vertical');
    expect(editor.getResult().dof).toBe(4);

    // Anchor the origin corner: -2.
    editor.setSelection([c0!]);
    editor.applyRelation('fix');
    expect(editor.getResult().dof).toBe(2);

    // Width and height: -2, and the sketch is pinned down.
    editor.setSelection([c0!, c1!]);
    editor.addDimension();
    expect(editor.getResult().dof).toBe(1);

    editor.setSelection([c0!, c3!]);
    editor.addDimension();

    const solved = editor.getResult();
    expect(solved.dof).toBe(0);
    expect(solved.status).toBe('fully-defined');
    expect(stage.querySelectorAll('[data-entity].is-full')).toHaveLength(4);
    expect(stage.querySelectorAll('[data-entity].is-under')).toHaveLength(0);
    expect(validate(editor.getDocument())).toEqual([]);
  });

  it('still drives the geometry once fully defined', () => {
    start(rectangleFixture(480, 240).doc);
    const { widthDimension, corners } = rectangleFixture(480, 240);

    editor.setDimensionValue(widthDimension, 600);
    expect(editor.getDocument().points[corners[1]]!.x).toBeCloseTo(600, 4);
    expect(editor.getResult().status).toBe('fully-defined');
  });

  it('turns red when a contradictory dimension is added', () => {
    const { doc, corners } = rectangleFixture(480, 240);
    start(doc);

    // A second width on the same pair, via the straight-line distance form.
    editor.setSelection([corners[0], corners[2]]);
    editor.addDimension();
    const diagonal = Object.keys(editor.getDocument().constraints).at(-1)!;
    editor.setDimensionValue(diagonal, 900);

    expect(editor.getResult().status).toBe('over-defined');
    expect(stage.querySelectorAll('.is-over').length).toBeGreaterThan(0);
  });
});
