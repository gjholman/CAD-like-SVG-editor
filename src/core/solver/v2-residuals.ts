/**
 * The v2 relations: parallel, perpendicular, collinear, tangent, equal,
 * concentric, midpoint, symmetric.
 *
 * Written as ordinary arithmetic on `Dual` values, so the Jacobian is exact by
 * construction rather than hand-derived (see `autodiff.ts` for why).
 *
 * **Units.** The v1 residuals are all in px. Angular relations cannot be:
 * "parallel" is about directions, and its natural residual is the sine of the
 * angle between them, which is dimensionless. Scaling by a length to force px
 * would mean picking *which* length, and the answer would differ for a short
 * line and a long one. So the angular rows are dimensionless in [-1, 1], and
 * the solver's tolerance is simply a tighter test for them than for a
 * distance: 1e-9 of a sine is about 6e-8 of a degree.
 */
import {
  abs,
  add,
  constant,
  div,
  hypot,
  mul,
  partialsOf,
  scale,
  sub,
  variable,
  type Dual,
} from './autodiff';
import { pointVariable, radiusVariable, type VariableMap } from './variables';
import type { ConstraintRow } from './residuals';
import type { Constraint, Entity, Id, SketchDocument } from '../model';

/** Below this, a direction or radius is too degenerate to differentiate. */
const DEGENERATE = 1e-12;

interface Vec {
  readonly x: Dual;
  readonly y: Dual;
}

/** Rows for one v2 relation. */
export function v2ConstraintRows(
  constraint: Constraint,
  doc: SketchDocument,
  variables: VariableMap,
  x: Float64Array,
): ConstraintRow[] {
  const id = constraint.id;
  const point = (pointId: Id): Vec => {
    const index = pointVariable(variables, pointId);
    return { x: variable(index, x[index]!), y: variable(index + 1, x[index + 1]!) };
  };

  switch (constraint.kind) {
    case 'parallel': {
      const a = lineDirection(constraint.a, doc, point);
      const b = lineDirection(constraint.b, doc, point);
      if (a === undefined || b === undefined) return [zero(id)];
      // sin of the angle between: zero when they point the same way.
      return [row(id, cross(unit(a), unit(b)))];
    }

    case 'perpendicular': {
      const a = lineDirection(constraint.a, doc, point);
      const b = lineDirection(constraint.b, doc, point);
      if (a === undefined || b === undefined) return [zero(id)];
      // cos of the angle between: zero at a right angle.
      return [row(id, dot(unit(a), unit(b)))];
    }

    case 'collinear': {
      const a = doc.entities[constraint.a];
      const b = doc.entities[constraint.b];
      if (a?.kind !== 'line' || b?.kind !== 'line') return [zero(id)];
      const da = direction(point(a.p1), point(a.p2));
      const db = direction(point(b.p1), point(b.p2));
      // Same direction, and one of B's ends on A's infinite line. Two rows,
      // which is the 2 DOF the plan's table gives collinear.
      return [
        row(id, cross(unit(da), unit(db))),
        row(id, distanceToLine(point(b.p1), point(a.p1), da)),
      ];
    }

    case 'equal': {
      const a = sizeOf(constraint.a, doc, variables, x, point);
      const b = sizeOf(constraint.b, doc, variables, x, point);
      if (a === undefined || b === undefined) return [zero(id)];
      // Length for lines, radius for circles and arcs. Both are px.
      return [row(id, sub(a, b))];
    }

    case 'concentric': {
      const a = centreOf(constraint.a, doc, point);
      const b = centreOf(constraint.b, doc, point);
      if (a === undefined || b === undefined) return [zero(id)];
      return [row(id, sub(a.x, b.x)), row(id, sub(a.y, b.y))];
    }

    case 'midpoint': {
      const line = doc.entities[constraint.entity];
      if (line?.kind !== 'line') return [zero(id)];
      const p = point(constraint.point);
      const middle = midpoint(point(line.p1), point(line.p2));
      return [row(id, sub(p.x, middle.x)), row(id, sub(p.y, middle.y))];
    }

    case 'symmetric': {
      const line = doc.entities[constraint.entity];
      if (line?.kind !== 'line') return [zero(id)];
      const p1 = point(constraint.p1);
      const p2 = point(constraint.p2);
      const a = point(line.p1);
      const axis = direction(a, point(line.p2));
      const chord = direction(p1, p2);
      // Halfway between them lies on the line, and the line joining them
      // crosses it at a right angle. Two rows, two DOF.
      return [
        row(id, distanceToLine(midpoint(p1, p2), a, axis)),
        row(id, dot(unit(chord), unit(axis))),
      ];
    }

    case 'tangent':
      return tangentRows(constraint.id, constraint.a, constraint.b, doc, variables, x, point);

    default:
      return [];
  }
}

