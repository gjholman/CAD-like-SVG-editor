import { describe, expect, it } from 'vitest';
import { createRng } from '../../../tests/fixtures/random-edits';
import {
  at,
  createMatrix,
  decomposeQr,
  matrixFromRows,
  multiplyVector,
  nullspace,
  rank,
  setAt,
  solveLeastSquares,
  toRows,
  type Matrix,
} from './linalg';

/** Largest |A·v|, which should be ~0 for a nullspace vector. */
function residual(matrix: Matrix, vector: readonly number[]): number {
  return Math.max(0, ...multiplyVector(matrix, vector).map(Math.abs));
}

function unitLength(vector: readonly number[]): number {
  return Math.hypot(...vector);
}

/** Are two vectors parallel? Compares directions, ignoring sign and scale. */
function cosineWith(a: readonly number[], b: readonly number[]): number {
  const dot = a.reduce((sum, value, i) => sum + value * b[i]!, 0);
  return Math.abs(dot) / (unitLength(a) * unitLength(b));
}

describe('matrix basics', () => {
  it('round-trips rows', () => {
    const rows = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(toRows(matrixFromRows(rows))).toEqual(rows);
  });

  it('reads and writes single entries', () => {
    const matrix = createMatrix(2, 3);
    setAt(matrix, 1, 2, 7);
    expect(at(matrix, 1, 2)).toBe(7);
    expect(at(matrix, 0, 0)).toBe(0);
  });

  it('multiplies by a vector', () => {
    const matrix = matrixFromRows([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(multiplyVector(matrix, [1, -1])).toEqual([-1, -1, -1]);
  });

  it('rejects ragged rows', () => {
    expect(() => matrixFromRows([[1, 2], [3]])).toThrow(/differing lengths/);
  });

  it('rejects a vector of the wrong length', () => {
    expect(() => multiplyVector(createMatrix(2, 3), [1, 2])).toThrow(/3 columns/);
  });
});

describe('rank', () => {
  it('is full for the identity', () => {
    expect(rank(matrixFromRows([[1, 0, 0], [0, 1, 0], [0, 0, 1]]))).toBe(3);
  });

  it('is zero for a zero matrix', () => {
    expect(rank(createMatrix(3, 4))).toBe(0);
  });

  it('is zero for a matrix with no rows', () => {
    expect(rank(createMatrix(0, 3))).toBe(0);
  });

  it('spots a duplicated row', () => {
    expect(rank(matrixFromRows([[1, 2], [2, 4]]))).toBe(1);
  });

  it('spots a row that is the sum of two others', () => {
    // Rows 1,2,3 / 4,5,6 / 7,8,9: the third is twice the second minus the first.
    expect(rank(matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 9]]))).toBe(2);
  });

  it('handles a wide matrix (more variables than constraints)', () => {
    expect(rank(matrixFromRows([[1, 0, 0], [0, 1, 0]]))).toBe(2);
  });

  it('handles a tall matrix (more constraints than variables)', () => {
    expect(rank(matrixFromRows([[1, 0], [0, 1], [1, 1]]))).toBe(2);
  });

  it('is not fooled by a badly scaled but independent matrix', () => {
    expect(rank(matrixFromRows([[1e6, 0], [0, 1e-6]]))).toBe(2);
  });
});

