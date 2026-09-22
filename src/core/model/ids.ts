/**
 * IDs are plain strings. Within a document they must be unique across *every*
 * collection (points, entities, constraints, paths, layers), because
 * constraints and path records reference points and entities by bare id.
 */
export type Id = string;

export type IdGenerator = (prefix?: string) => Id;

/**
 * Sequential ID generator, injected wherever IDs are minted so tests get
 * predictable values: `createIdGenerator()` yields `p1`, `line2`, `c3`, ...
 *
 * One counter serves every prefix, which is what makes the generated IDs
 * unique document-wide rather than only unique per kind.
 */
export function createIdGenerator(start = 0): IdGenerator {
  let n = start;
  return (prefix = 'id') => `${prefix}${++n}`;
}

/**
 * The largest counter any of `ids` carries.
 *
 * Since one counter serves every prefix, "past everything in this document"
 * is a single number: the biggest trailing number across all its ids. Ids
 * without one (a hand-written `outline`) contribute nothing, which is right —
 * a generated id always ends in a digit, so it can never collide with them.
 */
export function highestIdCounter(ids: Iterable<Id>): number {
  let highest = 0;
  for (const id of ids) {
    const digits = /(\d+)$/.exec(id);
    if (digits !== null) highest = Math.max(highest, Number(digits[1]));
  }
  return highest;
}

/**
 * A generator whose first id is past every id in `ids`.
 *
 * This is what opening a file needs. Start a fresh generator at zero instead
 * and the next point drawn is minted as `p3` while the loaded sketch already
 * has a `p3` — and because every edit is keyed by id, the new point does not
 * collide loudly, it *replaces* the loaded one.
 */
export function generatorPast(ids: Iterable<Id>): IdGenerator {
  return createIdGenerator(highestIdCounter(ids));
}
