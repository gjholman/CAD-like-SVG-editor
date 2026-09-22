import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import {
  addArc,
  addConstraint,
  addEntity,
  addLine,
  addPoint,
  compose,
  createEmptyDocument,
  createIdGenerator,
  validate,
  type Id,
} from '../../core/model';
import {
  canApplyRelation,
  describeSelection,
  dimensionEdit,
  dimensionPlan,
  pointPair,
  relationEdit,
  setDimensionValue,
  setReference,
  setSuspended,
} from './commands';

const twoPoints = compose(addPoint('p1', 0, 0), addPoint('p2', 100, 20))(createEmptyDocument());
const withLine = compose(
  addPoint('p1', 0, 0),
  addPoint('p2', 100, 20),
  addLine('line1', 'p1', 'p2', 'layer1'),
)(createEmptyDocument());

const ids = () => createIdGenerator();

describe('describeSelection', () => {
  it('splits points from entities', () => {
    expect(describeSelection(withLine, ['p1', 'line1', 'p2'])).toEqual({
      points: ['p1', 'p2'],
      entities: ['line1'],
    });
  });

  it('ignores ids that are neither', () => {
    expect(describeSelection(withLine, ['nope'])).toEqual({ points: [], entities: [] });
  });
});

describe('pointPair', () => {
  it('takes two selected points', () => {
    expect(pointPair(twoPoints, ['p1', 'p2'])).toEqual(['p1', 'p2']);
  });

  it('resolves a selected line to its endpoints', () => {
    // The plan allows a relation on "a line or two points"; v1 stores the
    // pair, so this is where a picked line is translated.
    expect(pointPair(withLine, ['line1'])).toEqual(['p1', 'p2']);
  });

  it('refuses a mixed or wrong-sized selection', () => {
    expect(pointPair(withLine, ['p1'])).toBeUndefined();
    expect(pointPair(withLine, ['p1', 'line1'])).toBeUndefined();
    expect(pointPair(twoPoints, [])).toBeUndefined();
  });
});

describe('relationEdit', () => {
  it('adds a horizontal between two points', () => {
    const doc = relationEdit('horizontal', twoPoints, ['p1', 'p2'], ids())!(twoPoints);
    const constraint = Object.values(doc.constraints)[0]!;

    expect(constraint).toMatchObject({ kind: 'horizontal', p1: 'p1', p2: 'p2' });
    expect(validate(doc)).toEqual([]);
  });

  it('adds a relation from a selected line', () => {
    const doc = relationEdit('vertical', withLine, ['line1'], ids())!(withLine);
    expect(Object.values(doc.constraints)[0]).toMatchObject({ kind: 'vertical', p1: 'p1', p2: 'p2' });
  });

  it('fixes every selected point at once', () => {
    const doc = relationEdit('fix', twoPoints, ['p1', 'p2'], ids())!(twoPoints);
    expect(Object.values(doc.constraints)).toHaveLength(2);
    expect(validate(doc)).toEqual([]);
  });

  it('refuses a duplicate, which would only make the sketch over defined', () => {
    const once = relationEdit('horizontal', twoPoints, ['p1', 'p2'], ids())!(twoPoints);
    expect(relationEdit('horizontal', once, ['p1', 'p2'], ids())).toBeUndefined();
    // Order of the pair does not matter.
    expect(relationEdit('horizontal', once, ['p2', 'p1'], ids())).toBeUndefined();
  });

  it('refuses a duplicate fix but still fixes the other point', () => {
    // One generator for the whole document: two generators would mint the same
    // id twice and the second constraint would quietly replace the first.
    const nextId = createIdGenerator();
    const once = relationEdit('fix', twoPoints, ['p1'], nextId)!(twoPoints);
    const both = relationEdit('fix', once, ['p1', 'p2'], nextId)!(once);

    expect(Object.values(both.constraints)).toHaveLength(2);
    expect(validate(both)).toEqual([]);
  });

  it('refuses a selection it cannot use', () => {
    expect(relationEdit('horizontal', twoPoints, ['p1'], ids())).toBeUndefined();
    expect(relationEdit('coincident', twoPoints, [], ids())).toBeUndefined();
    expect(relationEdit('fix', twoPoints, [], ids())).toBeUndefined();
  });
});

