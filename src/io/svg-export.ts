/**
 * SVG export: the output domain becoming an actual file.
 *
 * This is what the plan's option B was for. Path records hold the structure —
 * which entities form which path, in what order and direction, which subpaths
 * are closed, the fill rule and the style bag — so export is a straight walk
 * rather than a guess at connectivity.
 *
 * Built as strings rather than through the DOM, so it runs anywhere and needs
 * no jsdom to test. The tests still parse the result with a real parser, since
 * producing a string that only looks like SVG would be the easy mistake.
 *
 * What the plan decides and this follows: px only, y-down, construction
 * geometry omitted, layers as `<g>`, a one-member circle path exported as
 * `<circle>`, and export tolerating gaps where geometry has been pulled apart.
 */
import { sketchBounds, type Bounds, type Point2 } from '../ui/render/viewport';
import type { Entity, Id, PathRecord, SketchDocument, StyleBag } from '../core/model';

const SVG_NS = 'http://www.w3.org/2000/svg';
const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
const SODIPODI_NS = 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd';

/** Endpoints closer than this are the same point, so the path keeps running. */
const JOIN_TOLERANCE = 1e-6;

export interface ExportOptions {
  /** Solved positions, when they differ from the document's stored ones. */
  readonly positions?: Readonly<Record<Id, Point2>>;
  readonly radii?: Readonly<Record<Id, number>>;
  /** Blank space around the drawing, in px. */
  readonly margin?: number;
  /**
   * Write Inkscape's layer attributes so `<g>` groups open as layers there.
   * Harmless everywhere else; it is only extra namespaced attributes.
   */
  readonly inkscapeLayers?: boolean;
  /** Fallback style for geometry whose path carries none. */
  readonly defaultStyle?: StyleBag;
}

const DEFAULT_STYLE: StyleBag = { fill: 'none', stroke: '#1b1b1f', 'stroke-width': '1' };

