import { describe, expect, it } from 'vitest';

describe('test setup', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2);
  });

  it('has no DOM in the default environment, so src/core stays DOM-free', () => {
    expect(typeof document).toBe('undefined');
  });
});
