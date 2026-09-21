import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import { addLine, addPoint, compose, createEmptyDocument, createIdGenerator, validate } from '../../core/model';
import {
  canApplyRelation,
  describeSelection,
  dimensionEdit,
  dimensionPlan,
  pointPair,
  relationEdit,
  setDimensionValue,
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
      p1: 'p1',
      p2: 'p2',
      value: 100,
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
