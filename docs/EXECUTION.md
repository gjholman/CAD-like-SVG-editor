# Execution Plan

How we build the CAD-like SVG editor, in small steps. The *what* and *why* live in
[`svg-cad-plan.md`](svg-cad-plan.md); this file is the *how* and *in what order*.

**Status** (2026-09-22): Phase 1 complete. Phase 2 has two steps left.

| Step | | |
|---|---|---|
| 0 | Scaffold, tests, landing page | ✅ |
| 1 | Document model and `validate` | ✅ |
| 2 | History: dispatch, snapshots, undo/redo | ✅ |
| 3a | Linear algebra: rank, nullspace, least squares | ✅ |
| 3b | Solver v0: LM, DOF, definition status | ✅ |
| 4 | Read-only renderer, pan and zoom | ✅ |
| 5 | Editing v0: select, line, drag, undo | ✅ |
| 6 | Constraints and dimensions UI | ✅ |
| 7 | Native JSON save/load, SVG export | ✅ |
| 8 | Arcs in the core | ✅ |
| 9 | Arcs in the UI and export | ✅ |
| 10 | The rest of the relation set | ✅ |
| 11 | Angle, radius and diameter dimensions | ⬜ |
| 12 | Inference while drawing | ✅ |
| 13 | Relations panel: highlighting, cross-layer suspend | ◐ suspend and delete done |
| — | Chrome rebuild, grid, snapping, delete (added out of order) | ✅ |

**554 tests** across 27 files. `npm run typecheck`, `npm run test:run` and
`npm run build` all clean, and CI runs the three on every push.

Reading order for someone new: [`../README.md`](../README.md) for what it is,
[`SOLVING.md`](SOLVING.md) for how the solver works and what the colours mean,
[`svg-cad-plan.md`](svg-cad-plan.md) for the design intent and where the build
differs from it, then this file for the order things were built in.
A first UI mockup is in [`mockups/ui-mockup-v1.html`](mockups/ui-mockup-v1.html);
Steps 4 to 6 work from it.

---

## 1. Working agreements

- **Baby steps.** Every step ends green (tests pass, typecheck passes) and is committed before the next begins. Commit messages look like `step-1: document model types`.
- **Core before UI.** The model, history, and solver are built and tested with no interface at all. The UI comes after they work.
- **Tests alongside the code.** For `src/core/`, write the test with (or before) the code. Numeric results use `toBeCloseTo`, never exact equality.
- **One entry point for change.** Every edit to the document goes through history `dispatch`. UI code never mutates the model directly (this is what makes undo cheap).
- **Few dependencies.** Right now: Vite, Vitest, TypeScript. Later, only when a step needs it: `jsdom` (DOM tests for SVG import/export), maybe Playwright (end-to-end).
- **Keep the plan alive.** When a step settles a decision, update `svg-cad-plan.md` (decisions log + changelog).

### Assumptions to confirm

- **TypeScript.** Vite supports it with zero config, and the data model (points, entities, constraints, paths, layers) is a large typed schema that benefits from it. If you'd rather use plain JavaScript, the scaffold converts easily.
- **Coordinates are y-down**, matching SVG (no flipping on import/export).
- **Vitest** for tests, since it shares Vite's config and transforms.

---

## 2. File structure

```
CAD-like-SVG-editor/
├── index.html              the editor (Vite entry point), with the icon sprite
├── about.html              landing page, links into the editor
├── vite.config.ts          Vite + Vitest config, two page entries
├── docs/
│   ├── svg-cad-plan.md     design intent, decisions, and where the build differs
│   ├── EXECUTION.md        this file: the order things were built in
│   ├── SOLVING.md          how solving works, in plain terms
│   └── mockups/            ui-mockup-v1.html, the chrome's design source
├── src/
│   ├── main.ts             mounts the editor and wires the chrome
│   ├── landing.ts          entry for the landing page
│   ├── styles/
│   │   ├── app.css         editor chrome
│   │   ├── canvas.css      the drawing itself: status colours, grid, dimensions
│   │   └── landing.css
│   ├── core/               pure logic, NO DOM
│   │   ├── geometry.ts     bounds and arc maths, shared by io and ui
│   │   ├── model/          types, validate, edit helpers, ids
│   │   ├── solver/         linalg, residuals, autodiff, solve
│   │   └── history/        dispatch, snapshots, undo/redo
│   ├── io/                 native JSON save/load, SVG export (import in Phase 4)
│   └── ui/
│       ├── render/         canvas, viewport, grid, dimensions
│       └── editor/         tools, hit testing, commands, inference
└── tests/
    └── fixtures/           the rectangle, and a seeded random-edit generator
```

