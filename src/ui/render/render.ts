/**
 * Draws a document into the SVG DOM.
 *
 * Read-only: it produces elements and nothing else. No event handlers, no
 * mutation of the document. Tools come in Step 5 and go through `dispatch`.
 *
 * Structure, following the mockup's conventions:
 *
 *   <g class="sketch-view" transform=...>      pan and zoom
 *     <g class="sketch-layer" data-layer=...>  one per visible layer, back to front
 *       <g class="sketch-entity is-full" data-entity=...>
 *     <g class="sketch-points">                points on top of the geometry
 *
 * Colour comes from `currentColor`: the status class sets `color` and the
 * shapes stroke with it, so one class per element colours the whole thing.
 * `is-full` is black, `is-under` blue, `is-over` red — the plan's convention.
 *
 * The whole subtree is rebuilt on every call. At sketch scale that is fast
 * enough and it removes a whole class of stale-DOM bugs; if dragging a large
 * sketch ever feels slow, this is the place to add diffing.
 */
import type { EntityStatus, SolveResult } from '../../core/solver';
import type { Entity, Id, SketchDocument } from '../../core/model';
import { viewTransform, type Point2, type Viewport } from './viewport';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Radius of an endpoint dot, in screen px, held constant as you zoom. */
const DOT_RADIUS = 3.5;

export interface RenderOptions {
  readonly viewport: Viewport;
  /** Entities and points drawn with a selection halo. */
  readonly selection?: Iterable<Id>;
  /**
   * The rubber line a drawing tool trails from its last click to the cursor.
   * It is not in the document — nothing is committed until the click lands.
   */
  readonly preview?: { readonly from: Point2; readonly to: Point2 };
  /**
   * Status and solved geometry. Without it the document's own stored values
   * are drawn and everything renders as under defined, which is the honest
   * reading: nothing has told us otherwise.
   */
  readonly result?: SolveResult;
}

export function render(root: Element, doc: SketchDocument, options: RenderOptions): void {
  const { viewport, result } = options;
  const selection = new Set<Id>(options.selection ?? []);

  root.replaceChildren();
  const view = element('g', { class: 'sketch-view', transform: viewTransform(viewport) });

  const positions = result?.positions ?? doc.points;
  const radii = result?.radii ?? {};
  const conflicted = new Set<Id>(result?.conflicts ?? []);
  const overDefined = result?.status === 'over-defined';

  for (const layerId of doc.layerOrder) {
    const layer = doc.layers[layerId];
    if (layer === undefined || !layer.visible) continue;

    const group = element('g', { class: 'sketch-layer', 'data-layer': layerId });
    if (layer.locked) group.setAttribute('data-locked', 'true');

    for (const entity of entitiesOnLayer(doc, layerId)) {
      const shape = entityShape(entity, positions, radii);
      if (shape === undefined) continue;

      const status = entityClass(entity.id, result?.entityStatus, overDefined, conflicted, doc);
      const selected = selection.has(entity.id);
      const wrapper = element('g', {
        class: `sketch-entity ${status}${selected ? ' is-selected' : ''}`,
        'data-entity': entity.id,
      });
      if (entity.construction) wrapper.setAttribute('data-construction', 'true');
      // The halo is a copy of the shape drawn behind it, as in the mockup, so
      // selection reads clearly without disturbing the status colour.
      if (selected) {
        const halo = entityShape(entity, positions, radii);
        if (halo !== undefined) {
          halo.setAttribute('class', 'selhalo');
          wrapper.append(halo);
        }
      }
      wrapper.append(shape);
      group.append(wrapper);
    }

    view.append(group);
  }

  view.append(pointsGroup(doc, positions, viewport, result, overDefined, selection));
  if (options.preview !== undefined) view.append(previewLine(options.preview));
  root.append(view);
}

function entitiesOnLayer(doc: SketchDocument, layerId: Id): Entity[] {
  return Object.keys(doc.entities)
    .sort()
    .map((id) => doc.entities[id]!)
    .filter((entity) => entity.layer === layerId);
}

