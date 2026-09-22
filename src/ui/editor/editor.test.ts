// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, createIdGenerator, documentIds, validate } from '../../core/model';
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

/** jsdom has no PointerEvent, but a MouseEvent dispatched under the pointer
 *  type reaches the same listeners, which is all the editor needs. */
function pointer(type: string, x: number, y: number, button = 0): void {
  const target = type === 'pointerdown' ? stage : window;
  target.dispatchEvent(
    new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true }),
  );
}

function click(x: number, y: number): void {
  pointer('pointerdown', x, y);
  pointer('pointerup', x, y);
}

function drag(from: [number, number], ...to: [number, number][]): void {
  pointer('pointerdown', from[0], from[1]);
  for (const [x, y] of to) pointer('pointermove', x, y);
  const last = to.at(-1) ?? from;
  pointer('pointerup', last[0], last[1]);
}

function key(k: string, modifiers: Partial<KeyboardEventInit> = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...modifiers }));
}

function start(doc = createEmptyDocument()): Editor {
  editor = createEditor({ root: stage, document: doc, nextId: createIdGenerator() });
  return editor;
}

describe('the line tool', () => {
  beforeEach(() => {
    start();
    editor.setTool('line');
  });

  it('draws a line from two clicks', () => {
    click(0, 0);
    click(100, 0);

    const doc = editor.getDocument();
    expect(Object.keys(doc.entities)).toHaveLength(1);
    expect(Object.keys(doc.points)).toHaveLength(2);
    expect(validate(doc)).toEqual([]);
  });

  it('shows a preview between the first click and the cursor', () => {
    click(0, 0);
    // The cursor has not moved yet, so the preview starts degenerate at the
    // anchor rather than absent.
    expect(stage.querySelector('.preview')!.getAttribute('x2')).toBe('0');

    pointer('pointermove', 60, 40);
    const preview = stage.querySelector('.preview')!;
    expect(preview.getAttribute('x1')).toBe('0');
    expect(preview.getAttribute('x2')).toBe('60');
    expect(preview.getAttribute('y2')).toBe('40');
  });

  it('chains segments, sharing the point between them', () => {
    click(0, 0);
    click(100, 0);
    click(100, 80);

    const doc = editor.getDocument();
    const [first, second] = Object.values(doc.entities).filter((entity) => entity.kind === 'line');
    expect(Object.keys(doc.entities)).toHaveLength(2);
    expect(Object.keys(doc.points)).toHaveLength(3);
    // Sharing a point is what makes the join real, not merely coincident.
    expect(first?.p2).toBe(second?.p1);
    expect(first?.p2).not.toBeUndefined();
  });

  it('collects a chain into one path record', () => {
    click(0, 0);
    click(100, 0);
    click(100, 80);

    const paths = Object.values(editor.getDocument().paths);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.subpaths[0]!.members).toHaveLength(2);
  });

  it('reuses an existing point when clicked, rather than stacking a new one', () => {
    click(0, 0);
    click(100, 0);
    key('Escape');

    // Start a new chain from the end of the old one.
    click(100, 0);
    click(100, 80);

    const doc = editor.getDocument();
    expect(Object.keys(doc.points)).toHaveLength(3);
    expect(validate(doc)).toEqual([]);
  });

  it('refuses a zero-length segment', () => {
    click(40, 40);
    click(40, 40);

    expect(Object.keys(editor.getDocument().entities)).toHaveLength(0);
  });

  it('ends the chain on Escape', () => {
    click(0, 0);
    click(100, 0);
    key('Escape');
    pointer('pointermove', 200, 200);

    expect(stage.querySelector('.preview')).toBeNull();
  });

  it('ends the chain when the tool changes', () => {
    click(0, 0);
    editor.setTool('select');
    pointer('pointermove', 50, 50);

    expect(stage.querySelector('.preview')).toBeNull();
  });
});