### Dependency rule

```
ui  ->  io  ->  core
```

`core` imports nothing from `io` or `ui`. `io` may use DOM APIs (`DOMParser`) for SVG import. `ui` uses the DOM freely.

Geometry that both `io` and `ui` need (bounds, arc angles and sweeps) lives in
`core/geometry.ts`. Putting it in `ui` and importing it from `io` inverts this
rule, which is how it went wrong once already.

This maps onto the two domains in the plan: `core/model` holds the **constraint domain** (points, entities, constraints) and the **output domain** (paths, styles, layers), linked only by IDs; the solver only ever sees the first.

---

## 3. Test setup

**Tool:** Vitest, configured in `vite.config.ts`.

- **Default environment is Node**, not a browser. A stray `document` or `window` in `src/core` fails immediately. (`smoke.test.ts` checks this on purpose.)
- **Tests that need a DOM** opt in per file with `// @vitest-environment jsdom` on the first line. `jsdom` is installed as of Step 4; `render.test.ts` is the first file to use it.
- **Location:** unit tests sit next to the code (`solver.test.ts` beside `solver.ts`). Cross-module tests and fixtures live in `tests/`.
- **Scripts:** `npm test` (watch), `npm run test:run` (once), `npm run typecheck`.

### What each layer tests

| Layer | What we test |
|---|---|
| `core/model` | `validate()` catches dangling references, path members on different layers, duplicate IDs |
| `core/history` | Apply random transactions, undo them all, and the document equals the original. Redo, redo cleared by new edit, a drag gesture is one step |
| `core/solver` | The rectangle from the plan (16 DOF, down to 0). Redundant vs conflicting constraints. Dimension edits move geometry. Drag simulation. A growing corpus of known sketches with known DOF |
| `io` | JSON save then load equals the original. SVG export then import round-trips. Import fixtures. Scripts and event handlers in imported SVG are ignored |
| `ui` | Light: element counts after rendering. Later, a few Playwright flows (draw a line, add a dimension, undo) |

---

## 4. Setup (Step 0)

From the repo root:

```bash
unzip -n ~/Downloads/CAD-like-SVG-editor-starter.zip -d .   # -n keeps any files you already have
mkdir -p docs && git mv svg-cad-plan.md docs/                # skip if the plan is already in docs/
npm install -D vite vitest typescript
npm run dev          # landing page at the URL Vite prints
npm run test:run     # should pass 2 tests
npm run typecheck
git add -A && git commit -m "step-0: scaffold, tests, landing page"
```

Dependency versions are not pinned in the starter; `npm install -D` picks current ones and records them in `package.json` and the lockfile.

**Done when:** the landing page loads, both tests pass, typecheck is clean, and it's committed.

### Landing page

A placeholder until the UI design pass. It's laid out like a drawing sheet (ruled border, graph-paper drawing area, title block) and uses the editor's own status colors: blue for under defined, ink for fully defined, red for over defined. The hero sketch has one animation (it gets pinned down on load) that respects `prefers-reduced-motion`. Fonts (Barlow, Barlow Semi Condensed) load from Google Fonts with system fallbacks. Everything on it is described as planned, since nothing else exists yet.

---

## 5. Steps

Phase 1 from the plan, broken into small pieces. Each lists the files it adds and what "done" means.

### Design checkpoint (next conversation)

UI design for the editor itself: layout, tool palette, constraint and dimension interactions, status display. Feeds Steps 4 to 6. Steps 1 to 3 don't depend on it, so they can start in parallel.

### Step 1: Document model — done

- **Adds:** `core/model/` with types for `Point`, entities (`Line`, `Circle`, later `Arc`, `BezierChain`), `Constraint` (v1 kinds), `Path` record, `Layer`, `Document`; an injectable ID generator (so tests get predictable IDs); `validate(doc)`.
- **Tests:** `validate` accepts good documents and reports each kind of broken reference.
- **Done when:** a hand-built rectangle document (four lines, shared points, a closed path record) validates.

Delivered as `src/core/model/{ids,types,validate}.ts`, with the rectangle in
`tests/fixtures/rectangle.ts` (it seeds the solver corpus in Step 3b too).
`validate` reports every problem in one pass, each tagged with an `IssueCode`:
dangling references, ids reused across collections, a record filed under the
wrong key, non-finite numbers, path members on the wrong layer or claimed by
two paths, construction geometry inside a path, empty subpaths, and a
`layerOrder` that doesn't match the layer set.

