import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import {
  IDENTITY_VIEWPORT,
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  fitTo,
  panBy,
  screenToWorld,
  sketchBounds,
  viewTransform,
  worldToScreen,
  zoomAt,
  type Viewport,
} from './viewport';

const viewport: Viewport = { panX: 100, panY: 50, scale: 2 };

describe('worldToScreen and screenToWorld', () => {
  it('put the pan origin at the top-left corner', () => {
    expect(worldToScreen(viewport, { x: 100, y: 50 })).toEqual({ x: 0, y: 0 });
  });

  it('scale distances', () => {
    expect(worldToScreen(viewport, { x: 110, y: 60 })).toEqual({ x: 20, y: 20 });
  });

  it('round-trip', () => {
    for (const point of [{ x: 0, y: 0 }, { x: -37.5, y: 912.25 }, { x: 1e5, y: -1e5 }]) {
      const back = screenToWorld(viewport, worldToScreen(viewport, point));
      expect(back.x).toBeCloseTo(point.x, 9);
      expect(back.y).toBeCloseTo(point.y, 9);
    }
  });

  it('are the identity at the identity viewport', () => {
    expect(worldToScreen(IDENTITY_VIEWPORT, { x: 7, y: 9 })).toEqual({ x: 7, y: 9 });
  });
});

describe('panBy', () => {
  it('moves the content with the cursor', () => {
    // Dragging right by 20 screen px should bring content 20 px further right,
    // which means the world coordinate at the left edge decreases.
    const panned = panBy(viewport, 20, 0);
    expect(panned.panX).toBe(90);
    expect(worldToScreen(panned, { x: 100, y: 50 })).toEqual({ x: 20, y: 0 });
  });

  it('leaves the zoom alone', () => {
    expect(panBy(viewport, 13, -4).scale).toBe(2);
  });
});

describe('zoomAt', () => {
  it('keeps whatever is under the cursor exactly where it is', () => {
    const cursor = { x: 300, y: 180 };
    const before = screenToWorld(viewport, cursor);

    for (const factor of [1.1, 0.5, 4, 0.9]) {
      const zoomed = zoomAt(viewport, cursor, factor);
      const after = screenToWorld(zoomed, cursor);
      expect(after.x, `factor ${factor}`).toBeCloseTo(before.x, 9);
      expect(after.y, `factor ${factor}`).toBeCloseTo(before.y, 9);
    }
  });

  it('actually changes the scale', () => {
    expect(zoomAt(viewport, { x: 0, y: 0 }, 2).scale).toBe(4);
  });

  it('clamps at the limits and then stops changing', () => {
    const tiny = zoomAt({ panX: 0, panY: 0, scale: MIN_SCALE }, { x: 10, y: 10 }, 0.5);
    expect(tiny.scale).toBe(MIN_SCALE);

    const huge = zoomAt({ panX: 0, panY: 0, scale: MAX_SCALE }, { x: 10, y: 10 }, 2);
    expect(huge.scale).toBe(MAX_SCALE);
  });

  it('returns the same viewport when clamping leaves the scale unchanged', () => {
    const at = { panX: 0, panY: 0, scale: MAX_SCALE };
    expect(zoomAt(at, { x: 5, y: 5 }, 2)).toBe(at);
  });
});

describe('clampScale', () => {
  it.each([
    [0.0001, MIN_SCALE],
    [1, 1],
    [1e9, MAX_SCALE],
  ])('clamps %s to %s', (input, expected) => {
    expect(clampScale(input)).toBe(expected);
  });
});

describe('fitTo', () => {
  const bounds = { minX: 0, minY: 0, maxX: 480, maxY: 240 };

  it('fits the content inside the canvas with a margin', () => {
    const fitted = fitTo(bounds, { width: 1000, height: 600 }, 24);
    const topLeft = worldToScreen(fitted, { x: bounds.minX, y: bounds.minY });
    const bottomRight = worldToScreen(fitted, { x: bounds.maxX, y: bounds.maxY });

    expect(topLeft.x).toBeGreaterThanOrEqual(24 - 1e-6);
    expect(topLeft.y).toBeGreaterThanOrEqual(24 - 1e-6);
    expect(bottomRight.x).toBeLessThanOrEqual(1000 - 24 + 1e-6);
    expect(bottomRight.y).toBeLessThanOrEqual(600 - 24 + 1e-6);
  });

  it('centres the content', () => {
    const size = { width: 1000, height: 600 };
    const fitted = fitTo(bounds, size, 24);
    const topLeft = worldToScreen(fitted, { x: bounds.minX, y: bounds.minY });
    const bottomRight = worldToScreen(fitted, { x: bounds.maxX, y: bounds.maxY });

    expect(topLeft.x).toBeCloseTo(size.width - bottomRight.x, 6);
    expect(topLeft.y).toBeCloseTo(size.height - bottomRight.y, 6);
  });

  it('is limited by the tighter of the two axes', () => {
    // A wide canvas and a tall shape: height decides the zoom.
    const tall = { minX: 0, minY: 0, maxX: 10, maxY: 1000 };
    const fitted = fitTo(tall, { width: 1000, height: 200 }, 0);
    expect(fitted.scale).toBeCloseTo(0.2, 9);
  });

  it('survives degenerate bounds', () => {
    const dot = { minX: 5, minY: 5, maxX: 5, maxY: 5 };
    const fitted = fitTo(dot, { width: 800, height: 600 });
    expect(Number.isFinite(fitted.panX)).toBe(true);
    expect(fitted.scale).toBe(MAX_SCALE);
  });
});

describe('viewTransform', () => {
  it('matches worldToScreen', () => {
    expect(viewTransform({ panX: 100, panY: 50, scale: 2 })).toBe('translate(-200 -100) scale(2)');
  });

  it('is a bare scale when there is no pan', () => {
    expect(viewTransform({ panX: 0, panY: 0, scale: 1.5 })).toBe('translate(0 0) scale(1.5)');
  });
});

describe('sketchBounds', () => {
  it('covers every corner of the rectangle', () => {
    const { doc } = rectangleFixture(480, 240);
    expect(sketchBounds(doc)).toEqual({ minX: 0, minY: 0, maxX: 480, maxY: 240 });
  });

  it('includes a circle\'s whole disc, not just its centre', () => {
    const doc = {
      ...rectangleFixture().doc,
      points: { c: { id: 'c', x: 100, y: 100 } },
      entities: {
        circle1: { id: 'circle1', kind: 'circle' as const, center: 'c', radius: 30, layer: 'layer1', construction: false },
      },
      paths: {},
    };
    expect(sketchBounds(doc)).toEqual({ minX: 70, minY: 70, maxX: 130, maxY: 130 });
  });

  it('prefers solved positions when given them', () => {
    const { doc, corners } = rectangleFixture(480, 240);
    const moved = { ...doc.points, [corners[1]]: { id: corners[1], x: 900, y: 0 } };
    expect(sketchBounds(doc, moved)!.maxX).toBe(900);
  });

  it('is undefined for an empty document', () => {
    const { doc } = rectangleFixture();
    expect(sketchBounds({ ...doc, points: {}, entities: {}, paths: {} })).toBeUndefined();
  });
});
