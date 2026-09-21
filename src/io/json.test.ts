import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../tests/fixtures/rectangle';
import { createRng, randomTransaction } from '../../tests/fixtures/random-edits';
import { createEmptyDocument, createIdGenerator, type SketchDocument } from '../core/model';
import { SketchFileError, fromJson, suggestFilename, toJson } from './json';

describe('round trip', () => {
  it('returns an identical document', () => {
    const { doc } = rectangleFixture(480, 240);
    expect(fromJson(toJson(doc))).toEqual(doc);
  });

  it('survives an empty document', () => {
    const doc = createEmptyDocument();
    expect(fromJson(toJson(doc))).toEqual(doc);
  });

  it('holds for documents built by random edits', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const source = { nextId: createIdGenerator(1000), rng: createRng(seed) };
      let doc: SketchDocument = createEmptyDocument();
      for (let i = 0; i < 25; i += 1) doc = randomTransaction(source).transaction(doc);

      expect(fromJson(toJson(doc)), `seed ${seed}`).toEqual(doc);
    }
  });

  it('keeps exact coordinates, not rounded ones', () => {
    const doc = createEmptyDocument();
    const precise: SketchDocument = {
      ...doc,
      points: { p1: { id: 'p1', x: 1 / 3, y: -0.000123456789 } },
    };
    expect(fromJson(toJson(precise)).points['p1']).toEqual(precise.points['p1']);
  });

  it('writes something a person can diff', () => {
    const text = toJson(rectangleFixture().doc);
    expect(text).toContain('\n  "version": 1');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('loading a bad file', () => {
  const rejects = (text: string, pattern: RegExp) => {
    expect(() => fromJson(text)).toThrow(SketchFileError);
    expect(() => fromJson(text)).toThrow(pattern);
  };

  it('rejects text that is not JSON', () => {
    rejects('not json at all', /not valid JSON/);
  });

  it('rejects JSON that is not a sketch', () => {
    rejects('[1, 2, 3]', /does not contain a sketch/);
    rejects('"hello"', /does not contain a sketch/);
    rejects('null', /does not contain a sketch/);
  });

  it('rejects a file with no version', () => {
    rejects(JSON.stringify({ points: {} }), /no version/);
  });

  it('rejects a file from a newer build, by name', () => {
    const { doc } = rectangleFixture();
    rejects(JSON.stringify({ ...doc, version: 99 }), /newer version \(file 99, this build reads 1\)/);
  });

  it('rejects a file missing a collection', () => {
    const { doc } = rectangleFixture();
    const { entities: _entities, ...rest } = doc;
    rejects(JSON.stringify(rest), /missing its "entities"/);
  });

  it('rejects a file with a broken layerOrder', () => {
    const { doc } = rectangleFixture();
    rejects(JSON.stringify({ ...doc, layerOrder: 'layer1' }), /missing its "layerOrder"/);
  });

  it('rejects an inconsistent sketch and says what is wrong', () => {
    const { doc, lines } = rectangleFixture();
    const broken = {
      ...doc,
      entities: { ...doc.entities, [lines[0]]: { ...doc.entities[lines[0]]!, p2: 'gone' } },
    };
    rejects(JSON.stringify(broken), /inconsistent: .*unknown point "gone"/);
  });

  it('counts the problems it did not list', () => {
    const { doc } = rectangleFixture();
    const broken = { ...doc, points: {}, layerOrder: [...doc.layerOrder, 'nope'] };
    expect(() => fromJson(JSON.stringify(broken))).toThrow(/and \d+ more/);
  });
});

describe('suggestFilename', () => {
  it.each([
    ['bracket', 'bracket.json'],
    ['bracket.json', 'bracket.json'],
    ['  spaced  ', 'spaced.json'],
    ['odd/name*here', 'oddnamehere.json'],
    ['', 'sketch.json'],
    ['///', 'sketch.json'],
  ])('turns %o into %o', (input, expected) => {
    expect(suggestFilename(input)).toBe(expected);
  });

  it('defaults with no argument', () => {
    expect(suggestFilename()).toBe('sketch.json');
  });
});
