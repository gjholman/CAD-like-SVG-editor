/**
 * The drawing grid.
 *
 * Spacing adapts to the zoom: a fixed 10px grid turns into a grey wash when
 * you zoom out and disappears entirely when you zoom in, so the spacing steps
 * through a 1-2-5 ladder to keep the lines a usable distance apart on screen
 * whatever the scale. Every spacing on that ladder is a round number, so the
 * numbers under the cursor stay readable.
 *
 * Lines are emitted in world coordinates inside the view transform, with
 * non-scaling strokes, so a grid line is always one screen pixel.
 */
import type { Point2, Size, Viewport } from './viewport';

/** Below this screen distance apart, grid lines stop being useful. */
const MIN_SCREEN_SPACING = 7;
/** Major lines every tenth minor one, as in the mockup. */
const MAJOR_EVERY = 10;
/** Hard cap on lines per axis, so a pathological viewport cannot stall a frame. */
const MAX_LINES = 400;

export interface GridOptions {
  /** Preferred minor spacing in world px, before the ladder adjusts it. */
  readonly spacing: number;
  /** Canvas size in screen px, which decides how much grid to draw. */
  readonly size: Size;
}

/**
 * The spacing actually drawn: the smallest 1-2-5 step at or above the
 * preferred one that keeps lines far enough apart on screen.
 */
export function chooseGridSpacing(preferred: number, scale: number): number {
  if (!(preferred > 0) || !(scale > 0)) return preferred;

  // Start from the decade below and walk up until the screen gap is enough.
  const decade = 10 ** Math.floor(Math.log10(preferred));
  const steps = [1, 2, 5];
  let spacing = decade;

  for (let power = 0; power < 12; power += 1) {
    for (const step of steps) {
      const candidate = decade * 10 ** power * step;
      if (candidate < preferred) continue;
      if (candidate * scale >= MIN_SCREEN_SPACING) return candidate;
      spacing = candidate;
    }
  }
  return spacing;
}

/** The next 1-2-5 step strictly above `spacing`. */
function ladderStepAbove(spacing: number): number {
  const decade = 10 ** Math.floor(Math.log10(spacing) + 1e-12);
  for (const step of [1, 2, 5, 10]) {
    const candidate = decade * step;
    if (candidate > spacing * (1 + 1e-9)) return candidate;
  }
  return spacing * 10;
}

/**
 * Spacing coarse enough that neither axis exceeds the line cap.
 *
 * The cap used to be enforced by skipping the offending axis, which on a wide
 * monitor zoomed out meant one axis fitted and the other did not: the grid
 * became a set of parallel lines with nothing crossing them. Dropping half
 * the grid is a worse answer than drawing a coarser one, and stepping up the
 * ladder keeps the spacing a round number and the squares square.
 */
function coarsenToFit(spacing: number, widestSpan: number): number {
  let coarse = spacing;
  // Each step is at least 2x, so this terminates long before the guard.
  for (let step = 0; step < 40; step += 1) {
    if (widestSpan / coarse + 1 <= MAX_LINES) break;
    coarse = ladderStepAbove(coarse);
  }
  return coarse;
}

/** Rounds a point to the nearest grid intersection. */
export function snapToGrid(point: Point2, spacing: number): Point2 {
  if (!(spacing > 0)) return point;
  return {
    x: Math.round(point.x / spacing) * spacing,
    y: Math.round(point.y / spacing) * spacing,
  };
}

export interface GridLine {
  readonly axis: 'x' | 'y';
  /** World coordinate of the line along its axis. */
  readonly at: number;
  readonly kind: 'minor' | 'major' | 'origin';
}

/**
 * The lines covering the visible area.
 *
 * The two lines through the origin are called out separately: a sketch is
 * anchored to its origin, so seeing where it is matters more than seeing one
 * more grid square.
 */
export function gridLines(viewport: Viewport, options: GridOptions): GridLine[] {
  const chosen = chooseGridSpacing(options.spacing, viewport.scale);
  if (!(chosen > 0)) return [];

  const left = viewport.panX;
  const top = viewport.panY;
  const right = left + options.size.width / viewport.scale;
  const bottom = top + options.size.height / viewport.scale;

  const minor = coarsenToFit(chosen, Math.max(right - left, bottom - top));
  const major = minor * MAJOR_EVERY;

  const lines: GridLine[] = [];
  for (const [axis, from, to] of [
    ['x', left, right],
    ['y', top, bottom],
  ] as const) {
    const first = Math.ceil(from / minor) * minor;
    const count = Math.floor((to - first) / minor) + 1;
    // The spacing above already fits the cap; a negative count only means the
    // axis has no visible extent at all.
    if (count < 0) continue;

    for (let i = 0; i < count; i += 1) {
      // Multiply rather than accumulate, so 0 lands exactly on 0.
      const at = first + i * minor;
      const kind = at === 0 ? 'origin' : isMultiple(at, major) ? 'major' : 'minor';
      lines.push({ axis, at, kind });
    }
  }

  return lines;
}

/** Tolerant multiple test, since the ladder can land on values like 0.2. */
function isMultiple(value: number, of: number): boolean {
  const remainder = Math.abs(value) % of;
  return remainder < of * 1e-9 || of - remainder < of * 1e-9;
}
