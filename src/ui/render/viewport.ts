/**
 * Pan and zoom, as pure arithmetic. No DOM, so it tests in plain Node.
 *
 * The viewport maps world coordinates (the document's px, y-down) to screen
 * px:
 *
 *   screen = (world - pan) * scale
 *
 * Viewport state is deliberately *not* part of the document or of history:
 * panning is not an undoable edit (a plan decision).
 */
import type { SketchDocument } from '../../core/model';

export interface Viewport {
  /** World coordinate shown at the top-left of the canvas. */
  readonly panX: number;
  readonly panY: number;
  /** Screen px per world px. Larger is zoomed in. */
  readonly scale: number;
}

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export const IDENTITY_VIEWPORT: Viewport = { panX: 0, panY: 0, scale: 1 };

/** Zoom is clamped so a stray wheel gesture cannot lose the drawing. */
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 256;

export function worldToScreen(viewport: Viewport, point: Point2): Point2 {
  return {
    x: (point.x - viewport.panX) * viewport.scale,
    y: (point.y - viewport.panY) * viewport.scale,
  };
}

export function screenToWorld(viewport: Viewport, point: Point2): Point2 {
  return {
    x: point.x / viewport.scale + viewport.panX,
    y: point.y / viewport.scale + viewport.panY,
  };
}

/** Drag the canvas by a screen-space delta. */
export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return {
    ...viewport,
    panX: viewport.panX - dx / viewport.scale,
    panY: viewport.panY - dy / viewport.scale,
  };
}

/**
 * Zoom about a screen point, keeping whatever is under it exactly where it is.
 * That anchoring is what makes wheel-zoom feel right.
 */
export function zoomAt(viewport: Viewport, screen: Point2, factor: number): Viewport {
  const scale = clampScale(viewport.scale * factor);
  if (scale === viewport.scale) return viewport;

  const anchor = screenToWorld(viewport, screen);
  return {
    scale,
    panX: anchor.x - screen.x / scale,
    panY: anchor.y - screen.y / scale,
  };
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** A viewport showing `bounds` centred in `size`, with a margin in screen px. */
export function fitTo(bounds: Bounds, size: Size, padding = 24): Viewport {
  const width = Math.max(bounds.maxX - bounds.minX, Number.EPSILON);
  const height = Math.max(bounds.maxY - bounds.minY, Number.EPSILON);
  const usableWidth = Math.max(size.width - padding * 2, 1);
  const usableHeight = Math.max(size.height - padding * 2, 1);

  const scale = clampScale(Math.min(usableWidth / width, usableHeight / height));
  // Centre the content: split the leftover screen space evenly.
  const panX = bounds.minX - (size.width / scale - width) / 2;
  const panY = bounds.minY - (size.height / scale - height) / 2;

  return { panX, panY, scale };
}

/** The SVG transform that puts world coordinates on screen. */
export function viewTransform(viewport: Viewport): string {
  const { panX, panY, scale } = viewport;
  return `translate(${-panX * scale} ${-panY * scale}) scale(${scale})`;
}

/**
 * Extent of the drawing, from solved positions when there are any. Circles
 * count their whole disc, not just the centre, so `fitTo` does not clip them.
 */
export function sketchBounds(
  doc: SketchDocument,
  positions: Readonly<Record<string, Point2>> = doc.points,
  radii: Readonly<Record<string, number>> = {},
): Bounds | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;

  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    seen = true;
  };

  for (const id of Object.keys(doc.points)) {
    const point = positions[id] ?? doc.points[id]!;
    include(point.x, point.y);
  }

  for (const entity of Object.values(doc.entities)) {
    if (entity.kind !== 'circle') continue;
    const centre = positions[entity.center] ?? doc.points[entity.center];
    if (centre === undefined) continue;
    const radius = radii[entity.id] ?? entity.radius;
    include(centre.x - radius, centre.y - radius);
    include(centre.x + radius, centre.y + radius);
  }

  return seen ? { minX, minY, maxX, maxY } : undefined;
}