describe('decomposeQr', () => {
  it('leaves R upper trapezoidal', () => {
    const matrix = matrixFromRows([[4, 1, 2], [2, 7, 3], [1, 1, 9], [3, 2, 1]]);
    const { r } = decomposeQr(matrix);

    for (let i = 0; i < r.rows; i += 1) {
      for (let j = 0; j < Math.min(i, r.cols); j += 1) {
        expect(at(r, i, j)).toBeCloseTo(0, 10);
      }
    }
  });

  it('returns pivots that are a permutation of the columns', () => {
    const { pivots } = decomposeQr(matrixFromRows([[1, 5, 2], [0, 4, 1], [3, 1, 7]]));
    expect([...pivots].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('orders the diagonal by decreasing magnitude, which is what reveals rank', () => {
    const { r } = decomposeQr(matrixFromRows([[1, 0, 0], [0, 100, 0], [0, 0, 10]]));
    const diagonal = [0, 1, 2].map((k) => Math.abs(at(r, k, k)));
    expect(diagonal[0]).toBeGreaterThanOrEqual(diagonal[1]!);
    expect(diagonal[1]).toBeGreaterThanOrEqual(diagonal[2]!);
  });
});

describe('nullspace', () => {
  it('is empty when the matrix has full column rank', () => {
    expect(nullspace(matrixFromRows([[1, 0], [0, 1]]))).toEqual([]);
  });

  it('finds the free direction of a rank-deficient matrix', () => {
    const matrix = matrixFromRows([[1, 2], [2, 4]]);
    const basis = nullspace(matrix);

    expect(basis).toHaveLength(1);
    expect(residual(matrix, basis[0]!)).toBeCloseTo(0, 10);
    expect(cosineWith(basis[0]!, [2, -1])).toBeCloseTo(1, 10);
  });

  it('finds the free direction of the 1..9 matrix', () => {
    const matrix = matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    const basis = nullspace(matrix);

    expect(basis).toHaveLength(1);
    expect(residual(matrix, basis[0]!)).toBeCloseTo(0, 10);
    expect(cosineWith(basis[0]!, [1, -2, 1])).toBeCloseTo(1, 10);
  });

  it('spans everything when the matrix is zero', () => {
    const basis = nullspace(createMatrix(2, 3));
    expect(basis).toHaveLength(3);
    expect(rank(matrixFromRows(basis))).toBe(3);
  });

  it('returns unit vectors', () => {
    for (const vector of nullspace(matrixFromRows([[1, 1, 1, 1]]))) {
      expect(unitLength(vector)).toBeCloseTo(1, 10);
    }
  });

  it('returns an independent basis', () => {
    const matrix = matrixFromRows([[1, 1, 1, 1], [2, 2, 2, 2]]);
    const basis = nullspace(matrix);

    expect(basis).toHaveLength(3);
    expect(rank(matrixFromRows(basis))).toBe(3);
    for (const vector of basis) expect(residual(matrix, vector)).toBeCloseTo(0, 10);
  });
});

describe('solveLeastSquares', () => {
  it('solves a well-conditioned square system', () => {
    const matrix = matrixFromRows([[2, 1], [1, 3]]);
    const { solution, rank: rk } = solveLeastSquares(matrix, [5, 10]);

    expect(rk).toBe(2);
    expect(solution[0]).toBeCloseTo(1, 10);
    expect(solution[1]).toBeCloseTo(3, 10);
  });

  it('fits an exact line through an overdetermined system', () => {
    // y = 2 + 3t sampled at t = 0..3.
    const matrix = matrixFromRows([[1, 0], [1, 1], [1, 2], [1, 3]]);
    const { solution } = solveLeastSquares(matrix, [2, 5, 8, 11]);

    expect(solution[0]).toBeCloseTo(2, 10);
    expect(solution[1]).toBeCloseTo(3, 10);
  });

  it('gives the least-squares fit when no exact solution exists', () => {
    // Points (0,0) (1,1) (2,2) (3,4): the regression line is -0.2 + 1.3t.
    const matrix = matrixFromRows([[1, 0], [1, 1], [1, 2], [1, 3]]);
    const { solution } = solveLeastSquares(matrix, [0, 1, 2, 4]);

    expect(solution[0]).toBeCloseTo(-0.2, 10);
    expect(solution[1]).toBeCloseTo(1.3, 10);
  });

  it('still solves a consistent but rank-deficient system', () => {
    const matrix = matrixFromRows([[1, 1], [2, 2]]);
    const { solution, rank: rk } = solveLeastSquares(matrix, [1, 2]);

    expect(rk).toBe(1);
    for (const [i, value] of multiplyVector(matrix, solution).entries()) {
      expect(value).toBeCloseTo([1, 2][i]!, 10);
    }
  });

  it('rejects a right-hand side of the wrong length', () => {
    expect(() => solveLeastSquares(createMatrix(3, 2), [1, 2])).toThrow(/3 rows/);
  });

  it('stays accurate on matrices that invite cancellation', () => {
    // A column like [1, eps, eps, ...] is the case the Householder sign choice
    // exists for: taking alpha with the same sign as x[0] makes v[0] = x[0] -
    // alpha cancel, and accuracy collapses. Measured, that choice costs about
    // six digits here (7.8e-9 against 5.3e-15), so this threshold pins it.
    for (const eps of [1e-6, 1e-8, 1e-10, 1e-12]) {
      const size = 8;
      const matrix = matrixFromRows(
        Array.from({ length: size }, (_, i) =>
          Array.from({ length: size }, (_, j) => (j === 0 ? (i === 0 ? 1 : eps) : i === j ? 1 : eps)),
        ),
      );
      const answer = Array.from({ length: size }, (_, i) => i + 1);
      const { solution } = solveLeastSquares(matrix, multiplyVector(matrix, answer));

      for (let i = 0; i < size; i += 1) {
        expect(Math.abs(solution[i]! - answer[i]!), `eps ${eps}, entry ${i}`).toBeLessThan(1e-12);
      }
    }
  });
});

describe('the rectangle Jacobian from the plan', () => {
  // Variables, in order: x0 y0 x1 y1 x2 y2 x3 y3 for the four corners.
  // Corner 0 is fixed; 0-1 and 3-2 are horizontal; 0-3 and 1-2 are vertical.
  const fixX = [1, 0, 0, 0, 0, 0, 0, 0];
  const fixY = [0, 1, 0, 0, 0, 0, 0, 0];
  const horizontalBottom = [0, -1, 0, 1, 0, 0, 0, 0];
  const horizontalTop = [0, 0, 0, 0, 0, 1, 0, -1];
  const verticalLeft = [-1, 0, 0, 0, 0, 0, 1, 0];
  const verticalRight = [0, 0, -1, 0, 1, 0, 0, 0];
  const widthDimension = [-1, 0, 1, 0, 0, 0, 0, 0];
  const heightDimension = [0, -1, 0, 0, 0, 0, 0, 1];

  const geometric = [fixX, fixY, horizontalBottom, horizontalTop, verticalLeft, verticalRight];

  it('is fully defined with both dimensions: rank 8, no free directions', () => {
    const jacobian = matrixFromRows([...geometric, widthDimension, heightDimension]);

    expect(rank(jacobian)).toBe(8);
    expect(8 - rank(jacobian)).toBe(0); // DOF
    expect(nullspace(jacobian)).toEqual([]);
  });

  it('is under defined without the width dimension, and the free direction is width', () => {
    const jacobian = matrixFromRows([...geometric, heightDimension]);

    expect(rank(jacobian)).toBe(7);
    expect(8 - rank(jacobian)).toBe(1); // DOF

    const basis = nullspace(jacobian);
    expect(basis).toHaveLength(1);
    expect(residual(jacobian, basis[0]!)).toBeCloseTo(0, 10);
    // Width is free: the two right-hand corners slide in x together, and
    // nothing else moves.
    expect(cosineWith(basis[0]!, [0, 0, 1, 0, 1, 0, 0, 0])).toBeCloseTo(1, 10);
  });

  it('has two free directions with neither dimension', () => {
    expect(8 - rank(matrixFromRows(geometric))).toBe(2);
  });

  it('reports a redundant constraint as not adding rank', () => {
    // Dimensioning the width twice is consistent but redundant: eight rows of
    // constraint that between them only pin down seven directions.
    const jacobian = matrixFromRows([...geometric, widthDimension, widthDimension]);

    expect(jacobian.rows).toBe(8);
    expect(rank(jacobian)).toBe(7);
  });
});

describe('random matrices of known rank', () => {
  /** B (m×r) times C (r×n) has rank r for almost every random B and C. */
  function productOfRank(rng: () => number, rows: number, cols: number, r: number): Matrix {
    const left = Array.from({ length: rows }, () => Array.from({ length: r }, () => rng() * 2 - 1));
    const right = Array.from({ length: r }, () => Array.from({ length: cols }, () => rng() * 2 - 1));
    return matrixFromRows(
      left.map((row) =>
        Array.from({ length: cols }, (_, j) => row.reduce((sum, value, k) => sum + value * right[k]![j]!, 0)),
      ),
    );
  }

  it('recovers the rank and a valid nullspace every time', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rng = createRng(seed);
      const rows = 4 + Math.floor(rng() * 5);
      const cols = 4 + Math.floor(rng() * 5);
      const expected = 1 + Math.floor(rng() * (Math.min(rows, cols) - 1));
      const matrix = productOfRank(rng, rows, cols, expected);

      const where = `seed ${seed} (${rows}x${cols}, rank ${expected})`;
      expect(rank(matrix), where).toBe(expected);

      const basis = nullspace(matrix);
      expect(basis, where).toHaveLength(cols - expected);
      for (const vector of basis) {
        expect(residual(matrix, vector), where).toBeCloseTo(0, 8);
        expect(unitLength(vector), where).toBeCloseTo(1, 10);
      }
      if (basis.length > 0) expect(rank(matrixFromRows(basis)), where).toBe(basis.length);
    }
  });

  it('solves a consistent system built from a known answer', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rng = createRng(seed + 500);
      const size = 3 + Math.floor(rng() * 4);
      const matrix = productOfRank(rng, size, size, size);
      const answer = Array.from({ length: size }, () => rng() * 10 - 5);
      const b = multiplyVector(matrix, answer);

      const { solution, rank: rk } = solveLeastSquares(matrix, b);
      expect(rk, `seed ${seed}`).toBe(size);
      for (let i = 0; i < size; i += 1) {
        expect(solution[i], `seed ${seed}, entry ${i}`).toBeCloseTo(answer[i]!, 6);
      }
    }
  });
});
