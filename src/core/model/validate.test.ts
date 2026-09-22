import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import { removeEntity } from './edits';
import { createEmptyDocument, type Constraint, type SketchDocument } from './types';
import { isValid, validate, type IssueCode } from './validate';

/**
 * A deep, mutable copy of the fixture, for bending one invariant at a time.
 * structuredClone drops the readonly markers, which is exactly what we want.
 */
function mutableRectangle() {
  const fixture = rectangleFixture();
  return { ...fixture, doc: structuredClone(fixture.doc) as Mutable };
}

/** The document shape with its guard rails off, so a test can break one field. */
type Mutable = {
  version: 1;
  points: Record<string, any>;
  entities: Record<string, any>;
  constraints: Record<string, any>;
  paths: Record<string, any>;
  layers: Record<string, any>;
  layerOrder: string[];
};

function codes(doc: Mutable): IssueCode[] {
  return validate(doc as never).map((issue) => issue.code);
}

describe('validate', () => {
  it('accepts an empty document', () => {
    expect(validate(createEmptyDocument())).toEqual([]);
  });

  it('accepts the hand-built rectangle', () => {
    const { doc } = rectangleFixture();
    expect(validate(doc)).toEqual([]);
    expect(isValid(doc)).toBe(true);
  });

  it('builds the rectangle with predictable IDs', () => {
    const { corners, lines, layer, path } = rectangleFixture();
    expect(layer).toBe('layer1');
    expect(corners).toEqual(['p2', 'p3', 'p4', 'p5']);
    expect(lines).toEqual(['line6', 'line7', 'line8', 'line9']);
    expect(path).toBe('path17');
  });

  describe('references', () => {
    it('reports an entity pointing at a missing point', () => {
      const { doc, lines } = mutableRectangle();
      doc.entities[lines[0]].p2 = 'nope';
      expect(codes(doc)).toEqual(['dangling-reference']);
    });

    it('reports an entity on a missing layer', () => {
      const { doc, lines } = mutableRectangle();
      doc.entities[lines[0]].layer = 'nope';
      // The layer mismatch also trips the path check, which is the point of both.
      expect(codes(doc)).toEqual(['dangling-reference', 'path-member-wrong-layer']);
    });

    it('reports a constraint pointing at a missing point', () => {
      const { doc, widthDimension } = mutableRectangle();
      doc.constraints[widthDimension].p1 = 'nope';
      expect(codes(doc)).toEqual(['dangling-reference']);
    });

    it('reports a point-on constraint pointing at a missing entity', () => {
      const { doc, corners } = mutableRectangle();
      doc.constraints['c-extra'] = { id: 'c-extra', kind: 'point-on', point: corners[0], entity: 'nope' };
      expect(codes(doc)).toEqual(['dangling-reference']);
    });

    it('reports a path on a missing layer', () => {
      const { doc, path } = mutableRectangle();
      doc.paths[path].layer = 'nope';
      const found = codes(doc);
      expect(found).toContain('dangling-reference');
      expect(found).toContain('path-member-wrong-layer');
    });

    it('reports a path member that is not an entity', () => {
      const { doc, path } = mutableRectangle();
      doc.paths[path].subpaths[0].members[0].entity = 'nope';
      expect(codes(doc)).toEqual(['dangling-reference']);
    });
  });

  describe('ids', () => {
    it('reports a record filed under the wrong key', () => {
      const { doc, corners } = mutableRectangle();
      doc.points['elsewhere'] = { ...doc.points[corners[0]], id: corners[0] };
      delete doc.points[corners[0]];
      const found = codes(doc);
      expect(found).toContain('id-key-mismatch');
    });

    it('reports an id shared by two collections', () => {
      const { doc, corners } = mutableRectangle();
      doc.layers[corners[0]] = { id: corners[0], name: 'Clash', visible: true, locked: false };
      doc.layerOrder.push(corners[0]);
      expect(codes(doc)).toEqual(['duplicate-id']);
    });
  });

  describe('numbers', () => {
    it('reports a non-finite coordinate', () => {
      const { doc, corners } = mutableRectangle();
      doc.points[corners[0]].x = Number.NaN;
      expect(codes(doc)).toEqual(['bad-number']);
    });

    it('reports a non-finite dimension value', () => {
      const { doc, widthDimension } = mutableRectangle();
      doc.constraints[widthDimension].value = Number.POSITIVE_INFINITY;
      expect(codes(doc)).toEqual(['bad-number']);
    });

    it.each([0, -5, Number.NaN])('reports a circle with radius %s', (radius) => {
      const { doc, corners, layer } = mutableRectangle();
      doc.entities['circle-x'] = { id: 'circle-x', kind: 'circle', center: corners[0], radius, layer, construction: false };
      expect(codes(doc)).toEqual(['bad-number']);
    });
  });

  describe('paths', () => {
    it('reports a member on a different layer than its path', () => {
      const { doc, lines } = mutableRectangle();
      doc.layers['layer-b'] = { id: 'layer-b', name: 'Other', visible: true, locked: false };
      doc.layerOrder.push('layer-b');
      doc.entities[lines[0]].layer = 'layer-b';
      expect(codes(doc)).toEqual(['path-member-wrong-layer']);
    });

    it('reports construction geometry inside a path', () => {
      const { doc, lines } = mutableRectangle();
      doc.entities[lines[2]].construction = true;
      expect(codes(doc)).toEqual(['path-member-construction']);
    });

    it('reports an entity claimed by two paths', () => {
      const { doc, path, lines, layer } = mutableRectangle();
      doc.paths['path-b'] = {
        id: 'path-b',
        layer,
        subpaths: [{ members: [{ entity: lines[0], reversed: false }], closed: false }],
        fillRule: 'nonzero',
        style: {},
      };
      const found = codes(doc);
      expect(found).toEqual(['path-member-shared']);
      expect(validate(doc as never)[0]!.at).not.toBe(path);
    });

    it('reports an empty subpath', () => {
      const { doc, path } = mutableRectangle();
      doc.paths[path].subpaths.push({ members: [], closed: false });
      expect(codes(doc)).toEqual(['empty-subpath']);
    });
  });

  describe('layer order', () => {
    it('reports a layer missing from the order', () => {
      const { doc } = mutableRectangle();
      doc.layerOrder = [];
      expect(codes(doc)).toEqual(['layer-order-mismatch']);
    });

    it('reports an unknown layer in the order', () => {
      const { doc } = mutableRectangle();
      doc.layerOrder.push('nope');
      expect(codes(doc)).toEqual(['layer-order-mismatch']);
    });

    it('reports a layer listed twice', () => {
      const { doc, layer } = mutableRectangle();
      doc.layerOrder.push(layer);
      expect(codes(doc)).toEqual(['layer-order-mismatch']);
    });
  });

  it('reports every problem in one pass, not just the first', () => {
    const { doc, corners, lines } = mutableRectangle();
    doc.points[corners[1]].y = Number.NaN;
    doc.entities[lines[0]].p2 = 'nope';
    doc.layerOrder.push('nope');
    expect(codes(doc).sort()).toEqual(['bad-number', 'dangling-reference', 'layer-order-mismatch']);
  });
});