Two things settled while building it:

- **IDs are unique document-wide**, not just within a collection, since
  constraints and path members reference points and entities by bare id.
  `createIdGenerator` runs one counter across all prefixes to guarantee it.
- **Horizontal and vertical store a point pair** in v1, not an entity. The plan
  allows either; picking points keeps every v1 constraint referencing points
  alone, which keeps the solver's variable mapping simple. The UI resolves a
  picked line to its two endpoints.

### Step 2: History (undo/redo) — done

- **Adds:** `core/history/` with `createHistory(doc)`, `dispatch(transaction)`, `undo`, `redo`, and gesture grouping (a drag is one step).
- **Design:** immutable documents with structural sharing; history is a stack of document references (decided in the plan).
- **Tests:** the undo-everything property test, redo behavior, redo cleared by new edits, gesture coalescing.
- **Done when:** the property test passes over a few hundred random transaction sequences.

Delivered as `src/core/history/history.ts`. A `History` is itself an immutable
value, so `dispatch`, `undo` and `redo` return a new one rather than mutating;
the UI will keep the latest in a store. `Transaction` is `(doc) => doc`, and a
transaction that returns its input unchanged records no undo step and leaves
the redo stack alone.

The property test runs 300 seeded sequences of 25 random edits
(`tests/fixtures/random-edits.ts`), checking `validate` after every edit and
then undoing back to the start. It asserts **reference** equality with the
original document, not deep equality, which is what proves nothing was mutated
along the way. Three deliberate bugs (ignoring the gesture token, cloning the
document on create, not clearing the redo stack) were each checked to fail the
suite.

Settled while building it:

- **Gestures coalesce by token.** `dispatch(history, tx, { gesture })` replaces
  the present entry when the token matches the last one, so a drag is one step.
  The caller mints a fresh token per gesture on pointer-down; reusing a token
  after an ordinary edit correctly starts a new step.
- **Stack depth is uncapped.** Snapshots share structure, so they are cheap,
  and the plan already names inverse patches as the answer if memory ever
  becomes a concern. Revisit only with evidence.
- **Labels live on entries**, so `undoLabel`/`redoLabel` can drive the menu and
  the mockup's undo tooltip.

`removeEntity` (drop an entity and clean it out of path records, constraints
and emptied subpaths) lives in the test fixture for now. It belongs in `src`
as a real editing helper in Step 5.

### Step 3a: Small linear algebra — done

- **Adds:** `core/solver/linalg.ts`: dense matrices, solve a linear system, rank and nullspace (QR with pivoting, or SVD).
- **Tests:** known matrices with known rank and nullspace; a well-conditioned solve.
- **Done when:** rank and nullspace are trustworthy on hand-checked cases.

Delivered as `src/core/solver/linalg.ts`, built on one rank-revealing
decomposition — Householder QR with column pivoting — that answers all three
questions Step 3b asks: `rank` (for DOF and definition status), `nullspace`
(for per-entity blue/black colouring), and `solveLeastSquares` (the
Gauss-Newton step).

The tests include a hand-written Jacobian for the plan's rectangle, which is
the real de-risking for Step 3b: with both dimensions it has rank 8 and an
empty nullspace (0 DOF, fully defined); drop the width dimension and it drops
to rank 7 with a single free direction, and that direction is exactly the two
right-hand corners sliding in x together. Dimensioning the width twice gives
eight constraint rows at rank 7 — the redundancy the plan warns simple
subtraction cannot see.

Settled while building it:

- **QR with column pivoting, not SVD.** One decomposition covers rank,
  nullspace and least squares, at a fraction of SVD's code. Revisit only if
  rank decisions near the tolerance prove flaky in practice.
- **Column norms are recomputed, not downdated.** Downdating is the usual
  optimisation but loses accuracy as it goes. At sketch scale the recompute is
  the same order as the factorisation, and rank is what decides whether the UI
  calls a sketch fully defined, so accuracy wins.
- **Rank-deficient least squares returns a basic solution** (free variables at
  zero), not the minimum-norm one. LM damping makes the stacked system full
  rank in 3b, so it never bites; the returned `rank` says when it would.
- **The Householder sign choice is load-bearing** and now has a test. Measured
  on near-cancellation matrices, choosing the sign toward `x[0]` instead of
  away costs about six digits (7.8e-9 against 5.3e-15).

### Step 3b: Solver v0 — done

