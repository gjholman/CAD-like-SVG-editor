/**
 * Invariant checker for documents.
 *
 * Option B (explicit path records) buys a clean export walk at the cost of two
 * structures that can drift apart, so the plan pairs it with this check: run it
 * in tests, and after every undo/redo in dev.
 */
import type { Id } from './ids';
import {
  entityPointIds,
  type Constraint,
  type PathRecord,
  type SketchDocument,
} from './types';

export type IssueCode =
  /** The same id is used by two records. IDs must be unique document-wide. */
  | 'duplicate-id'
  /** A record is filed under a key that isn't its own id. */
  | 'id-key-mismatch'
  /** A reference points at a point/entity/layer that isn't in the document. */
  | 'dangling-reference'
  /** A coordinate, radius or dimension value isn't a usable number. */
  | 'bad-number'
  /** A path member's entity sits on a different layer than the path. */
  | 'path-member-wrong-layer'
  /** Construction geometry is never exported, so it can't be in a path. */
  | 'path-member-construction'
  /** An entity is claimed by more than one path. */
  | 'path-member-shared'
  /** A subpath with no members can't produce any `d` output. */
  | 'empty-subpath'
  /** layerOrder must list every layer exactly once and nothing else. */
  | 'layer-order-mismatch';

export interface ValidationIssue {
  readonly code: IssueCode;
  /** The id of the record at fault, so the UI can point at it. */
  readonly at: Id;
  readonly message: string;
}

/**
 * Returns every problem found, in no particular order. An empty array means
 * the document is well formed; it says nothing about whether the sketch is
 * solvable, which is the solver's job.
 */
export function validate(doc: SketchDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: IssueCode, at: Id, message: string) => {
    issues.push({ code, at, message });
  };

  checkIdsUnique(doc, add);

  const hasPoint = (id: Id) => Object.hasOwn(doc.points, id);
  const hasEntity = (id: Id) => Object.hasOwn(doc.entities, id);
  const hasLayer = (id: Id) => Object.hasOwn(doc.layers, id);

  for (const point of Object.values(doc.points)) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      add('bad-number', point.id, `point "${point.id}" has a non-finite coordinate`);
    }
  }

  for (const entity of Object.values(doc.entities)) {
    for (const pointId of entityPointIds(entity)) {
      if (!hasPoint(pointId)) {
        add('dangling-reference', entity.id, `${entity.kind} "${entity.id}" references unknown point "${pointId}"`);
      }
    }
    if (!hasLayer(entity.layer)) {
      add('dangling-reference', entity.id, `${entity.kind} "${entity.id}" references unknown layer "${entity.layer}"`);
    }
    if (entity.kind === 'circle' && !(Number.isFinite(entity.radius) && entity.radius > 0)) {
      add('bad-number', entity.id, `circle "${entity.id}" needs a positive radius, got ${entity.radius}`);
    }
  }

  for (const constraint of Object.values(doc.constraints)) {
    const refs = constraintRefs(constraint);
    for (const pointId of refs.points) {
      if (!hasPoint(pointId)) {
        add('dangling-reference', constraint.id, `${constraint.kind} "${constraint.id}" references unknown point "${pointId}"`);
      }
    }
    for (const entityId of refs.entities) {
      if (!hasEntity(entityId)) {
        add('dangling-reference', constraint.id, `${constraint.kind} "${constraint.id}" references unknown entity "${entityId}"`);
      }
    }
    if ('value' in constraint && !Number.isFinite(constraint.value)) {
      add('bad-number', constraint.id, `${constraint.kind} "${constraint.id}" has a non-finite value`);
    }
  }

  checkPaths(doc, add);
  checkLayerOrder(doc, add);

  return issues;
}

/** True when the document has no problems at all. */
export function isValid(doc: SketchDocument): boolean {
  return validate(doc).length === 0;
}

type AddIssue = (code: IssueCode, at: Id, message: string) => void;

function checkIdsUnique(doc: SketchDocument, add: AddIssue): void {
  const collections: ReadonlyArray<readonly [string, Readonly<Record<Id, { readonly id: Id }>>]> = [
    ['point', doc.points],
    ['entity', doc.entities],
    ['constraint', doc.constraints],
    ['path', doc.paths],
    ['layer', doc.layers],
  ];

  const owner = new Map<Id, string>();
  for (const [what, records] of collections) {
    for (const [key, record] of Object.entries(records)) {
      if (key !== record.id) {
        add('id-key-mismatch', key, `${what} filed under "${key}" but its id is "${record.id}"`);
      }
      const previous = owner.get(key);
      if (previous !== undefined) {
        add('duplicate-id', key, `id "${key}" is used by both a ${previous} and a ${what}`);
      } else {
        owner.set(key, what);
      }
    }
  }
}

function checkPaths(doc: SketchDocument, add: AddIssue): void {
  const claimedBy = new Map<Id, Id>();

  for (const path of Object.values(doc.paths)) {
    if (!Object.hasOwn(doc.layers, path.layer)) {
      add('dangling-reference', path.id, `path "${path.id}" references unknown layer "${path.layer}"`);
    }
    for (const subpath of path.subpaths) {
      if (subpath.members.length === 0) {
        add('empty-subpath', path.id, `path "${path.id}" has a subpath with no members`);
      }
      for (const member of subpath.members) {
        checkPathMember(doc, path, member.entity, claimedBy, add);
      }
    }
  }
}

function checkPathMember(
  doc: SketchDocument,
  path: PathRecord,
  entityId: Id,
  claimedBy: Map<Id, Id>,
  add: AddIssue,
): void {
  const entity = doc.entities[entityId];
  if (entity === undefined) {
    add('dangling-reference', path.id, `path "${path.id}" references unknown entity "${entityId}"`);
    return;
  }
  if (entity.layer !== path.layer) {
    add(
      'path-member-wrong-layer',
      path.id,
      `path "${path.id}" is on layer "${path.layer}" but member "${entityId}" is on "${entity.layer}"`,
    );
  }
  if (entity.construction) {
    add('path-member-construction', path.id, `path "${path.id}" includes construction entity "${entityId}"`);
  }
  const previous = claimedBy.get(entityId);
  if (previous !== undefined && previous !== path.id) {
    add('path-member-shared', path.id, `entity "${entityId}" is a member of both "${previous}" and "${path.id}"`);
  } else {
    claimedBy.set(entityId, path.id);
  }
}

function checkLayerOrder(doc: SketchDocument, add: AddIssue): void {
  const seen = new Set<Id>();
  for (const layerId of doc.layerOrder) {
    if (!Object.hasOwn(doc.layers, layerId)) {
      add('layer-order-mismatch', layerId, `layerOrder lists unknown layer "${layerId}"`);
    } else if (seen.has(layerId)) {
      add('layer-order-mismatch', layerId, `layerOrder lists layer "${layerId}" more than once`);
    }
    seen.add(layerId);
  }
  for (const layerId of Object.keys(doc.layers)) {
    if (!seen.has(layerId)) {
      add('layer-order-mismatch', layerId, `layer "${layerId}" is missing from layerOrder`);
    }
  }
}

/** Which points and entities a constraint refers to. */
function constraintRefs(constraint: Constraint): { points: Id[]; entities: Id[] } {
  switch (constraint.kind) {
    case 'fix':
      return { points: [constraint.point], entities: [] };
    case 'point-on':
      return { points: [constraint.point], entities: [constraint.entity] };
    case 'coincident':
    case 'horizontal':
    case 'vertical':
    case 'distance':
    case 'horizontal-distance':
    case 'vertical-distance':
      return { points: [constraint.p1, constraint.p2], entities: [] };
  }
}