describe('the select tool', () => {
  it('selects a point and shows it', () => {
    const { doc, corners } = rectangleFixture(480, 240);
    start(doc);
    click(0, 0);

    expect(editor.getSelection()).toEqual([corners[0]]);
    expect(stage.querySelector(`[data-point="${corners[0]}"]`)!.getAttribute('class')).toContain(
      'is-selected',
    );
  });

  it('selects a line and gives it a halo', () => {
    const { doc, lines } = rectangleFixture(480, 240);
    start(doc);
    click(240, 0);

    expect(editor.getSelection()).toEqual([lines[0]]);
    expect(stage.querySelector(`[data-entity="${lines[0]}"] .selhalo`)).not.toBeNull();
  });

  it('clears the selection when clicking empty space', () => {
    const { doc } = rectangleFixture(480, 240);
    start(doc);
    click(0, 0);
    click(240, 120);

    expect(editor.getSelection()).toEqual([]);
  });

  it('will not select geometry on a locked layer', () => {
    const { doc, layer } = rectangleFixture(480, 240);
    start({ ...doc, layers: { ...doc.layers, [layer]: { ...doc.layers[layer]!, locked: true } } });
    click(240, 0);

    expect(editor.getSelection()).toEqual([]);
  });
});

describe('dragging', () => {
  it('moves a free point and re-solves as it goes', () => {
    // A loose rectangle: width is free, so the right-hand corners can slide.
    const { doc, widthDimension, corners } = rectangleFixture(480, 240);
    const constraints = { ...doc.constraints };
    delete constraints[widthDimension];
    start({ ...doc, constraints });

    drag([480, 0], [520, 0], [600, 0]);

    const moved = editor.getDocument();
    expect(moved.points[corners[1]]!.x).toBeCloseTo(600, 3);
    // The vertical relation carries the other right-hand corner along.
    expect(moved.points[corners[2]]!.x).toBeCloseTo(600, 3);
    expect(validate(moved)).toEqual([]);
  });

  it('is one undo step however many moves it took', () => {
    const { doc, widthDimension } = rectangleFixture(480, 240);
    const constraints = { ...doc.constraints };
    delete constraints[widthDimension];
    start({ ...doc, constraints });

    drag([480, 0], [500, 0], [540, 0], [580, 0], [600, 0]);
    expect(editor.getHistory().past).toHaveLength(1);

    editor.undo();
    expect(editor.getDocument().points[doc.points[Object.keys(doc.points)[1]!]!.id]).toBeDefined();
    expect(editor.canUndo()).toBe(false);
  });

  it('keeps two separate drags as separate steps', () => {
    const { doc, widthDimension } = rectangleFixture(480, 240);
    const constraints = { ...doc.constraints };
    delete constraints[widthDimension];
    start({ ...doc, constraints });

    drag([480, 0], [600, 0]);
    drag([600, 0], [700, 0]);

    expect(editor.getHistory().past).toHaveLength(2);
  });

  it('will not drag a fully defined sketch out of shape', () => {
    const { doc, corners } = rectangleFixture(480, 240);
    start(doc);
    drag([480, 0], [600, 90]);

    const after = editor.getDocument();
    expect(after.points[corners[1]]!.x).toBeCloseTo(480, 3);
    expect(after.points[corners[0]]!.y).toBeCloseTo(0, 3);
  });

  it('does nothing when the drag starts on empty space', () => {
    const { doc } = rectangleFixture(480, 240);
    start(doc);
    drag([240, 120], [300, 160]);

    expect(editor.canUndo()).toBe(false);
  });
});

