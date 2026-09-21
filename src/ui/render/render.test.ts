// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import { solve } from '../../core/solver';
import type { Constraint, Id, SketchDocument } from '../../core/model';
import { render } from './render';
import { IDENTITY_VIEWPORT, type Viewport } from './viewport';

const SVG_NS = 'http://www.w3.org/2000/svg';

let stage: Element;

beforeEach(() => {
  stage = document.createElementNS(SVG_NS, 'svg');
  document.body.replaceChildren(stage);
});

function draw(doc: SketchDocument, viewport: Viewport = IDENTITY_VIEWPORT): void {
  render(stage, doc, { viewport, result: solve(doc) });
}

function without(doc: SketchDocument, ...ids: Id[]): SketchDocument {
  const constraints = { ...doc.constraints };
  for (const id of ids) delete constraints[id];
  return { ...doc, constraints };
}

const classOf = (selector: string) => stage.querySelector(selector)?.getAttribute('class') ?? '';

describe('render: the rectangle', () => {
  it('draws one line per entity and one dot per point', () => {
    const { doc } = rectangleFixture();
    draw(doc);

    expect(stage.querySelectorAll('[data-entity]')).toHaveLength(4);
    expect(stage.querySelectorAll('line.line')).toHaveLength(4);
    expect(stage.querySelectorAll('[data-point]')).toHaveLength(4);
  });

  it('puts entities in a group for their layer', () => {
    const { doc, layer } = rectangleFixture();
    draw(doc);

    const group = stage.querySelector(`[data-layer="${layer}"]`);
    expect(group).not.toBeNull();
    expect(group!.querySelectorAll('[data-entity]')).toHaveLength(4);
  });

  it('draws a line between its two endpoints', () => {
    const { doc, lines } = rectangleFixture(480, 240);
    draw(doc);

    const line = stage.querySelector(`[data-entity="${lines[0]}"] line`)!;
    expect(line.getAttribute('x1')).toBe('0');
    expect(line.getAttribute('y1')).toBe('0');
    expect(line.getAttribute('x2')).toBe('480');
    expect(line.getAttribute('y2')).toBe('0');
  });

  // The step's "done when": black once fully defined, blue while loose.
  it('is black when fully defined', () => {
    const { doc, lines } = rectangleFixture();
    draw(doc);

    for (const id of lines) {
      expect(classOf(`[data-entity="${id}"]`), id).toContain('is-full');
    }
    for (const dot of stage.querySelectorAll('[data-point]')) {
      expect(dot.getAttribute('class')).toContain('is-full');
    }
  });

  it('is blue while loose', () => {
    const { doc, widthDimension, lines } = rectangleFixture();
    draw(without(doc, widthDimension));

    // Only the left edge touches neither sliding corner.
    expect(classOf(`[data-entity="${lines[0]}"]`)).toContain('is-under');
    expect(classOf(`[data-entity="${lines[1]}"]`)).toContain('is-under');
    expect(classOf(`[data-entity="${lines[2]}"]`)).toContain('is-under');
    expect(classOf(`[data-entity="${lines[3]}"]`)).toContain('is-full');
  });

  it('colours individual points by their own freedom', () => {
    const { doc, widthDimension, corners } = rectangleFixture();
    draw(without(doc, widthDimension));

    expect(classOf(`[data-point="${corners[0]}"]`)).toContain('is-full');
    expect(classOf(`[data-point="${corners[3]}"]`)).toContain('is-full');
    expect(classOf(`[data-point="${corners[1]}"]`)).toContain('is-under');
    expect(classOf(`[data-point="${corners[2]}"]`)).toContain('is-under');
  });

  it('turns the implicated geometry red when over defined', () => {
    const { doc, corners, lines } = rectangleFixture(480, 240);
    const contradiction: Constraint = {
      id: 'c-bad',
      kind: 'horizontal-distance',
      p1: corners[0],
      p2: corners[1],
      value: 300,
    };
    draw({ ...doc, constraints: { ...doc.constraints, 'c-bad': contradiction } });

    expect(classOf(`[data-entity="${lines[0]}"]`)).toContain('is-over');
  });
});

