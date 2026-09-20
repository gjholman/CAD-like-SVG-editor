# Parametric SVG Sketcher — Planning Doc

**Status:** Planning
**Started:** 2026-09-20

---

## 1. Vision

A web app for 2D SVG design that works like a SolidWorks sketch: draw geometry loosely, then pin it down with **relations** (geometric constraints) and **dimensions** (driving numbers). A live solver keeps everything consistent whenever a number changes or a point is dragged. SVG is the output format.

---

## 2. Defining characteristics of SolidWorks-style sketching

1. **Sketch entities**: points, lines, arcs, circles, ellipses, splines, plus rectangles/slots/polygons (which are just bundles of lines/arcs with relations pre-applied).
2. **Construction geometry**: entities that participate in constraints but don't appear in the output (centerlines, helper circles).
3. **Relations (geometric constraints)**: coincident, horizontal, vertical, parallel, perpendicular, tangent, etc. They say *how* geometry relates without giving numbers.
4. **Dimensions**: driving numbers (length, distance, angle, radius/diameter). Changing a driving dimension moves the geometry. *Reference* dimensions are read-only measurements that don't constrain anything.
5. **Live constraint solver**: every edit or drag re-solves the whole sketch.
6. **Definition status feedback**: the sketch (and each entity) is visibly under defined, fully defined, or over defined.
7. **Fixed origin / reference**: a fully defined sketch must be anchored to something (origin or a fixed point), otherwise it can still slide around.
8. **Drag-to-explore**: on an under-defined sketch you can drag geometry and it moves only along its remaining free directions. This is how you "feel" what's still loose.
9. **Inference while drawing**: the tool auto-adds relations as you draw (horizontal when near horizontal, coincident when snapping to an endpoint, tangent when leaving an arc, etc.).
10. **Design intent**: sketches are built to capture *why* (equal, symmetric, tangent) rather than just where things ended up.
11. **Named parameters / equations**: dimensions have names (e.g. `D1@Sketch1`) and can be driven by variables or formulas (`width = 2 * height`).
12. **Editing tools**: trim, extend, offset, mirror, fillet, chamfer, linear/circular patterns, move/rotate/scale.
13. **Rebuild/history**: parametric means editing an early value regenerates everything downstream. For 2D-only, this mostly lives inside the sketch solve, but named parameters give a mini version of it.

### Status colors (SolidWorks convention, worth copying)

| Color | Meaning |
|---|---|
| Blue | Under defined: free degrees of freedom remain |
| Black | Fully defined: zero degrees of freedom |
| Red | Over defined: redundant or conflicting constraints |
| Yellow | Solver couldn't find a valid solution |

---

## 3. How to fully define geometry (degrees of freedom)

**Core idea:** every entity has a number of numeric variables (degrees of freedom, DOF). Every constraint removes some. A sketch is **fully defined when DOF = 0**.

### DOF per entity

| Entity | Variables | DOF |
|---|---|---|
| Point | x, y | 2 |
| Line segment | two endpoints | 4 |
| Infinite line / construction line | point + angle | 2 |
| Circle | center (2) + radius | 3 |
| Arc | center (2) + radius + start angle + end angle | 5 |
| Ellipse | center (2) + two radii + rotation | 5 |
| Cubic Bézier segment | 4 control points | 8 |
| Spline (n control points) | 2 per control point | 2n |

### DOF removed per constraint

| Constraint | DOF removed |
|---|---|
| Fix point / point at origin | 2 |
| Coincident (point–point) | 2 |
| Point on line/arc/circle | 1 |
| Midpoint | 2 |
| Horizontal / Vertical (line or two points) | 1 |
| Parallel | 1 |
| Perpendicular | 1 |
| Collinear (two lines) | 2 |
| Tangent (line–arc, arc–arc) | 1 |
| Concentric | 2 |
| Equal (length or radius) | 1 |
| Symmetric (two points about a line) | 2 |
| Any driving dimension | 1 |

### Recipes: fully defining each segment type

- **Line**: 4 DOF. Typical: one endpoint fixed or coincident to something (2) + horizontal/vertical or an angle (1) + length (1).
- **Circle**: 3 DOF. Center located (2) + diameter (1).
- **Arc**: 5 DOF. Center located (2) + radius (1) + two more for the sweep, usually from endpoints coincident to other geometry, or one endpoint plus an angle dimension. Tangent to a neighbor is a common cheap way to remove one.
- **Chain of segments**: coincident endpoints remove 2 each, so joining shapes into a closed profile is where most of the DOF disappear.

### Worked example: a rectangle

1. Four separate lines: 4 × 4 = **16 DOF**
2. Four corner coincidences: −8 → **8 DOF**
3. Two horizontal + two vertical: −4 → **4 DOF** (x position, y position, width, height)
4. Bottom-left corner coincident with origin: −2 → **2 DOF** (width, height)
5. Width dimension + height dimension: −2 → **0 DOF, fully defined**

### The caveat: simple subtraction isn't enough

