# Parametric SVG Sketcher — Planning Doc

**Status:** Phase 1 complete. Phase 2 all but two steps.
**Started:** 2026-09-20 · **Last reviewed:** 2026-09-22

This document is the *intent*: what we are building and why. It is kept as a
record, so where the implementation went another way the section says so rather
than being quietly rewritten — see [§9 Where the build differs from this
plan](#9-where-the-build-differs-from-this-plan).

- How it was built, step by step: [`EXECUTION.md`](EXECUTION.md)
- How the solver works, in plain terms: [`SOLVING.md`](SOLVING.md)

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

**Built.** All four, per entity *and* per point, plus a count in the status bar.

| Color | Meaning | In the code |
|---|---|---|
| Blue | Under defined: free degrees of freedom remain | `is-under`, `#2f6fde` |
| Black | Fully defined: zero degrees of freedom | `is-full`, `#20262c` |
| Red | Over defined: redundant or conflicting constraints | `is-over`, `#d6362b` |
| Yellow | Solver couldn't find a valid solution | status `unsolved` |

---

## 3. How to fully define geometry (degrees of freedom)

**Core idea:** every entity has a number of numeric variables (degrees of freedom, DOF). Every constraint removes some. A sketch is **fully defined when DOF = 0**.

### DOF per entity

| Entity | Variables | DOF | Built? |
|---|---|---|---|
| Point | x, y | 2 | yes |
| Line segment | two endpoints | 4 | yes |
| Infinite line / construction line | point + angle | 2 | no |
| Circle | center (2) + radius | 3 | yes |
| Arc | center (2) + radius + start angle + end angle | 5 | yes, **stored differently** |
| Ellipse | center (2) + two radii + rotation | 5 | no |
| Cubic Bézier segment | 4 control points | 8 | no (Phase 4) |
| Spline (n control points) | 2 per control point | 2n | no (Phase 4) |

**The arc is stored as three points** — centre, start, end — plus a direction
flag, not as centre/radius/angles. Kept the plan's way, an arc's endpoints
would be *derived* values and no line could ever share a point with an arc,
which is how this model keeps its topology explicit. The solver adds one
implicit constraint per arc (both endpoints equidistant from the centre), so
the arithmetic still lands on 5: six variables minus one. See
[`SOLVING.md`](SOLVING.md) for the worked count.

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

### v1 (MVP) — built

- Geometric: coincident, point-on-object, horizontal, vertical, fix
- Dimensional: distance (point–point / line length), horizontal distance, vertical distance

Horizontal and vertical are **stored as a point pair**, not an entity
reference. The plan allows either; picking points keeps every v1 constraint
referencing points alone, and the UI resolves a picked line to its endpoints.

### v2 — geometric relations built, dimensions not yet

- Geometric: parallel, perpendicular, tangent, equal, collinear, concentric, midpoint, symmetric — **all built** (Step 10)
- Dimensional: angle, radius, diameter, point–line distance — **not yet** (Step 11)
- Reference (non-driving) dimensions — **not yet** (Step 11)

Two relations turned out to need care, both recorded in §8:

- **Tangency has two forms.** At a join (the line ends where the arc begins)
  it must be stated as perpendicularity of the radius at the shared point;
  distance-to-line-equals-radius is degenerate there and removes no freedom at
  all. Without a shared point, the distance form is the right one.
- **Equal** means length for lines and radius for circles and arcs, never one
  against the other.

### Later — not started

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

**Built**, in `src/core/solver/`: dense pivoted Householder QR for rank and
nullspace (`linalg.ts`), residuals and Jacobians (`residuals.ts`,
`v2-residuals.ts`), Levenberg-Marquardt with status and conflict reporting
(`solve.ts`). The v2 Jacobians come from a small forward-mode autodiff
(`autodiff.ts`) rather than hand derivation. Clustering is **not** built: every
solve still touches the whole sketch.

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

Status as of 2026-09-22: **Phase 0 and Phase 1 complete. Phase 2 is at 4 of 6
items**, with angle/radius/diameter dimensions and the relations panel's last
pieces outstanding. Phases 3 to 5 are untouched. Step-by-step detail is in
[`EXECUTION.md`](EXECUTION.md).

**Phase 0 — Decisions ✅**
- Decided: own solver, SVG DOM rendering, Vite, px only, Bézier-chain splines, JSON native format, cross-layer constraints (toggleable, persistent suspend), explicit path records, snapshot-based undo/redo. Coordinate convention settled (y-down throughout, clockwise-positive angles). Still open: cross-layer suspend UI, remaining import details

**Phase 1 — Sketch core ✅**
- Points, lines, circles
- Coincident, horizontal, vertical, fix, distance dimensions
- Solver + DOF counter + blue/black/red status
- Drag-to-solve
- Basic SVG export + native save/load (JSON)
- Undo/redo built on the single-transaction entry point (Cmd/Ctrl+Z)

**Phase 2 — Full relation set** (4 of 6)
- ✅ Arcs, tangent, parallel, perpendicular, equal, midpoint, symmetric, concentric, collinear
- ⬜ Angle/radius/diameter dimensions
- ✅ Inference while drawing (horizontal and vertical; tangent inference now possible but not wired)
- ✅ Constraint list panel (view, delete, suspend) — selecting a relation to highlight what it acts on is still to come
- ➕ Not in the original plan, added because the UI needed them: the editor
  chrome from the mockup, an adaptive drawing grid with snapping, and delete

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

Settled since this list was written:

- ~~**Coordinate convention**~~ — y-down throughout, no flipping on import or
  export. Angles follow from that: increasing angle is clockwise on screen,
  which is also SVG's sweep-flag 1. See `core/geometry.ts`.
- ~~**Whether the inference setting defaults on**~~ — on in the app, off in the
  editor API, since it changes both where a click lands and what the document
  ends up containing.

Still open:

- **Cross-layer suspend UI:** behavior is decided (persistent) and suspend/resume
  works from the relations panel. Still to settle: the affordance for
  suspending *because* a relation crosses layers, and how that reads on the
  canvas. Layers themselves have no UI yet.
- **Import fidelity (remaining):** rounded rects, CSS class resolution, tolerance default, whether exports embed native JSON by default.
- **Native file format:** JSON is decided, with a version field and a refusal to read a newer one; still to settle migrations and whether history is ever saved.
- **Dimension placement:** annotations are positioned by rule (outward from the drawing's centre, repeats stacked). Letting the user drag one needs a field on the constraint, so it waits.
- **How two round things touch:** outside or inside is read from where the geometry currently sits, because the constraint does not record it. Dragging one circle through another can flip the meaning.
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
- **Rendering status:** carried by `currentColor` and one class per element (`is-full`, `is-under`, `is-over`), matching the mockup. Points are drawn once in their own group and coloured by their own freedom, which is why the solver reports per-point status as well as per-entity.
- **Canvas draws entities, not paths.** Path records are the output domain and belong to export; the canvas wants one element per entity for hit-testing and per-entity colour.
- **Line weight is screen-constant** (`vector-effect="non-scaling-stroke"`, dot radius divided by zoom), so zooming never reads as a change to the drawing.
- **Dragging a point** re-solves with that point pinned and writes the solved document back under one gesture token, so a drag is one undo step.
- **Drawing on an existing point reuses it**, so joined segments share a point rather than relying on a coincident constraint. Structural topology stays explicit, as the data model section intends.
- **A chain of segments drawn end to end becomes one path record**, which is how the drawing tools keep the output domain in step with the geometry.
- **Every edit commits its solve** into the same transaction, so solved positions live in the snapshot as intended. A solve that did not converge is not committed: an over-defined sketch keeps the user's own geometry, in red, rather than a least-squares compromise.
- **Duplicate relations are refused** at the command layer rather than left to the solver to report as redundancy.
- **Smart dimension** picks the axis the two points are most separated along, falling back to a straight-line distance on a diagonal.
- **Dimension placement is derived**, not stored: annotations sit on the far side of the drawing from its centre, and repeats stack. A user-chosen offset needs a schema field and waits for the dimension-placement work.
- **SVG export builds strings, not DOM**, so it runs anywhere; tests parse the output with a real parser to check it is genuinely valid SVG.
- **A subpath exports closed only when the walk returned to where its current run started.** `Z` closes to the last `M`, so closing a path with a gap in it would draw an edge the sketch does not have.
- **Loading a native file validates before returning it**, failing with a message that names the problem. Files from a newer version are refused rather than half-read.
- **Hidden layers export hidden** rather than being dropped, so a round trip loses nothing.
- **Grid spacing adapts through a 1-2-5 ladder** rather than being fixed, so lines stay a usable distance apart on screen at any zoom while every spacing remains a round number.
- **Snapping never overrides an existing point**, and is opt-in at the editor API so callers do not inherit a change to where their clicks land.
- **Deleting a point cascades** to the entities that referenced it and the constraints that named it: anything else would leave a dangling reference that `validate` rejects.
- **Inference moves the point as well as adding the relation.** Adding the relation alone leaves a kink the next solve pulls out, which reads as the line jumping; moving alone gives a sketch that looks right and falls apart when anything moves.
- **Coincident is not inferred**, because reusing a clicked point already shares it, which is the stronger statement. A joined point is never nudged onto an axis, since that would move the geometry it is shared with.
- **The v2 relations' Jacobians come from forward-mode autodiff**, not hand derivation; the v1 ones stay hand-derived. Finite-difference tests check both.
- **Angular residuals are dimensionless** (the sine or cosine of an angle) while distance residuals are px. Forcing angles into px would mean choosing a length to scale by, and the answer would differ for a short line and a long one.
- **Tangency at a join is stated as perpendicularity of the radius at the shared point**, not as distance-to-line equals radius: the latter sits on the boundary of an inequality, so its gradient is zero and it removes no freedom. Without a shared point the distance form is correct and is used.
- **How two round things touch** — outside or inside — is read from where the geometry currently sits, since the constraint does not record it.
- **Arcs are stored as three points** (centre, start, end) plus a direction flag, not as centre/radius/angles. Radius is derived, endpoints are ordinary points that lines and arcs can share, and the solver adds one implicit constraint per arc (the endpoints are equidistant from the centre) so the DOF still come to 5, as the DOF table says.

---

## 9. Where the build differs from this plan

Every row is a place the implementation went another way. The plan above is
left as written; this is the ledger.

| What the plan said | What was built | Why |
|---|---|---|
| Arc = centre, radius, start angle, end angle | Arc = centre, start and end **points**, plus a direction flag. Radius derived; one implicit equal-radius constraint per arc | Stored the plan's way, an arc's endpoints are derived values and no line can share a point with an arc. Shared points are how this model keeps topology explicit. The DOF still come to 5 |
| Horizontal / vertical apply to "a line or two points" | Stored as a **point pair**; the UI resolves a picked line to its endpoints | Keeps every v1 constraint referencing points only, so the solver's variable mapping stays simple |
| "Analytic or finite-difference Jacobian" | v1 residuals hand-derived; **v2 residuals from forward-mode autodiff** | Eight more derivations, each involving a normalised direction or a distance to a line, is where a sign error hides until a sketch quietly refuses to solve. Both are checked against finite differences |
| Residuals implicitly all in px | Distance residuals in px; **angular residuals dimensionless** (sine or cosine of an angle) | Forcing an angle into px means choosing *which* length to scale by, and the answer would differ for a short line and a long one |
| Tangent is one constraint | **Two formulations**, chosen by whether the two entities share a point | At a join, distance-to-line-equals-radius sits on the boundary of an inequality, so its gradient is zero and it removes no freedom. A slot reported 4 DOF until this was fixed |
| Inference covers "horizontal, vertical, coincident, tangent" | Horizontal and vertical only | Coincident is already covered by reusing a clicked point, which shares it — a stronger statement. Tangent inference became possible only with Step 10 and is not wired up yet |
| Dimensions have a placement | Placement is **derived**: outward from the drawing's centre, repeats stacked | Storing a user-chosen offset needs a field on the constraint, which belongs with the dimension-placement work |
| (not mentioned) | A **drawing grid** with 1-2-5 adaptive spacing and snapping | The canvas needed somewhere to put things. Snapping is on in the app, off in the editor API |
| (not mentioned) | **Delete**, cascading from a point to the geometry that used it | Undo was the only way to remove anything |
| Landing page is the entry point | The **editor** is the app at `/`; the landing page moved to `/about.html` | Once there was an editor, the app should be the app |
| Solver splits into independent clusters (later optimisation) | Not built: every solve touches the whole sketch | No sketch has been large enough to need it. Still the right next optimisation |

### Things the plan was right about, worth saying

- **One transaction entry point.** Every change goes through `dispatch`, and
  retrofitting undo was never necessary. A drag coalesces to one step by
  carrying a gesture token.
- **Rank, not subtraction.** Counting constraints would have called the first
  slot fully defined. The Jacobian's rank caught that four tangencies were
  removing nothing.
- **Explicit path records (option B).** Export is a straight walk, and the
  predicted drift risk showed up exactly where predicted — a deleted entity
  left behind in a path — which `validate` and the edit helpers now prevent.
- **Core before UI.** The solver was finished and tested before anything was
  drawn, and every UI bug since has been a UI bug rather than a solver bug.

---

## 10. Changelog

- 2026-09-20: Initial planning doc created.
- 2026-09-20: Recorded first round of decisions (solver, rendering, stack, units, layers, import/export); added spline primer.
- 2026-09-20: Decided cross-layer constraints (toggleable), Bézier-chain splines, JSON native format; deferred export styling; added undo/redo and import fidelity sections.
- 2026-09-20: Decided cross-layer suspend behavior and import defaults (transforms, Bézier circles, units, auto-constraints, non-geometry, security); added compound-path options and tradeoffs.
- 2026-09-20: Decided persistent cross-layer suspend, path records (option B), and snapshot-based undo/redo.
- 2026-09-21: Step 1 (document model and `validate`) built; recorded the ID-uniqueness and horizontal/vertical-as-point-pair decisions.
- 2026-09-21: Step 2 (history) built; recorded the gesture-token and history-depth decisions. CI now runs typecheck, tests and build on every push.
- 2026-09-21: Step 3a (linear algebra) built on pivoted Householder QR; the rectangle's Jacobian confirms 0 DOF fully defined, 1 DOF without the width dimension, and rank 7 from eight rows when the width is dimensioned twice.
- 2026-09-21: Step 3b (solver v0) built: all eight v1 constraints with analytic Jacobians checked against finite differences, LM iteration, DOF and per-entity status, conflict reporting, and two-pass dragging. Phase 1's core (model, history, solver) is complete.
- 2026-09-21: Step 4 (read-only renderer) built: layers as groups, entities as elements, status colours from the solver, pan and zoom. Colours verified in a real browser, not only in jsdom.
- 2026-09-21: Step 5 (editing v0) built: document edit helpers, hit testing, select and line tools, drag-to-solve, undo/redo on the keyboard, and an editing sandbox at sketch.html. Driven end to end in a real browser.
- 2026-09-21: Step 6 (constraints and dimensions UI) built: multi-selection, relation commands with the mockup's shortcuts, smart dimensions drawn on the canvas, and an editable relations panel. The plan's rectangle can now be drawn by hand and watched go blue to black. Phase 1 has one step left.
- 2026-09-21: Step 7 (native JSON save/load and SVG export) built, completing Phase 1. The editor is now the app at `/`, with the landing page at `/about.html`.
- 2026-09-21: Phase 2 broken into Steps 8-13; decided arcs are stored as three shared points plus a direction flag rather than centre/radius/angles, so endpoints can be shared with other geometry.
- 2026-09-21: Step 8 (arcs in the core) built: the arc entity, its implicit equal-radius constraint, point-on an arc, and DOF and per-entity status. An arc reports 5 DOF and shares endpoints with lines without a coincident constraint.
- 2026-09-21: Step 9 (arcs in the UI and export) built: arc rendering, rim hit testing within the sweep, a centrepoint arc tool that takes its direction from the traced sweep, and `A` commands on export. Shared geometry moved to `core/geometry.ts`, restoring the `ui -> io -> core` dependency rule.
- 2026-09-22: Chrome rebuilt on the mockup (icon tool rail, panels, view HUD, status bar); added an adaptive drawing grid with snapping, and delete.
- 2026-09-22: Step 12 (inference while drawing) built: horizontal and vertical inferred as you draw, with the point moved onto the axis and a hint shown before the click commits. Tangent waits for the tangent constraint in Step 10.
- 2026-09-22: Fixed two bugs of one shape found by driving the app: `referencedPoints` and the renderer's conflict check each listed an entity's points by hand and, because `center` exists on both a circle and an arc, silently ignored an arc's endpoints. Both now go through `entityPointIds`.
- 2026-09-22: Step 10 (the rest of the relation set) built: parallel, perpendicular, collinear, tangent, equal, concentric, midpoint and symmetric, with autodiff-derived Jacobians checked against finite differences. A slot now solves to 0 DOF.
- 2026-09-22: Documentation pass. Marked what is built through the plan, added §9 recording every place the build differs from it, and wrote `SOLVING.md` explaining degrees of freedom, rank, and what the status colours mean, with each claim tied to the test that proves it.
- 2026-09-22: Code-review pass. Fourteen findings fixed, each pinned by a test verified to fail without its fix: the id generator not advancing on `load` (which silently *overwrote* loaded geometry rather than colliding), shortcuts firing while typing in a dimension field, zero-gradient rows counted as rank deficiency, a per-constraint QR in the conflict finder that froze dragging, a grid that dropped an entire axis instead of coarsening, and a `viewBox` guard an order of magnitude below the precision it was printed at. `editor.ts` (907 lines) and `main.ts` (469) were split along their seams; `docs/PITFALLS.md` records the bug *classes* behind the findings.
