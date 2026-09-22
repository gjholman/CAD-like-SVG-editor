/**
 * Forward-mode automatic differentiation over sparse gradients.
 *
 * The v1 constraints have hand-derived Jacobians, checked against finite
 * differences. That was fine for eight simple residuals; the v2 relations are
 * harder — tangency, symmetry and collinearity each involve a normalised
 * direction or a distance-to-line, and hand-deriving eight more is where a
 * sign error would go unnoticed until a sketch quietly refused to solve.
 *
 * So the v2 residuals are written as ordinary arithmetic on `Dual` values and
 * the derivatives come out exact by construction. The finite-difference tests
 * then check the whole thing end to end, which is what they did for the
 * hand-derived ones too.
 *
 * Gradients are sparse maps because a constraint touches a handful of
 * variables out of however many the sketch has.
 */

export interface Dual {
  readonly value: number;
  /** ∂value/∂variable, by variable index. Absent means zero. */
  readonly grad: ReadonlyMap<number, number>;
}

const NO_GRAD: ReadonlyMap<number, number> = new Map();

/** A number that does not depend on any variable. */
export function constant(value: number): Dual {
  return { value, grad: NO_GRAD };
}

/** The variable at `index`, whose derivative with respect to itself is 1. */
export function variable(index: number, value: number): Dual {
  return { value, grad: new Map([[index, 1]]) };
}

export function add(a: Dual, b: Dual): Dual {
  return { value: a.value + b.value, grad: combine(a.grad, 1, b.grad, 1) };
}

export function sub(a: Dual, b: Dual): Dual {
  return { value: a.value - b.value, grad: combine(a.grad, 1, b.grad, -1) };
}

export function neg(a: Dual): Dual {
  return { value: -a.value, grad: combine(a.grad, -1, NO_GRAD, 0) };
}

export function scale(a: Dual, k: number): Dual {
  return { value: a.value * k, grad: combine(a.grad, k, NO_GRAD, 0) };
}

/** d(ab) = b·da + a·db */
export function mul(a: Dual, b: Dual): Dual {
  return { value: a.value * b.value, grad: combine(a.grad, b.value, b.grad, a.value) };
}

/** d(a/b) = da/b − a·db/b² */
export function div(a: Dual, b: Dual): Dual {
  if (b.value === 0) return constant(0);
  return {
    value: a.value / b.value,
    grad: combine(a.grad, 1 / b.value, b.grad, -a.value / (b.value * b.value)),
  };
}

/**
 * √(x² + y²), the length that shows up in every distance and radius.
 *
 * At zero the length has no derivative — every direction increases it equally
 * — so the gradient is dropped rather than made up. The row then carries the
 * error but removes no degrees of freedom, which is the honest answer for
 * degenerate geometry.
 */
export function hypot(x: Dual, y: Dual): Dual {
  const value = Math.hypot(x.value, y.value);
  if (value === 0) return constant(0);
  return { value, grad: combine(x.grad, x.value / value, y.grad, y.value / value) };
}

/**
 * |a|, for residuals that measure a distance regardless of side (tangency is
 * the same whichever side of the line the centre sits on). Not differentiable
 * at zero, where the sign is undefined; the caller guards that case.
 */
export function abs(a: Dual): Dual {
  return a.value < 0 ? neg(a) : a;
}

/** Sparse `pa · a + pb · b`. */
function combine(
  a: ReadonlyMap<number, number>,
  pa: number,
  b: ReadonlyMap<number, number>,
  pb: number,
): ReadonlyMap<number, number> {
  const grad = new Map<number, number>();
  for (const [index, value] of a) grad.set(index, value * pa);
  for (const [index, value] of b) grad.set(index, (grad.get(index) ?? 0) + value * pb);
  return grad;
}

/** The sparse partials, in the shape the Jacobian assembler wants. */
export function partialsOf(dual: Dual): (readonly [number, number])[] {
  return [...dual.grad].filter(([, weight]) => weight !== 0);
}