describe('render: layers', () => {
  function twoLayers(): SketchDocument {
    const { doc, lines } = rectangleFixture();
    return {
      ...doc,
      layers: {
        ...doc.layers,
        second: { id: 'second', name: 'Second', visible: true, locked: false },
      },
      layerOrder: [...doc.layerOrder, 'second'],
      entities: { ...doc.entities, [lines[0]]: { ...doc.entities[lines[0]]!, layer: 'second' } },
      paths: {},
    };
  }

  it('draws layers back to front, in layerOrder', () => {
    const doc = twoLayers();
    draw(doc);

    const order = [...stage.querySelectorAll('[data-layer]')].map((g) => g.getAttribute('data-layer'));
    expect(order).toEqual(doc.layerOrder);
  });

  it('skips hidden layers entirely', () => {
    const doc = twoLayers();
    const hidden = { ...doc, layers: { ...doc.layers, second: { ...doc.layers['second']!, visible: false } } };
    draw(hidden);

    expect(stage.querySelector('[data-layer="second"]')).toBeNull();
    expect(stage.querySelectorAll('[data-entity]')).toHaveLength(3);
  });

  it('marks locked layers without hiding them', () => {
    const doc = twoLayers();
    const locked = { ...doc, layers: { ...doc.layers, second: { ...doc.layers['second']!, locked: true } } };
    draw(locked);

    expect(stage.querySelector('[data-layer="second"]')!.getAttribute('data-locked')).toBe('true');
    expect(stage.querySelectorAll('[data-entity]')).toHaveLength(4);
  });

  it('still draws points belonging to a hidden layer\'s geometry', () => {
    // Points are not owned by a layer, so they stay visible.
    const doc = twoLayers();
    const hidden = { ...doc, layers: { ...doc.layers, second: { ...doc.layers['second']!, visible: false } } };
    draw(hidden);

    expect(stage.querySelectorAll('[data-point]')).toHaveLength(4);
  });
});

describe('render: construction geometry', () => {
  it('draws it as a centreline and marks it', () => {
    const { doc, lines } = rectangleFixture();
    const withConstruction = {
      ...doc,
      entities: { ...doc.entities, [lines[0]]: { ...doc.entities[lines[0]]!, construction: true } },
      paths: {},
    };
    draw(withConstruction);

    const wrapper = stage.querySelector(`[data-entity="${lines[0]}"]`)!;
    expect(wrapper.getAttribute('data-construction')).toBe('true');
    expect(wrapper.querySelector('line')!.getAttribute('class')).toBe('center');
    expect(stage.querySelector(`[data-entity="${lines[1]}"] line`)!.getAttribute('class')).toBe('line');
  });
});

describe('render: circles', () => {
  const doc: SketchDocument = {
    version: 1,
    points: { p1: { id: 'p1', x: 40, y: 60 } },
    entities: {
      circle1: { id: 'circle1', kind: 'circle', center: 'p1', radius: 25, layer: 'layer1', construction: false },
    },
    constraints: {},
    paths: {},
    layers: { layer1: { id: 'layer1', name: 'Layer 1', visible: true, locked: false } },
    layerOrder: ['layer1'],
  };

  it('draws a circle at its centre with its radius', () => {
    draw(doc);
    const circle = stage.querySelector('[data-entity="circle1"] circle')!;

    expect(circle.getAttribute('cx')).toBe('40');
    expect(circle.getAttribute('cy')).toBe('60');
    expect(circle.getAttribute('r')).toBe('25');
  });

  it('uses the solved radius, not the stored one', () => {
    const constrained: SketchDocument = {
      ...doc,
      points: { ...doc.points, p2: { id: 'p2', x: 90, y: 60 } },
      constraints: {
        c1: { id: 'c1', kind: 'fix', point: 'p1' },
        c2: { id: 'c2', kind: 'fix', point: 'p2' },
        c3: { id: 'c3', kind: 'point-on', point: 'p2', entity: 'circle1' },
      },
    };
    draw(constrained);

    expect(Number(stage.querySelector('[data-entity="circle1"] circle')!.getAttribute('r'))).toBeCloseTo(50, 3);
  });
});