/**
 * Tangency.
 *
 * There are two cases, and using the wrong one silently removes no freedom.
 *
 * **Tangent at a shared point** — the usual case, and what a slot or a fillet
 * is made of: the line ends where the arc begins. Here
 * `distance(centre, line) = radius` is *degenerate*, because
 * `distance(centre, line) ≤ |end − centre|` always holds, with equality
 * exactly at the solution. A residual sitting at that boundary has a zero
 * gradient, so it constrains nothing and the sketch never becomes defined.
 * Stated as "the radius at the shared point meets the line at a right angle"
 * it is an ordinary equation with an ordinary gradient.
 *
 * **Tangent without a shared point** — geometry that merely touches. Then
 * `distance(centre, line) = radius` is the right statement and is not
 * degenerate.
 *
 * Two round things touching share the second case's ambiguity: outside
 * (centres a sum of radii apart) or inside (a difference). Which one the user
 * means is not in the constraint, so it is read from where the geometry
 * currently sits — fixed for the whole solve, since it comes from the
 * document rather than the iterating variables. Dragging one circle through
 * the other can flip it between solves, which is a known v0 rough edge.
 */
function tangentRows(
  id: Id,
  aId: Id,
  bId: Id,
  doc: SketchDocument,
  variables: VariableMap,
  x: Float64Array,
  point: (pointId: Id) => Vec,
): ConstraintRow[] {
  const a = doc.entities[aId];
  const b = doc.entities[bId];
  if (a === undefined || b === undefined) return [zero(id)];

  // Line and round thing, either way round.
  const line = a.kind === 'line' ? a : b.kind === 'line' ? b : undefined;
  const round = a.kind === 'line' ? b : b.kind === 'line' ? a : undefined;

  if (line !== undefined && round !== undefined) {
    if (round.kind === 'line') return [zero(id)]; // two lines are never tangent
    const centre = centreOf(round.id, doc, point);
    if (centre === undefined) return [zero(id)];
    const axis = direction(point(line.p1), point(line.p2));

    // Tangent at a join: the radius to the shared point is perpendicular to
    // the line. See the note above for why the distance form cannot be used.
    const shared = sharedPoint(line, round);
    if (shared !== undefined) {
      return [row(id, dot(unit(axis), unit(direction(centre, point(shared)))))];
    }

    const radius = sizeOf(round.id, doc, variables, x, point);
    if (radius === undefined) return [zero(id)];
    const gap = distanceToLine(centre, point(line.p1), axis);
    if (Math.abs(gap.value) < DEGENERATE) return [zero(id)];
    // Distance regardless of side: tangency does not care which side the
    // centre is on, only that it is a radius away.
    return [row(id, sub(abs(gap), radius))];
  }

  if (a.kind === 'line' || b.kind === 'line') return [zero(id)];

  const ca = centreOf(a.id, doc, point);
  const cb = centreOf(b.id, doc, point);
  const ra = sizeOf(a.id, doc, variables, x, point);
  const rb = sizeOf(b.id, doc, variables, x, point);
  if (ca === undefined || cb === undefined || ra === undefined || rb === undefined) return [zero(id)];

  // Two arcs meeting at a point: their radii there are in line with each
  // other, which is the non-degenerate statement for the same reason.
  const joined = sharedPoint(a, b);
  if (joined !== undefined) {
    const p = point(joined);
    return [row(id, cross(unit(direction(ca, p)), unit(direction(cb, p))))];
  }

  const between = hypot(sub(cb.x, ca.x), sub(cb.y, ca.y));
  const outside = add(ra, rb);
  const inside = abs(sub(ra, rb));
  // Whichever the geometry is already closer to is what the user meant.
  const internal = Math.abs(between.value - inside.value) < Math.abs(between.value - outside.value);

  return [row(id, sub(between, internal ? inside : outside))];
}

