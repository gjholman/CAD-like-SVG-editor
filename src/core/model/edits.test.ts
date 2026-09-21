import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import {
  addConstraint,
  addLine,
  addPoint,
  closePath,
  compose,
  extendPath,
  movePoint,
  pruneOrphanPoints,
  referencedPoints,
  removeConstraint,
  removeEntity,
  startPath,
} from './edits';
import { createEmptyDocument } from './types';
import { validate } from './validate';

describe('point edits', () => {
  it('adds a point', () => {
    const doc = addPoint('p1', 10, 20)(createEmptyDocument());
    expect(doc.points['p1']).toEqual({ id: 'p1', x: 10, y: 20 });
    expect(validate(doc)).toEqual([]);
  });

  it('moves a point', () => {
    const doc = compose(addPoint('p1', 0, 0), movePoint('p1', 5, 6))(createEmptyDocument());
    expect(doc.points['p1']).toEqual({ id: 'p1', x: 5, y: 6 });
  });

  it('returns the same document when the move is a no-op', () => {
    const doc = addPoint('p1', 5, 6)(createEmptyDocument());
    expect(movePoint('p1', 5, 6)(doc)).toBe(doc);
  });

  it('ignores a move of a point that is not there', () => {
    const doc = createEmptyDocument();
    expect(movePoint('gone', 1, 2)(doc)).toBe(doc);
  });

  it('leaves the original document untouched', () => {
    const before = createEmptyDocument();
    addPoint('p1', 1, 1)(before);
    expect(before.points).toEqual({});
  });
});

describe('compose', () => {
  it('runs edits in order as one step', () => {
    const doc = compose(
      addPoint('p1', 0, 0),
      addPoint('p2', 100, 0),
      addLine('line1', 'p1', 'p2', 'layer1'),
    )(createEmptyDocument());

    expect(Object.keys(doc.points)).toEqual(['p1', 'p2']);
    expect(doc.entities['line1']).toMatchObject({ kind: 'line', p1: 'p1', p2: 'p2' });
    expect(validate(doc)).toEqual([]);
  });

  it('with no edits changes nothing', () => {
    const doc = createEmptyDocument();
    expect(compose()(doc)).toBe(doc);
  });
});

describe('path edits', () => {
  const twoLines = compose(
    addPoint('p1', 0, 0),
    addPoint('p2', 100, 0),
    addPoint('p3', 100, 100),
    addLine('line1', 'p1', 'p2', 'layer1'),
    addLine('line2', 'p2', 'p3', 'layer1'),
  );

  it('starts a path on the entity\'s own layer', () => {
    const doc = compose(twoLines, startPath('path1', 'line1'))(createEmptyDocument());
    expect(doc.paths['path1']).toMatchObject({ layer: 'layer1', fillRule: 'nonzero' });
    expect(doc.paths['path1']!.subpaths[0]!.members).toEqual([{ entity: 'line1', reversed: false }]);
    expect(validate(doc)).toEqual([]);
  });

  it('extends a path, which is how a chain becomes one <path d>', () => {
    const doc = compose(
      twoLines,
      startPath('path1', 'line1'),
      extendPath('path1', 'line2'),
    )(createEmptyDocument());

    expect(doc.paths['path1']!.subpaths[0]!.members.map((m) => m.entity)).toEqual(['line1', 'line2']);
    expect(validate(doc)).toEqual([]);
  });

  it('refuses to put construction geometry in a path', () => {
    // validate forbids it, so the edit must not build one.
    const doc = compose(
      addPoint('p1', 0, 0),
      addPoint('p2', 100, 0),
      addLine('line1', 'p1', 'p2', 'layer1', true),
      startPath('path1', 'line1'),
    )(createEmptyDocument());

    expect(doc.paths['path1']).toBeUndefined();
    expect(validate(doc)).toEqual([]);
  });

  it('refuses to extend a path with an entity from another layer', () => {
    const withLayer = (doc: ReturnType<typeof createEmptyDocument>) => ({
      ...doc,
      layers: { ...doc.layers, other: { id: 'other', name: 'Other', visible: true, locked: false } },
      layerOrder: [...doc.layerOrder, 'other'],
    });
    const doc = compose(
      withLayer,
      addPoint('p1', 0, 0),
      addPoint('p2', 100, 0),
      addPoint('p3', 100, 50),
      addLine('line1', 'p1', 'p2', 'layer1'),
      addLine('line2', 'p2', 'p3', 'other'),
      startPath('path1', 'line1'),
      extendPath('path1', 'line2'),
    )(createEmptyDocument());

    expect(doc.paths['path1']!.subpaths[0]!.members).toHaveLength(1);
    expect(validate(doc)).toEqual([]);
  });

  it('closes a path once', () => {
    const doc = compose(twoLines, startPath('path1', 'line1'), closePath('path1'))(createEmptyDocument());
    expect(doc.paths['path1']!.subpaths[0]!.closed).toBe(true);
    expect(closePath('path1')(doc)).toBe(doc);
  });
});