- **Adds:** `core/solver/` with variables from points; constraints: fix, coincident, horizontal, vertical, point-to-point distance; damped Gauss-Newton / Levenberg-Marquardt; DOF from Jacobian rank; per-entity status from the nullspace.
- **API:** `solve(doc) -> { positions, dof, status, conflicts }`, pure and DOM-free.
- **Tests:** the plan's rectangle worked example, redundant vs conflicting detection, editing a dimension moves geometry, simulated drag.
- **Done when:** the rectangle example reports 0 DOF after the last constraint is added, and a contradiction is reported as over defined.

Delivered as `variables.ts` (document to variable vector), `residuals.ts`
(constraint equations and their analytic derivatives) and `solve.ts` (the LM
loop and status). All **eight** v1 constraint kinds are implemented, not the
five listed above: the model defines them all and the rectangle fixture uses
the horizontal and vertical distance dimensions, so stopping at five would have
left `validate` accepting documents the solver could not read.

`solve` returns positions, radii, `dof`, `status`, per-entity status,
`conflicts`, `converged`, `iterations` and the worst residual. `applySolution`
turns a result into a new document for `dispatch` to record.

Settled while building it:

- **Dragging is two passes, not one objective.** The first draft put the cursor
  in with the real constraints at equal weight, and a test caught it moving a
  *fixed* corner to y=25 to meet the cursor halfway. A drag that breaks a `fix`
  is simply wrong. Now pass one pulls toward the cursor and pass two re-solves
  the real constraints alone, landing back on the constraint manifold nearest
  the cursor. Pins are excluded from status too, so dragging fully defined
  geometry moves nothing and stays black rather than turning red.
- **Circle radius is a solver variable**, matching the plan's 3 DOF for a
  circle, so an undimensioned circle correctly reports a free radius.
- **All residuals are in px**, including point-on-line, which divides the cross
  product by the line length to give a signed distance rather than an area. One
  lambda damps every row, so mixed units would weight rows wrongly.
- **`fix` anchors to the document's stored position.** The solver starts there,
  so the residual starts at zero and stays there.
- **Conflicts name the whole dependent group:** every constraint whose removal
  would not reduce the rank. For two contradictory dimensions that means both,
  which is honest — either could be the wrong one.
- **Redundant-but-consistent is over defined** (red), per the plan. A separate
  `unsolved` status carries the plan's yellow, for when no solution is found
  from the current starting point.

The Jacobian is hand-derived, so every constraint kind is checked against
central differences at fixed *and* random configurations. A solver with a wrong
Jacobian often still converges, just slowly, so convergence tests alone would
not catch one.

### Step 4: Read-only renderer — done

- **Adds:** `ui/render` that draws a document into the SVG DOM: layers as `<g>`, entities as elements, status colors from the solver result; pan and zoom.
- **Done when:** the hand-built rectangle from Step 1 renders, black once fully defined and blue while loose.

Delivered as `src/ui/render/viewport.ts` (pan and zoom, pure arithmetic, tested
in plain Node) and `src/ui/render/render.ts` (the DOM), with canvas styling in
`src/styles/canvas.css`. Colours and line weights come from the mockup, so the
two stay in step. `jsdom` joins the dev dependencies for the first DOM tests.

Read-only means read-only: the renderer produces elements and nothing else. No
event handlers, no document mutation. Tools arrive in Step 5.

Settled while building it:

- **Status rides on `currentColor`.** One class per element (`is-full`,
  `is-under`, `is-over`) sets `color`, and strokes and dots pick it up. Same
  trick the mockup uses.
- **Points are drawn once, in their own group**, coloured by their *own*
  freedom. That needed a new `pointStatus` on the solver result: an entity is
  under defined when *either* endpoint can move, so its status cannot say which
  endpoint is the loose one. Same nullspace test, no extra work.
- **Entities are drawn individually, not through path records.** Path records
  are the output domain and belong to export (Step 7); the canvas wants one
  element per entity so it can be hit-tested and coloured on its own.
- **Only implicated geometry turns red.** An over-defined sketch colours the
  entities touched by a reported conflict, not the whole drawing.
- **Stroke width and dot size are constant on screen**, via
  `vector-effect="non-scaling-stroke"` and a dot radius divided by the zoom.
  Line weight that grew with zoom would read as a drawing change.
- **The whole subtree is rebuilt on each call.** No diffing yet: at sketch
  scale it is fast and it removes a class of stale-DOM bugs. This is the first
  place to look if dragging a large sketch ever feels slow.