function entityShape(
  entity: Entity,
  positions: Readonly<Record<Id, Point2>>,
  radii: Readonly<Record<Id, number>>,
): Element | undefined {
  // Construction geometry keeps its own dashed look, as in the mockup.
  const shapeClass = entity.construction ? 'center' : 'line';

  if (entity.kind === 'line') {
    const p1 = positions[entity.p1];
    const p2 = positions[entity.p2];
    if (p1 === undefined || p2 === undefined) return undefined;
    return element('line', {
      class: shapeClass,
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      'vector-effect': 'non-scaling-stroke',
    });
  }

  const centre = positions[entity.center];
  if (centre === undefined) return undefined;
  return element('circle', {
    class: shapeClass,
    cx: centre.x,
    cy: centre.y,
    r: radii[entity.id] ?? entity.radius,
    'vector-effect': 'non-scaling-stroke',
  });
}

function pointsGroup(
  doc: SketchDocument,
  positions: Readonly<Record<Id, Point2>>,
  viewport: Viewport,
  result: SolveResult | undefined,
  overDefined: boolean,
  selection: ReadonlySet<Id>,
): Element {
  const group = element('g', { class: 'sketch-points' });
  // Dots are a screen-space size, so divide out the zoom.
  const radius = DOT_RADIUS / viewport.scale;

  for (const id of Object.keys(doc.points).sort()) {
    const point = positions[id] ?? doc.points[id]!;
    const status = statusClass(result?.pointStatus?.[id], overDefined);
    const selected = selection.has(id);
    group.append(
      element('circle', {
        class: `dot ${status}${selected ? ' is-selected' : ''}`,
        'data-point': id,
        cx: point.x,
        cy: point.y,
        r: selected ? radius * 1.6 : radius,
      }),
    );
  }

  return group;
}

/**
 * An entity turns red when the sketch is over defined *and* it is implicated:
 * a redundant constraint reported by the solver touches one of its points.
 * Everything else takes its own blue/black status.
 */
function entityClass(
  id: Id,
  entityStatus: Readonly<Record<Id, EntityStatus>> | undefined,
  overDefined: boolean,
  conflicted: ReadonlySet<Id>,
  doc: SketchDocument,
): string {
  if (overDefined && touchesConflict(id, conflicted, doc)) return 'is-over';
  return statusClass(entityStatus?.[id], false);
}

function touchesConflict(entityId: Id, conflicted: ReadonlySet<Id>, doc: SketchDocument): boolean {
  if (conflicted.size === 0) return false;
  const entity = doc.entities[entityId];
  if (entity === undefined) return false;

  const points = new Set(entity.kind === 'line' ? [entity.p1, entity.p2] : [entity.center]);
  for (const constraintId of conflicted) {
    const constraint = doc.constraints[constraintId];
    if (constraint === undefined) continue;
    if (constraint.kind === 'fix' && points.has(constraint.point)) return true;
    if (constraint.kind === 'point-on' && (points.has(constraint.point) || constraint.entity === entityId)) {
      return true;
    }
    if ('p1' in constraint && (points.has(constraint.p1) || points.has(constraint.p2))) return true;
  }
  return false;
}

function statusClass(status: EntityStatus | undefined, overDefined: boolean): string {
  if (overDefined) return 'is-over';
  return status === 'fully-defined' ? 'is-full' : 'is-under';
}

function previewLine(preview: { from: Point2; to: Point2 }): Element {
  return element('line', {
    class: 'preview',
    x1: preview.from.x,
    y1: preview.from.y,
    x2: preview.to.x,
    y2: preview.to.y,
    'vector-effect': 'non-scaling-stroke',
  });
}

function element(name: string, attributes: Record<string, string | number>): Element {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, typeof value === 'number' ? trim(value) : value);
  }
  return node;
}

/** Keeps coordinates readable in the DOM without losing sub-pixel accuracy. */
function trim(value: number): string {
  return String(Math.round(value * 1e4) / 1e4);
}
