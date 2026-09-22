import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import { solve } from '../../core/solver';
import {
  addConstraint,
  addLine,
  addPoint,
  compose,
  createEmptyDocument,
  type Constraint,
} from '../../core/model';
import { dimensionGeometry, formatValue, signedDimensionValue } from './dimensions';
import { IDENTITY_VIEWPORT } from './viewport';

describe('formatValue', () => {
  it('shows a magnitude, because a negative width is only a pick order', () => {
    expect(formatValue(-480)).toBe('480');
    expect(formatValue(480)).toBe('480');
  });

  it('keeps two decimals for a value that has them', () => {
    expect(formatValue(12.5)).toBe('12.50');
  });
});

describe('signedDimensionValue', () => {
  it('keeps a right-to-left dimension pointing the same way', () => {
    expect(signedDimensionValue(-480, 300)).toBe(-300);
  });

  it('leaves a left-to-right dimension positive', () => {
    expect(signedDimensionValue(480, 300)).toBe(300);
  });

  it('reads a typed minus as the magnitude the field was showing', () => {
    // The field shows 480 for a stored -480, so typing -300 into it means the
    // same 300 the field would have shown — not "flip this dimension round".
    expect(signedDimensionValue(-480, -300)).toBe(-300);
    expect(signedDimensionValue(480, -300)).toBe(300);
  });

  it('never changes a dimension\'s orientation', () => {
    for (const stored of [-480, -1, 1, 480]) {
      for (const typed of [-300, -0.5, 0, 0.5, 300]) {
        const next = signedDimensionValue(stored, typed);
        expect(Math.sign(next) === 0 || Math.sign(next) === Math.sign(stored)).toBe(true);
      }
    }
  });
});

describe('dimensionGeometry', () => {
  const { doc, corners } = rectangleFixture(480, 240);
  const positions = solve(doc).positions;

  it('lays out one annotation per driving dimension', () => {
    const laid = dimensionGeometry(doc, positions, IDENTITY_VIEWPORT);
    expect(laid).toHaveLength(2);
    expect(laid.map((d) => d.label).sort()).toEqual(['240', '480']);
  });

  it('stacks two dimensions on the same pair clear of each other', () => {
    const duplicate: Constraint = {
      id: 'c-dup',
      kind: 'horizontal-distance',
      p1: corners[0],
      p2: corners[1],
      value: 480,
    };
    const stacked = { ...doc, constraints: { ...doc.constraints, [duplicate.id]: duplicate } };
    const laid = dimensionGeometry(stacked, positions, IDENTITY_VIEWPORT).filter(
      (d) => d.label === '480',
    );

    expect(laid).toHaveLength(2);
    expect(laid[0]!.lineFrom.y).not.toBeCloseTo(laid[1]!.lineFrom.y, 3);
  });

  it('offsets away from the drawing\'s own centre, wherever the drawing is', () => {
    // Placement is measured from the centre of the whole drawing, which is
    // one property per document rather than per dimension — so it is computed
    // once. A sketch far from the origin is what tells the two apart: here
    // the drawing's centre is *below* the edge being measured, so the
    // annotation goes up, while the origin sits above it.
    const far = compose(
      addPoint('a', 1000, 1000),
      addPoint('b', 1200, 1000),
      addPoint('c', 1100, 1400),
      addLine('line1', 'a', 'b', 'layer1'),
      addLine('line2', 'b', 'c', 'layer1'),
      addConstraint({ id: 'c1', kind: 'horizontal-distance', p1: 'a', p2: 'b', value: 200 }),
    )(createEmptyDocument());

    const laid = dimensionGeometry(far, far.points, IDENTITY_VIEWPORT);
    expect(laid).toHaveLength(1);
    expect(laid[0]!.lineFrom.y).toBeLessThan(1000);
  });

  it('pushes each annotation clear of the shape it measures', () => {
    const laid = dimensionGeometry(doc, positions, IDENTITY_VIEWPORT);
    const width = laid.find((d) => d.label === '480')!;
    const height = laid.find((d) => d.label === '240')!;

    // y-down: the top edge's annotation sits above it, at a smaller y.
    expect(width.lineFrom.y).toBeLessThan(0);
    // The left edge's annotation sits to its left, at a smaller x.
    expect(height.lineFrom.x).toBeLessThan(0);
  });

  it('keeps its offsets the same size as the zoom changes', () => {
    const near = dimensionGeometry(doc, positions, { ...IDENTITY_VIEWPORT, scale: 4 });
    const far = dimensionGeometry(doc, positions, { ...IDENTITY_VIEWPORT, scale: 1 });
    const gapAt = (laid: readonly { lineFrom: { y: number } }[]) =>
      Math.abs(laid.find((d) => d.lineFrom.y < 0)!.lineFrom.y);

    // Four times the zoom, a quarter of the world-space offset.
    expect(gapAt(near)).toBeCloseTo(gapAt(far) / 4, 6);
  });
});
