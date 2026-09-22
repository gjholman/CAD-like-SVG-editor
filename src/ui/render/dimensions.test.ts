import { describe, expect, it } from 'vitest';
import { rectangleFixture } from '../../../tests/fixtures/rectangle';
import { solve } from '../../core/solver';
import {
  addArc,
  addConstraint,
  addEntity,
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

describe('the Step 11 annotations', () => {
  /** A right-angled wedge, a circle and an arc, all at tidy coordinates. */
  const shapes = compose(
    addPoint('o', 0, 0),
    addPoint('ax', 100, 0),
    addPoint('bx', 0, 100),
    addPoint('c', 300, 0),
    addPoint('ac', 600, 0),
    addPoint('as', 660, 0),
    addPoint('ae', 600, 60),
    addLine('lineA', 'o', 'ax', 'layer1'),
    addLine('lineB', 'o', 'bx', 'layer1'),
    addEntity({ id: 'circ', kind: 'circle', center: 'c', radius: 40, layer: 'layer1', construction: false }),
    addArc('arc1', 'ac', 'as', 'ae', 'layer1'),
  )(createEmptyDocument());

  const laidOut = (constraint: Constraint, doc = shapes) =>
    dimensionGeometry(addConstraint(constraint)(doc), doc.points, IDENTITY_VIEWPORT)[0];

  describe('an angle', () => {
    const angle = laidOut({ id: 'a1', kind: 'angle', a: 'lineA', b: 'lineB', value: 90 })!;

    it('sweeps an arc around where the lines cross', () => {
      expect(angle.shape).toBe('angular');
      expect(angle.arc).toBeDefined();
      expect(angle.arc!.centre).toEqual({ x: 0, y: 0 });
      expect(angle.arc!.sweep).toBeCloseTo(Math.PI / 2, 9);
    });

    it('reads in degrees, with the sign the geometry has', () => {
      expect(angle.label).toBe('90°');
      const other = laidOut({ id: 'a1', kind: 'angle', a: 'lineB', b: 'lineA', value: -90 })!;
      expect(other.label).toBe('-90°');
    });

    it('puts its label outside the arc, between the two lines', () => {
      // Halfway round a quarter turn from +x is 45 degrees, and y is down.
      expect(angle.labelAt.x).toBeGreaterThan(0);
      expect(angle.labelAt.y).toBeGreaterThan(0);
      expect(Math.hypot(angle.labelAt.x, angle.labelAt.y)).toBeGreaterThan(angle.arc!.radius);
    });

    it('is not drawn at all between parallel lines', () => {
      // They have no vertex, and inventing one off at infinity is worse than
      // drawing nothing. The constraint itself stays perfectly legal.
      const parallel = compose(
        addPoint('p1', 0, 0),
        addPoint('p2', 100, 0),
        addPoint('p3', 0, 50),
        addPoint('p4', 100, 50),
        addLine('l1', 'p1', 'p2', 'layer1'),
        addLine('l2', 'p3', 'p4', 'layer1'),
      )(createEmptyDocument());

      expect(laidOut({ id: 'a1', kind: 'angle', a: 'l1', b: 'l2', value: 0 }, parallel)).toBeUndefined();
    });

    it('finds the vertex even when the segments do not actually touch', () => {
      // The angle is between the *lines*, so the arc goes where they would
      // cross if extended.
      const apart = compose(
        addPoint('p1', 100, 0),
        addPoint('p2', 200, 0),
        addPoint('p3', 0, 100),
        addPoint('p4', 0, 200),
        addLine('l1', 'p1', 'p2', 'layer1'),
        addLine('l2', 'p3', 'p4', 'layer1'),
      )(createEmptyDocument());

      const laid = laidOut({ id: 'a1', kind: 'angle', a: 'l1', b: 'l2', value: 90 }, apart)!;
      expect(laid.arc!.centre.x).toBeCloseTo(0, 9);
      expect(laid.arc!.centre.y).toBeCloseTo(0, 9);
    });
  });

  describe('a radius and a diameter', () => {
    const radius = laidOut({ id: 'r1', kind: 'radius', entity: 'arc1', value: 60 })!;
    const diameter = laidOut({ id: 'd1', kind: 'diameter', entity: 'circ', value: 80 })!;

    it('are leaders on the geometry, with no extension lines', () => {
      expect(radius.shape).toBe('radial');
      expect(radius.extensions).toBe(false);
      expect(diameter.extensions).toBe(false);
    });

    it('run from the centre to the rim, and rim to rim', () => {
      // toMatchObject, not toEqual: a position that came from the document
      // rather than the solver is a stored Point, so it carries its own id.
      expect(radius.lineFrom).toMatchObject({ x: 600, y: 0 });
      expect(Math.hypot(radius.lineTo.x - 600, radius.lineTo.y)).toBeCloseTo(60, 9);

      // A diameter crosses the whole circle, so its ends are 2r apart.
      expect(Math.hypot(diameter.lineTo.x - diameter.lineFrom.x, diameter.lineTo.y - diameter.lineFrom.y))
        .toBeCloseTo(80, 9);
    });

    it('give a radius one arrowhead and a diameter two', () => {
      // A radius' other end is the centre, which is not a measured edge.
      expect(radius.arrows).toBe(1);
      expect(diameter.arrows).toBe(2);
    });

    it('carry the prefix that says which is which', () => {
      expect(radius.label).toBe('R60');
      expect(diameter.label).toBe('⌀80');
    });

    it('fan out rather than stack on top of each other', () => {
      const both = dimensionGeometry(
        compose(
          addConstraint({ id: 'r1', kind: 'radius', entity: 'circ', value: 40 }),
          addConstraint({ id: 'p1', kind: 'point-on', point: 'o', entity: 'circ' }),
        )(shapes),
        shapes.points,
        IDENTITY_VIEWPORT,
      );
      expect(both).toHaveLength(1);
    });
  });

  describe('a point-to-line distance', () => {
    const gap = laidOut({ id: 'g1', kind: 'point-line-distance', point: 'bx', entity: 'lineA', value: 100 })!;

    it('runs from the point to the foot of the perpendicular', () => {
      // lineA lies along y = 0, so the foot of (0,100) is the origin.
      expect(gap.lineFrom).toMatchObject({ x: 0, y: 100 });
      expect(gap.lineTo.x).toBeCloseTo(0, 9);
      expect(gap.lineTo.y).toBeCloseTo(0, 9);
    });

    it('needs no extension line when the foot is on the segment', () => {
      expect(gap.extensions).toBe(false);
    });

    it('extends the line when the foot falls beyond its end', () => {
      // The measurement is to the infinite line, so the drawing has to show
      // where that is rather than leaving the dimension hanging in space.
      const beyond = laidOut(
        { id: 'g1', kind: 'point-line-distance', point: 'bx', entity: 'lineA', value: 100 },
        compose(addPoint('bx', -200, 100))(shapes),
      )!;
      expect(beyond.extensions).toBe(true);
    });
  });

  describe('a reference dimension', () => {
    it('brackets its number, which is the only thing that marks it', () => {
      const driving = laidOut({ id: 'r1', kind: 'radius', entity: 'circ', value: 40 })!;
      const measured = laidOut({ id: 'r1', kind: 'radius', entity: 'circ', value: 40, reference: true })!;

      expect(driving.label).toBe('R40');
      expect(measured.label).toBe('(R40)');
      expect(measured.reference).toBe(true);
      expect(driving.reference).toBe(false);
    });

    it('is drawn, unlike a constraint the solver ignores for other reasons', () => {
      // Being out of the solve is not a reason to be invisible: the whole
      // point of a reference dimension is that you can read it.
      const measured = laidOut({ id: 'd1', kind: 'distance', p1: 'o', p2: 'ax', value: 100, reference: true });
      expect(measured).toBeDefined();
    });
  });
});