describe('v2 relations', () => {
  const base = () => {
    const { doc, lines } = rectangleFixture();
    return { doc: structuredClone(doc) as Mutable, lines };
  };

  it('accepts a relation between two entities', () => {
    const { doc, lines } = base();
    doc.constraints['c-par'] = { id: 'c-par', kind: 'parallel', a: lines[0], b: lines[2] };
    expect(codes(doc)).toEqual([]);
  });

  it('reports an entity-pair relation naming a missing entity', () => {
    const { doc, lines } = base();
    doc.constraints['c-par'] = { id: 'c-par', kind: 'parallel', a: lines[0], b: 'gone' };
    expect(codes(doc)).toEqual(['dangling-reference']);
  });

  it('reports a midpoint naming a missing point or entity', () => {
    const { doc, lines, corners } = { ...base(), corners: rectangleFixture().corners };
    doc.constraints['c-mid'] = { id: 'c-mid', kind: 'midpoint', point: 'gone', entity: lines[0] };
    expect(codes(doc)).toEqual(['dangling-reference']);

    doc.constraints['c-mid'] = { id: 'c-mid', kind: 'midpoint', point: corners[0], entity: 'gone' };
    expect(codes(doc)).toEqual(['dangling-reference']);
  });

  it('reports a symmetric relation naming missing references', () => {
    const { doc, lines } = base();
    const { corners } = rectangleFixture();
    doc.constraints['c-sym'] = {
      id: 'c-sym',
      kind: 'symmetric',
      p1: corners[0],
      p2: 'gone',
      entity: lines[0],
    };
    expect(codes(doc)).toEqual(['dangling-reference']);
  });

  it('takes an entity-pair relation with the entity it names', () => {
    // Deleting a line must not leave a parallel relation pointing at it.
    const { doc, lines } = base();
    doc.constraints['c-par'] = { id: 'c-par', kind: 'parallel', a: lines[0], b: lines[2] };
    const trimmed = removeEntity(lines[0])(doc as never);

    expect(trimmed.constraints['c-par']).toBeUndefined();
    expect(validate(trimmed)).toEqual([]);
  });
});