describe('canApplyRelation', () => {
  it('agrees with relationEdit', () => {
    expect(canApplyRelation('horizontal', twoPoints, ['p1', 'p2'])).toBe(true);
    expect(canApplyRelation('horizontal', twoPoints, ['p1'])).toBe(false);
    expect(canApplyRelation('fix', twoPoints, ['p1'])).toBe(true);
  });

  it('goes false once the relation is already there', () => {
    const once = relationEdit('coincident', twoPoints, ['p1', 'p2'], ids())!(twoPoints);
    expect(canApplyRelation('coincident', once, ['p1', 'p2'])).toBe(false);
  });
});

describe('dimensionPlan', () => {
  it('measures a mostly-horizontal pair as a width', () => {
    expect(dimensionPlan(twoPoints, ['p1', 'p2'])).toEqual({
      kind: 'horizontal-distance',
      points: ['p1', 'p2'],
      entities: [],
      value: 100,
      label: '100',
    });
  });

  it('measures a mostly-vertical pair as a height', () => {
    const tall = compose(addPoint('p1', 0, 0), addPoint('p2', 10, 240))(createEmptyDocument());
    expect(dimensionPlan(tall, ['p1', 'p2'])).toMatchObject({ kind: 'vertical-distance', value: 240 });
  });

  it('falls back to a straight-line distance on a diagonal', () => {
    const diagonal = compose(addPoint('p1', 0, 0), addPoint('p2', 30, 40))(createEmptyDocument());
    expect(dimensionPlan(diagonal, ['p1', 'p2'])).toMatchObject({ kind: 'distance', value: 50 });
  });

  it('keeps the sign, so a right-to-left pick still means the same geometry', () => {
    expect(dimensionPlan(twoPoints, ['p2', 'p1'])?.value).toBe(-100);
  });

  it('measures from solved positions when given them', () => {
    const solved = { p1: { x: 0, y: 0 }, p2: { x: 600, y: 0 } };
    expect(dimensionPlan(twoPoints, ['p1', 'p2'], solved)?.value).toBe(600);
  });

  it('refuses a selection it cannot measure', () => {
    expect(dimensionPlan(twoPoints, ['p1'])).toBeUndefined();
  });
});

describe('dimensionEdit', () => {
  it('adds the planned dimension', () => {
    const doc = dimensionEdit(twoPoints, ['p1', 'p2'], ids())!(twoPoints);
    expect(Object.values(doc.constraints)[0]).toMatchObject({
      kind: 'horizontal-distance',
      value: 100,
    });
    expect(validate(doc)).toEqual([]);
  });

  it('refuses a second dimension on the same pair and axis', () => {
    const once = dimensionEdit(twoPoints, ['p1', 'p2'], ids())!(twoPoints);
    expect(dimensionEdit(once, ['p1', 'p2'], ids())).toBeUndefined();
  });
});

describe('setDimensionValue', () => {
  it('changes the number', () => {
    const { doc, widthDimension } = rectangleFixture(480, 240);
    const wider = setDimensionValue(widthDimension, 600)(doc);
    expect((wider.constraints[widthDimension] as { value: number }).value).toBe(600);
  });

  it('ignores a non-dimension, a missing id, and a value that is not a number', () => {
    const { doc, widthDimension } = rectangleFixture();
    const fix = Object.values(doc.constraints).find((c) => c.kind === 'fix')!;

    expect(setDimensionValue(fix.id, 10)(doc)).toBe(doc);
    expect(setDimensionValue('gone', 10)(doc)).toBe(doc);
    expect(setDimensionValue(widthDimension, Number.NaN)(doc)).toBe(doc);
  });

  it('is a no-op when the value already matches', () => {
    const { doc, widthDimension } = rectangleFixture(480, 240);
    expect(setDimensionValue(widthDimension, 480)(doc)).toBe(doc);
  });
});

describe('setSuspended', () => {
  it('suspends and resumes', () => {
    const { doc, widthDimension } = rectangleFixture();
    const off = setSuspended(widthDimension, true)(doc);

    expect(off.constraints[widthDimension]!.suspended).toBe(true);
    expect(setSuspended(widthDimension, true)(off)).toBe(off);
    expect(setSuspended(widthDimension, false)(off).constraints[widthDimension]!.suspended).toBe(false);
  });
});