jsdom checks structure but does not paint, so the colours were also verified in
real Chromium: `rgb(32,38,44)` for fully defined, `rgb(47,111,222)` for under
defined, `rgb(214,54,43)` for over defined, and a dashed grey centreline for
construction geometry.

### Step 5: Editing v0 — done

- **Adds:** select tool, line tool, drag a point (solver runs during the drag), all through `dispatch`; Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z wired to history.
- **Done when:** you can draw a line, drag it, and undo/redo it.

Delivered as `src/core/model/edits.ts` (pure document edits), `src/ui/editor/`
(hit testing and the editor shell) and `sketch.html` + `src/sketch.ts`, an
editing sandbox that finally makes the editor reachable in a browser. The
landing page is untouched; the designed chrome from the mockup arrives with the
panels in Step 6.

`removeEntity` moved out of the test fixture into `core/model/edits.ts`, as
this step's entry said it should, and now sits beside `addPoint`, `movePoint`,
`addLine`, `startPath`, `extendPath`, `closePath` and `pruneOrphanPoints`.
Tools compose these and hand the result to `dispatch`; nothing in `ui` mutates
a document.

Settled while building it:

- **A drag re-solves with the point pinned**, then writes the solved document
  back under one gesture token, so the whole drag is a single undo step and the
  rest of the sketch follows along whatever freedom it has.
- **Clicking an existing point reuses it.** Two segments drawn end to end
  genuinely share a point rather than merely touching, which is how the
  topology stays explicit.
- **A chain of segments becomes one path record**, so export in Step 7 finds
  the structure the plan's option B expects.
- **The line tool refuses a zero-length segment**, and `extendPath` refuses
  construction geometry or a member from another layer — `validate` forbids
  both, so the edit must not be able to build one.
- **Locked layers cannot be selected or dragged.** Hidden layers are already
  invisible to the hit test.
- **The viewport is not in history.** Panning and zooming leave the undo stack
  alone, per the plan.

jsdom has no pointer events, no layout and no painting, so the whole flow was
also driven in real Chromium against the dev server: drawing a three-segment
chain, dragging a corner across eight moves, then undoing back to empty. It
took **five** undo steps (first point, three lines, one drag), which is the
gesture coalescing working end to end.

### Step 6: Constraints and dimensions UI v0 — done

- **Adds:** add horizontal, vertical, coincident, fix from a selection; a dimension tool; a DOF counter; status coloring live.
- **Done when:** you can draw the plan's rectangle by hand and watch it go from blue to black.

Delivered as `src/ui/editor/commands.ts` (selection to constraint),
`src/ui/render/dimensions.ts` (annotations on the canvas), multi-selection in
the editor, and a relations panel in the sandbox with editable dimension
values. Relations are commands on the current selection rather than modal
tools, with the mockup's shortcuts: ⇧H, ⇧V, ⇧C, ⇧F, and D for a dimension.

The "done when" is a test that builds the plan's rectangle entirely through the
editor and watches 8 → 4 → 2 → 0 DOF, ending with four black edges. The same
sequence was then carried out by hand in a real browser.

Settled while building it:

- **Every edit commits its solve.** Applying a relation used to re-solve for
  *display* only, so adding a horizontal did not actually level the points in
  the document. The plan keeps solved positions in the snapshot, so `apply` now
  solves inside the transaction — and deliberately does *not* commit a solve
  that failed to converge, so a contradictory constraint shows the user their
  own geometry in red rather than a least-squares compromise.
- **Duplicates are refused.** A second identical relation is pure redundancy:
  the solver would correctly call the sketch over defined and the user would
  have no idea why.
- **Smart dimension picks the dominant axis**, so one tool serves width and
  height; a pair that is neither clearly horizontal nor vertical gets a
  straight-line distance.
- **A selected line resolves to its endpoints.** The plan allows a relation on
  a line or a point pair and v1 stores the pair, so the UI is where that
  translation happens.
- **Shift-click adds to the selection and never starts a drag**, since
  shift-clicking is how the pair a relation needs is built.
- **Dimension placement is derived, not stored.** The model has nowhere to keep
  a user-chosen offset, so each dimension is placed on the far side of the
  drawing from its centre and repeats are stacked. Dragging a dimension into
  place needs a schema field and belongs with that work.

### Step 7: Save/load and export — done

- **Adds:** `io/` native JSON save and load (with a version field); SVG export that rebuilds `<path d>` from path records.
- **Tests:** JSON round-trip equality; exported SVG parses and has the expected geometry.
- **Done when:** the Step 6 rectangle survives save, reload, and export to a valid SVG.

