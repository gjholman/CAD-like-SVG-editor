import { describe, expect, it } from 'vitest';
import { abs, add, constant, div, hypot, mul, neg, partialsOf, scale, sub, variable } from './autodiff';

/** Central difference of a one-variable function, for checking by hand. */
function numeric(f: (t: number) => number, at: number, step = 1e-6): number {
  return (f(at + step) - f(at - step)) / (2 * step);
}

describe('values', () => {
  it('computes arithmetic', () => {
    const a = variable(0, 3);
    const b = variable(1, 4);
    expect(add(a, b).value).toBe(7);
    expect(sub(a, b).value).toBe(-1);
    expect(mul(a, b).value).toBe(12);
    expect(div(a, b).value).toBeCloseTo(0.75, 12);
    expect(hypot(a, b).value).toBe(5);
    expect(neg(a).value).toBe(-3);
    expect(scale(a, 2).value).toBe(6);
    expect(abs(neg(a)).value).toBe(3);
  });

  it('treats a constant as depending on nothing', () => {
    expect(partialsOf(constant(7))).toEqual([]);
  });
});

describe('derivatives', () => {
  const gradOf = (dual: { grad: ReadonlyMap<number, number> }, index: number) =>
    dual.grad.get(index) ?? 0;

  it('is 1 for a variable with respect to itself and 0 for another', () => {
    const a = variable(0, 3);
    expect(gradOf(a, 0)).toBe(1);
    expect(gradOf(a, 1)).toBe(0);
  });

  it('follows the product rule', () => {
    const product = mul(variable(0, 3), variable(1, 4));
    expect(gradOf(product, 0)).toBe(4);
    expect(gradOf(product, 1)).toBe(3);
  });

  it('follows the quotient rule', () => {
    const quotient = div(variable(0, 3), variable(1, 4));
    expect(gradOf(quotient, 0)).toBeCloseTo(1 / 4, 12);
    expect(gradOf(quotient, 1)).toBeCloseTo(-3 / 16, 12);
  });

  it('differentiates a length', () => {
    const length = hypot(variable(0, 3), variable(1, 4));
    expect(gradOf(length, 0)).toBeCloseTo(3 / 5, 12);
    expect(gradOf(length, 1)).toBeCloseTo(4 / 5, 12);
  });

  it('accumulates when a variable appears twice', () => {
    // d(x + x)/dx = 2, not 1: the two contributions must add, not replace.
    const a = variable(0, 5);
    expect(gradOf(add(a, a), 0)).toBe(2);
    // d(x·x)/dx = 2x
    expect(gradOf(mul(a, a), 0)).toBe(10);
  });

  it('matches finite differences on a composite expression', () => {
    // f(t) = t / hypot(t, 4), differentiated at t = 3.
    const f = (t: number) => t / Math.hypot(t, 4);
    const t = variable(0, 3);
    const expression = div(t, hypot(t, constant(4)));

    expect(gradOf(expression, 0)).toBeCloseTo(numeric(f, 3), 8);
  });

  it('flips the gradient with abs when the value is negative', () => {
    expect(gradOf(abs(variable(0, -3)), 0)).toBe(-1);
    expect(gradOf(abs(variable(0, 3)), 0)).toBe(1);
  });
});

describe('degenerate cases', () => {
  it('drops the gradient of a zero length rather than inventing one', () => {
    // Every direction increases it equally, so there is no derivative.
    const length = hypot(variable(0, 0), variable(1, 0));
    expect(length.value).toBe(0);
    expect(partialsOf(length)).toEqual([]);
  });

  it('throws on a division by zero rather than inventing a value', () => {
    // A quiet zero here would read downstream as "satisfied, and constrains
    // nothing" — a constraint that silently removes no freedom, which is the
    // hardest kind of bug to see in a sketch. Every caller guards the length
    // first, so getting here means a guard is missing: say so loudly.
    expect(() => div(variable(0, 1), constant(0))).toThrow(/divide by zero/);
    expect(() => div(constant(0), variable(0, 0))).toThrow(/divide by zero/);
  });
});

describe('partialsOf', () => {
  it('leaves out terms that cancelled', () => {
    // x − x depends on nothing, and a zero row would waste a column.
    const a = variable(0, 5);
    expect(partialsOf(sub(a, a))).toEqual([]);
  });

  it('gives index and weight pairs', () => {
    expect(partialsOf(add(variable(2, 1), variable(5, 1))).sort()).toEqual([
      [2, 1],
      [5, 1],
    ]);
  });
});