describe('undo and redo', () => {
  beforeEach(() => {
    start();
    editor.setTool('line');
  });

  it('undoes a drawn line and redoes it', () => {
    click(0, 0);
    click(100, 0);
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(1);

    editor.undo();
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(0);

    editor.redo();
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(1);
  });

  it('responds to the keyboard', () => {
    click(0, 0);
    click(100, 0);

    key('z', { metaKey: true });
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(0);

    key('z', { metaKey: true, shiftKey: true });
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(1);

    key('z', { ctrlKey: true });
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(0);

    key('y', { ctrlKey: true });
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(1);
  });

  it('redraws the canvas after an undo', () => {
    click(0, 0);
    click(100, 0);
    expect(stage.querySelectorAll('[data-entity]')).toHaveLength(1);

    editor.undo();
    expect(stage.querySelectorAll('[data-entity]')).toHaveLength(0);
  });

  it('abandons a chain in progress when history moves', () => {
    click(0, 0);
    click(100, 0);
    editor.undo();
    pointer('pointermove', 200, 200);

    // The point the chain was hanging from may be gone, so no stale preview.
    expect(stage.querySelector('.preview')).toBeNull();
  });

  it('does nothing at the ends of the stack', () => {
    editor.undo();
    editor.redo();
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);
  });
});

describe('tools and keyboard', () => {
  beforeEach(() => start());

  it('starts on select', () => {
    expect(editor.getTool()).toBe('select');
  });

  it('switches with V and L', () => {
    key('l');
    expect(editor.getTool()).toBe('line');
    key('v');
    expect(editor.getTool()).toBe('select');
  });

  it('does not treat an accelerator as a tool shortcut', () => {
    key('l', { metaKey: true });
    expect(editor.getTool()).toBe('select');
  });
});

describe('view', () => {
  beforeEach(() => start(rectangleFixture(480, 240).doc));

  it('zooms about the cursor on the wheel', () => {
    stage.dispatchEvent(
      Object.assign(new MouseEvent('wheel', { clientX: 100, clientY: 100, bubbles: true, cancelable: true }), {
        deltaY: -200,
      }),
    );

    expect(editor.getViewport().scale).toBeGreaterThan(1);
  });

  it('pans on the middle button', () => {
    pointer('pointerdown', 100, 100, 1);
    pointer('pointermove', 140, 130);
    pointer('pointerup', 140, 130, 1);

    expect(editor.getViewport().panX).toBeCloseTo(-40, 6);
    expect(editor.getViewport().panY).toBeCloseTo(-30, 6);
  });

  it('does not record the view in history', () => {
    pointer('pointerdown', 100, 100, 1);
    pointer('pointermove', 140, 130);
    pointer('pointerup', 140, 130, 1);

    expect(editor.canUndo()).toBe(false);
  });

  it('zooms to fit the drawing', () => {
    editor.zoomToFit();
    expect(editor.getViewport().scale).not.toBe(1);
  });
});

describe('lifecycle', () => {
  it('draws on creation', () => {
    start(rectangleFixture().doc);
    expect(stage.querySelectorAll('[data-entity]')).toHaveLength(4);
  });

  it('stops listening once destroyed', () => {
    start();
    editor.setTool('line');
    editor.destroy();

    click(0, 0);
    click(100, 0);
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(0);

    editor = createEditor({ root: stage }); // so afterEach has something to destroy
  });
});

describe('opening a document', () => {
  it('draws with fresh ids instead of overwriting the loaded sketch', () => {
    // The generator used to keep counting from wherever the previous sketch
    // left it, so the first point drawn after opening a file was minted as an
    // id the file already used. Edits are keyed by id, so that did not fail
    // loudly — it replaced a corner of the loaded rectangle, in place.
    start();
    const loaded = rectangleFixture().doc;
    editor.load(loaded);

    const before = documentIds(loaded);
    editor.setTool('line');
    click(600, 600);
    click(700, 600);

    const after = editor.getDocument();
    // Every id the file had is still there, and nothing was quietly replaced.
    for (const id of before) expect(documentIds(after)).toContain(id);
    expect(Object.keys(after.points)).toHaveLength(6);
    expect(Object.keys(after.entities)).toHaveLength(5);
    expect(validate(after)).toEqual([]);
  });

  it('starts past the ids of a document handed in at construction', () => {
    // Same bug, one step earlier: a document passed to `createEditor` is as
    // much a loaded sketch as one opened from a file.
    const loaded = rectangleFixture().doc;
    editor = createEditor({ root: stage, document: loaded });
    editor.setTool('line');
    click(600, 600);
    click(700, 600);

    const after = editor.getDocument();
    for (const id of documentIds(loaded)) expect(documentIds(after)).toContain(id);
    expect(validate(after)).toEqual([]);
  });
});

