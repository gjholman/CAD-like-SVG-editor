# Bugs this build keeps making

A standing list of the mistakes that have actually bitten us, grouped by the
shape of the mistake rather than by where it happened. Each entry says what
went wrong, what it cost, and the habit that catches it next time.

This is not a list of every bug fixed — most bugs are one-offs and teach
nothing. These are the ones with a *shape*, where the same mistake has already
appeared twice or looks likely to.

A note on how they were found, because it is the most useful thing here: three
of these were invisible to the test suite and only showed up when the real app
was driven in a real browser, and two more were found by deliberately breaking
the fix to see whether any test complained. Writing the test is not the same as
having a test that works.

---

## 1. The lookup that typechecks against the wrong case

**What happened.** `referencedPoints` listed each entity kind's point fields by
hand. `center` exists on both a circle and an arc, so an `else` branch written
for circles compiled cleanly against an arc — and silently dropped the arc's
`start` and `end`. `pruneOrphanPoints` then deleted points the arc still
needed, and the next solve threw `solver: no variable for point` (the guard in
`core/solver/variables.ts`). The renderer's conflict check had the same bug
independently.

**Why the type system did not help.** A discriminated union catches a *missing*
case. It cannot catch a case that happens to typecheck because the two variants
share a field name.

**The habit.** Anything that needs "every id in X" calls the one helper that
knows: `entityPointIds` and `constraintRefs` in `core/model/types.ts`. Never
re-list the fields at the call site, however small the call site is. Both
places now go through the helpers, and `edits.ts` carries a comment saying why.

---

## 2. The silent no-op

**What happened, repeatedly.**

- `div` in `core/solver/autodiff.ts` returned zero on a zero divisor.
  Downstream, a row of zeros is indistinguishable from "this constraint is
  satisfied and constrains nothing" — so a missing guard would have shown up
  as a sketch that quietly refused to become defined, with nothing to point at.
- Applying a relation re-solved for display only and never committed the
  result, so the geometry did not move and the relation looked broken.
- A guard in `place()` handled a case that could not happen (a click on an
  existing point never creates one), so it looked like protection and was dead
  code.

**The habit.** In numeric code, a degenerate input is either *handled
deliberately, with a comment saying what the honest answer is* (`hypot` at zero
drops its gradient, because every direction increases the length equally) or it
*throws*. It is never quietly zero. `div` now throws, and a test drives every
v2 relation through a fully collapsed sketch to prove the callers guard first.

---

## 3. The residual with no gradient

**What happened.** A slot — two half-circles joined by two lines — reported
four degrees of freedom with all four tangency constraints marked redundant.
The residual `distance(centre, line) = radius` is, at a shared join point, an
inequality that holds with equality *exactly* at the solution
(`distance ≤ |end − centre|` always). A residual sitting on that boundary has a
zero gradient: it is satisfied, it is not redundant, and it removes no freedom.

Two more bugs in the same family surfaced in the code review:

- The rank comparison counted zero rows as constraints, so one degenerate arc
  made a healthy sketch report **over-defined** with nothing the user could
  remove to fix it.
- A zero row is trivially in the left nullspace of `Jᵀ` (`eᵢᵀJ = 0` for free),
  so the conflict finder blamed whichever degenerate relation produced it for a
  redundancy it took no part in. A test caught this one within a minute of the
  rewrite.

**The habit.** For every residual, ask where it is *not differentiable*, and
what its gradient is there. Then test the collapsed case: every point on top of
every other point, every radius zero. The tangency constraint now has two
forms, chosen by whether a shared point exists, with the reasoning written out
in `v2-residuals.ts`; rank is compared against `nonZeroRows`, not row count;
and `findConflicts` drops zero rows before looking for dependencies.

---

## 4. The resync that destroys what was clicked

**What happened.** The chrome resynced on a global `pointerdown`, which
rebuilt the relations list — tearing out the very button the click had landed
on, before the `click` event could reach it. The panel's buttons did nothing,
silently, and nothing in the test suite noticed.

**The habit.** Two rules, both now in the code:

- Rebuild a list only when its *contents* changed. `chrome.ts` keeps a
  signature of the relations and returns early when it matches.
- A control resyncs itself after its own handler runs; global listeners cover
  the canvas and the keyboard only. `main.ts` says this in a comment, because
  it is the kind of thing that gets "simplified" back into a bug.