/**
 * A point both entities are built from, if there is one. That shared point is
 * what makes a join a join rather than a coincidence.
 */
function sharedPoint(a: Entity, b: Entity): Id | undefined {
  const ends = (entity: Entity): readonly Id[] =>
    entity.kind === 'line'
      ? [entity.p1, entity.p2]
      : entity.kind === 'arc'
        ? [entity.start, entity.end]
        : [];

  const aEnds = ends(a);
  return ends(b).find((id) => aEnds.includes(id));
}

/** A line entity's direction, or undefined if it is not a line. */
function lineDirection(
  entityId: Id,
  doc: SketchDocument,
  point: (pointId: Id) => Vec,
): Vec | undefined {
  const entity = doc.entities[entityId];
  if (entity?.kind !== 'line') return undefined;
  return direction(point(entity.p1), point(entity.p2));
}

/**
 * The entity's one length: a line's length, a circle's radius, an arc's radius
 * (which is derived from its centre and start point).
 */
function sizeOf(
  entityId: Id,
  doc: SketchDocument,
  variables: VariableMap,
  x: Float64Array,
  point: (pointId: Id) => Vec,
): Dual | undefined {
  const entity = doc.entities[entityId];
  if (entity === undefined) return undefined;

  if (entity.kind === 'line') {
    const d = direction(point(entity.p1), point(entity.p2));
    return hypot(d.x, d.y);
  }
  if (entity.kind === 'circle') {
    const index = radiusVariable(variables, entity.id);
    return variable(index, x[index]!);
  }
  const d = direction(point(entity.center), point(entity.start));
  return hypot(d.x, d.y);
}

/** The centre of a circle or arc. Lines have none. */
function centreOf(
  entityId: Id,
  doc: SketchDocument,
  point: (pointId: Id) => Vec,
): Vec | undefined {
  const entity: Entity | undefined = doc.entities[entityId];
  if (entity === undefined || entity.kind === 'line') return undefined;
  return point(entity.center);
}

/** Signed distance from a point to the infinite line through `a` along `d`. */
function distanceToLine(p: Vec, a: Vec, d: Vec): Dual {
  const length = hypot(d.x, d.y);
  if (length.value < DEGENERATE) return constant(0);
  return div(cross(d, direction(a, p)), length);
}

function direction(from: Vec, to: Vec): Vec {
  return { x: sub(to.x, from.x), y: sub(to.y, from.y) };
}

function midpoint(a: Vec, b: Vec): Vec {
  return { x: scale(add(a.x, b.x), 0.5), y: scale(add(a.y, b.y), 0.5) };
}

function unit(v: Vec): Vec {
  const length = hypot(v.x, v.y);
  if (length.value < DEGENERATE) return { x: constant(0), y: constant(0) };
  return { x: div(v.x, length), y: div(v.y, length) };
}

function cross(a: Vec, b: Vec): Dual {
  return sub(mul(a.x, b.y), mul(a.y, b.x));
}

function dot(a: Vec, b: Vec): Dual {
  return add(mul(a.x, b.x), mul(a.y, b.y));
}

function row(constraint: Id, residual: Dual): ConstraintRow {
  return { constraint, residual: residual.value, partials: partialsOf(residual) };
}

/** A row that carries no error and no gradient, for geometry it cannot read. */
function zero(constraint: Id): ConstraintRow {
  return { constraint, residual: 0, partials: [] };
}
