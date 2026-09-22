import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import {
  addLine,
  addPoint,
  compose,
  createEmptyDocument,
  type Constraint,
  type SketchDocument,
} from '../../core/model';
import { solve } from '../../core/solver';
import { HINTS, RELATION_ICONS, RELATION_NAMES, describeRefs, statusLine, summariseSelection } from './labels';

/** The fixture with one constraint removed, to leave some freedom behind. */
function without(doc: SketchDocument, id: string): SketchDocument {
  const constraints = { ...doc.constraints };
  delete constraints[id];
  return { ...doc, constraints };
}

describe('summariseSelection', () => {
  const { doc, corners, lines, widthDimension } = rectangleFixture(480, 240);
  const result = solve(doc);

  it('says what to do when nothing is selected', () => {
    const summary = summariseSelection(doc, result, []);
    expect(summary.name).toBe('Nothing selected');
    expect(summary.sub).toContain('shift-click');
  });

  it('counts a multiple selection and lists it', () => {
    const summary = summariseSelection(doc, result, [corners[0], corners[1]]);
    expect(summary.name).toBe('2 selected');
    expect(summary.sub).toBe(`${corners[0]}, ${corners[1]}`);
  });

  it('gives a point its coordinates and whether it can still move', () => {
    const summary = summariseSelection(doc, result, [corners[1]]);
    expect(summary.name).toBe(`Point ${corners[1]}`);
    expect(summary.sub).toContain('X 480.00');
    expect(summary.sub).toContain('Y 0.00');
    // The fixture is fully constrained, so nothing moves.
    expect(summary.sub).toContain('fully defined');
  });

  it('says a point can still move when it can', () => {
    const loose = without(doc, widthDimension);
    const summary = summariseSelection(loose, solve(loose), [corners[1]]);
    expect(summary.sub).toContain('can still move');
  });

  it('names an entity by kind, capitalised', () => {
    expect(summariseSelection(doc, result, [lines[0]]).name).toBe(`Line ${lines[0]}`);
  });

  it('calls out construction geometry', () => {
    const withConstruction = compose(
      addPoint('a', 0, 0),
      addPoint('b', 10, 0),
      addLine('guide', 'a', 'b', 'layer1', true),
    )(createEmptyDocument());
    const summary = summariseSelection(withConstruction, solve(withConstruction), ['guide']);
    expect(summary.sub).toContain('Construction');
  });

  it('names a relation and what it acts on', () => {
    const summary = summariseSelection(doc, result, [widthDimension]);
    expect(summary.name).toBe('Width');
    expect(summary.sub).toBe(`${corners[0]} and ${corners[1]}`);
  });

  it('falls back rather than going blank on an id it cannot find', () => {
    const summary = summariseSelection(doc, result, ['nothing-like-this']);
    expect(summary.name).toBe('1 selected');
    expect(summary.sub).toBe('nothing-like-this');
  });
});

describe('statusLine', () => {
  it('calls an empty sketch empty, not fully defined', () => {
    // Zero points means zero degrees of freedom, which is arithmetically true
    // and reads as though something has been pinned down.
    const empty = createEmptyDocument();
    const line = statusLine(empty, solve(empty));
    expect(line.text).toBe('Empty sketch');
    expect(line.dot).toBe('empty');
    expect(line.detail).toContain('line tool');
  });

  it('reports a fully defined sketch with no freedom left', () => {
    const { doc } = rectangleFixture();
    const line = statusLine(doc, solve(doc));
    expect(line.text).toBe('Fully defined');
    expect(line.dot).toBe('');
    expect(line.detail).toBe('0 degrees of freedom');
  });

  it('counts the freedom an under defined sketch has left', () => {
    const { doc, widthDimension } = rectangleFixture();
    const loose = without(doc, widthDimension);
    const line = statusLine(loose, solve(loose));
    expect(line.text).toBe('Under defined');
    expect(line.dot).toBe('under');
    expect(line.detail).toBe('1 degree of freedom');
  });

  it('says degree, singular, for exactly one', () => {
    const { doc, widthDimension, heightDimension } = rectangleFixture();
    const one = without(doc, widthDimension);
    const two = without(one, heightDimension);
    expect(statusLine(one, solve(one)).detail).toBe('1 degree of freedom');
    expect(statusLine(two, solve(two)).detail).toBe('2 degrees of freedom');
  });

  it('marks an over defined sketch', () => {
    const { doc, corners } = rectangleFixture(480, 240);
    const duplicate: Constraint = {
      id: 'c-dup',
      kind: 'horizontal-distance',
      p1: corners[0],
      p2: corners[1],
      value: 480,
    };
    const over = { ...doc, constraints: { ...doc.constraints, [duplicate.id]: duplicate } };
    expect(statusLine(over, solve(over)).dot).toBe('over');
  });
});

describe('the label tables', () => {
  it('names and illustrates every constraint kind the app can make', () => {
    const kinds = [
      'horizontal',
      'vertical',
      'coincident',
      'fix',
      'parallel',
      'perpendicular',
      'collinear',
      'tangent',
      'equal',
      'concentric',
      'midpoint',
      'symmetric',
      'point-on',
      'distance',
      'horizontal-distance',
      'vertical-distance',
    ];
    for (const kind of kinds) {
      expect(RELATION_NAMES[kind], kind).toBeTruthy();
      expect(RELATION_ICONS[kind], kind).toMatch(/^#i-/);
    }
  });

  it('hints at every tool', () => {
    for (const tool of ['select', 'line', 'arc'] as const) {
      expect(HINTS[tool].length, tool).toBeGreaterThan(20);
    }
  });
});

describe('describeRefs', () => {
  it('lists points before entities', () => {
    const pointOn: Constraint = { id: 'c1', kind: 'point-on', point: 'p1', entity: 'line1' };
    expect(describeRefs(pointOn)).toBe('p1 and line1');
  });
});