---

## 5. An id collision is an overwrite, not an error

**What happened.** `load()` replaced the document but left the id generator
counting from wherever the *previous* sketch had stopped. The first point drawn
after opening a file was minted with an id the file already used. Every edit is
keyed by id, so this did not collide loudly — it **replaced** a corner of the
loaded geometry, in place, and the only visible symptom was a shape quietly
losing a corner.

**The habit.** Anything keyed by id accepts a duplicate without complaint, so
whoever mints ids must start past everything already in the document:
`generatorPast(documentIds(doc))`, on `load` and on construction alike. The
browser check drives the whole round trip — save, reopen, draw on top — because
that is the only place the bug was ever visible.

---

## 6. A threshold in the wrong units

**What happened.** The exported `viewBox` guarded against a zero-size document
with a minimum extent of `1e-9`, but attribute values are rounded to four
decimals on the way out. A vertical line exported as `width="0"`, and an SVG
with zero width draws nothing.

**The habit.** A guard has to be in the units of the thing it protects. If the
output rounds, the guard belongs above the rounding step, not below it.

---

## 7. A partial map where a total one was assumed

**What happened.** `toSvg` and `sketchBounds` both take a positions map that
may cover only some points. Half their helpers fell back to the stored points
and half gave up and returned undefined — so a partial map exported the lines
and silently dropped the arcs. `arcShape` made it worse: it does its own
lookups, so it had nothing to fall back on.

**The habit.** Merge at the boundary, once, and let every lookup below be
total. Scattering `?? doc.points[id]` through the call sites guarantees that
one of them will be missed.

---

## 8. What jsdom cannot do

jsdom has no layout, no painting, and no pointer events. `getBoundingClientRect`
returns zeros, `element.contentEditable = 'true'` is a no-op that sets no
attribute, and `isContentEditable` is not implemented at all.

**Bugs that passed the suite and failed in Chromium:**

- The line tool never closed a loop, so nothing exported with a `Z`.
- The panel buttons did nothing (entry 4 above).
- An arc finished by clicking its own centre produced an invisible zero-extent
  entity — the unit test asserted the arc existed, which it did, and the arc
  was unrenderable.

**The habit.** Drive the real app in a real browser for anything involving hit
testing, layout, painting or focus. Chromium and Playwright are available
(`/opt/pw-browsers/chromium`); a throwaway script against `vite dev` takes a
couple of minutes and has now earned its keep three times over.

---

## 9. Tests that pass for the wrong reason

The most uncomfortable entry, and the one worth re-reading. All of these were
*my* bugs, in tests I wrote to prove a fix worked:

- Two tests asserted that typing in a text field left the sketch alone — using
  ids (`line1`, `p1`) that the fixture does not contain. They passed whether or
  not the fix was there, because the selection was empty either way. Mutation
  testing caught them; nothing else would have.
- A test expected a dimension edit to move only the far point. The solver takes
  the minimum-norm step, so it moves both a little. The test was wrong about
  the solver, not the other way round.
- `page.mouse.click(x, y, { modifiers })` silently ignores the option. The
  Shift never happened and the test passed anyway.
- `3 * QUARTER + Math.PI / 2` is 2π, not 3π/2.
- `toEqual` on computed bounds, where `cos(π)·r` leaves 1.2e-14 behind.
- A fixture constrained so thoroughly that the constraint under test could not
  be satisfied — so it "failed to converge" for a reason that had nothing to do
  with what was being tested.
- A patch script whose `str.replace` anchor did not match, so the edit silently
  did nothing.

**The habits.**

- **Mutation-test every fix.** Break the fix on purpose, run the test, confirm
  it fails, put the fix back. Every fix in the code-review pass was checked
  this way, and it caught two vacuous tests out of about forty.
- **Assert every replacement.** A patch script asserts its anchor matched
  exactly once before writing.
- **Build test fixtures from the fixture's own return value**, never from
  guessed id strings.

---

## How to use this file

When a bug turns out to have a shape — when it could recur somewhere else in
the codebase, or it already has — add it here with the same three parts: what
happened, what it cost, and the habit. When the habit is in the code (a helper,
a guard, a comment), say where, so the entry and the code stay attached.
