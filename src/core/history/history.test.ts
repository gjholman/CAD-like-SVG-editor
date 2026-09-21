import { describe, expect, it } from 'vitest';
import { createRng, randomTransaction } from '../../../tests/fixtures/random-edits';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import { createEmptyDocument, createIdGenerator, removeEntity, validate, type SketchDocument } from '../model';
import {
  canRedo,
  canUndo,
  createHistory,
  current,
  dispatch,
  redo,
  redoLabel,
  undo,
  undoLabel,
  type Transaction,
} from './history';

/** Moves a point, the archetypal edit. */
const movePoint =
  (id: string, x: number, y: number): Transaction =>
  (doc) => ({ ...doc, points: { ...doc.points, [id]: { id, x, y } } });

const addPoint =
  (id: string): Transaction =>
  (doc) => ({ ...doc, points: { ...doc.points, [id]: { id, x: 0, y: 0 } } });

describe('history', () => {
  it('starts on the given document with nothing to undo or redo', () => {
    const doc = createEmptyDocument();
    const history = createHistory(doc);

    expect(current(history)).toBe(doc);
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
  });

  it('advances the present and leaves the original document untouched', () => {
    const { doc, corners } = rectangleFixture();
    const history = dispatch(createHistory(doc), movePoint(corners[0], 5, 7));

    expect(current(history).points[corners[0]]).toEqual({ id: corners[0], x: 5, y: 7 });
    expect(doc.points[corners[0]]).toEqual({ id: corners[0], x: 0, y: 0 });
    expect(canUndo(history)).toBe(true);
  });

  it('undoes back to the exact previous document, by reference', () => {
    const doc = createEmptyDocument();
    const history = dispatch(createHistory(doc), addPoint('p1'));

    const undone = undo(history);
    expect(current(undone)).toBe(doc);
    expect(canUndo(undone)).toBe(false);
    expect(canRedo(undone)).toBe(true);
  });

  it('redoes the step it just undid, by reference', () => {
    const history = dispatch(createHistory(createEmptyDocument()), addPoint('p1'));
    const after = current(history);

    expect(current(redo(undo(history)))).toBe(after);
  });

  it('walks a multi-step stack in both directions', () => {
    let history = createHistory(createEmptyDocument());
    for (const id of ['p1', 'p2', 'p3']) history = dispatch(history, addPoint(id));

    expect(Object.keys(current(history).points)).toEqual(['p1', 'p2', 'p3']);
    history = undo(undo(history));
    expect(Object.keys(current(history).points)).toEqual(['p1']);
    history = redo(history);
    expect(Object.keys(current(history).points)).toEqual(['p1', 'p2']);
  });

  it('clears the redo stack on a new edit', () => {
    let history = dispatch(createHistory(createEmptyDocument()), addPoint('p1'));
    history = undo(history);
    expect(canRedo(history)).toBe(true);

    history = dispatch(history, addPoint('p2'));
    expect(canRedo(history)).toBe(false);
    expect(Object.keys(current(history).points)).toEqual(['p2']);
  });

  it('ignores a transaction that changes nothing', () => {
    const history = createHistory(createEmptyDocument());
    const unchanged = dispatch(history, (doc) => doc);

    expect(unchanged).toBe(history);
    expect(canUndo(unchanged)).toBe(false);
  });

  it('does not clear the redo stack for a no-op transaction', () => {
    let history = dispatch(createHistory(createEmptyDocument()), addPoint('p1'));
    history = undo(history);
    history = dispatch(history, (doc) => doc);

    expect(canRedo(history)).toBe(true);
  });

  it('refuses to undo or redo past the ends', () => {
    const history = createHistory(createEmptyDocument());
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  describe('gestures', () => {
    it('collapses a whole drag into one undo step', () => {
      const { doc, corners } = rectangleFixture();
      let history = createHistory(doc);

      // One pointer-down, many pointer-moves, all under one token.
      for (let i = 1; i <= 10; i += 1) {
        history = dispatch(history, movePoint(corners[0], i, i), { gesture: 'drag-1' });
      }

      expect(current(history).points[corners[0]]).toEqual({ id: corners[0], x: 10, y: 10 });
      expect(history.past).toHaveLength(1);

      history = undo(history);
      expect(current(history)).toBe(doc);
      expect(canUndo(history)).toBe(false);
    });

    it('keeps separate gestures as separate steps', () => {
      const { doc, corners } = rectangleFixture();
      let history = createHistory(doc);
      history = dispatch(history, movePoint(corners[0], 1, 1), { gesture: 'drag-1' });
      history = dispatch(history, movePoint(corners[0], 2, 2), { gesture: 'drag-2' });

      expect(history.past).toHaveLength(2);
      expect(current(undo(history)).points[corners[0]]).toEqual({ id: corners[0], x: 1, y: 1 });
    });

    it('closes a gesture when an ordinary edit follows', () => {
      let history = createHistory(createEmptyDocument());
      history = dispatch(history, addPoint('p1'), { gesture: 'drag-1' });
      history = dispatch(history, addPoint('p2'));
      history = dispatch(history, addPoint('p3'), { gesture: 'drag-1' });

      // The reused token must not reach back past the ordinary edit.
      expect(history.past).toHaveLength(3);
    });
  });

  describe('labels', () => {
    it('reports what undo and redo would do', () => {
      let history = createHistory(createEmptyDocument());
      history = dispatch(history, addPoint('p1'), { label: 'Add Point' });
      history = dispatch(history, movePoint('p1', 3, 4), { label: 'Move Point' });

      expect(undoLabel(history)).toBe('Move Point');
      expect(redoLabel(history)).toBeUndefined();

      history = undo(history);
      expect(undoLabel(history)).toBe('Add Point');
      expect(redoLabel(history)).toBe('Move Point');
    });

    it('has no undo label at the start of history', () => {
      expect(undoLabel(createHistory(createEmptyDocument()))).toBeUndefined();
    });
  });

  describe('property: undoing everything returns the original document', () => {
    const seeds = Array.from({ length: 300 }, (_, i) => i + 1);

    it(`holds across ${seeds.length} random sequences`, () => {
      for (const seed of seeds) {
        const original: SketchDocument = createEmptyDocument();
        const source = { nextId: createIdGenerator(1000), rng: createRng(seed) };

        let history = createHistory(original);
        for (let i = 0; i < 25; i += 1) {
          const { transaction, label } = randomTransaction(source);
          history = dispatch(history, transaction, { label });

          const issues = validate(current(history));
          expect(issues, `seed ${seed}, edit ${i} (${label}): ${JSON.stringify(issues)}`).toEqual([]);
        }

        while (canUndo(history)) history = undo(history);

        // Reference equality, not deep equality: it proves nothing was mutated
        // along the way and that the snapshots really do share structure.
        expect(current(history), `seed ${seed}`).toBe(original);
      }
    });

    it('redoing everything gets back to where the edits ended', () => {
      const source = { nextId: createIdGenerator(1000), rng: createRng(42) };
      let history = createHistory(createEmptyDocument());
      for (let i = 0; i < 40; i += 1) {
        const { transaction, label } = randomTransaction(source);
        history = dispatch(history, transaction, { label });
      }
      const ended = current(history);

      while (canUndo(history)) history = undo(history);
      while (canRedo(history)) history = redo(history);

      expect(current(history)).toBe(ended);
    });
  });
});

describe('random edits', () => {
  // Guards the property test above: if the generator ever degenerated into
  // no-ops it would still "pass", while proving nothing.
  it('builds a document with geometry, paths, constraints and layers', () => {
    const source = { nextId: createIdGenerator(1000), rng: createRng(7) };
    let doc = createEmptyDocument();
    for (let i = 0; i < 200; i += 1) doc = randomTransaction(source).transaction(doc);

    expect(Object.keys(doc.points).length).toBeGreaterThan(5);
    expect(Object.keys(doc.entities).length).toBeGreaterThan(5);
    expect(Object.keys(doc.constraints).length).toBeGreaterThan(5);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expect(doc.layerOrder.length).toBeGreaterThan(1);
    expect(validate(doc)).toEqual([]);
  });

  it('keeps path records in sync when an entity is removed', () => {
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
});
