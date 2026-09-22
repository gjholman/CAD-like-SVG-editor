// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addArc,
  addEntity,
  addLine,
  addPoint,
  compose,
  createEmptyDocument,
  createIdGenerator,
  validate,
  type Constraint,
  type SketchDocument,
} from '../../core/model';
import { createEditor, type Editor } from './editor';

/**
 * Step 11 and 13 through the editor: what the user actually does.
 *
 * The commands and the renderer have their own tests; these check the wiring
 * between them — that picking geometry and pressing the dimension button adds
 * the right thing, that the canvas shows it, and that a relation's selection
 * lights up what it acts on.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

let stage: Element;
let editor: Editor;

beforeEach(() => {
  stage = document.createElementNS(SVG_NS, 'svg');
  document.body.replaceChildren(stage);
});

afterEach(() => editor.destroy());

/** A wedge, a circle and an arc, on one layer. */
const shapes: SketchDocument = compose(
  addPoint('o', 0, 0),
  addPoint('ax', 100, 0),
  addPoint('bx', 0, 100),
  addPoint('c', 300, 0),
  addPoint('ac', 600, 0),
  addPoint('as', 660, 0),
  addPoint('ae', 600, 60),
  addLine('lineA', 'o', 'ax', 'layer1'),
  addLine('lineB', 'o', 'bx', 'layer1'),
  addEntity({ id: 'circ', kind: 'circle', center: 'c', radius: 40, layer: 'layer1', construction: false }),
  addArc('arc1', 'ac', 'as', 'ae', 'layer1'),
)(createEmptyDocument());

function start(doc = shapes): Editor {
  editor = createEditor({ root: stage, document: doc, nextId: createIdGenerator() });
  return editor;
}

const dimensions = () => Object.values(editor.getDocument().constraints);

describe('the smart dimension, on everything it can measure', () => {
  beforeEach(() => start());

  it('dimensions two picked lines as an angle', () => {
    editor.setSelection(['lineA', 'lineB']);
    expect(editor.planDimension()).toMatchObject({ kind: 'angle', value: 90 });

    editor.addDimension();
    expect(dimensions()).toHaveLength(1);
    expect(dimensions()[0]).toMatchObject({ kind: 'angle', a: 'lineA', b: 'lineB', value: 90 });
    expect(validate(editor.getDocument())).toEqual([]);
  });

  it('dimensions a circle by diameter and an arc by radius', () => {
    editor.setSelection(['circ']);
    editor.addDimension();
    editor.setSelection(['arc1']);
    editor.addDimension();

    expect(dimensions().map((c) => c.kind).sort()).toEqual(['diameter', 'radius']);
  });

  it('dimensions a point against a line', () => {
    editor.setSelection(['bx', 'lineA']);
    editor.addDimension();
    expect(dimensions()[0]).toMatchObject({ kind: 'point-line-distance', value: 100 });
  });

  it('leaves the button disabled for a selection it cannot measure', () => {
    editor.setSelection(['circ', 'arc1', 'lineA']);
    expect(editor.planDimension()).toBeUndefined();
    editor.addDimension();
    expect(dimensions()).toHaveLength(0);
  });

  it('draws each new annotation on the canvas', () => {
    editor.setSelection(['lineA', 'lineB']);
    editor.addDimension();
    editor.setSelection(['circ']);
    editor.addDimension();
    editor.setSelection(['bx', 'lineA']);
    editor.addDimension();

    const drawn = [...stage.querySelectorAll('[data-dimension]')];
    expect(drawn).toHaveLength(3);
    // The angle is an arc, so its dimension line is a path with an A command.
    const angle = stage.querySelector('.dimension.is-angular .dim-line')!;
    expect(angle.getAttribute('d')).toContain('A');
  });

  it('moves the geometry when an angle is retyped, like any dimension', () => {
    editor.setSelection(['o']);
    editor.applyRelation('fix');
    editor.setSelection(['ax']);
    editor.applyRelation('fix');
    editor.setSelection(['lineA', 'lineB']);
    editor.addDimension();

    const angle = dimensions().find((c) => c.kind === 'angle')!;
    editor.setDimensionValue(angle.id, 45);

    const b = editor.getResult().positions['bx']!;
    expect((Math.atan2(b.y, b.x) * 180) / Math.PI).toBeCloseTo(45, 4);
  });
});

