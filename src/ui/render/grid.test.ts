import { describe, expect, it } from 'vitest';
import { chooseGridSpacing, gridLines, snapToGrid } from './grid';

describe('chooseGridSpacing', () => {
  it('keeps the preferred spacing when there is room for it', () => {
    expect(chooseGridSpacing(10, 1)).toBe(10);
    expect(chooseGridSpacing(10, 4)).toBe(10);
  });

  it('steps up through 1-2-5 as you zoom out', () => {
    // At these scales a 10px grid would be 7px, 3.5px and 0.7px on screen.
    expect(chooseGridSpacing(10, 0.5)).toBe(20);
    expect(chooseGridSpacing(10, 0.2)).toBe(50);
    expect(chooseGridSpacing(10, 0.05)).toBe(200);
  });

  it('never returns a spacing below the preferred one', () => {
    for (const scale of [0.01, 0.1, 1, 10, 100]) {
      expect(chooseGridSpacing(10, scale), `scale ${scale}`).toBeGreaterThanOrEqual(10);
    }
  });

  it('only returns round numbers', () => {
    for (const scale of [0.003, 0.02, 0.09, 0.3, 1, 7, 60]) {
      const spacing = chooseGridSpacing(10, scale);
      const mantissa = spacing / 10 ** Math.floor(Math.log10(spacing));
      expect([1, 2, 5]).toContain(Math.round(mantissa));
    }
  });

  it('survives nonsense input rather than looping', () => {
    expect(chooseGridSpacing(0, 1)).toBe(0);
    expect(chooseGridSpacing(10, 0)).toBe(10);
    expect(chooseGridSpacing(-5, 1)).toBe(-5);
  });
});

describe('snapToGrid', () => {
  it('rounds to the nearest intersection', () => {
    expect(snapToGrid({ x: 12, y: -17 }, 10)).toEqual({ x: 10, y: -20 });
    expect(snapToGrid({ x: 15, y: 25 }, 10)).toEqual({ x: 20, y: 30 });
  });

  it('leaves a point that is already on the grid', () => {
    expect(snapToGrid({ x: 40, y: -60 }, 20)).toEqual({ x: 40, y: -60 });
  });

  it('does nothing without a usable spacing', () => {
    const point = { x: 3, y: 4 };
    expect(snapToGrid(point, 0)).toBe(point);
    expect(snapToGrid(point, -1)).toBe(point);
  });
});

describe('gridLines', () => {
  const size = { width: 200, height: 100 };
  const viewport = { panX: 0, panY: 0, scale: 1 };

  it('covers the visible area', () => {
    const lines = gridLines(viewport, { spacing: 50, size });
    const xs = lines.filter((line) => line.axis === 'x').map((line) => line.at);
    const ys = lines.filter((line) => line.axis === 'y').map((line) => line.at);

    expect(xs).toEqual([0, 50, 100, 150, 200]);
    expect(ys).toEqual([0, 50, 100]);
  });

  it('follows the pan', () => {
    const lines = gridLines({ panX: 120, panY: 0, scale: 1 }, { spacing: 50, size });
    expect(lines.filter((line) => line.axis === 'x').map((line) => line.at)).toEqual([150, 200, 250, 300]);
  });

  it('marks the origin lines, which anchor the sketch', () => {
    const origins = gridLines(viewport, { spacing: 50, size }).filter((line) => line.kind === 'origin');
    expect(origins).toHaveLength(2);
    expect(origins.every((line) => line.at === 0)).toBe(true);
  });

  it('marks every tenth line as major', () => {
    const lines = gridLines({ panX: 0, panY: 0, scale: 1 }, { spacing: 10, size: { width: 300, height: 10 } });
    const majors = lines.filter((line) => line.axis === 'x' && line.kind === 'major').map((line) => line.at);
    expect(majors).toEqual([100, 200, 300]);
  });

  it('keeps lines a usable distance apart at any zoom, which bounds the count', () => {
    // The real invariant: adjacent lines are never closer together on screen
    // than the minimum, so the count can only grow with the canvas, not with
    // how far out you zoom. A fixed 10px grid at 1% zoom would be 10,000
    // lines per axis.
    const canvas = { width: 1000, height: 1000 };

    for (const scale of [0.001, 0.01, 0.1, 1, 10, 100]) {
      const lines = gridLines({ panX: 0, panY: 0, scale }, { spacing: 10, size: canvas });
      const xs = lines.filter((line) => line.axis === 'x').map((line) => line.at);
      expect(xs.length, `scale ${scale}`).toBeGreaterThan(1);

      const screenGap = (xs[1]! - xs[0]!) * scale;
      expect(screenGap, `scale ${scale}`).toBeGreaterThanOrEqual(7);
      // One line per gap across the canvas, give or take the edges.
      expect(xs.length, `scale ${scale}`).toBeLessThanOrEqual(canvas.width / 7 + 2);
    }
  });

  it('returns nothing for an unusable spacing', () => {
    expect(gridLines(viewport, { spacing: 0, size })).toEqual([]);
  });

  it('coarsens on a wide canvas instead of dropping an axis', () => {
    // An ultrawide monitor zoomed out: the line cap used to be enforced by
    // skipping the axis that exceeded it, so the horizontal axis fitted and
    // the vertical one vanished — a grid of parallel lines with nothing
    // crossing them.
    const lines = gridLines(
      { panX: 0, panY: 0, scale: 0.8 },
      { spacing: 10, size: { width: 3440, height: 1440 } },
    );
    const xs = lines.filter((line) => line.axis === 'x');
    const ys = lines.filter((line) => line.axis === 'y');

    expect(xs.length).toBeGreaterThan(0);
    expect(ys.length).toBeGreaterThan(0);
    // Both axes stay inside the cap, and the squares stay square.
    expect(xs.length).toBeLessThanOrEqual(400);
    expect(ys.length).toBeLessThanOrEqual(400);
    expect(xs[1]!.at - xs[0]!.at).toBeCloseTo(ys[1]!.at - ys[0]!.at, 10);
  });

  it('keeps the coarsened spacing a round number', () => {
    const lines = gridLines(
      { panX: 0, panY: 0, scale: 0.8 },
      { spacing: 10, size: { width: 3440, height: 1440 } },
    );
    const xs = lines.filter((line) => line.axis === 'x');
    const step = xs[1]!.at - xs[0]!.at;
    // Every rung of the ladder is 1, 2 or 5 times a power of ten.
    const mantissa = step / 10 ** Math.floor(Math.log10(step));
    expect([1, 2, 5]).toContain(Math.round(mantissa));
  });

  it('gives up rather than drawing an absurd number of lines', () => {
    // A tiny spacing that the ladder is told to respect: bail, do not hang.
    const lines = gridLines({ panX: 0, panY: 0, scale: 1e6 }, { spacing: 1e-9, size: { width: 4000, height: 4000 } });
    expect(lines.length).toBeLessThanOrEqual(800);
  });
});
