/**
 * The mapping between a document and the solver's variable vector.
 *
 * Variables are the numbers the solver is allowed to move: two per point, plus
 * one radius per circle. That matches the plan's DOF table (point 2, circle
 * centre 2 + radius 1), so a circle with nothing constraining its size
 * correctly reports one remaining degree of freedom.
 *
 * IDs are sorted so the layout depends only on *which* records a document
 * holds, never on the order they were added. Two documents with the same
 * contents therefore produce the same Jacobian, which keeps tests stable.
 */
import { entityPointIds, type Entity, type Id, type SketchDocument } from '../model';

export interface VariableMap {
  readonly count: number;
  /** Index of a point's x. Its y is the very next index. */
  readonly pointIndex: ReadonlyMap<Id, number>;
  /** Index of a circle's radius. */
  readonly radiusIndex: ReadonlyMap<Id, number>;
}

export function mapVariables(doc: SketchDocument): VariableMap {
  const pointIndex = new Map<Id, number>();
  const radiusIndex = new Map<Id, number>();
  let next = 0;

  for (const id of Object.keys(doc.points).sort()) {
    pointIndex.set(id, next);
    next += 2;
  }
  for (const id of Object.keys(doc.entities).sort()) {
    if (doc.entities[id]!.kind === 'circle') {
      radiusIndex.set(id, next);
      next += 1;
    }
  }

  return { count: next, pointIndex, radiusIndex };
}

/** The document's stored values, which are the solver's starting guess. */
export function initialVector(doc: SketchDocument, variables: VariableMap): Float64Array {
  const x = new Float64Array(variables.count);
  for (const [id, index] of variables.pointIndex) {
    const point = doc.points[id]!;
    x[index] = point.x;
    x[index + 1] = point.y;
  }
  for (const [id, index] of variables.radiusIndex) {
    const entity = doc.entities[id]!;
    if (entity.kind === 'circle') x[index] = entity.radius;
  }
  return x;
}

/** Index of a point's x, or a clear error when the document is inconsistent. */
export function pointVariable(variables: VariableMap, id: Id): number {
  const index = variables.pointIndex.get(id);
  if (index === undefined) throw new Error(`solver: no variable for point "${id}" (run validate first)`);
  return index;
}

export function radiusVariable(variables: VariableMap, id: Id): number {
  const index = variables.radiusIndex.get(id);
  if (index === undefined) throw new Error(`solver: no radius variable for entity "${id}"`);
  return index;
}

/**
 * Every variable an entity owns. Used to decide the entity's own status: it is
 * fully defined when none of these can move.
 */
export function entityVariables(entity: Entity, variables: VariableMap): number[] {
  const indices: number[] = [];
  for (const pointId of entityPointIds(entity)) {
    const index = variables.pointIndex.get(pointId);
    if (index !== undefined) indices.push(index, index + 1);
  }
  const radius = variables.radiusIndex.get(entity.id);
  if (radius !== undefined) indices.push(radius);
  return indices;
}