describe('reference dimensions', () => {
  /** Just a circle: sketch status is a property of the whole document, so
   *  anything else in it would be under defined and drown out the point. */
  const justACircle: SketchDocument = compose(
    addPoint('c', 300, 0),
    addEntity({ id: 'circ', kind: 'circle', center: 'c', radius: 40, layer: 'layer1', construction: false }),
  )(createEmptyDocument());

  beforeEach(() => start());

  function addReference(): Constraint {
    editor.setSelection(['circ']);
    editor.addDimension();
    const dimension = dimensions()[0]!;
    editor.setReference(dimension.id, true);
    return editor.getDocument().constraints[dimension.id]!;
  }

  it('turns a driving dimension into a measurement', () => {
    expect(addReference()).toMatchObject({ kind: 'diameter', reference: true });
  });

  it('gives the freedom back when it stops driving', () => {
    start(justACircle);
    editor.setSelection(['c']);
    editor.applyRelation('fix');
    editor.setSelection(['circ']);
    editor.addDimension();
    expect(editor.getResult().status).toBe('fully-defined');

    const dimension = dimensions().find((c) => c.kind === 'diameter')!;
    editor.setReference(dimension.id, true);
    expect(editor.getResult().status).toBe('under-defined');
    expect(editor.getResult().dof).toBe(1);
  });

  it('is still drawn, bracketed', () => {
    addReference();
    const text = stage.querySelector('.dimension.is-reference .dim-text')!;
    expect(text.textContent).toMatch(/^\(⌀\d+\)$/);
  });

  it('goes back to driving, and takes the freedom again', () => {
    start(justACircle);
    editor.setSelection(['c']);
    editor.applyRelation('fix');
    const dimension = addReference();
    editor.setReference(dimension.id, false);

    expect(editor.getResult().status).toBe('fully-defined');
    expect(stage.querySelector('.dimension.is-reference')).toBeNull();
  });

  it('is one undo step, like every other change', () => {
    const dimension = addReference();
    editor.undo();
    expect(editor.getDocument().constraints[dimension.id]?.reference).not.toBe(true);
  });
});

describe('selecting a relation highlights what it acts on', () => {
  beforeEach(() => start());

  it('lights up both lines behind a parallel relation', () => {
    editor.setSelection(['lineA', 'lineB']);
    editor.applyRelation('parallel');
    const relation = dimensions()[0]!;

    editor.setSelection([relation.id]);
    const related = [...stage.querySelectorAll('.sketch-entity.is-related')].map((e) =>
      e.getAttribute('data-entity'),
    );
    expect(related.sort()).toEqual(['lineA', 'lineB']);
  });

  it('lights up the points behind a point relation', () => {
    editor.setSelection(['o', 'ax']);
    editor.applyRelation('horizontal');
    const relation = dimensions()[0]!;

    editor.setSelection([relation.id]);
    const related = [...stage.querySelectorAll('.dot.is-related')].map((e) =>
      e.getAttribute('data-point'),
    );
    expect(related.sort()).toEqual(['ax', 'o']);
  });

  it('marks it as related, not as selected: it is not what would be deleted', () => {
    editor.setSelection(['lineA', 'lineB']);
    editor.applyRelation('parallel');
    const relation = dimensions()[0]!;
    editor.setSelection([relation.id]);

    expect(stage.querySelectorAll('.sketch-entity.is-selected')).toHaveLength(0);
    expect(stage.querySelector('.relhalo')).not.toBeNull();

    // Deleting removes the relation itself, and leaves the geometry alone.
    editor.deleteSelection();
    expect(Object.keys(editor.getDocument().entities)).toHaveLength(4);
    expect(dimensions()).toHaveLength(0);
  });

  it('clears the highlight when the selection moves on', () => {
    editor.setSelection(['lineA', 'lineB']);
    editor.applyRelation('parallel');
    editor.setSelection([dimensions()[0]!.id]);
    expect(stage.querySelector('.is-related')).not.toBeNull();

    editor.setSelection([]);
    expect(stage.querySelector('.is-related')).toBeNull();
  });

  it('does not light up a selected line\'s own endpoints', () => {
    // The line is already showing its selection; repeating it on its points
    // says nothing new.
    editor.setSelection(['lineA']);
    expect(stage.querySelector('.dot.is-related')).toBeNull();
  });
});

describe('the cross-layer affordance', () => {
  /** Two lines on two layers, tied together. Only a loaded file looks like this. */
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

  it('finds nothing to suspend in a sketch drawn here', () => {
    // Every tool puts its geometry on the first layer, so nothing drawn in the
    // app can cross one. The affordance is for documents opened from a file.
    start();
    expect(editor.getCrossLayer()).toEqual([]);
  });

  it('names the crossing relation in a loaded document', () => {
    start(twoLayers);
    expect(editor.getCrossLayer()).toEqual(['x1']);
  });

  it('narrows to the geometry being worked on', () => {
    start(twoLayers);
    editor.setSelection(['lineA']);
    expect(editor.getCrossLayer()).toEqual(['x1']);
  });

  it('does not vanish when the selection touches no crossing', () => {
    // The relation is still there, still badged in the panel. A button that
    // disappeared would read as the feature breaking, so it falls back to the
    // whole document and its label says so.
    start(twoLayers);
    editor.setSelection(['b2']);
    expect(editor.getCrossLayer()).toEqual(['x1']);
  });

  it('suspends the crossing and gives the freedom back', () => {
    start(twoLayers);
    const before = editor.getResult().dof;

    editor.suspendCrossLayer(true);
    expect(editor.getDocument().constraints['x1']).toMatchObject({ suspended: true });
    expect(editor.getResult().dof).toBe(before + 1);
  });

  it('resumes it, because the suspension is persistent rather than momentary', () => {
    start(twoLayers);
    editor.suspendCrossLayer(true);
    editor.suspendCrossLayer(false);

    expect(editor.getDocument().constraints['x1']).toMatchObject({ suspended: false });
  });

  it('is one undo step however many relations it touches', () => {
    start(twoLayers);
    editor.suspendCrossLayer(true);
    editor.undo();
    expect(editor.getDocument().constraints['x1']!.suspended).toBeUndefined();
  });
});