"Total DOF minus constraints removed" only works when every constraint is independent. Two failure modes:

- **Redundant**: a constraint that's already implied by others (e.g. line A is perpendicular to line B, B is perpendicular to line C, and you *also* mark A parallel to C). Consistent, but the arithmetic double-counts.
- **Conflicting**: constraints that contradict each other (a line dimensioned as 10 and also equal to a line dimensioned as 20).

The correct test uses the **Jacobian** of the constraint equations (rows = constraints, columns = variables):

- `DOF = (#variables) − rank(J)`
- Fully defined when `rank(J) = #variables`
- Over defined when there are more independent-looking constraints than the rank supports, or the solver can't satisfy them all
- **Per-entity status:** compute the nullspace of J; an entity is fully defined if its variables have no component in the nullspace. This is how the UI can color individual lines blue vs black.

---

## 4. Constraint set

### v1 (MVP)

- Geometric: coincident, point-on-object, horizontal, vertical, fix
- Dimensional: distance (point–point / line length), horizontal distance, vertical distance

### v2

- Geometric: parallel, perpendicular, tangent, equal, collinear, concentric, midpoint, symmetric
- Dimensional: angle, radius, diameter, point–line distance
- Reference (non-driving) dimensions

### Later

- Named parameters and equations
- Pattern constraints (linear/circular)
- Blocks/groups, sketch-to-sketch references

---

## 5. Architecture ideas

### Layers

1. **Sketch model** (plain JSON, the source of truth): points, entities (referencing point IDs), constraints, parameters.
2. **Solver**: takes the model, returns updated point/param values plus DOF/status info.
3. **UI/renderer**: draws the solved model, handles tools, snapping, dragging, dimension placement.
4. **Import/export**: SVG ⇄ model.

### Data model sketch

- **Points are first-class** and shared by entities (`line: {p1, p2}`, `arc: {center, start, end}`, `circle: {center, radius}`). Connectivity through shared point IDs (or explicit coincident constraints) keeps the topology explicit.
- Constraints reference entity/point IDs plus an optional value or parameter name.

### Solver options

| Option | Notes |
|---|---|
| Existing constraint solver compiled to WASM (e.g. planegcs from FreeCAD, SolveSpace's solver library) | Fast path to a working prototype and battle-tested handling of many constraint types. Worth verifying current packaging/licensing before committing. |
| Write our own in TypeScript | Damped Gauss-Newton / Levenberg–Marquardt on constraint residuals, analytic or finite-difference Jacobian, rank via QR/SVD. More work, full control, good for learning. |

Open decision: start with an existing solver to validate the UX, or build our own.

### SVG mapping

| Sketch entity | SVG output |
|---|---|
| Line | `<line>` or `path` `L` |
| Circle | `<circle>` |
| Ellipse | `<ellipse>` |
| Arc | `path` with `A rx ry rot large-arc sweep x y` |
| Spline | Chain of cubic Béziers (`C`) |
| Closed profile | Single `<path>` with `Z` |

Notes:

- SVG arcs use **endpoint parameterization**, while the sketch model uses **center parameterization**, so conversions are needed both ways (including large-arc/sweep flags).
- Construction geometry is omitted from export.
- **Round-tripping:** embed the sketch JSON (constraints included) in the SVG (`<metadata>` or a custom namespace) so the file reopens fully constrained but still renders normally in any other SVG tool.
- Importing arbitrary SVGs: geometry comes in unconstrained (all blue); optionally offer auto-detection of obvious relations (horizontal/vertical, coincident endpoints).

---

## 6. Roadmap

**Phase 0 — Decisions**
- Solver approach, framework, coordinate/units model

**Phase 1 — Sketch core**
- Points, lines, circles
- Coincident, horizontal, vertical, fix, distance dimensions
- Solver + DOF counter + blue/black/red status
- Drag-to-solve
- Basic SVG export

**Phase 2 — Full relation set**
- Arcs, tangent, parallel, perpendicular, equal, midpoint, symmetric, concentric
- Angle/radius/diameter dimensions
- Inference while drawing
- Constraint list panel (view/delete constraints)

**Phase 3 — Editing tools**
- Trim, extend, offset, mirror, fillet, chamfer
- Construction geometry toggle

**Phase 4 — Parametric layer**
- Named dimensions, equations
- SVG import + round-trip with embedded constraints
- Undo/redo (likely from the start in practice)

**Phase 5 — Extras**
- Splines, patterns, blocks, multiple sketches/layers

---

## 7. Open questions

- Own solver vs existing library?
- Rendering: SVG DOM (easy hit testing) vs Canvas (better for very large sketches)?
- Framework/stack?
- Units and scale: px only, or real-world units (mm/in) with export scaling?
- Splines: how much of a priority, and Bézier vs NURBS-style control?
- One sketch per document, or multiple sketches/layers?
- How much SVG import matters versus starting from a blank sketch?

---

## 8. Decisions log

_(none yet)_

---

## 9. Changelog

- 2026-09-20: Initial planning doc created.