describe('dimensionPlan: what the pick decides', () => {
  /** A wedge, a circle and an arc, to pick from. */
  const shapes = compose(
    addPoint('o', 0, 0),
    addPoint('ax', 100, 0),
    addPoint('bx', 0, 100),
    addPoint('c', 300, 0),
    addPoint('ac', 500, 0),
    addPoint('as', 560, 0),
    addPoint('ae', 500, 60),
    addLine('lineA', 'o', 'ax', 'layer1'),
    addLine('lineB', 'o', 'bx', 'layer1'),
    addEntity({ id: 'circ', kind: 'circle', center: 'c', radius: 40, layer: 'layer1', construction: false }),
    addArc('arc1', 'ac', 'as', 'ae', 'layer1'),
  )(createEmptyDocument());

  it('reads two lines as the angle between them', () => {
    // y is down, so lineB at (0,100) is 90 degrees clockwise from lineA.
    expect(dimensionPlan(shapes, ['lineA', 'lineB'])).toMatchObject({
      kind: 'angle',
      entities: ['lineA', 'lineB'],
      value: 90,
      label: '90°',
    });
  });

  it('measures the angle the other way round when picked the other way round', () => {
    expect(dimensionPlan(shapes, ['lineB', 'lineA'])).toMatchObject({ kind: 'angle', value: -90 });
  });

  it('gives an angle in (-180, 180], the number you would read off a drawing', () => {
    const wide = compose(
      addPoint('o', 0, 0),
      addPoint('ax', 100, 0),
      addPoint('bx', -100, -10),
      addLine('lineA', 'o', 'ax', 'layer1'),
      addLine('lineB', 'o', 'bx', 'layer1'),
    )(createEmptyDocument());
    const value = dimensionPlan(wide, ['lineA', 'lineB'])!.value;
    expect(value).toBeGreaterThan(-180);
    expect(value).toBeLessThanOrEqual(180);
  });

  it('dimensions a circle by diameter, as a drawing does', () => {
    expect(dimensionPlan(shapes, ['circ'])).toMatchObject({
      kind: 'diameter',
      entities: ['circ'],
      value: 80,
      label: '⌀80',
    });
  });

  it('dimensions an arc by radius, as a drawing does', () => {
    expect(dimensionPlan(shapes, ['arc1'])).toMatchObject({
      kind: 'radius',
      entities: ['arc1'],
      value: 60,
      label: 'R60',
    });
  });

  it('reads a point and a line as the distance between them', () => {
    expect(dimensionPlan(shapes, ['bx', 'lineA'])).toMatchObject({
      kind: 'point-line-distance',
      points: ['bx'],
      entities: ['lineA'],
      value: 100,
    });
  });

  it('still reads a single line as its own length', () => {
    expect(dimensionPlan(shapes, ['lineA'])).toMatchObject({ kind: 'horizontal-distance', value: 100 });
  });

  it('has nothing to offer for a selection it cannot read', () => {
    expect(dimensionPlan(shapes, [])).toBeUndefined();
    expect(dimensionPlan(shapes, ['circ', 'arc1', 'lineA'])).toBeUndefined();
    expect(dimensionPlan(shapes, ['circ', 'lineA'])).toBeUndefined(); // no angle to a circle
  });

  it('measures from solved positions rather than stored ones', () => {
    const stretched = dimensionPlan(shapes, ['arc1'], {
      ac: { x: 500, y: 0 },
      as: { x: 600, y: 0 },
      ae: { x: 500, y: 100 },
    });
    expect(stretched).toMatchObject({ kind: 'radius', value: 100 });
  });
});

