/**
 * The small dense linear algebra the solver runs on.
 *
 * Everything here is built on one rank-revealing decomposition: Householder QR
 * with column pivoting. That single tool answers all three questions Step 3b
 * asks of it:
 *
 *   rank(J)       -> DOF = (#variables) - rank, and whether a sketch is
 *                    fully, under or over defined
 *   nullspace(J)  -> which variables can still move, so the UI can colour an
 *                    individual line blue or black
 *   least squares -> the Gauss-Newton / Levenberg-Marquardt step
 *
 * Dense is the right call at sketch scale (the plan says so); clustering is the
 * later optimisation. Unlike documents, matrices here are mutable number
 * buffers — they are scratch space, never part of a snapshot.
 */

/** Dense matrix, row-major. */
export interface Matrix {
  readonly rows: number;
  readonly cols: number;
  readonly data: Float64Array;
}

export function createMatrix(rows: number, cols: number): Matrix {
  return { rows, cols, data: new Float64Array(rows * cols) };
}

export function matrixFromRows(rows: readonly (readonly number[])[]): Matrix {
  const rowCount = rows.length;
  const colCount = rows[0]?.length ?? 0;
  for (const row of rows) {
    if (row.length !== colCount) throw new Error('matrixFromRows: rows have differing lengths');
  }
  const matrix = createMatrix(rowCount, colCount);
  for (let i = 0; i < rowCount; i += 1) {
    for (let j = 0; j < colCount; j += 1) matrix.data[i * colCount + j] = rows[i]![j]!;
  }
  return matrix;
}

export function at(matrix: Matrix, row: number, col: number): number {
  return matrix.data[row * matrix.cols + col]!;
}

export function setAt(matrix: Matrix, row: number, col: number, value: number): void {
  matrix.data[row * matrix.cols + col] = value;
}

export function toRows(matrix: Matrix): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < matrix.rows; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < matrix.cols; j += 1) row.push(at(matrix, i, j));
    rows.push(row);
  }
  return rows;
}

/** Aᵀ. Needed to ask questions about a matrix's *rows* via its columns. */
export function transpose(matrix: Matrix): Matrix {
  const result = createMatrix(matrix.cols, matrix.rows);
  for (let i = 0; i < matrix.rows; i += 1) {
    for (let j = 0; j < matrix.cols; j += 1) setAt(result, j, i, at(matrix, i, j));
  }
  return result;
}

/**
 * How many rows carry any gradient at all.
 *
 * A row of zeros is a constraint that, at this configuration, says nothing —
 * degenerate geometry produces them deliberately. Counting it as a constraint
 * when comparing against the rank would report the sketch over defined for no
 * reason the user can act on.
 */
