/**
 * Document edits, as pure functions.
 *
 * Each one takes a document and returns a new one, which is exactly the shape
 * `history.dispatch` wants. Tools compose these rather than touching the model
 * directly; that single entry point is what makes undo cheap (a plan decision).
 *
 * The helpers that touch geometry also keep the *output* domain in step. Path
 * records are a second structure that can drift from the geometry (option B's
 * one real cost), so removing an entity here also removes it from any path,
 * and drawing tools extend paths through `extendPath` rather than by hand.
 */
import type { Id } from './ids';
import type { Constraint, Entity, PathRecord, Point, SketchDocument, SubPath } from './types';

/** Structurally identical to history's `Transaction`; kept separate so `model` owns no dependency on `history`. */
export type DocumentEdit = (doc: SketchDocument) => SketchDocument;

/** Runs edits in order, as one transaction and so one undo step. */
export function compose(...edits: readonly DocumentEdit[]): DocumentEdit {
  return (doc) => edits.reduce((current, edit) => edit(current), doc);
}

export function addPoint(id: Id, x: number, y: number): DocumentEdit {
  return (doc) => ({ ...doc, points: { ...doc.points, [id]: { id, x, y } } });
}

/** Moves a point. Returns the document unchanged if it is already there. */
export function movePoint(id: Id, x: number, y: number): DocumentEdit {
  return (doc) => {
    const point = doc.points[id];
    if (point === undefined) return doc;
    if (point.x === x && point.y === y) return doc;
    return { ...doc, points: { ...doc.points, [id]: { ...point, x, y } } };
  };
}

export function addEntity(entity: Entity): DocumentEdit {
  return (doc) => ({ ...doc, entities: { ...doc.entities, [entity.id]: entity } });
}

export function addLine(
  id: Id,
  p1: Id,
  p2: Id,
  layer: Id,
  construction = false,
): DocumentEdit {
  return addEntity({ id, kind: 'line', p1, p2, layer, construction });
}

export function addConstraint(constraint: Constraint): DocumentEdit {
  return (doc) => ({ ...doc, constraints: { ...doc.constraints, [constraint.id]: constraint } });
}

export function removeConstraint(id: Id): DocumentEdit {
  return (doc) => {
    if (!Object.hasOwn(doc.constraints, id)) return doc;
    const constraints = { ...doc.constraints };
    delete constraints[id];
    return { ...doc, constraints };
  };
}

/** Starts a path holding one entity, on that entity's own layer. */
export function startPath(id: Id, entityId: Id, reversed = false): DocumentEdit {
  return (doc) => {
    const entity = doc.entities[entityId];
    if (entity === undefined || entity.construction) return doc;
    const path: PathRecord = {
      id,
      layer: entity.layer,
      subpaths: [{ members: [{ entity: entityId, reversed }], closed: false }],
      fillRule: 'nonzero',
      style: {},
    };
    return { ...doc, paths: { ...doc.paths, [id]: path } };
  };
}

/**
 * Appends an entity to a path's last subpath, which is how a chain of lines
 * drawn end to end becomes one `<path d>` on export.
 */
export function extendPath(pathId: Id, entityId: Id, reversed = false): DocumentEdit {
  return (doc) => {
    const path = doc.paths[pathId];
    const entity = doc.entities[entityId];
    if (path === undefined || entity === undefined) return doc;
    // A path member must share its path's layer and never be construction
    // geometry; validate enforces both, so refuse rather than build a bad one.
    if (entity.construction || entity.layer !== path.layer) return doc;

    const last = path.subpaths.at(-1);
    const subpaths: SubPath[] =
      last === undefined
        ? [{ members: [{ entity: entityId, reversed }], closed: false }]
        : [
            ...path.subpaths.slice(0, -1),
            { ...last, members: [...last.members, { entity: entityId, reversed }] },
          ];

    return { ...doc, paths: { ...doc.paths, [pathId]: { ...path, subpaths } } };
  };
}

/** Marks a path's last subpath closed, so export writes a trailing `Z`. */
export function closePath(pathId: Id): DocumentEdit {
  return (doc) => {
    const path = doc.paths[pathId];
    const last = path?.subpaths.at(-1);
    if (path === undefined || last === undefined || last.closed) return doc;
    return {
      ...doc,
      paths: {
        ...doc.paths,
        [pathId]: { ...path, subpaths: [...path.subpaths.slice(0, -1), { ...last, closed: true }] },
      },
    };
  };
}

/**
 * Drops an entity and everything that referenced it: path members, subpaths
 * left empty, paths left with no subpaths, and any constraint naming it.
 *
 * Points are left alone. A point with nothing attached is legal, and deleting
 * one silently would take its constraints with it.
 */
export function removeEntity(entityId: Id): DocumentEdit {
  return (doc) => {
    if (!Object.hasOwn(doc.entities, entityId)) return doc;

    const entities = { ...doc.entities };
    delete entities[entityId];

    const paths: Record<Id, PathRecord> = {};
    for (const path of Object.values(doc.paths)) {
      const subpaths = path.subpaths
        .map((subpath): SubPath => ({
          ...subpath,
          members: subpath.members.filter((member) => member.entity !== entityId),
        }))
        .filter((subpath) => subpath.members.length > 0);
      if (subpaths.length > 0) paths[path.id] = { ...path, subpaths };
    }

    const constraints = Object.fromEntries(
      Object.entries(doc.constraints).filter(
        ([, constraint]) => !(constraint.kind === 'point-on' && constraint.entity === entityId),
      ),
    );

    return { ...doc, entities, paths, constraints };
  };
}

/** Every point an entity still in the document depends on. */
export function referencedPoints(doc: SketchDocument): Set<Id> {
  const used = new Set<Id>();
  for (const entity of Object.values(doc.entities)) {
    if (entity.kind === 'line') {
      used.add(entity.p1);
      used.add(entity.p2);
    } else {
      used.add(entity.center);
    }
  }
  for (const constraint of Object.values(doc.constraints)) {
    if (constraint.kind === 'fix') used.add(constraint.point);
    else if (constraint.kind === 'point-on') used.add(constraint.point);
    else {
      used.add(constraint.p1);
      used.add(constraint.p2);
    }
  }
  return used;
}

/** Removes points nothing refers to, for tidying up after a delete. */
export function pruneOrphanPoints(): DocumentEdit {
  return (doc) => {
    const used = referencedPoints(doc);
    const points: Record<Id, Point> = {};
    for (const [id, point] of Object.entries(doc.points)) {
      if (used.has(id)) points[id] = point;
    }
    return Object.keys(points).length === Object.keys(doc.points).length ? doc : { ...doc, points };
  };
}