Delivered as `src/io/json.ts` and `src/io/svg-export.ts`, with Save, Open and
Export SVG wired into the app.

Settled while building it:

- **Export builds strings, not DOM.** It runs anywhere and needs no jsdom. The
  tests still parse the result with a real `DOMParser`, because producing
  something that merely looks like SVG is the easy mistake.
- **A closed subpath is only closed when the pen came back to where the run
  started.** `Z` closes to the last `M`, so a path with a gap in it would
  otherwise draw an edge the sketch does not have. A test caught this.
- **The line tool closes the loop**, as the plan says it should: clicking back
  on the point a chain began from marks the path closed and ends the chain.
  Until this landed, drawing a rectangle exported an open path.
- **Geometry in no path is still exported.** Drawing a loose line and exporting
  must not silently lose it.
- **Loading validates before returning.** A file from a newer build, or one
  hand-edited into an inconsistent state, fails at the door with a message
  naming the problem rather than three steps later inside the solver.
- **Hidden layers export hidden** (`display:none`) rather than being dropped,
  so nothing is lost on a round trip.
- **Inkscape layer attributes are opt-in** (`inkscapeLayers`), and the app
  turns them on, so exports open as layers there.

Still open from the plan, and deliberately not built here: embedding the native
JSON in `<metadata>` for a constrained round trip. That decision is still
listed as open, and it pairs with SVG *import* in Phase 4.

### The app

`index.html` is the editor and `/about.html` is the landing page, which links
into it. The editor chrome is still deliberately plain — the designed chrome in
`docs/mockups/ui-mockup-v1.html` (tool rail, panel stack, rulers) is built out
as the features behind it land.

**After Step 7:** Phase 1 is complete.

---

## 6. Phase 2 steps

Same working agreements: core before UI, every step green and committed.

### How an arc is represented (decided here, before Step 8)

The plan's DOF table gives an arc 5 DOF as centre (2) + radius + start angle +
end angle. Stored that way, though, an arc's **endpoints are derived values**,
so a line could never share a point with an arc — and shared points are how
this model keeps topology explicit (a Phase 1 decision that the line tool
already relies on).

So an arc is stored as **three points — centre, start, end — plus a direction
flag**, and the solver adds one implicit constraint per arc: the two endpoints
are equidistant from the centre. The arithmetic lands in the same place:

```
3 points                     6 variables
implicit equal-radius        -1
                            ----
                              5 DOF, as the plan says
```

Radius is derived (`|start - centre|`), endpoints are ordinary points that
lines and other arcs can share, and every existing relation works on them
unchanged. The direction flag is not a variable; it says which of the two ways
round the arc sweeps, and maps to SVG's sweep flag on export.

### Step 8: Arcs in the core — done

- **Adds:** `Arc` entity (centre, start, end, direction); `validate` coverage;
  the implicit equal-radius constraint in the solver; arc variables in the DOF
  and per-entity status; `point-on` an arc.
- **Tests:** an arc alone reports 5 DOF; fixing its centre and both endpoints
  fully defines it; the implicit constraint is not reportable as a user
  conflict; a line sharing an endpoint with an arc solves as one sketch.
- **Done when:** a hand-built arc solves, and its DOF count matches the plan.

An arc alone reports 5 DOF, as the plan's table says. A line hanging off an
arc's start point solves as one sketch with no coincident constraint between
them, which is the point of storing the endpoints.

Settled while building it:

- **The implicit row is structural, so it is never reported as a conflict.**
  Naming a constraint the user cannot delete would be advice they cannot act
  on; over-constraining an arc names only the user's own `fix` relations.
- **Radius comes from the start point**, not whichever endpoint is handy. On a
  solved arc the two agree; mid-drag they do not, and the renderer draws then.
- **Arcs contribute no variables of their own.** Their three points already
  carry six, and the implicit row removes the seventh degree of freedom the
  plan's table does not grant them.

Adding the entity kind made TypeScript name every place that assumed two kinds
— hit testing, rendering, export. Each skips arcs explicitly until Step 9,
rather than being widened early and left untested.

### Step 9: Arcs in the UI and in export — done

- **Adds:** arc rendering; hit testing against the rim within the sweep; a
  centrepoint arc tool (centre, start, end); `A` commands in `<path d>` and a
  standalone arc export.
- **Done when:** you can draw an arc, drag it, and export it as valid SVG.

