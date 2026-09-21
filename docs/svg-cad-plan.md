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
- **Paths** are separate records in the output domain (see Compound paths), referencing entity IDs; the solver never sees them.

### Solver options

| Option | Notes |
|---|---|
| Existing constraint solver compiled to WASM (e.g. planegcs from FreeCAD, SolveSpace's solver library) | Fast path to a working prototype and battle-tested handling of many constraint types. Worth verifying current packaging/licensing before committing. |
| Write our own in TypeScript | Damped Gauss-Newton / Levenberg–Marquardt on constraint residuals, analytic or finite-difference Jacobian, rank via QR/SVD. More work, full control, good for learning. |

**Decision:** build our own solver. Existing solvers (SolveSpace, planegcs) are fair game for inspiration on approach, but not as dependencies.

Solver design notes:

- Keep it a pure module with no DOM code so it can be unit tested headlessly (Vitest pairs naturally with Vite).
- Start with a dense Jacobian; that's fine at sketch scale.
- Later optimization: split the sketch into independent clusters (connected components of the constraint graph) and solve each separately, so dragging one shape doesn't re-solve everything.
- Solve scope is the connected cluster of constraints, regardless of layer. Cross-layer constraints just join clusters. The toggle works by **suspending cross-layer constraints on the geometry being clicked on**. Suspension is persistent: those constraints are marked suspended (shown greyed), excluded from solves, and stay that way until re-enabled. Geometry that relied on a suspended constraint reports as under defined, since the constraint no longer removes DOF.
- Build a test corpus early: sketches with known DOF counts and known solutions.

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
- **Files:** the native save format is our own JSON (layers, entities, constraints, parameters, a version field). SVG export is a separate, clean output. Optionally embed the native JSON in `<metadata>` so an exported SVG can reopen fully constrained while still rendering normally in other tools.
- **Layers** export as `<g>` groups (Inkscape-style layers use `inkscape:groupmode="layer"`).
- **Units:** px only; the exported `viewBox` is in px.
- Importing arbitrary SVGs: geometry comes in unconstrained (all blue); optionally offer auto-detection of obvious relations (horizontal/vertical, coincident endpoints).

### Splines: primer and approach

- SVG only has Bézier curves natively. A **cubic Bézier segment** is 4 points: start anchor, two handles, end anchor. The curve leaves the start heading toward handle 1 and arrives at the end coming from handle 2. That's 8 DOF per segment.
- A "spline" in a drawing tool is usually a **chain of cubic Béziers** sharing anchor points. How smooth a join is:
  - **C0**: the segments just meet at the anchor (a corner is possible).
  - **G1**: tangent direction is continuous (handle, anchor, handle are collinear).
  - **C1**: G1 plus equal handle lengths (symmetric join).
  - **C2**: curvature is continuous too.
- CAD systems like SolidWorks use **NURBS/B-splines** internally: control points pull the curve toward them, with knots and weights controlling the shape. They can be converted to Bézier chains for SVG export.
- **Fit-point splines** (curve passes through points you click) are a drawing *tool*: it computes a Bézier chain from the clicked points.

**Approach:** model splines as cubic Bézier chains.

- Anchors and handles are ordinary sketch points, so every existing constraint works on them.
- "Smooth join" is a collinear constraint on handle–anchor–handle (removes 1 DOF); "symmetric join" adds equal handle lengths (1 more).
- Tangent-to-line at an endpoint is a collinear constraint between the line and the end handle.
- Import and export map directly to SVG `C` commands. Defer NURBS and fit-point tools.

**Import normalization** (SVG path commands to the internal model): relative to absolute coordinates, `H`/`V` to lines, `S` to `C`, `Q`/`T` to `C` (exact degree elevation), `A` to center-parameterized arcs, and element `transform`s applied to the points.

### Undo/redo (crucial, designed in from day one)

- Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z (and Ctrl+Y) redo must be reliable everywhere.
- **Core rule:** every change to the sketch goes through a single entry point (a transaction/dispatch function). UI code never mutates the model directly. Retrofitting undo later is painful; this rule makes it cheap.
- **Decided approach:** immutable model with snapshots and structural sharing. Each transaction produces a new model; history is a stack of model references. Simple and robust at sketch scale. Alternatives: command pattern with inverse operations (more code, easier to drift out of sync), or inverse patches (a middle path if memory ever becomes a concern).
- **Gestures coalesce:** a drag is one undo step, committed on mouse-up, not one per pixel.
- **Solved positions live in the snapshot**, so undo restores the exact previous state without needing to re-solve.
- **Compound operations are one step:** import, trim, mirror, paste, dimension edits plus their re-solve.
- Viewport (pan/zoom) is not part of history. Redo stack clears on a new edit. History is not saved in the native file by default.
- **Test idea:** apply random transactions, undo them all, and check the model equals the original.

### Import fidelity

Real-world SVGs contain much more than shapes. Import pipeline:

1. **Parse** (security approach decided) with `DOMParser` and read only geometry and whitelisted attributes. Never insert imported markup into the page (no `innerHTML`); scripts, event handlers, and external references are ignored. Rebuild our own elements from the parsed data.
2. **Resolve**: units, `viewBox`, transforms, `<use>` instances, styles.
3. **Normalize** shapes and paths into model primitives (see Import normalization above).
4. **Clean**: merge endpoints within tolerance into shared points, drop zero-length or duplicate segments, treat a `Z` closure as a real join.
5. **(Optional) infer** constraints.
6. **Build layers** and produce an **import report** listing anything skipped.

✅ marks rows that are decided; the rest are proposed defaults.

| SVG feature | Proposed default | Decision still open |
|---|---|---|
| `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` | Convert to lines/arcs/circles/ellipses. A `rect` becomes four lines with its natural relations (coincident corners, horizontal/vertical). | Rounded rects: lines + tangent arcs? |
| Elliptical arcs (`rx ≠ ry` or rotated) | Circular arcs (`rx = ry`) become arcs; true elliptical arcs become Bézier chains (approximation). | Add an elliptical-arc entity later? |
| ✅ Circles drawn as 4 Béziers (common from Illustrator) | Stay Bézier chains and are treated as their own shape type. | None for now; no circle detection. |
| ✅ Transforms (`matrix`, `rotate`, `scale`, `skew`) | Bake into point coordinates. Circles under non-uniform scale/skew become ellipses or Béziers. | None; groups lose their transform after import. |
| ✅ Size, units, `viewBox` | Scale to the size the browser would render (CSS px, 96 per inch), so px is the only unit. Export writes px `width`/`height` and `viewBox`. | None (decided: files in other units are converted to px). |
| Groups / layers | Top-level `<g>` (including Inkscape layers) become layers; nested groups flatten into their top-level layer; loose top-level shapes go to a default layer. | Keep nested group structure? |
| `<use>`, `<symbol>`, `<defs>` | Expand instances into real copies (no live link). | Support linked instances later? |
| ✅ Compound paths (holes, fill rule) | Model must remember which entities form which path/subpath, their order and direction, and the fill rule, so export can rebuild each `<path d>`. | None (decided: option B, explicit path records; see "Compound paths: options and tradeoffs"). |
| Styles (stroke, fill, opacity, classes, `<style>` blocks) | Keep presentation attributes and inline styles as an **opaque style bag** per element, so nothing is lost on re-export even though styling isn't designed yet. | How far to resolve CSS classes into inline styles. |
| ✅ Text, images, gradients, patterns, filters, clip paths, masks, markers | Not geometry: skip and list in the import report. Convert text to outlines before importing. | None; not a concern. |
| Tolerance | Merge endpoints within ~0.01 px, configurable. | Default value. |
| ✅ Auto-constraints | None, except structural ones (shared endpoints, rect relations). Optional import setting to infer horizontal/vertical/tangent joins with a tolerance, shown for review before applying. | Whether the inference setting defaults to on; lock imported geometry until constrained? |
| Re-importing our own exports | Embedded native JSON plus a hash of the exported geometry. Hash matches: load the full model with constraints. Hash mismatch (edited elsewhere): geometry-only import with a warning. | Whether to embed by default. |
| Large files | Unconstrained points cost the solver almost nothing (only constrained clusters are solved). | SVG DOM performance limits, decide later. |

### Compound paths: options and tradeoffs

The model has to answer where "this group of segments is one SVG path" lives. Requirements:

1. Export can rebuild each `<path d>` with correct subpaths, order, and direction.
2. Holes work (subpath winding plus fill rule).
3. Each path has a home for its opaque style bag (style belongs to the whole element, not to individual segments).
4. The structure survives editing (trim, split, delete, fillet, mirror) and undo.
5. The solver never has to know about it.

**Option A: membership stored on each entity** (path id, index in path, reversed flag)

- Pros: simple lookups; no second structure.
- Cons: order and subpath boundaries are scattered across entities, so every split/remove/insert must renumber siblings; style and fill rule have no natural home (duplicated per entity or an awkward "first entity holds it" convention).

**Option B: explicit path records** (`{id, layer, style, fillRule, subpaths: [{members: [{entityId, reversed}], closed}]}`)

- Pros: one place for structure, style, and fill rule; export is a straight walk; import builds records directly; a circle is a one-member path that exports as `<circle>`; the solver ignores paths; construction geometry is simply "in no path".
- Cons: two structures (geometry connectivity and path lists) can drift out of sync; edits must update both inside the same transaction; export must tolerate gaps (someone drags connected points apart) by starting a new subpath.

**Option C: derive paths from connectivity at export** (no path records)

- Pros: purely geometric model, nothing to keep in sync; closest to how SolidWorks treats contours (derived from the sketch).
- Cons: can't carry style or fill rule; can't preserve an imported path's start point, order, or direction (re-export differs from import); ambiguous where 3+ segments meet; merges separate shapes that merely touch.

**Decided: B.** Think of it as two domains linked only by IDs:

- **Constraint domain:** points, entities, constraints (what the solver sees).
- **Output domain:** paths, styles, layers (what becomes SVG).

Mitigating B's sync risk:

- Only mutate through the transaction entry point, using helpers (`splitEntity`, `removeEntity`, ...) that update path members.
- A `validate(model)` invariant check (every member exists, members share the path's layer) run in tests and after every undo/redo in dev.
- Export tolerates gaps.
- Drawing tools maintain paths automatically: a new line starts a path, a line starting at the previous end extends it, closing the loop marks it closed.

---

## 6. Roadmap

**Phase 0 — Decisions**
- Decided: own solver, SVG DOM rendering, Vite, px only, Bézier-chain splines, JSON native format, cross-layer constraints (toggleable, persistent suspend), explicit path records, snapshot-based undo/redo. Remaining: coordinate convention, cross-layer suspend UI, remaining import details

**Phase 1 — Sketch core**
- Points, lines, circles
- Coincident, horizontal, vertical, fix, distance dimensions
- Solver + DOF counter + blue/black/red status
- Drag-to-solve
- Basic SVG export + native save/load (JSON)
- Undo/redo built on the single-transaction entry point (Cmd/Ctrl+Z)

**Phase 2 — Full relation set**
- Arcs, tangent, parallel, perpendicular, equal, midpoint, symmetric, concentric
- Angle/radius/diameter dimensions
- Inference while drawing
- Constraint list panel (view/delete constraints)

**Phase 3 — Editing tools**
- Trim, extend, offset, mirror, fillet, chamfer
- Construction geometry toggle
- Layers (visibility, lock, ordering) + cross-layer constraints toggle

**Phase 4 — Parametric layer**
- Named dimensions, equations
- Cubic Bézier spline entities (needed for SVG import)
- SVG import + optional embedded-constraint round-trip

**Phase 5 — Extras**
- Patterns, blocks, fit-point / NURBS-style spline tool

---

## 7. Open questions

- **Cross-layer suspend UI:** behavior is decided (persistent). Still to settle: the affordance (modifier key, button, context menu) and how suspended constraints are shown and re-enabled.
- **Import fidelity (remaining):** rounded rects, CSS class resolution, tolerance default, whether the inference setting defaults on, whether exports embed native JSON by default.
- **Native file format:** JSON is decided; still to settle versioning/migration and whether history is ever saved.
- **Coordinate convention:** SVG is y-down. Keep y-down internally (no flipping on import/export) and pick angle conventions.
- **Export styling:** deferred. Imported styles are preserved as opaque data in the meantime.

---

## 8. Decisions log

- **Solver:** build our own (existing solvers like SolveSpace and planegcs are for inspiration only).
- **Rendering:** SVG DOM.
- **Stack:** Vite.
- **Units:** px only.
- **Layers:** wanted. Constraints can reference geometry across layers, and this must be toggleable. The toggle suspends cross-layer constraints for whatever is being clicked on at the time, and the suspension is persistent until re-enabled.
- **Import/export:** both important. SVG export is required.
- **Native save format:** JSON.
- **Splines:** cubic Bézier chains.
- **Export styling:** deferred until we get closer.
- **Undo/redo:** crucial (Cmd/Ctrl+Z); designed in from day one. Implemented as immutable model snapshots with structural sharing.
- **Compound paths:** option B, explicit path records (constraint domain and output domain linked only by IDs).
- **Import, transforms:** baked into point coordinates.
- **Import, circles drawn as four Béziers:** stay Bézier chains, treated as their own shape type (no circle detection for now).
- **Import, units:** px only; files declaring other units are converted to px (scaled to the size a browser would render).
- **Import, auto-constraints:** yes. Structural ones (shared endpoints, rect relations) apply automatically; optional inference (horizontal/vertical/tangent) is reviewable.
- **Import, non-geometry** (text, gradients, filters, etc.): skipped; not a concern.
- **Import, security:** parse and rebuild; never inject imported markup into the page.
- **IDs:** unique across every collection in a document, not merely within one, because constraints and path members reference points and entities by bare id.
- **Horizontal/vertical constraints:** stored as a point pair in v1 (not an entity reference), so every v1 constraint references points only. The UI resolves a picked line to its endpoints.
- **Gesture grouping:** `dispatch` coalesces by a caller-supplied gesture token rather than explicit begin/end calls, so a drag is one undo step. The caller mints a fresh token per gesture.
- **History depth:** uncapped for now; structural sharing makes snapshots cheap, and inverse patches remain the answer if memory becomes a concern.
- **Rank and nullspace:** Householder QR with column pivoting, not SVD. One decomposition serves rank, nullspace and least squares. Column norms are recomputed rather than downdated, trading a little speed for the accuracy that definition status depends on.
- **Dragging:** the cursor is a goal, not a constraint. A drag solves in two passes (pull toward the cursor, then restore the real constraints on their own), so it can never break a relation to reach the cursor, and it never changes the sketch's definition status. Dragging fully defined geometry moves nothing.
- **Solver residual units:** every residual is in px, including point-on-line, which uses signed distance rather than the raw cross product. Levenberg-Marquardt damps all rows with one lambda, so mixed units would weight them wrongly.
- **Circle radius is a solver variable**, giving a circle the plan's 3 DOF.
- **Conflict reporting:** an over-defined sketch names every constraint whose removal would not reduce the Jacobian's rank, i.e. the whole dependent group rather than a guess at which one is wrong.

---

## 9. Changelog

- 2026-09-20: Initial planning doc created.
- 2026-09-20: Recorded first round of decisions (solver, rendering, stack, units, layers, import/export); added spline primer.
- 2026-09-20: Decided cross-layer constraints (toggleable), Bézier-chain splines, JSON native format; deferred export styling; added undo/redo and import fidelity sections.
- 2026-09-20: Decided cross-layer suspend behavior and import defaults (transforms, Bézier circles, units, auto-constraints, non-geometry, security); added compound-path options and tradeoffs.
- 2026-09-20: Decided persistent cross-layer suspend, path records (option B), and snapshot-based undo/redo.
- 2026-09-21: Step 1 (document model and `validate`) built; recorded the ID-uniqueness and horizontal/vertical-as-point-pair decisions.
- 2026-09-21: Step 2 (history) built; recorded the gesture-token and history-depth decisions. CI now runs typecheck, tests and build on every push.
- 2026-09-21: Step 3a (linear algebra) built on pivoted Householder QR; the rectangle's Jacobian confirms 0 DOF fully defined, 1 DOF without the width dimension, and rank 7 from eight rows when the width is dimensioned twice.
- 2026-09-21: Step 3b (solver v0) built: all eight v1 constraints with analytic Jacobians checked against finite differences, LM iteration, DOF and per-entity status, conflict reporting, and two-pass dragging. Phase 1's core (model, history, solver) is complete.
