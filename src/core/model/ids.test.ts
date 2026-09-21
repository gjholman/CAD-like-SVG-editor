import { describe, expect, it } from 'vitest';
import { createIdGenerator } from './ids';

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