Arc geometry moved into `src/core/geometry.ts`, which also picked up a
dependency-rule violation introduced in Step 7: `io/svg-export.ts` was
importing `sketchBounds` from `ui/render/viewport`, inverting `ui -> io ->
core`. Both layers now take the shared geometry from `core`, where it belongs.

Settled while building it:

- **The arc tool takes its direction from the sweep the cursor traced**, not
  from where the last click lands. Accumulating the angle travelled is what
  distinguishes a small arc from the large one the other way round, and it is
  the only way to draw past half a turn with three clicks.
- **The end point is placed on the arc's own circle**, at the cursor's angle,
  so a new arc starts consistent instead of being pulled into shape by the
  implicit constraint.
- **Coincident endpoints read as a whole turn, not as nothing.** An arc whose
  ends have been dragged together is still an arc; a zero sweep would make it
  vanish. SVG cannot draw a whole turn in one `A` command, so it goes out as
  two halves.
- **Off its sweep, an arc is measured to its nearer endpoint**, so the missing
  side of the circle is not clickable.
- **A reversed path member travels the arc the other way**, which flips the
  sweep flag as well as the endpoints.

### Chrome rebuild, grid and delete (out of step order)

Taken early, because the plain toolbar was wrapping to three rows and every new
tool made it worse.

- **Adds:** the mockup's chrome — icon tool rail, menu bar, collapsible
  Selection and Relations panels, view HUD, status bar — reusing the mockup's
  own icon sprite so the two stay the same drawing. A drawing grid with
  1-2-5 adaptive spacing, snap-to-grid, and delete.
- **Not built yet:** rulers, and the layer and parameter panels, which wait for
  the features that would fill them. There is no artboard either: the canvas is
  unbounded paper rather than a sized sheet.

Settled while building it:

- **Grid spacing steps through a 1-2-5 ladder.** A fixed 10px grid becomes a
  grey wash zoomed out and vanishes zoomed in; the ladder keeps lines a usable
  distance apart on screen at any scale, and every step is a round number so
  the coordinates stay readable. The two lines through the origin are called
  out, because a sketch is anchored to its origin.
- **Snapping never overrides an existing point.** Joining to real geometry
  matters more than landing on a round number, and shared points are what make
  the topology explicit.
- **Snapping is off in the editor API and on in the app.** It changes where a
  click lands, so callers opt in rather than inherit it.
- **Deleting a point takes its geometry with it.** Keeping a line whose
  endpoint has gone would leave a dangling reference that `validate` rejects,
  so the cascade is the only correct behaviour, not a convenience. Orphaned
  points are pruned afterwards.
- **The panel only rebuilds when it changed.** Resyncing the chrome on every
  global pointer event tore the clicked row out of the DOM before its `click`
  fired, so the panel's own delete and suspend buttons silently did nothing.

### Step 10: The rest of the relation set — done

- **Adds:** parallel, perpendicular, tangent, equal, collinear, concentric,
  midpoint, symmetric, each with an analytic Jacobian checked against finite
  differences; selection rules and buttons for each.
- **Done when:** a slot (two lines, two tangent arcs) can be fully defined.

A slot now solves to 0 DOF and is driven by its length and radius dimensions.

Settled while building it:

- **The v2 residuals use forward-mode autodiff** (`core/solver/autodiff.ts`),
  not hand-derived Jacobians. Eight more derivations — tangency, symmetry,
  collinearity, each involving a normalised direction or a distance to a line
  — is where a sign error would hide until a sketch quietly refused to solve.
  Written as ordinary arithmetic on `Dual` values the derivatives are exact by
  construction, and the same finite-difference tests still check the
  expressions end to end. The v1 residuals stay hand-derived: they work and
  are tested, and rewriting them would be churn. Migrating them later is
  worthwhile but is not a bug fix.
- **Angular residuals are dimensionless.** Every v1 residual is in px, but
  "parallel" is about directions and its natural residual is the sine of the
  angle between them. Scaling by a length to force px would mean choosing
  *which* length, and the answer would differ for a short line and a long one.
  So angular rows are in [-1, 1] and the solver's tolerance is simply a
  tighter test for them: 1e-9 of a sine is about 6e-8 of a degree.
