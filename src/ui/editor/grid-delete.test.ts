// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, createIdGenerator, validate } from '../../core/model';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import { createEditor, type Editor, type EditorOptions } from './editor';

const SVG_NS = 'http://www.w3.org/2000/svg';
let stage: Element;
let editor: Editor;

beforeEach(() => {
  stage = document.createElementNS(SVG_NS, 'svg');
  document.body.replaceChildren(stage);
});

afterEach(() => editor.destroy());

function start(options: Partial<EditorOptions> = {}): Editor {
  editor = createEditor({
    root: stage,
    document: createEmptyDocument(),
    nextId: createIdGenerator(),
    // jsdom reports a zero-sized element, so the grid needs a size to draw.
    size: () => ({ width: 400, height: 300 }),
    ...options,
  });
  return editor;
}

function click(x: number, y: number): void {
  stage.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y, button: 0, bubbles: true }));
}

function key(k: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
}

describe('the grid on the canvas', () => {
  it('is drawn behind the geometry by default', () => {
    start();
    const grid = stage.querySelector('.sketch-grid')!;
    expect(grid).not.toBeNull();
    expect(grid.querySelectorAll('.grid-line').length).toBeGreaterThan(0);

    // Behind: the grid group comes first in the view.
    expect(stage.querySelector('.sketch-view')!.firstElementChild).toBe(grid);
  });

  it('marks the two lines through the origin', () => {
    start();
    expect(stage.querySelectorAll('.grid-origin')).toHaveLength(2);
  });

  it('can be turned off and on', () => {
    start();
    editor.setGridVisible(false);
    expect(stage.querySelector('.sketch-grid')).toBeNull();

    editor.setGridVisible(true);
    expect(stage.querySelectorAll('.grid-line').length).toBeGreaterThan(0);
  });

  it('responds to G', () => {
    start();
    key('g');
    expect(editor.isGridVisible()).toBe(false);
    key('g');
    expect(editor.isGridVisible()).toBe(true);
  });

  it('is off when the editor is asked to start without it', () => {
    start({ showGrid: false });
    expect(stage.querySelector('.sketch-grid')).toBeNull();
  });
});

describe('snapping to the grid', () => {
  it('is off unless asked for, so a click lands where it was made', () => {
    start();
    editor.setTool('line');
    click(203, 147);
    click(398, 152);

    expect(Object.values(editor.getDocument().points)[0]).toMatchObject({ x: 203, y: 147 });
  });

  it('rounds new points to the grid when on', () => {
    start({ snapToGrid: true });
    editor.setTool('line');
    click(203, 147);
    click(398, 152);

    const points = Object.values(editor.getDocument().points);
    expect(points[0]).toMatchObject({ x: 200, y: 150 });
    expect(points[1]).toMatchObject({ x: 400, y: 150 });
  });

  it('never overrides an existing point', () => {
    // Joining to real geometry matters more than landing on a round number.
    start({ snapToGrid: true });
    editor.setTool('line');
    click(203, 147);
    click(398, 152);
    key('Escape');

    click(202, 151); // near the first point, which should be reused
    click(300, 400);

    expect(Object.keys(editor.getDocument().points)).toHaveLength(3);
  });

  it('snaps a dragged point', () => {
    const { doc, widthDimension, corners } = rectangleFixture(480, 240);
    const constraints = { ...doc.constraints };
    delete constraints[widthDimension];
    start({ document: { ...doc, constraints }, snapToGrid: true });

    stage.dispatchEvent(new MouseEvent('pointerdown', { clientX: 480, clientY: 0, button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 603, clientY: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 603, clientY: 0, button: 0, bubbles: true }));

    expect(editor.getDocument().points[corners[1]]!.x).toBeCloseTo(600, 3);
  });

  it('can be toggled', () => {
    start();
    expect(editor.isSnapping()).toBe(false);
    editor.setSnapping(true);
    expect(editor.isSnapping()).toBe(true);
  });
});

describe('dimension visibility', () => {
  it('can be turned off', () => {
    start({ document: rectangleFixture().doc });
    expect(stage.querySelectorAll('[data-dimension]').length).toBeGreaterThan(0);

    editor.setDimensionsVisible(false);
    expect(stage.querySelectorAll('[data-dimension]')).toHaveLength(0);
    expect(editor.areDimensionsVisible()).toBe(false);
  });
});

describe('deleting', () => {
  it('removes a selected entity and leaves the rest valid', () => {
    const { doc, lines } = rectangleFixture();
    start({ document: doc });

    editor.setSelection([lines[0]]);
    editor.deleteSelection();

    const after = editor.getDocument();
    expect(after.entities[lines[0]]).toBeUndefined();
    expect(Object.keys(after.entities)).toHaveLength(3);
    expect(validate(after)).toEqual([]);
  });

  it('takes the geometry that depended on a deleted point', () => {
    const { doc, corners } = rectangleFixture();
    start({ document: doc });

    editor.setSelection([corners[1]]);
    editor.deleteSelection();

    const after = editor.getDocument();
    // The two edges meeting at that corner cannot exist without it.
    expect(Object.keys(after.entities)).toHaveLength(2);
    expect(after.points[corners[1]]).toBeUndefined();
    expect(validate(after)).toEqual([]);
  });

  it('removes constraints that named a deleted point', () => {
    const { doc, corners } = rectangleFixture();
    start({ document: doc });
    const before = Object.keys(doc.constraints).length;

    editor.setSelection([corners[0]]);
    editor.deleteSelection();

    expect(Object.keys(editor.getDocument().constraints).length).toBeLessThan(before);
    expect(validate(editor.getDocument())).toEqual([]);
  });

  it('removes a selected relation, giving back the freedom it took', () => {
    const { doc, widthDimension } = rectangleFixture();
    start({ document: doc });

    editor.setSelection([widthDimension]);
    editor.deleteSelection();

    expect(editor.getDocument().constraints[widthDimension]).toBeUndefined();
    expect(editor.getResult().dof).toBe(1);
  });

  it('prunes points that nothing refers to any more', () => {
    const { doc, lines } = rectangleFixture();
    start({ document: { ...doc, constraints: {} } });

    editor.setSelection([...lines]);
    editor.deleteSelection();

    const after = editor.getDocument();
    expect(Object.keys(after.entities)).toHaveLength(0);
    expect(Object.keys(after.points)).toHaveLength(0);
    expect(Object.keys(after.paths)).toHaveLength(0);
  });

  it('is one undo step', () => {
    const { doc, corners } = rectangleFixture();
    start({ document: doc });

    editor.setSelection([corners[1]]);
    editor.deleteSelection();
    editor.undo();

    expect(Object.keys(editor.getDocument().entities)).toHaveLength(4);
    expect(Object.keys(editor.getDocument().points)).toHaveLength(4);
  });

  it('clears the selection afterwards', () => {
    const { doc, lines } = rectangleFixture();
    start({ document: doc });
    editor.setSelection([lines[0]]);
    editor.deleteSelection();

    expect(editor.getSelection()).toEqual([]);
  });

  it('does nothing with an empty selection', () => {
    start({ document: rectangleFixture().doc });
    editor.deleteSelection();

    expect(editor.canUndo()).toBe(false);
  });

  it('responds to Delete and Backspace', () => {
    const { doc, lines } = rectangleFixture();
    start({ document: doc });

    editor.setSelection([lines[0]]);
    key('Delete');
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(3);

    editor.setSelection([lines[1]]);
    key('Backspace');
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(2);
  });
});