export function nonZeroRows(matrix: Matrix, tolerance = 0): number {
  let count = 0;
  for (let i = 0; i < matrix.rows; i += 1) {
    for (let j = 0; j < matrix.cols; j += 1) {
      if (Math.abs(at(matrix, i, j)) > tolerance) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

/** A·v. Throws if the shapes disagree, which is always a programming error. */
export function multiplyVector(matrix: Matrix, vector: readonly number[]): number[] {
  if (vector.length !== matrix.cols) {
    throw new Error(`multiplyVector: matrix has ${matrix.cols} columns, vector has ${vector.length}`);
  }
  const result = new Array<number>(matrix.rows).fill(0);
  for (let i = 0; i < matrix.rows; i += 1) {
    let sum = 0;
    for (let j = 0; j < matrix.cols; j += 1) sum += at(matrix, i, j) * vector[j]!;
    result[i] = sum;
  }
  return result;
}

export interface QrDecomposition {
  /** Upper trapezoidal R, same shape as the input. */
  readonly r: Matrix;
  /**
   * Column permutation: column k of R corresponds to column `pivots[k]` of the
   * original matrix. Pivoting is what makes the decomposition rank-revealing.
   */
  readonly pivots: readonly number[];
  readonly rank: number;
  /** The tolerance below which a diagonal entry counted as zero. */
  readonly tolerance: number;
  /** Householder vectors, one per elimination step. */
  readonly reflectors: readonly Float64Array[];
  readonly betas: readonly number[];
}

/**
 * Householder QR with column pivoting.
 *
 * Column norms are recomputed from scratch at each step rather than downdated.
 * Downdating is the usual optimisation but loses accuracy as it goes, and at
 * sketch scale the full recompute costs the same order as the factorisation
 * itself. Accuracy matters more here: rank is what decides whether the UI
 * calls a sketch fully defined.
 *
 * `tolerance` defaults to a relative one scaled by the largest diagonal entry,
 * which is what makes rank meaningful for matrices in px-sized units.
 */
export function decomposeQr(input: Matrix, tolerance?: number): QrDecomposition {
  const { rows, cols } = input;
  const r: Matrix = { rows, cols, data: Float64Array.from(input.data) };
  const pivots = Array.from({ length: cols }, (_, j) => j);
  const reflectors: Float64Array[] = [];
  const betas: number[] = [];
  const steps = Math.min(rows, cols);

  for (let k = 0; k < steps; k += 1) {
    // Pivot on the column with the largest remaining norm.
    let best = k;
    let bestNorm = -1;
    for (let j = k; j < cols; j += 1) {
      let norm = 0;
      for (let i = k; i < rows; i += 1) norm += at(r, i, j) ** 2;
      if (norm > bestNorm) {
        bestNorm = norm;
        best = j;
      }
    }
    if (bestNorm <= 0) break; // everything left is zero; R is already trapezoidal
    if (best !== k) swapColumns(r, k, best, pivots);

    // Householder reflector zeroing column k below the diagonal.
    const length = rows - k;
    const v = new Float64Array(length);
    for (let i = 0; i < length; i += 1) v[i] = at(r, k + i, k);

    let norm = 0;
    for (let i = 0; i < length; i += 1) norm += v[i]! ** 2;
    norm = Math.sqrt(norm);
    if (norm === 0) {
      reflectors.push(v);
      betas.push(0);
      continue;
    }

    // Choosing the sign away from v[0] avoids cancellation.
    const alpha = v[0]! >= 0 ? -norm : norm;
    v[0] = v[0]! - alpha;

    let vv = 0;
    for (let i = 0; i < length; i += 1) vv += v[i]! ** 2;
    const beta = vv === 0 ? 0 : 2 / vv;

    if (beta !== 0) {
      for (let j = k; j < cols; j += 1) {
        let dot = 0;
        for (let i = 0; i < length; i += 1) dot += v[i]! * at(r, k + i, j);
        const factor = beta * dot;
        for (let i = 0; i < length; i += 1) setAt(r, k + i, j, at(r, k + i, j) - factor * v[i]!);
      }
    }

    // Make the zeros exact rather than leaving rounding dust below the diagonal.
    setAt(r, k, k, alpha);
    for (let i = k + 1; i < rows; i += 1) setAt(r, i, k, 0);

    reflectors.push(v);
    betas.push(beta);
  }

  // Pivoting makes |R[k][k]| non-increasing, so rank is where it falls below
  // the tolerance.
  const largest = steps > 0 ? Math.abs(at(r, 0, 0)) : 0;
  const tol = tolerance ?? Math.max(rows, cols) * Number.EPSILON * largest;
  let rank = 0;
  while (rank < steps && Math.abs(at(r, rank, rank)) > tol) rank += 1;

  return { r, pivots, rank, tolerance: tol, reflectors, betas };
}

/** Number of independent rows, i.e. independent constraints. */
export function rank(matrix: Matrix, tolerance?: number): number {
  return decomposeQr(matrix, tolerance).rank;
}

/**
 * A basis for `{ x : A x = 0 }`, as unit vectors of length `A.cols`.
 *
 * For a Jacobian this is the set of directions the sketch can still move in:
 * empty means fully defined, and one vector per remaining degree of freedom.
 */
export function nullspace(matrix: Matrix, tolerance?: number): number[][] {
  const decomposition = decomposeQr(matrix, tolerance);
  return nullspaceOf(decomposition, matrix.cols);
}

function nullspaceOf(decomposition: QrDecomposition, cols: number): number[][] {
  const { r, pivots, rank: rk } = decomposition;
  const basis: number[][] = [];

  // One basis vector per free column: set that column to 1, then back-solve
  // the leading triangular block for the rest.
  for (let free = rk; free < cols; free += 1) {
    const permuted = new Array<number>(cols).fill(0);
    permuted[free] = 1;
    for (let i = rk - 1; i >= 0; i -= 1) {
      let sum = -at(r, i, free);
      for (let j = i + 1; j < rk; j += 1) sum -= at(r, i, j) * permuted[j]!;
      permuted[i] = sum / at(r, i, i);
    }

    // Undo the column pivoting, then normalise.
    const vector = new Array<number>(cols).fill(0);
    for (let i = 0; i < cols; i += 1) vector[pivots[i]!] = permuted[i]!;
    const norm = Math.hypot(...vector);
    basis.push(norm === 0 ? vector : vector.map((value) => value / norm));
  }

  return basis;
}

export interface LeastSquaresResult {
  /** Minimises ‖A x − b‖. Free variables are left at zero when rank deficient. */
  readonly solution: number[];
  readonly rank: number;
}

/**
 * Least-squares solve of A x = b, which is the Gauss-Newton step.
 *
 * When A is rank deficient this returns a *basic* solution (free variables set
 * to zero) rather than the minimum-norm one. Levenberg-Marquardt damping makes
 * the stacked system full rank anyway, so the distinction never bites in 3b —
 * but the returned `rank` says when it applies.
 */
export function solveLeastSquares(matrix: Matrix, b: readonly number[], tolerance?: number): LeastSquaresResult {
  if (b.length !== matrix.rows) {
    throw new Error(`solveLeastSquares: matrix has ${matrix.rows} rows, b has ${b.length}`);
  }
  const decomposition = decomposeQr(matrix, tolerance);
  const { r, pivots, rank: rk, reflectors, betas } = decomposition;

  // Qᵀb, by applying the reflectors in turn rather than ever forming Q.
  const qtb = Array.from(b);
  for (let k = 0; k < reflectors.length; k += 1) {
    const v = reflectors[k]!;
    const beta = betas[k]!;
    if (beta === 0) continue;
    let dot = 0;
    for (let i = 0; i < v.length; i += 1) dot += v[i]! * qtb[k + i]!;
    const factor = beta * dot;
    for (let i = 0; i < v.length; i += 1) qtb[k + i] = qtb[k + i]! - factor * v[i]!;
  }

  const permuted = new Array<number>(matrix.cols).fill(0);
  for (let i = rk - 1; i >= 0; i -= 1) {
    let sum = qtb[i]!;
    for (let j = i + 1; j < rk; j += 1) sum -= at(r, i, j) * permuted[j]!;
    permuted[i] = sum / at(r, i, i);
  }

  const solution = new Array<number>(matrix.cols).fill(0);
  for (let i = 0; i < matrix.cols; i += 1) solution[pivots[i]!] = permuted[i]!;

  return { solution, rank: rk };
}

function swapColumns(matrix: Matrix, a: number, b: number, pivots: number[]): void {
  for (let i = 0; i < matrix.rows; i += 1) {
    const temp = at(matrix, i, a);
    setAt(matrix, i, a, at(matrix, i, b));
    setAt(matrix, i, b, temp);
  }
  const temp = pivots[a]!;
  pivots[a] = pivots[b]!;
  pivots[b] = temp;
}