- **Tangency is stated two different ways, and the distinction decides whether
  a slot can be defined at all.** At a *join* — the line ends where the arc
  begins, which is what a slot or a fillet is made of — `distance(centre,
  line) = radius` is degenerate: `distance(centre, line) ≤ |end − centre|`
  always holds, with equality exactly at the solution, so the residual sits on
  the boundary of an inequality and its gradient is zero. It constrains
  nothing, and the first slot reported 4 DOF with all four tangencies flagged
  as redundant. Stated as "the radius at the shared point meets the line at a
  right angle" it is an ordinary equation. Without a shared point the distance
  form is correct and not degenerate, so both are kept and the presence of a
  shared point chooses between them. Two arcs meeting at a point get the same
  treatment: their radii there are in line.
- **Which way two round things touch is read from the geometry.** Outside (a
  sum of radii apart) or inside (a difference) is not in the constraint. The
  choice comes from the document rather than the iterating variables, so it is
  fixed for a whole solve; dragging one circle through another can flip it
  between solves, a known v0 rough edge.
- **The commands layer refuses combinations the solver cannot read.**
  "Parallel to a circle" would otherwise sit in the relations list removing no
  freedom, with nothing to tell the user why their sketch stayed blue.
- **Constraint references have one definition.** `constraintRefs` in
  `core/model/types.ts` now serves `validate`, the solver, delete and the
  panel alike. Every call site used to list the fields by hand, which is
  exactly how an arc's endpoints came to be treated as unreferenced, and eight
  new relations would have multiplied that risk by eight.

### Step 11: Angle, radius and diameter dimensions

- **Adds:** those three dimension kinds, their annotations, and reference
  (non-driving) dimensions.
- **Done when:** an angled line can be dimensioned and driven by its angle.

### Step 12: Inference while drawing — done

- **Adds:** relation inference as you draw (horizontal, vertical, coincident,
  tangent) with on-canvas hints, applied on commit and reviewable.
- **Done when:** drawing a roughly horizontal line picks up a horizontal
  relation, and the hint is visible before the click lands.

Delivered as `src/ui/editor/inference.ts` (pure geometry) plus hint glyphs on
the canvas and an Infer toggle in the HUD. **Tangent is not inferred**: there
is no tangent constraint to infer until Step 10, and inferring a relation the
model cannot express would be worse than not inferring it.

Settled while building it:

- **Inference moves the point as well as recording the relation.** Recording
  only would leave a visible kink for the solver to pull out on the next
  solve, which the user sees as the line jumping after the click. Moving only
  is the mistake the plan warns about: the sketch looks right and falls apart
  the moment anything moves.
- **Coincident is not inferred separately**, because the line tool already
  reuses a clicked point. Sharing the point *is* the coincidence, and it is
  stronger than a constraint between two points in the same place.
- **A joined point is left exactly where the geometry is.** Nudging a shared
  point onto an axis would move the geometry it is shared with, so the join
  wins and nothing is inferred.
- **Short segments infer nothing.** Below about 12 screen px the angle is
  mostly cursor noise, and the guard is measured on screen rather than in
  world units so it behaves the same at any zoom.
- **Inference and snapping compose.** Snapping decides where the point lands
  on the grid; inference then aligns it to the axis (which keeps it on the
  grid, since the anchor is on the grid too) and records the reason.

Driving the app afterwards found a crash that the whole test suite had missed:
deleting geometry in a sketch that also held an arc threw
`solver: no variable for point`. `referencedPoints` listed an entity's points
by hand, and since `center` exists on a circle *and* an arc, the else-branch
that assumed circle compiled cleanly while dropping the arc's endpoints — so
pruning orphans took them out from under the arc. The renderer's conflict
check had the same bug, quieter: an arc would not turn red when a conflict
touched its endpoints. Both now go through `entityPointIds`, the helper that
exists for exactly this, and the class of bug is worth remembering: the
discriminated union catches a *missing* case, not a case that happens to
typecheck.

A mutation revealed that a guard in the editor's `place()` was unobservable:
a click that hits a point reuses its id and never creates a point, so the
position `place` returned was discarded. The dead branch is gone and the real
behaviour — an off-grid point is still joined to, not snapped past — now has a
test of its own.

### Step 13: Relations panel

- **Adds:** delete and suspend from the panel, selecting a relation highlights
  what it acts on, and the cross-layer suspend affordance the plan left open.
- **Done when:** a relation can be found, understood, suspended and deleted
  without touching the canvas.

---

## 7. Still open (not blocking Steps 1 to 3)

- Cross-layer suspend: the UI affordance (modifier key, button, or context menu).
- Import fidelity leftovers: rounded rects, CSS class resolution, merge tolerance, whether inference defaults on, embedding native JSON in exports.
- Native file versioning and migrations.
- Export styling (deferred by decision).