describe('dimensionEdit: the new kinds', () => {
  const shapes = compose(
    addPoint('o', 0, 0),
    addPoint('ax', 100, 0),
    addPoint('bx', 0, 100),
    addPoint('c', 300, 0),
    addLine('lineA', 'o', 'ax', 'layer1'),
    addLine('lineB', 'o', 'bx', 'layer1'),
    addEntity({ id: 'circ', kind: 'circle', center: 'c', radius: 40, layer: 'layer1', construction: false }),
  )(createEmptyDocument());

  const applied = (selection: Id[], options?: { reference?: boolean }) => {
    const edit = dimensionEdit(shapes, selection, createIdGenerator(), undefined, options);
    return edit === undefined ? undefined : Object.values(edit(shapes).constraints)[0];
  };

  it('builds an angle constraint naming both lines', () => {
    expect(applied(['lineA', 'lineB'])).toMatchObject({ kind: 'angle', a: 'lineA', b: 'lineB', value: 90 });
  });

  it('builds a diameter constraint naming the circle', () => {
    expect(applied(['circ'])).toMatchObject({ kind: 'diameter', entity: 'circ', value: 80 });
  });

  it('builds a point-line distance naming both', () => {
    expect(applied(['bx', 'lineA'])).toMatchObject({
      kind: 'point-line-distance',
      point: 'bx',
      entity: 'lineA',
      value: 100,
    });
  });

  it('marks a reference dimension as one when asked', () => {
    expect(applied(['circ'], { reference: true })).toMatchObject({ kind: 'diameter', reference: true });
    expect(applied(['circ'])).not.toHaveProperty('reference');
  });

  it('refuses a second dimension of the same kind on the same geometry', () => {
    const once = dimensionEdit(shapes, ['circ'], createIdGenerator())!(shapes);
    expect(dimensionEdit(once, ['circ'], createIdGenerator())).toBeUndefined();
  });

  it('refuses a diameter on a circle that already has a radius', () => {
    // They say the same thing, so the solver would rightly call the sketch
    // over defined — with two dimensions that do not look like duplicates.
    // A circle plans as a diameter, so the radius has to be put there by hand,
    // which is also what opening a file can do.
    const withRadius = addConstraint({
      id: 'r1',
      kind: 'radius',
      entity: 'circ',
      value: 40,
    })(shapes);

    expect(dimensionPlan(withRadius, ['circ'])).toMatchObject({ kind: 'diameter' });
    expect(dimensionEdit(withRadius, ['circ'], createIdGenerator())).toBeUndefined();
  });

  it('refuses a radius on an arc that already has a diameter', () => {
    const arcs = compose(
      addPoint('ac', 0, 0),
      addPoint('as', 60, 0),
      addPoint('ae', 0, 60),
      addArc('arc1', 'ac', 'as', 'ae', 'layer1'),
      addConstraint({ id: 'd1', kind: 'diameter', entity: 'arc1', value: 120 }),
    )(createEmptyDocument());

    expect(dimensionPlan(arcs, ['arc1'])).toMatchObject({ kind: 'radius' });
    expect(dimensionEdit(arcs, ['arc1'], createIdGenerator())).toBeUndefined();
  });

  it('produces a document that validates', () => {
    for (const selection of [['lineA', 'lineB'], ['circ'], ['bx', 'lineA'], ['lineA']]) {
      const edit = dimensionEdit(shapes, selection, createIdGenerator());
      expect(validate(edit!(shapes)), selection.join('+')).toEqual([]);
    }
  });
});

describe('setReference', () => {
  const withDimension = compose(
    addPoint('p1', 0, 0),
    addPoint('p2', 100, 0),
    addConstraint({ id: 'dim1', kind: 'distance', p1: 'p1', p2: 'p2', value: 100 }),
    addConstraint({ id: 'rel1', kind: 'horizontal', p1: 'p1', p2: 'p2' }),
  )(createEmptyDocument());

  it('turns a driving dimension into a measurement and back', () => {
    const measured = setReference('dim1', true)(withDimension);
    expect(measured.constraints['dim1']).toMatchObject({ reference: true });
    expect(setReference('dim1', false)(measured).constraints['dim1']).toMatchObject({ reference: false });
  });

  it('leaves a relation alone: only a dimension can be a measurement', () => {
    expect(setReference('rel1', true)(withDimension)).toBe(withDimension);
  });

  it('returns the same document when nothing would change', () => {
    expect(setReference('dim1', false)(withDimension)).toBe(withDimension);
  });
});