describe('keyboard shortcuts and text fields', () => {
  /** A key event as if typed into a panel input, not the canvas. */
  function typeInto(element: Element, k: string, modifiers: Partial<KeyboardEventInit> = {}): void {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...modifiers }));
  }

  let field: HTMLInputElement;
  let fixture: ReturnType<typeof rectangleFixture>;

  beforeEach(() => {
    fixture = rectangleFixture();
    start(fixture.doc);
    field = document.createElement('input');
    document.body.append(field);
  });

  it('leaves the sketch alone when Backspace edits a dimension field', () => {
    // The handler is on the document so shortcuts work wherever focus is —
    // which means it also hears every keystroke typed into the panel's
    // dimension inputs. Backspace there deleted the selected geometry.
    editor.setSelection([fixture.lines[0]]);
    typeInto(field, 'Backspace');
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(4);
  });

  it('does not switch tools on letters typed into a field', () => {
    editor.setTool('select');
    typeInto(field, 'l');
    typeInto(field, 'a');
    expect(editor.getTool()).toBe('select');
  });

  it('does not add a dimension on a typed d', () => {
    const before = Object.keys(editor.getDocument().constraints).length;
    editor.setSelection([fixture.corners[1], fixture.corners[2]]);
    // The same selection and key from the canvas does add one, so the
    // assertion below is about where the keystroke came from, not about the
    // command being unavailable.
    typeInto(field, 'd');
    expect(Object.keys(editor.getDocument().constraints)).toHaveLength(before);
    typeInto(stage, 'd');
    expect(Object.keys(editor.getDocument().constraints)).toHaveLength(before + 1);
  });

  it('still takes the shortcut when the key comes from the canvas', () => {
    editor.setTool('select');
    typeInto(stage, 'l');
    expect(editor.getTool()).toBe('line');
  });

  it('leaves undo to the field itself, and to the editor elsewhere', () => {
    // Ctrl+Z in a text field is the field's own undo — the browser handles
    // it, and the editor must not undo the sketch behind it at the same time.
    start();
    editor.setTool('line');
    click(0, 0);
    click(100, 0);
    typeInto(field, 'z', { ctrlKey: true });
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(1);

    typeInto(stage, 'z', { ctrlKey: true });
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(0);
  });
});

describe('drag solving', () => {
  it('redraws once per position, not once per pointer move', () => {
    // A pinned solve runs whether or not the document changed, so with
    // snapping on, every pixel of cursor travel inside one grid cell used to
    // cost a full solve and redraw.
    let draws = 0;
    editor = createEditor({
      root: stage,
      document: rectangleFixture().doc,
      nextId: createIdGenerator(),
      size: () => {
        draws += 1;
        return { width: 800, height: 600 };
      },
      snapToGrid: true,
      gridSpacing: 50,
    });

    pointer('pointerdown', 480, 240);
    const atFirst = draws;
    // Four moves, all snapping to the same grid intersection.
    pointer('pointermove', 470, 250);
    pointer('pointermove', 472, 248);
    pointer('pointermove', 468, 252);
    pointer('pointermove', 471, 249);
    const afterSame = draws;
    // One that lands on the next intersection along.
    pointer('pointermove', 420, 250);
    pointer('pointerup', 420, 250);

    expect(afterSame - atFirst).toBe(1);
    expect(draws - afterSame).toBe(1);
  });

  it('does not let the cursor pin change the sketch\'s status', () => {
    // The drag displays the solve computed with the point pinned. That is
    // only safe because a pin is a pull toward the cursor rather than a
    // constraint: it must not make an under-defined sketch look defined.
    start();
    editor.setTool('line');
    click(0, 0);
    click(100, 0);
    editor.setTool('select');
    expect(editor.getResult().status).toBe('under-defined');

    drag([100, 0], [140, 40]);
    expect(editor.getResult().status).toBe('under-defined');
    expect(editor.getResult().dof).toBe(4);
  });
});
