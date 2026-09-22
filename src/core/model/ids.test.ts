import { describe, expect, it } from 'vitest';
import { createIdGenerator, generatorPast, highestIdCounter } from './ids';

describe('createIdGenerator', () => {
  it('counts up from one, so tests can predict IDs', () => {
    const nextId = createIdGenerator();
    expect([nextId('p'), nextId('p'), nextId('p')]).toEqual(['p1', 'p2', 'p3']);
  });

  it('shares one counter across prefixes, keeping IDs unique document-wide', () => {
    const nextId = createIdGenerator();
    expect([nextId('p'), nextId('line'), nextId('c')]).toEqual(['p1', 'line2', 'c3']);
  });

  it('falls back to a generic prefix', () => {
    expect(createIdGenerator()()).toBe('id1');
  });

  it('can start past an existing document\'s highest counter', () => {
    expect(createIdGenerator(10)('p')).toBe('p11');
  });

  it('gives independent generators independent counters', () => {
    const a = createIdGenerator();
    const b = createIdGenerator();
    a('p');
    expect(b('p')).toBe('p1');
  });
});

describe('highestIdCounter', () => {
  it('finds the largest trailing number', () => {
    expect(highestIdCounter(['p1', 'line7', 'c3'])).toBe(7);
  });

  it('is zero for no ids at all', () => {
    expect(highestIdCounter([])).toBe(0);
  });

  it('ignores ids that carry no counter', () => {
    // A hand-written id can never collide with a generated one, which always
    // ends in a digit, so it should not push the counter up.
    expect(highestIdCounter(['outline', 'layer-main'])).toBe(0);
    expect(highestIdCounter(['outline', 'p4'])).toBe(4);
  });

  it('reads the whole number, not just the last digit', () => {
    expect(highestIdCounter(['p9', 'p120'])).toBe(120);
  });
});

describe('generatorPast', () => {
  it('starts past every id it was given', () => {
    const nextId = generatorPast(['p1', 'line2', 'c3']);
    expect(nextId('p')).toBe('p4');
  });

  it('never repeats an id the document already holds', () => {
    const existing = ['p1', 'p2', 'line3', 'c4', 'path5', 'layer6'];
    const nextId = generatorPast(existing);
    const minted = Array.from({ length: 10 }, () => nextId('p'));
    expect(minted.filter((id) => existing.includes(id))).toEqual([]);
    expect(new Set(minted).size).toBe(10);
  });

  it('counts from one for an empty document', () => {
    expect(generatorPast([])('p')).toBe('p1');
  });
});
