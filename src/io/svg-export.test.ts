// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../tests/fixtures/rectangle';
import {
  addArc,
  addLine,
  addPoint,
  compose,
  createEmptyDocument,
  extendPath,
  startPath,
  type SketchDocument,
} from '../core/model';
import { solve } from '../core/solver';
import { fromJson, toJson } from './json';
import { pathData, toSvg } from './svg-export';

/**
 * Parsing with a real parser matters: producing a string that merely looks
 * like SVG is the easy mistake, and a browser would reject it silently.
 */
function parse(svg: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const error = parsed.querySelector('parsererror');
  expect(error, error?.textContent ?? '').toBeNull();
  return parsed.documentElement as unknown as SVGSVGElement;
}

describe('the document element', () => {
  it('is a well-formed svg in the SVG namespace', () => {
    const root = parse(toSvg(rectangleFixture(480, 240).doc));

    expect(root.nodeName).toBe('svg');
    expect(root.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  it('sizes the viewBox to the drawing, in px', () => {
    const root = parse(toSvg(rectangleFixture(480, 240).doc));

    expect(root.getAttribute('viewBox')).toBe('0 0 480 240');
    expect(root.getAttribute('width')).toBe('480');
    expect(root.getAttribute('height')).toBe('240');
  });

  it('adds a margin when asked', () => {
    const root = parse(toSvg(rectangleFixture(480, 240).doc, { margin: 10 }));
    expect(root.getAttribute('viewBox')).toBe('-10 -10 500 260');
  });

  it('still produces a valid document for an empty sketch', () => {
    const root = parse(toSvg(createEmptyDocument()));
    expect(root.getAttribute('viewBox')).toBe('0 0 1 1');
    expect(root.children).toHaveLength(0);
  });
});

describe('layers', () => {
  it('become groups, in draw order', () => {
    const { doc, lines } = rectangleFixture();
    const twoLayers: SketchDocument = {
      ...doc,
      layers: { ...doc.layers, second: { id: 'second', name: 'Second', visible: true, locked: false } },
      layerOrder: [...doc.layerOrder, 'second'],
      entities: { ...doc.entities, [lines[0]]: { ...doc.entities[lines[0]]!, layer: 'second' } },
      paths: {},
    };
    const root = parse(toSvg(twoLayers));
    const groups = [...root.querySelectorAll('g')];

    expect(groups.map((g) => g.getAttribute('id'))).toEqual(twoLayers.layerOrder);
  });

  it('carries the layer name', () => {
    const { doc, layer } = rectangleFixture();
    const root = parse(toSvg(doc));
    expect(root.querySelector(`#${layer}`)!.getAttribute('data-name')).toBe('Outline');
  });

  it('writes Inkscape layer attributes when asked', () => {
    const { doc, layer } = rectangleFixture();
    const root = parse(toSvg(doc, { inkscapeLayers: true }));
    const group = root.querySelector(`#${layer}`)!;

    expect(group.getAttribute('inkscape:groupmode')).toBe('layer');
    expect(group.getAttribute('inkscape:label')).toBe('Outline');
    expect(root.getAttribute('xmlns:inkscape')).toContain('inkscape');
  });

  it('exports a hidden layer hidden rather than dropping it', () => {
    const { doc, layer } = rectangleFixture();
    const hidden = { ...doc, layers: { ...doc.layers, [layer]: { ...doc.layers[layer]!, visible: false } } };
    const root = parse(toSvg(hidden));

    expect(root.querySelector(`#${layer}`)!.getAttribute('style')).toBe('display:none');
    expect(root.querySelectorAll('path')).toHaveLength(1);
  });
});

describe('paths rebuilt from path records', () => {
  it('walks the rectangle into one closed subpath', () => {
    const { doc, path } = rectangleFixture(480, 240);
    const root = parse(toSvg(doc));
    const element = root.querySelector(`#${path}`)!;

    expect(element.nodeName).toBe('path');
    expect(element.getAttribute('d')).toBe('M0 0L480 0L480 240L0 240L0 0Z');
  });

  it('honours a reversed member', () => {
    const { doc, path, lines } = rectangleFixture(480, 240);
    const subpath = doc.paths[path]!.subpaths[0]!;
    const flipped: SketchDocument = {
      ...doc,
      paths: {
        [path]: {
          ...doc.paths[path]!,
          subpaths: [
            {
              ...subpath,
              members: [{ entity: lines[0], reversed: true }],
              closed: false,
            },
          ],
        },
      },
    };
    // Walking the first edge backwards runs from (480,0) to (0,0).
    expect(pathData(flipped.paths[path]!, flipped, flipped.points)).toBe('M480 0L0 0');
  });

  it('carries the fill rule only when it is not the default', () => {
    const { doc, path } = rectangleFixture();
    expect(toSvg(doc)).not.toContain('fill-rule');

    const evenodd = { ...doc, paths: { [path]: { ...doc.paths[path]!, fillRule: 'evenodd' as const } } };
    expect(parse(toSvg(evenodd)).querySelector(`#${path}`)!.getAttribute('fill-rule')).toBe('evenodd');
  });

  it('carries the path\'s own style over the default', () => {
    const { doc, path } = rectangleFixture();
    const styled = {
      ...doc,
      paths: { [path]: { ...doc.paths[path]!, style: { stroke: '#ff0000', 'stroke-width': '3' } } },
    };
    const element = parse(toSvg(styled)).querySelector(`#${path}`)!;

    expect(element.getAttribute('stroke')).toBe('#ff0000');
    expect(element.getAttribute('stroke-width')).toBe('3');
    expect(element.getAttribute('fill')).toBe('none');
  });

  it('starts a new run where the geometry has been pulled apart', () => {
    // Two segments that no longer meet: export must not draw a line across
    // the gap, it must lift the pen.
    const doc = compose(
      addPoint('p1', 0, 0),
      addPoint('p2', 100, 0),
      addPoint('p3', 200, 0),
      addPoint('p4', 300, 0),
      addLine('line1', 'p1', 'p2', 'layer1'),
      addLine('line2', 'p3', 'p4', 'layer1'),
      startPath('path1', 'line1'),
      extendPath('path1', 'line2'),
    )(createEmptyDocument());

    expect(pathData(doc.paths['path1']!, doc, doc.points)).toBe('M0 0L100 0M200 0L300 0');
  });

  it('does not close a broken loop, which would draw an edge that is not there', () => {
    // Z closes back to the last M. After a gap that is not where the shape
    // started, so closing would invent a diagonal across the drawing.
    const { doc, path, lines } = rectangleFixture(480, 240);
    const entities = { ...doc.entities };
    delete entities[lines[1]];
    const gapped = { ...doc, entities };

    expect(doc.paths[path]!.subpaths[0]!.closed).toBe(true);
    expect(pathData(gapped.paths[path]!, gapped, gapped.points)).not.toContain('Z');
    // The intact rectangle still closes.
    expect(pathData(doc.paths[path]!, doc, doc.points).endsWith('Z')).toBe(true);
  });

  it('skips a member whose entity has gone', () => {
    const { doc, path, lines } = rectangleFixture(480, 240);
    const entities = { ...doc.entities };
    delete entities[lines[1]];
    const gapped = { ...doc, entities };

    expect(pathData(gapped.paths[path]!, gapped, gapped.points)).toBe('M0 0L480 0M480 240L0 240L0 0');
  });
});

describe('circles', () => {
  const circleDoc: SketchDocument = {
    version: 1,
    points: { p1: { id: 'p1', x: 50, y: 60 } },
    entities: {
      circle1: { id: 'circle1', kind: 'circle', center: 'p1', radius: 20, layer: 'layer1', construction: false },
    },
    constraints: {},
    paths: {
      path1: {
        id: 'path1',
        layer: 'layer1',
        subpaths: [{ members: [{ entity: 'circle1', reversed: false }], closed: true }],
        fillRule: 'nonzero',
        style: {},
      },
    },
    layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
    layerOrder: ['layer1'],
  };

  it('a one-member circle path exports as <circle>, as the plan asks', () => {
    const element = parse(toSvg(circleDoc)).querySelector('#path1')!;

    expect(element.nodeName).toBe('circle');
    expect(element.getAttribute('cx')).toBe('50');
    expect(element.getAttribute('cy')).toBe('60');
    expect(element.getAttribute('r')).toBe('20');
  });

  it('sizes the viewBox around the whole disc', () => {
    expect(parse(toSvg(circleDoc)).getAttribute('viewBox')).toBe('30 40 40 40');
  });

  it('becomes arcs inside a longer path', () => {
    const mixed: SketchDocument = {
      ...circleDoc,
      points: { ...circleDoc.points, p2: { id: 'p2', x: 0, y: 0 }, p3: { id: 'p3', x: 10, y: 0 } },
      entities: {
        ...circleDoc.entities,
        line1: { id: 'line1', kind: 'line', p1: 'p2', p2: 'p3', layer: 'layer1', construction: false },
      },
      paths: {
        path1: {
          ...circleDoc.paths['path1']!,
          subpaths: [
            {
              members: [
                { entity: 'line1', reversed: false },
                { entity: 'circle1', reversed: false },
              ],
              closed: false,
            },
          ],
        },
      },
    };
    const d = parse(toSvg(mixed)).querySelector('#path1')!.getAttribute('d')!;

    expect(d).toContain('M0 0L10 0');
    expect(d).toContain('A20 20 0 1 0');
  });
});

describe('what is left out and what is not', () => {
  it('omits construction geometry', () => {
    const { doc, lines } = rectangleFixture();
    const withConstruction = {
      ...doc,
      entities: { ...doc.entities, [lines[0]]: { ...doc.entities[lines[0]]!, construction: true } },
      paths: {},
    };
    const root = parse(toSvg(withConstruction));

    expect(root.querySelectorAll('line')).toHaveLength(3);
    expect(root.innerHTML).not.toContain(lines[0]);
  });

  it('still exports geometry that belongs to no path', () => {
    // Drawing a loose line and exporting must not silently lose it.
    const doc = compose(
      addPoint('p1', 0, 0),
      addPoint('p2', 100, 40),
      addLine('line1', 'p1', 'p2', 'layer1'),
    )(createEmptyDocument());
    const element = parse(toSvg(doc)).querySelector('line')!;

    expect(element.getAttribute('x1')).toBe('0');
    expect(element.getAttribute('y2')).toBe('40');
  });

  it('does not export an entity twice when it is in a path', () => {
    const { doc } = rectangleFixture();
    const root = parse(toSvg(doc));

    expect(root.querySelectorAll('path')).toHaveLength(1);
    expect(root.querySelectorAll('line')).toHaveLength(0);
  });

  it('escapes anything that would break the markup', () => {
    const { doc, layer } = rectangleFixture();
    const awkward = {
      ...doc,
      layers: { ...doc.layers, [layer]: { ...doc.layers[layer]!, name: 'A & B <"quoted">' } },
    };
    const root = parse(toSvg(awkward));

    expect(root.querySelector(`#${layer}`)!.getAttribute('data-name')).toBe('A & B <"quoted">');
  });
});

describe('solved values', () => {
  it('exports the solved geometry, not the stored geometry', () => {
    const { doc, widthDimension, path } = rectangleFixture(480, 240);
    const widened = {
      ...doc,
      constraints: {
        ...doc.constraints,
        [widthDimension]: { ...doc.constraints[widthDimension]!, value: 600 } as never,
      },
    };
    const result = solve(widened);
    const root = parse(toSvg(widened, { positions: result.positions, radii: result.radii }));

    expect(root.querySelector(`#${path}`)!.getAttribute('d')).toBe('M0 0L600 0L600 240L0 240L0 0Z');
  });
});

describe('degenerate extents', () => {
  it('gives a vertical line a width a renderer will accept', () => {
    // The viewBox guarded its minimum extent at 1e-9, but attributes are
    // rounded to four decimals on the way out — so a vertical line exported
    // as width="0", and an SVG with zero width draws nothing at all.
    const doc = compose(
      addPoint('a', 10, 0),
      addPoint('b', 10, 100),
      addLine('line1', 'a', 'b', 'layer1'),
      startPath('path1', 'line1'),
    )(createEmptyDocument());

    const root = parse(toSvg(doc));
    expect(Number(root.getAttribute('width'))).toBeGreaterThan(0);
    const [, , boxWidth] = root.getAttribute('viewBox')!.split(' ').map(Number);
    expect(boxWidth).toBeGreaterThan(0);
  });

  it('does the same for a horizontal line', () => {
    const doc = compose(
      addPoint('a', 0, 10),
      addPoint('b', 100, 10),
      addLine('line1', 'a', 'b', 'layer1'),
      startPath('path1', 'line1'),
    )(createEmptyDocument());

    const root = parse(toSvg(doc));
    expect(Number(root.getAttribute('height'))).toBeGreaterThan(0);
  });

  it('keeps a single point exportable too', () => {
    const doc = addPoint('a', 5, 5)(createEmptyDocument());
    const root = parse(toSvg(doc));
    expect(Number(root.getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(root.getAttribute('height'))).toBeGreaterThan(0);
  });
});

describe('a partial positions map', () => {
  it('still exports the arcs and circles it says nothing about', () => {
    // A caller handing in positions for only the points it moved used to lose
    // whole entities: some helpers fell back to the stored points and others
    // simply returned undefined, so the lines came out and the arc did not.
    const doc = compose(
      addPoint('c', 0, 0),
      addPoint('s', 100, 0),
      addPoint('e', 0, 100),
      addPoint('a', 0, 0),
      addPoint('b', 50, 0),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
      addLine('line1', 'a', 'b', 'layer1'),
    )(createEmptyDocument());

    // Only one point is named, and not one the arc uses.
    const root = parse(toSvg(doc, { positions: { b: { x: 60, y: 0 } } }));

    expect(root.querySelector('#arc1')).not.toBeNull();
    expect(root.querySelector('#line1')!.getAttribute('x2')).toBe('60');
  });
});

/** The step's "done when": save, reload, and export to a valid SVG. */
describe('the Step 6 rectangle survives the whole trip', () => {
  it('saves, reloads and exports', () => {
    const { doc, path } = rectangleFixture(480, 240);

    const reloaded = fromJson(toJson(doc));
    expect(reloaded).toEqual(doc);

    const svg = toSvg(reloaded);
    const root = parse(svg);

    expect(root.getAttribute('viewBox')).toBe('0 0 480 240');
    expect(root.querySelector(`#${path}`)!.getAttribute('d')).toBe('M0 0L480 0L480 240L0 240L0 0Z');

    // And the exported file is still valid after a second round trip.
    expect(parse(toSvg(fromJson(toJson(reloaded))))).not.toBeNull();
  });
});

describe('arcs', () => {
  const arcEdits = (clockwise = true) =>
    compose(
      addPoint('c', 0, 0),
      addPoint('s', 100, 0),
      addPoint('e', 0, 100),
      addArc('arc1', 'c', 's', 'e', 'layer1', clockwise),
    );
  const arcDoc = (clockwise = true): SketchDocument => arcEdits(clockwise)(createEmptyDocument());

  it('a lone arc exports as a one-command path', () => {
    const element = parse(toSvg(arcDoc())).querySelector('#arc1')!;

    expect(element.nodeName).toBe('path');
    expect(element.getAttribute('d')).toBe('M100 0A100 100 0 0 1 0 100');
  });

  it('flips the sweep flag with the direction', () => {
    // The other way round is also the long way round here, so both flags move.
    expect(parse(toSvg(arcDoc(false))).querySelector('#arc1')!.getAttribute('d')).toBe(
      'M100 0A100 100 0 1 0 0 100',
    );
  });

  it('joins an arc to a line inside one path', () => {
    const doc = compose(
      arcEdits(),
      addPoint('far', 0, 300),
      addLine('line1', 'e', 'far', 'layer1'),
      startPath('path1', 'arc1'),
      extendPath('path1', 'line1'),
    )(createEmptyDocument());

    expect(parse(toSvg(doc)).querySelector('#path1')!.getAttribute('d')).toBe(
      'M100 0A100 100 0 0 1 0 100L0 300',
    );
  });

  it('travels a reversed arc the other way, flipping its sweep', () => {
    const doc = compose(
      arcEdits(),
      startPath('path1', 'arc1', true),
    )(createEmptyDocument());

    expect(parse(toSvg(doc)).querySelector('#path1')!.getAttribute('d')).toBe(
      'M0 100A100 100 0 0 0 100 0',
    );
  });

  it('draws a whole turn as two halves, since one A command cannot', () => {
    // Endpoints dragged together: start and end coincide, so a single arc
    // command would be a no-op and the arc would vanish.
    const whole = compose(
      addPoint('c', 0, 0),
      addPoint('s', 100, 0),
      addPoint('e', 100, 0),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
    )(createEmptyDocument());
    const d = parse(toSvg(whole)).querySelector('#arc1')!.getAttribute('d')!;

    expect(d).toBe('M100 0A100 100 0 1 1 -100 0A100 100 0 1 1 100 0');
  });

  it('sizes the viewBox to the arc, not to its whole circle', () => {
    expect(parse(toSvg(arcDoc())).getAttribute('viewBox')).toBe('0 0 100 100');
  });

  it('skips an arc whose radius has collapsed', () => {
    const degenerate = compose(
      addPoint('c', 0, 0),
      addPoint('s', 0, 0),
      addPoint('e', 0, 100),
      addArc('arc1', 'c', 's', 'e', 'layer1'),
    )(createEmptyDocument());

    expect(parse(toSvg(degenerate)).querySelector('#arc1')).toBeNull();
  });
});
