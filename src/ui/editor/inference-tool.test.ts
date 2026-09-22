// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, createIdGenerator, validate } from '../../core/model';
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
    size: () => ({ width: 400, height: 300 }),
    showGrid: false,
    inferRelations: true,
    ...options,
  });
  editor.setTool('line');
  return editor;
}

function move(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
}

function click(x: number, y: number): void {
  stage.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y, button: 0, bubbles: true }));
}

const kinds = () => Object.values(editor.getDocument().constraints).map((c) => c.kind);

describe('inference while drawing a line', () => {
  it('adds a horizontal relation to a nearly level segment', () => {
    start();
    click(0, 0);
    move(200, 3);
    click(200, 3);

    expect(kinds()).toEqual(['horizontal']);
    expect(validate(editor.getDocument())).toEqual([]);
  });

  it('lands the point exactly level, not three pixels off', () => {
    // Adding the relation without moving the point would leave a kink for the
    // solver to pull out, which the user sees as the line jumping.
    start();
    click(0, 0);
    move(200, 3);
    click(200, 3);

    const [, second] = Object.values(editor.getDocument().points);
    expect(second!.y).toBeCloseTo(0, 6);
    expect(second!.x).toBeCloseTo(200, 6);
  });

  it('adds a vertical relation to a nearly plumb segment', () => {
    start();
    click(0, 0);
    move(-4, 200);
    click(-4, 200);

    expect(kinds()).toEqual(['vertical']);
    expect(Object.values(editor.getDocument().points)[1]!.x).toBeCloseTo(0, 6);
  });

  it('adds nothing to a clearly diagonal segment', () => {
    start();
    click(0, 0);
    move(150, 150);
    click(150, 150);

    expect(kinds()).toEqual([]);
  });

  it('shows the relation before the click commits it', () => {
    start();
    click(0, 0);
    expect(stage.querySelector('.hint-glyph')).toBeNull();

    move(200, 3);
    expect(stage.querySelector('.hint-glyph')).not.toBeNull();
    expect(editor.getInferred()).toEqual(['horizontal']);
  });

  it('drops the hint once the segment is no longer near an axis', () => {
    start();
    click(0, 0);
    move(200, 3);
    expect(editor.getInferred()).toEqual(['horizontal']);

    move(200, 120);
    expect(editor.getInferred()).toEqual([]);
    expect(stage.querySelector('.hint-glyph')).toBeNull();
  });

  it('makes the segment and its relation one undo step', () => {
    start();
    click(0, 0);
    move(200, 3);
    click(200, 3);

    editor.undo();
    const after = editor.getDocument();
    expect(Object.keys(after.entities)).toHaveLength(0);
    expect(Object.keys(after.constraints)).toHaveLength(0);
  });

  it('does not infer when joining to an existing point', () => {
    start();
    click(0, 0);
    move(200, 3);
    click(200, 3); // horizontal inferred
    click(200, 200);
    editor.setTool('select');
    editor.setTool('line');

    // Start a fresh chain at an existing point and end on another one.
    const before = kinds().length;
    click(0, 0);
    click(200, 200);

    // Joining says more than an axis guess would, so nothing extra is added.
    expect(kinds().length).toBe(before);
  });

  it('keeps inferring down a chain', () => {
    start();
    click(0, 0);
    move(200, 2);
    click(200, 2);
    move(198, 160);
    click(198, 160);

    expect(kinds()).toEqual(['horizontal', 'vertical']);
    expect(editor.getResult().dof).toBe(4); // 3 points, less 2 relations
  });

  it('infers nothing at all when turned off', () => {
    start({ inferRelations: false });
    click(0, 0);
    move(200, 3);

    expect(editor.getInferred()).toEqual([]);
    click(200, 3);
    expect(kinds()).toEqual([]);
    // And the point stays exactly where it was put.
    expect(Object.values(editor.getDocument().points)[1]!.y).toBe(3);
  });

  it('can be switched off mid-draw', () => {
    start();
    click(0, 0);
    move(200, 3);
    expect(editor.getInferred()).toEqual(['horizontal']);

    editor.setInferring(false);
    expect(editor.getInferred()).toEqual([]);
    click(200, 3);
    expect(kinds()).toEqual([]);
  });

  it('works alongside grid snapping', () => {
    // Snapping puts the point on the grid; inference still records why.
    start({ snapToGrid: true });
    click(3, 2);
    move(203, 6);
    click(203, 6);

    const points = Object.values(editor.getDocument().points);
    expect(points[0]).toMatchObject({ x: 0, y: 0 });
    expect(points[1]).toMatchObject({ x: 200, y: 0 });
    expect(kinds()).toEqual(['horizontal']);
  });
});
