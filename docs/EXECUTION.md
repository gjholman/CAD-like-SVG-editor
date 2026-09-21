# Execution Plan

How we build the CAD-like SVG editor, in small steps. The *what* and *why* live in
[`svg-cad-plan.md`](svg-cad-plan.md); this file is the *how* and *in what order*.

**Status:** Step 4 (read-only renderer) delivered. Next: Step 5 (editing v0).
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
├── index.html              landing page (Vite entry point)
├── package.json
├── tsconfig.json
├── vite.config.ts          Vite + Vitest config
├── README.md
├── docs/
│   ├── svg-cad-plan.md     the plan and decisions
│   └── EXECUTION.md        this file
├── src/
│   ├── main.ts             entry: loads landing styles now, mounts the editor later
│   ├── styles/
│   │   └── landing.css
│   ├── core/               pure logic, NO DOM
│   │   ├── model/          (Step 1) types + validate()
│   │   ├── solver/         (Steps 3a/3b) linear algebra, constraints, solve()
│   │   └── history/        (Step 2) dispatch, snapshots, undo/redo
│   ├── io/                 (Step 7) native JSON, SVG import/export
│   └── ui/                 (Steps 4-6) rendering, tools, panels, shortcuts
└── tests/
    └── fixtures/           sample SVGs and sketch JSON for tests
```

### Dependency rule

```
ui  ->  io  ->  core
```

`core` imports nothing from `io` or `ui`. `io` may use DOM APIs (`DOMParser`) for SVG import. `ui` uses the DOM freely.

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

### Step 5: Editing v0

- **Adds:** select tool, line tool, drag a point (solver runs during the drag), all through `dispatch`; Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z wired to history.
- **Done when:** you can draw a line, drag it, and undo/redo it.

### Step 6: Constraints and dimensions UI v0

- **Adds:** add horizontal, vertical, coincident, fix from a selection; a dimension tool; a DOF counter; status coloring live.
- **Done when:** you can draw the plan's rectangle by hand and watch it go from blue to black.

### Step 7: Save/load and export

- **Adds:** `io/` native JSON save and load (with a version field); SVG export that rebuilds `<path d>` from path records.
- **Tests:** JSON round-trip equality; exported SVG parses and has the expected geometry.
- **Done when:** the Step 6 rectangle survives save, reload, and export to a valid SVG.

**After Step 7:** Phase 1 is complete. Continue with Phase 2 in the plan (arcs, more relations, inference while drawing).

---

## 6. Still open (not blocking Steps 1 to 3)

- Cross-layer suspend: the UI affordance (modifier key, button, or context menu).
- Import fidelity leftovers: rounded rects, CSS class resolution, merge tolerance, whether inference defaults on, embedding native JSON in exports.
- Native file versioning and migrations.
- Export styling (deferred by decision).
