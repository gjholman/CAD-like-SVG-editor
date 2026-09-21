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
