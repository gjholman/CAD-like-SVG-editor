/**
 * The plan's worked example, as a document.
 *
 * Corners are shared points rather than four loose lines joined by coincident
 * constraints, so the eight DOF the plan's arithmetic removes with corner
 * coincidences never exist here. What's left:
 *
 *   4 points                        8 DOF
 *   fix corner 0                   -2
 *   horizontal on top and bottom   -2
 *   vertical on left and right     -2
 *   width + height dimensions      -2
 *                                 ----
 *                                   0  fully defined
 *
 * Step 3b's solver tests check that arithmetic against the Jacobian rank.
 * Coordinates are y-down, so corner 0 is the top-left on screen.
 */
import { createIdGenerator, type Id, type SketchDocument } from '../../src/core/model';

export interface RectangleFixture {
  readonly doc: SketchDocument;
  /** The four corners, walking the loop from the origin corner. */
  readonly corners: readonly [Id, Id, Id, Id];
  readonly lines: readonly [Id, Id, Id, Id];
  readonly layer: Id;
  readonly path: Id;
  readonly widthDimension: Id;
  readonly heightDimension: Id;
}

/** A closed, fully constrained rectangle anchored at the origin. */
export function rectangleFixture(width = 480, height = 240): RectangleFixture {
  const nextId = createIdGenerator();
  const layer = nextId('layer');

  const corners = [
    { id: nextId('p'), x: 0, y: 0 },
    { id: nextId('p'), x: width, y: 0 },
    { id: nextId('p'), x: width, y: height },
    { id: nextId('p'), x: 0, y: height },
  ] as const;

  const lines = corners.map((corner, i) => ({
    id: nextId('line'),
    kind: 'line' as const,
    p1: corner.id,
    p2: corners[(i + 1) % corners.length]!.id,
    layer,
    construction: false,
  }));

  const constraints = [
    { id: nextId('c'), kind: 'fix' as const, point: corners[0].id },
    { id: nextId('c'), kind: 'horizontal' as const, p1: corners[0].id, p2: corners[1].id },
    { id: nextId('c'), kind: 'horizontal' as const, p1: corners[3].id, p2: corners[2].id },
    { id: nextId('c'), kind: 'vertical' as const, p1: corners[0].id, p2: corners[3].id },
    { id: nextId('c'), kind: 'vertical' as const, p1: corners[1].id, p2: corners[2].id },
    { id: nextId('c'), kind: 'horizontal-distance' as const, p1: corners[0].id, p2: corners[1].id, value: width },
    { id: nextId('c'), kind: 'vertical-distance' as const, p1: corners[0].id, p2: corners[3].id, value: height },
  ];

  const path = {
    id: nextId('path'),
    layer,
    subpaths: [{ members: lines.map((line) => ({ entity: line.id, reversed: false })), closed: true }],
    fillRule: 'nonzero' as const,
    style: { fill: 'none', stroke: '#1b1b1f' },
  };

  const doc: SketchDocument = {
    version: 1,
    points: byId(corners),
    entities: byId(lines),
    constraints: byId(constraints),
    paths: byId([path]),
    layers: { [layer]: { id: layer, name: 'Outline', visible: true, locked: false } },
    layerOrder: [layer],
  };

  return {
    doc,
    corners: [corners[0].id, corners[1].id, corners[2].id, corners[3].id],
    lines: [lines[0]!.id, lines[1]!.id, lines[2]!.id, lines[3]!.id],
    layer,
    path: path.id,
    widthDimension: constraints[5]!.id,
    heightDimension: constraints[6]!.id,
  };
}

function byId<T extends { id: Id }>(records: readonly T[]): Record<Id, T> {
  return Object.fromEntries(records.map((record) => [record.id, record]));
}