export function toSvg(doc: SketchDocument, options: ExportOptions = {}): string {
  const positions = options.positions ?? doc.points;
  const radii = options.radii ?? {};
  const margin = options.margin ?? 0;
  const style = options.defaultStyle ?? DEFAULT_STYLE;

  const box = viewBox(doc, positions, radii, margin);
  const claimed = claimedEntities(doc);

  const body: string[] = [];
  for (const layerId of doc.layerOrder) {
    const layer = doc.layers[layerId];
    if (layer === undefined) continue;

    const children: string[] = [];
    for (const id of Object.keys(doc.paths).sort()) {
      const path = doc.paths[id]!;
      if (path.layer !== layerId) continue;
      const element = pathElement(path, doc, positions, radii, style);
      if (element !== undefined) children.push(element);
    }

    // Geometry in no path still has to come out, or drawing a loose line and
    // exporting would silently lose it.
    for (const id of Object.keys(doc.entities).sort()) {
      const entity = doc.entities[id]!;
      if (entity.layer !== layerId || entity.construction || claimed.has(id)) continue;
      const element = looseElement(entity, positions, radii, style);
      if (element !== undefined) children.push(element);
    }

    if (children.length === 0) continue;
    body.push(layerGroup(layerId, layer.name, layer.visible, children, options.inkscapeLayers === true));
  }

  const attributes: Record<string, string> = {
    xmlns: SVG_NS,
    width: number(box.maxX - box.minX),
    height: number(box.maxY - box.minY),
    viewBox: `${number(box.minX)} ${number(box.minY)} ${number(box.maxX - box.minX)} ${number(box.maxY - box.minY)}`,
  };
  if (options.inkscapeLayers === true) {
    attributes['xmlns:inkscape'] = INKSCAPE_NS;
    attributes['xmlns:sodipodi'] = SODIPODI_NS;
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg ${formatAttributes(attributes)}>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

function viewBox(
  doc: SketchDocument,
  positions: Readonly<Record<Id, Point2>>,
  radii: Readonly<Record<Id, number>>,
  margin: number,
): Bounds {
  const bounds = sketchBounds(doc, positions, radii);
  // An empty sketch still has to produce a valid, non-zero-sized document.
  if (bounds === undefined) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return {
    minX: bounds.minX - margin,
    minY: bounds.minY - margin,
    maxX: Math.max(bounds.maxX + margin, bounds.minX - margin + 1e-9),
    maxY: Math.max(bounds.maxY + margin, bounds.minY - margin + 1e-9),
  };
}

function layerGroup(
  id: Id,
  name: string,
  visible: boolean,
  children: readonly string[],
  inkscape: boolean,
): string {
  const attributes: Record<string, string> = { id };
  if (inkscape) {
    attributes['inkscape:groupmode'] = 'layer';
    attributes['inkscape:label'] = name;
  } else {
    attributes['data-name'] = name;
  }
  // A hidden layer is exported hidden rather than dropped, so nothing is lost.
  if (!visible) attributes['style'] = 'display:none';

  return [`  <g ${formatAttributes(attributes)}>`, ...children.map((child) => `    ${child}`), '  </g>'].join('\n');
}

/**
 * One path record as an element. A path that is a single circle comes out as
 * `<circle>`, which is what the plan asks for and what a person opening the
 * file would expect to see.
 */
function pathElement(
  path: PathRecord,
  doc: SketchDocument,
  positions: Readonly<Record<Id, Point2>>,
  radii: Readonly<Record<Id, number>>,
  fallback: StyleBag,
): string | undefined {
  const style = { ...fallback, ...path.style };

  const only = path.subpaths.length === 1 && path.subpaths[0]!.members.length === 1
    ? doc.entities[path.subpaths[0]!.members[0]!.entity]
    : undefined;
  if (only?.kind === 'circle') {
    return circleElement(only, positions, radii, style, path.id);
  }

  const d = pathData(path, doc, positions, radii);
  if (d === '') return undefined;

  const attributes: Record<string, string> = { id: path.id, d };
  // nonzero is the SVG default, so only say so when it differs.
  if (path.fillRule === 'evenodd') attributes['fill-rule'] = 'evenodd';
  return `<path ${formatAttributes({ ...attributes, ...style })}/>`;
}

/**
 * The `d` string. Walks each subpath in order, honouring `reversed`, and
 * starts a fresh `M` wherever the next member does not begin where the last
 * one ended — the gap case the plan says export must tolerate.
 */
export function pathData(
  path: PathRecord,
  doc: SketchDocument,
  positions: Readonly<Record<Id, Point2>>,
  radii: Readonly<Record<Id, number>> = {},
): string {
  const parts: string[] = [];

  for (const subpath of path.subpaths) {
    let cursor: Point2 | undefined;
    // Where the current run began. `Z` closes back to the last `M`, so closing
    // after a gap would draw an edge the sketch does not have.
    let runStart: Point2 | undefined;

    for (const member of subpath.members) {
      const entity = doc.entities[member.entity];
      if (entity === undefined) continue;

      // Arcs export in Step 9, with their `A` commands.
      if (entity.kind === 'arc') continue;

      if (entity.kind === 'circle') {
        // A circle cannot continue a chain, so it becomes its own closed run.
        const centre = positions[entity.center] ?? doc.points[entity.center];
        if (centre === undefined) continue;
        parts.push(circleData(centre, radii[entity.id] ?? entity.radius));
        cursor = undefined;
        runStart = undefined;
        continue;
      }

      const startId = member.reversed ? entity.p2 : entity.p1;
      const endId = member.reversed ? entity.p1 : entity.p2;
      const from = positions[startId] ?? doc.points[startId];
      const to = positions[endId] ?? doc.points[endId];
      if (from === undefined || to === undefined) continue;

      // A member that does not begin where the last one ended starts a fresh
      // run: this is the gap the plan says export has to tolerate.
      if (cursor === undefined || !same(cursor, from)) {
        parts.push(`M${number(from.x)} ${number(from.y)}`);
        runStart = from;
      }
      parts.push(`L${number(to.x)} ${number(to.y)}`);
      cursor = to;
    }

    // Only a run that came back to its own start is genuinely closed.
    if (subpath.closed && cursor !== undefined && runStart !== undefined && same(cursor, runStart)) {
      parts.push('Z');
    }
  }

  return parts.join('');
}

/** Two half-arcs, the usual way to draw a full circle in a path. */
function circleData(centre: Point2, radius: number): string {
  const left = centre.x - radius;
  const right = centre.x + radius;
  return (
    `M${number(left)} ${number(centre.y)}` +
    `A${number(radius)} ${number(radius)} 0 1 0 ${number(right)} ${number(centre.y)}` +
    `A${number(radius)} ${number(radius)} 0 1 0 ${number(left)} ${number(centre.y)}Z`
  );
}

function looseElement(
  entity: Entity,
  positions: Readonly<Record<Id, Point2>>,
  radii: Readonly<Record<Id, number>>,
  style: StyleBag,
): string | undefined {
  if (entity.kind === 'arc') return undefined; // Step 9
  if (entity.kind === 'circle') return circleElement(entity, positions, radii, style, entity.id);

  const a = positions[entity.p1];
  const b = positions[entity.p2];
  if (a === undefined || b === undefined) return undefined;
  return `<line ${formatAttributes({
    id: entity.id,
    x1: number(a.x),
    y1: number(a.y),
    x2: number(b.x),
    y2: number(b.y),
    ...style,
  })}/>`;
}

function circleElement(
  entity: Entity & { kind: 'circle' },
  positions: Readonly<Record<Id, Point2>>,
  radii: Readonly<Record<Id, number>>,
  style: StyleBag,
  id: Id,
): string | undefined {
  const centre = positions[entity.center];
  if (centre === undefined) return undefined;
  return `<circle ${formatAttributes({
    id,
    cx: number(centre.x),
    cy: number(centre.y),
    r: number(radii[entity.id] ?? entity.radius),
    ...style,
  })}/>`;
}

function claimedEntities(doc: SketchDocument): Set<Id> {
  const claimed = new Set<Id>();
  for (const path of Object.values(doc.paths)) {
    for (const subpath of path.subpaths) {
      for (const member of subpath.members) claimed.add(member.entity);
    }
  }
  return claimed;
}

function same(a: Point2, b: Point2): boolean {
  return Math.abs(a.x - b.x) <= JOIN_TOLERANCE && Math.abs(a.y - b.y) <= JOIN_TOLERANCE;
}

/** Trims solver noise without losing precision anyone can see. */
function number(value: number): string {
  const rounded = Math.round(value * 1e4) / 1e4;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function formatAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
    .join(' ');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