describe('removeEntity', () => {
  it('takes the entity out of its path and keeps the document valid', () => {
    const { doc, lines, path } = rectangleFixture();
    const trimmed = removeEntity(lines[1])(doc);

    expect(trimmed.entities[lines[1]]).toBeUndefined();
    expect(trimmed.paths[path]!.subpaths[0]!.members.map((m) => m.entity)).toEqual([
      lines[0],
      lines[2],
      lines[3],
    ]);
    expect(validate(trimmed)).toEqual([]);
  });

  it('drops a path once its last member goes', () => {
    const { doc, lines, path } = rectangleFixture();
    const stripped = lines.reduce((current, id) => removeEntity(id)(current), doc);

    expect(stripped.paths[path]).toBeUndefined();
    expect(validate(stripped)).toEqual([]);
  });

  it('removes constraints that named the entity', () => {
    const doc = compose(
      addPoint('p1', 0, 0),
      addPoint('p2', 100, 0),
      addPoint('p3', 50, 50),
      addLine('line1', 'p1', 'p2', 'layer1'),
      addConstraint({ id: 'c1', kind: 'point-on', point: 'p3', entity: 'line1' }),
    )(createEmptyDocument());

    const trimmed = removeEntity('line1')(doc);
    expect(trimmed.constraints['c1']).toBeUndefined();
    expect(validate(trimmed)).toEqual([]);
  });

  it('leaves the points alone, since a free point is legal', () => {
    const { doc, lines, corners } = rectangleFixture();
    const trimmed = removeEntity(lines[0])(doc);
    expect(Object.keys(trimmed.points).sort()).toEqual([...corners].sort());
  });

  it('ignores an entity that is not there', () => {
    const { doc } = rectangleFixture();
    expect(removeEntity('gone')(doc)).toBe(doc);
  });
});

describe('constraints', () => {
  it('adds and removes', () => {
    const doc = compose(
      addPoint('p1', 0, 0),
      addConstraint({ id: 'c1', kind: 'fix', point: 'p1' }),
    )(createEmptyDocument());

    expect(doc.constraints['c1']).toBeDefined();
    expect(removeConstraint('c1')(doc).constraints).toEqual({});
    expect(removeConstraint('gone')(doc)).toBe(doc);
  });
});

describe('orphan points', () => {
  it('lists the points something still refers to', () => {
    const { doc, corners } = rectangleFixture();
    expect([...referencedPoints(doc)].sort()).toEqual([...corners].sort());
  });

  it('prunes only the points nothing refers to', () => {
    const { doc, lines } = rectangleFixture();
    const stripped = lines.reduce((current, id) => removeEntity(id)(current), doc);

    // The constraints still name the corners, so nothing is orphaned yet.
    expect(Object.keys(pruneOrphanPoints()(stripped).points)).toHaveLength(4);

    const bare = { ...stripped, constraints: {} };
    expect(Object.keys(pruneOrphanPoints()(bare).points)).toHaveLength(0);
    expect(validate(pruneOrphanPoints()(bare))).toEqual([]);
  });

  it('returns the same document when nothing is orphaned', () => {
    const { doc } = rectangleFixture();
    expect(pruneOrphanPoints()(doc)).toBe(doc);
  });
});
