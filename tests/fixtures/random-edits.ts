/**
 * A seeded stream of random document edits, for property tests.
 *
 * Every edit here produces a document that `validate` still accepts, so a test
 * can assert the invariants hold at each step as well as after undoing back to
 * the start. Deletion goes through the real `removeEntity` edit from
 * `core/model`, which keeps the path records in sync — the drift that option
 * B's explicit path records risk.
 */
import type { Transaction } from '../../src/core/history';
import {
  removeEntity,
  type Entity,
  type Id,
  type IdGenerator,
  type Layer,
  type PathRecord,
  type SketchDocument,
} from '../../src/core/model';

/** mulberry32: small, fast, and reproducible from a seed. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EditSource {
  readonly nextId: IdGenerator;
  readonly rng: () => number;
}

const EDIT_KINDS = [
  'add-point',
  'move-point',
  'add-line',
  'add-circle',
  'add-path',
  'add-horizontal',
  'add-fix',
  'add-layer',
  'toggle-layer',
  'remove-entity',
] as const;

export type EditKind = (typeof EDIT_KINDS)[number];

/**
 * One random edit. When the document can't support the chosen edit (a line
 * needs two points), the transaction returns the document untouched, which
 * `dispatch` correctly records as no step at all.
 */
export function randomTransaction(source: EditSource): { transaction: Transaction; label: EditKind } {
  const kind = EDIT_KINDS[Math.floor(source.rng() * EDIT_KINDS.length)]!;
  return { transaction: (doc) => applyEdit(doc, kind, source), label: kind };
}

function applyEdit(doc: SketchDocument, kind: EditKind, source: EditSource): SketchDocument {
  const { nextId, rng } = source;
  const points = Object.values(doc.points);
  const entities = Object.values(doc.entities);
  const layerIds = doc.layerOrder;

  switch (kind) {
    case 'add-point': {
      const id = nextId('p');
      return { ...doc, points: { ...doc.points, [id]: { id, x: coord(rng), y: coord(rng) } } };
    }

    case 'move-point': {
      const point = pick(rng, points);
      if (point === undefined) return doc;
      return {
        ...doc,
        points: { ...doc.points, [point.id]: { ...point, x: coord(rng), y: coord(rng) } },
      };
    }

    case 'add-line': {
      const [p1, p2] = pickTwo(rng, points);
      const layer = pick(rng, layerIds);
      if (p1 === undefined || p2 === undefined || layer === undefined) return doc;
      const id = nextId('line');
      const line: Entity = { id, kind: 'line', p1: p1.id, p2: p2.id, layer, construction: rng() < 0.2 };
      return { ...doc, entities: { ...doc.entities, [id]: line } };
    }

    case 'add-circle': {
      const center = pick(rng, points);
      const layer = pick(rng, layerIds);
      if (center === undefined || layer === undefined) return doc;
      const id = nextId('circle');
      const circle: Entity = {
        id,
        kind: 'circle',
        center: center.id,
        radius: 1 + rng() * 100,
        layer,
        construction: false,
      };
      return { ...doc, entities: { ...doc.entities, [id]: circle } };
    }

    case 'add-path': {
      // Only real geometry not already claimed by another path may join one.
      const claimed = claimedEntities(doc);
      const free = entities.filter((entity) => !entity.construction && !claimed.has(entity.id));
      const member = pick(rng, free);
      if (member === undefined) return doc;
      const id = nextId('path');
      const path: PathRecord = {
        id,
        layer: member.layer,
        subpaths: [{ members: [{ entity: member.id, reversed: rng() < 0.5 }], closed: false }],
        fillRule: 'nonzero',
        style: {},
      };
      return { ...doc, paths: { ...doc.paths, [id]: path } };
    }

    case 'add-horizontal': {
      const [p1, p2] = pickTwo(rng, points);
      if (p1 === undefined || p2 === undefined) return doc;
      const id = nextId('c');
      return {
        ...doc,
        constraints: { ...doc.constraints, [id]: { id, kind: 'horizontal', p1: p1.id, p2: p2.id } },
      };
    }

    case 'add-fix': {
      const point = pick(rng, points);
      if (point === undefined) return doc;
      const id = nextId('c');
      return { ...doc, constraints: { ...doc.constraints, [id]: { id, kind: 'fix', point: point.id } } };
    }

    case 'add-layer': {
      const id = nextId('layer');
      const layer: Layer = { id, name: `Layer ${doc.layerOrder.length + 1}`, visible: true, locked: false };
      return { ...doc, layers: { ...doc.layers, [id]: layer }, layerOrder: [...doc.layerOrder, id] };
    }

    case 'toggle-layer': {
      const layerId = pick(rng, layerIds);
      if (layerId === undefined) return doc;
      const layer = doc.layers[layerId]!;
      return { ...doc, layers: { ...doc.layers, [layerId]: { ...layer, visible: !layer.visible } } };
    }

    case 'remove-entity': {
      const entity = pick(rng, entities);
      if (entity === undefined) return doc;
      return removeEntity(entity.id)(doc);
    }
  }
}

/** Every entity already claimed by a path. */
function claimedEntities(doc: SketchDocument): Set<Id> {
  const claimed = new Set<Id>();
  for (const path of Object.values(doc.paths)) {
    for (const subpath of path.subpaths) {
      for (const member of subpath.members) claimed.add(member.entity);
    }
  }
  return claimed;
}

function coord(rng: () => number): number {
  return Math.round((rng() * 1000 - 500) * 100) / 100;
}

function pick<T>(rng: () => number, items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[Math.floor(rng() * items.length)];
}

function pickTwo<T>(rng: () => number, items: readonly T[]): [T | undefined, T | undefined] {
  if (items.length < 2) return [undefined, undefined];
  const first = Math.floor(rng() * items.length);
  let second = Math.floor(rng() * (items.length - 1));
  if (second >= first) second += 1;
  return [items[first], items[second]];
}