describe('dimensions on the wrong geometry', () => {
  /** A line and a circle, to attach dimensions to. */
  const shapes = (constraint: Constraint): SketchDocument => ({
    version: 1,
    points: {
      p1: { id: 'p1', x: 0, y: 0 },
      p2: { id: 'p2', x: 100, y: 0 },
      c: { id: 'c', x: 50, y: 50 },
    },
    entities: {
      line1: { id: 'line1', kind: 'line', p1: 'p1', p2: 'p2', layer: 'layer1', construction: false },
      circ1: { id: 'circ1', kind: 'circle', center: 'c', radius: 25, layer: 'layer1', construction: false },
    },
    constraints: { [constraint.id]: constraint },
    paths: {},
    layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
    layerOrder: ['layer1'],
  });

  it('rejects a radius on a line', () => {
    const issues = validate(shapes({ id: 'd1', kind: 'radius', entity: 'line1', value: 10 }));
    expect(issues.map((i) => i.code)).toEqual(['dimension-wrong-entity']);
    expect(issues[0]!.message).toContain('radius');
  });

  it('rejects a diameter on a line', () => {
    expect(validate(shapes({ id: 'd1', kind: 'diameter', entity: 'line1', value: 10 }))).toHaveLength(1);
  });

  it('rejects an angle to a circle', () => {
    const issues = validate(shapes({ id: 'd1', kind: 'angle', a: 'line1', b: 'circ1', value: 30 }));
    expect(issues.map((i) => i.code)).toEqual(['dimension-wrong-entity']);
  });

  it('rejects a point-to-line distance measured to a circle', () => {
    const issues = validate(shapes({ id: 'd1', kind: 'point-line-distance', point: 'c', entity: 'circ1', value: 30 }));
    expect(issues.map((i) => i.code)).toEqual(['dimension-wrong-entity']);
  });

  it('accepts each of them on the geometry that can carry it', () => {
    expect(validate(shapes({ id: 'd1', kind: 'radius', entity: 'circ1', value: 25 }))).toEqual([]);
    expect(validate(shapes({ id: 'd1', kind: 'diameter', entity: 'circ1', value: 50 }))).toEqual([]);
    expect(validate(shapes({ id: 'd1', kind: 'angle', a: 'line1', b: 'line1', value: 0 }))).toEqual([]);
    expect(
      validate(shapes({ id: 'd1', kind: 'point-line-distance', point: 'c', entity: 'line1', value: 50 })),
    ).toEqual([]);
  });

  it('still catches a non-finite value on a new dimension kind', () => {
    const issues = validate(shapes({ id: 'd1', kind: 'radius', entity: 'circ1', value: Number.NaN }));
    expect(issues.map((i) => i.code)).toEqual(['bad-number']);
  });

  it('has nothing to say about a reference dimension being wrong', () => {
    // A reference dimension's number is an output, so any finite value is
    // legal however far from the geometry it currently is.
    expect(
      validate(shapes({ id: 'd1', kind: 'radius', entity: 'circ1', value: 999, reference: true })),
    ).toEqual([]);
  });
});
