import { describe, expect, it } from 'vitest';
import {
  addArc,
  addEntity,
  addLine,
  addPoint,
  compose,
  createEmptyDocument,
  createIdGenerator,
  validate,
  type SketchDocument,
} from '../../core/model';
import { canApplyRelation, relationEdit, type RelationKind } from './commands';

/** Two lines, two circles, an arc and a loose point. */
const sandbox: SketchDocument = compose(
  addPoint('a1', 0, 0),
  addPoint('a2', 100, 0),
  addPoint('b1', 0, 40),
  addPoint('b2', 90, 60),
  addPoint('ca', 200, 0),
  addPoint('cb', 300, 0),
  addPoint('as', 340, 0),
  addPoint('ae', 300, 40),
  addPoint('loose', 50, 90),
  addLine('lineA', 'a1', 'a2', 'layer1'),
  addLine('lineB', 'b1', 'b2', 'layer1'),
  addEntity({ id: 'circA', kind: 'circle', center: 'ca', radius: 30, layer: 'layer1', construction: false }),
  addEntity({ id: 'circB', kind: 'circle', center: 'cb', radius: 20, layer: 'layer1', construction: false }),
  addArc('arcA', 'cb', 'as', 'ae', 'layer1'),
)(createEmptyDocument());

const ids = () => createIdGenerator();
const apply = (kind: RelationKind, selection: string[]) =>
  relationEdit(kind, sandbox, selection, ids())?.(sandbox);

describe('which selections suit which relation', () => {
  it.each([
    ['parallel', ['lineA', 'lineB'], true],
    ['parallel', ['lineA', 'circA'], false],
    ['parallel', ['lineA'], false],
    ['perpendicular', ['lineA', 'lineB'], true],
    ['perpendicular', ['circA', 'circB'], false],
    ['collinear', ['lineA', 'lineB'], true],
    ['collinear', ['lineA', 'arcA'], false],
    ['concentric', ['circA', 'circB'], true],
    ['concentric', ['circA', 'arcA'], true],
    ['concentric', ['lineA', 'circA'], false],
    ['tangent', ['lineA', 'circA'], true],
    ['tangent', ['circA', 'lineA'], true],
    ['tangent', ['circA', 'arcA'], true],
    ['tangent', ['lineA', 'lineB'], false],
    ['equal', ['lineA', 'lineB'], true],
    ['equal', ['circA', 'circB'], true],
    ['equal', ['circA', 'arcA'], true],
    ['equal', ['lineA', 'circA'], false],
    ['midpoint', ['loose', 'lineA'], true],
    ['midpoint', ['loose', 'circA'], false],
    ['midpoint', ['loose'], false],
    ['symmetric', ['a1', 'b1', 'lineA'], true],
    ['symmetric', ['a1', 'lineA'], false],
    ['symmetric', ['a1', 'b1', 'circA'], false],
  ] as const)('%s with %j is %s', (kind, selection, expected) => {
    expect(canApplyRelation(kind, sandbox, selection)).toBe(expected);
  });

  it('refuses a relation between an entity and itself', () => {
    expect(canApplyRelation('parallel', sandbox, ['lineA', 'lineA'])).toBe(false);
  });

  it('refuses an entity-pair relation when points are also selected', () => {
    // An ambiguous selection is better refused than guessed at.
    expect(canApplyRelation('parallel', sandbox, ['lineA', 'lineB', 'a1'])).toBe(false);
  });
});

describe('the edits they produce', () => {
  it('builds an entity-pair constraint', () => {
    const doc = apply('parallel', ['lineA', 'lineB'])!;
    expect(Object.values(doc.constraints)[0]).toMatchObject({ kind: 'parallel', a: 'lineA', b: 'lineB' });
    expect(validate(doc)).toEqual([]);
  });

  it('builds a midpoint constraint', () => {
    const doc = apply('midpoint', ['loose', 'lineA'])!;
    expect(Object.values(doc.constraints)[0]).toMatchObject({
      kind: 'midpoint',
      point: 'loose',
      entity: 'lineA',
    });
    expect(validate(doc)).toEqual([]);
  });

  it('builds a symmetric constraint', () => {
    const doc = apply('symmetric', ['a1', 'b1', 'lineA'])!;
    expect(Object.values(doc.constraints)[0]).toMatchObject({
      kind: 'symmetric',
      p1: 'a1',
      p2: 'b1',
      entity: 'lineA',
    });
    expect(validate(doc)).toEqual([]);
  });
});

describe('duplicates', () => {
  it('refuses the same entity pair twice, either way round', () => {
    const once = apply('parallel', ['lineA', 'lineB'])!;
    expect(relationEdit('parallel', once, ['lineA', 'lineB'], ids())).toBeUndefined();
    expect(relationEdit('parallel', once, ['lineB', 'lineA'], ids())).toBeUndefined();
  });

  it('still allows a different relation on the same pair', () => {
    const once = apply('parallel', ['lineA', 'lineB'])!;
    expect(relationEdit('equal', once, ['lineA', 'lineB'], ids())).toBeDefined();
  });

  it('refuses a duplicate midpoint and symmetric', () => {
    const mid = apply('midpoint', ['loose', 'lineA'])!;
    expect(relationEdit('midpoint', mid, ['loose', 'lineA'], ids())).toBeUndefined();

    const sym = apply('symmetric', ['a1', 'b1', 'lineA'])!;
    expect(relationEdit('symmetric', sym, ['b1', 'a1', 'lineA'], ids())).toBeUndefined();
  });
});