describe('render: viewport', () => {
  it('applies the pan and zoom as a transform', () => {
    const { doc } = rectangleFixture();
    draw(doc, { panX: 100, panY: 50, scale: 2 });

    expect(stage.querySelector('.sketch-view')!.getAttribute('transform')).toBe('translate(-200 -100) scale(2)');
  });

  it('keeps dots the same size on screen as you zoom', () => {
    const { doc } = rectangleFixture();

    draw(doc, { panX: 0, panY: 0, scale: 1 });
    const atOne = Number(stage.querySelector('[data-point]')!.getAttribute('r'));

    draw(doc, { panX: 0, panY: 0, scale: 4 });
    const atFour = Number(stage.querySelector('[data-point]')!.getAttribute('r'));

    expect(atFour * 4).toBeCloseTo(atOne, 6);
  });

  it('keeps stroke width constant on screen', () => {
    const { doc } = rectangleFixture();
    draw(doc, { panX: 0, panY: 0, scale: 8 });

    expect(stage.querySelector('line')!.getAttribute('vector-effect')).toBe('non-scaling-stroke');
  });
});

describe('render: re-rendering', () => {
  it('replaces the previous drawing rather than stacking on it', () => {
    const { doc } = rectangleFixture();
    draw(doc);
    draw(doc);
    draw(doc);

    expect(stage.querySelectorAll('[data-entity]')).toHaveLength(4);
    expect(stage.querySelectorAll('.sketch-view')).toHaveLength(1);
  });

  it('shows the new geometry after a dimension change', () => {
    const { doc, widthDimension, corners } = rectangleFixture(480, 240);
    draw(doc);
    expect(stage.querySelector(`[data-point="${corners[1]}"]`)!.getAttribute('cx')).toBe('480');

    const widened = {
      ...doc,
      constraints: {
        ...doc.constraints,
        [widthDimension]: { ...doc.constraints[widthDimension]!, value: 600 } as Constraint,
      },
    };
    draw(widened);
    expect(Number(stage.querySelector(`[data-point="${corners[1]}"]`)!.getAttribute('cx'))).toBeCloseTo(600, 3);
  });
});

describe('render: without a solve result', () => {
  it('draws stored geometry and calls everything under defined', () => {
    const { doc, lines } = rectangleFixture();
    render(stage, doc, { viewport: IDENTITY_VIEWPORT });

    expect(stage.querySelectorAll('[data-entity]')).toHaveLength(4);
    expect(classOf(`[data-entity="${lines[0]}"]`)).toContain('is-under');
  });
});

describe('render: robustness', () => {
  it('skips an entity whose points are missing rather than throwing', () => {
    // validate would reject this, but the renderer must not crash the editor.
    const { doc, lines } = rectangleFixture();
    const broken = {
      ...doc,
      entities: { ...doc.entities, [lines[0]]: { ...doc.entities[lines[0]]!, p2: 'gone' } },
      paths: {},
    };
    render(stage, broken, { viewport: IDENTITY_VIEWPORT });

    expect(stage.querySelectorAll('[data-entity]')).toHaveLength(3);
  });

  it('draws an empty document without complaint', () => {
    const { doc } = rectangleFixture();
    render(stage, { ...doc, points: {}, entities: {}, paths: {} }, { viewport: IDENTITY_VIEWPORT });

    expect(stage.querySelectorAll('[data-entity]')).toHaveLength(0);
    expect(stage.querySelector('.sketch-view')).not.toBeNull();
  });
});
