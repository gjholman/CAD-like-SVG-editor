// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEditor, type Editor } from '../editor';
import { createEmptyDocument, createIdGenerator, type SketchDocument } from '../../core/model';
import { createChrome, type Chrome } from './chrome';
import { wireCommands } from './commands';

/**
 * The relations panel, against the markup it actually runs on.
 *
 * `index.html` is the real thing, but a panel test that needed the whole page
 * would break every time the chrome moved. This is the subset the panel reads
 * and writes, by the same selectors.
 */
const PANEL = `
  <svg id="stage"></svg>
  <button data-action="dimension"></button>
  <button data-action="delete"></button>
  <button data-action="undo"></button>
  <button data-action="redo"></button>
  <div id="relations"></div>
  <span id="relation-count"></span>
  <p id="relations-empty"></p>
  <button data-action="cross-layer" hidden></button>
  <span id="hint"></span>
  <span id="sel-name"></span>
  <span id="sel-sub"></span>
  <span id="status-dot"></span>
  <span id="status-text"></span>
  <span id="dof"></span>
`;

let editor: Editor;
let chrome: Chrome;

beforeEach(() => {
  document.body.innerHTML = PANEL;
});

afterEach(() => editor.destroy());

function start(doc: SketchDocument = createEmptyDocument()): void {
  const stage = document.querySelector('#stage')!;
  editor = createEditor({ root: stage, document: doc, nextId: createIdGenerator() });
  chrome = createChrome(editor);
  wireCommands(editor, () => chrome.sync());
  chrome.sync();
}

const rows = () => [...document.querySelectorAll<HTMLElement>('#relations .relation')];
const crossLayerButton = () => document.querySelector<HTMLButtonElement>('[data-action="cross-layer"]')!;

/** A circle with a driving diameter, which is the simplest dimension row. */
const circleWithDiameter: SketchDocument = {
  version: 1,
  points: { c: { id: 'c', x: 0, y: 0 } },
  entities: {
    circ: { id: 'circ', kind: 'circle', center: 'c', radius: 40, layer: 'layer1', construction: false },
  },
  constraints: { d1: { id: 'd1', kind: 'diameter', entity: 'circ', value: 80 } },
  paths: {},
  layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
  layerOrder: ['layer1'],
};

describe('a dimension row', () => {
  it('offers an editable field for a driving dimension', () => {
    start(circleWithDiameter);
    const input = rows()[0]!.querySelector('input')!;

    expect(input.readOnly).toBe(false);
    expect(input.value).toBe('80');
  });

  it('shows a reference dimension as a read-out that cannot be typed into', () => {
    // Its number is an output. A field that looks editable but does nothing
    // would be worse than no field at all.
    start(circleWithDiameter);
    editor.setReference('d1', true);
    chrome.sync();

    const input = rows()[0]!.querySelector('input')!;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe('(⌀80)');
    expect(rows()[0]!.classList.contains('reference')).toBe(true);
  });

  it('toggles between driving and reference from the panel', () => {
    start(circleWithDiameter);
    const toggle = () => rows()[0]!.querySelector<HTMLButtonElement>('[data-reference]')!;

    toggle().click();
    expect(editor.getDocument().constraints['d1']).toMatchObject({ reference: true });
    toggle().click();
    expect(editor.getDocument().constraints['d1']).toMatchObject({ reference: false });
  });

  it('rebuilds the row when the reference flag changes', () => {
    // The list is only rebuilt when its signature changes, so the flag has to
    // be part of that signature or the panel would show stale state.
    start(circleWithDiameter);
    editor.setReference('d1', true);
    chrome.sync();
    expect(rows()[0]!.querySelector('input')!.readOnly).toBe(true);
  });
});

describe('the cross-layer affordance', () => {
  const twoLayers: SketchDocument = {
    version: 1,
    points: {
      a1: { id: 'a1', x: 0, y: 0 },
      a2: { id: 'a2', x: 100, y: 0 },
      b1: { id: 'b1', x: 0, y: 50 },
      b2: { id: 'b2', x: 100, y: 60 },
    },
    entities: {
      lineA: { id: 'lineA', kind: 'line', p1: 'a1', p2: 'a2', layer: 'front', construction: false },
      lineB: { id: 'lineB', kind: 'line', p1: 'b1', p2: 'b2', layer: 'back', construction: false },
    },
    constraints: {
      x1: { id: 'x1', kind: 'parallel', a: 'lineA', b: 'lineB' },
      w1: { id: 'w1', kind: 'horizontal', p1: 'a1', p2: 'a2' },
    },
    paths: {},
    layers: {
      front: { id: 'front', name: 'Front', visible: true, locked: false },
      back: { id: 'back', name: 'Back', visible: true, locked: false },
    },
    layerOrder: ['front', 'back'],
  };

  it('stays out of the way when nothing crosses a layer', () => {
    start(circleWithDiameter);
    expect(crossLayerButton().hidden).toBe(true);
  });

  it('appears, and counts what it would act on', () => {
    start(twoLayers);
    expect(crossLayerButton().hidden).toBe(false);
    expect(crossLayerButton().textContent).toContain('Suspend 1');
  });

  it('suspends from the panel and offers to resume', () => {
    start(twoLayers);
    crossLayerButton().click();

    expect(editor.getDocument().constraints['x1']).toMatchObject({ suspended: true });
    expect(crossLayerButton().textContent).toContain('Resume 1');

    crossLayerButton().click();
    expect(editor.getDocument().constraints['x1']).toMatchObject({ suspended: false });
  });

  it('badges the row that crosses, and only that row', () => {
    start(twoLayers);
    const badged = rows().filter((row) => row.querySelector('.crosses') !== null);
    expect(badged).toHaveLength(1);
    expect(badged[0]!.textContent).toContain('across layers');
  });
});

describe('the relations list', () => {
  it('counts what is in it and hides the empty note', () => {
    start(circleWithDiameter);
    expect(document.querySelector('#relation-count')!.textContent).toBe('1');
    expect(document.querySelector<HTMLElement>('#relations-empty')!.hidden).toBe(true);
  });

  it('shows the empty note for a sketch with no relations', () => {
    start();
    expect(document.querySelector<HTMLElement>('#relations-empty')!.hidden).toBe(false);
  });

  it('selects what a row names when the row is clicked', () => {
    start(circleWithDiameter);
    rows()[0]!.click();
    expect(editor.getSelection()).toEqual(['d1']);
  });

  it('deletes a relation from its own row', () => {
    start(circleWithDiameter);
    rows()[0]!.querySelector<HTMLButtonElement>('button[title="Delete relation"]')!.click();
    expect(Object.keys(editor.getDocument().constraints)).toHaveLength(0);
    // The circle itself survives: deleting a relation is not deleting geometry.
    expect(Object.keys(editor.getDocument().entities)).toEqual(['circ']);
  });
});
