# How solving works

What "fully defined" means, why the editor colours things blue and black, and
where to look in the code when it disagrees with you.

No prior CAD or numerical-methods knowledge assumed. Every claim here has a
test behind it, named so you can go and read it.

---

## 1. The idea in one page

You draw geometry roughly. Then you tell the sketch what you *meant*: these
two lines are level with each other, that corner is pinned to the origin, this
width is 480 px. The editor works out whether what you have said is enough to
pin the drawing down completely — and if it isn't, it tells you what is still
free to move.

That question has an exact answer, and it is not "count the constraints". The
editor turns the sketch into a system of equations, and asks how many of those
equations are genuinely independent. The gap between the number of unknowns and
that answer is what the status bar calls **degrees of freedom**.

- **0 degrees of freedom** → the drawing can't move. Black.
- **More than 0** → something can still slide. Blue.
- **Contradictory or duplicated relations** → Red, and the editor names them.

---

## 2. What a sketch is made of

Three things, and the distinction matters:

**Points** carry the actual coordinates. They are the only thing that has a
position.

**Entities** are shapes built *out of* points and never carry their own
coordinates — a line is "the segment between those two points". This is why
drawing a second line from the end of the first genuinely joins them: they
share the point, rather than having two points that happen to sit on top of
each other.

**Constraints** are the statements you make about points and entities.

A circle is the one exception: it has a centre point plus a radius of its own,
because there is nothing else for its size to come from.

> There is a fourth kind of thing — **paths**, which record that these
> segments form one `<path>` in the exported SVG, with its style and fill
> rule. The solver never sees them. Two domains, linked only by IDs: see
> `svg-cad-plan.md` §5.

---

## 3. Degrees of freedom

### The intuition

A single point dropped on the canvas can move two ways: left/right and
up/down. That is **2 degrees of freedom**. Pin it to the origin and it has
none.

A line is two points, so **4**. Say it's horizontal and you have taken one
away — it can still slide around and change length, but its two ends must stay
level. Three left.

Every unknown number is a degree of freedom. Every independent statement you
make removes one.

### What this editor actually stores

The plan's DOF table describes the *idea*. Here is what the code counts, which
differs for arcs — see `svg-cad-plan.md` §9 for why.

| Shape | Variables the solver moves | Free to move |
|---|---|---|
| Point | its x and its y | **2** |
| Line | nothing of its own — its two points carry 4 between them | **4** |
| Circle | its radius, plus its centre point's 2 | **3** |
| Arc | nothing of its own — centre, start and end carry 6 — *minus* one built-in equation | **5** |

An arc is stored as three points: centre, start, end. Six numbers, but an arc
whose two ends sat at different distances from its centre would not be an arc
at all — so the solver always adds one equation of its own saying they are
equal. Six minus one is five, which is exactly what the plan's table says an
arc should have.

That built-in equation is *structural*, not something you added, so it can
never be deleted and is never blamed when a sketch goes red.

- `src/core/solver/variables.ts` — what becomes a variable
- `arcs.test.ts` → `"is 5, as the plan's table says"`
- `arcs.test.ts` → `"is never reported as a conflict, since the user cannot delete it"`

### Worked example: the rectangle

Four corners, drawn as four lines sharing their corner points.

| Step | Removes | Left |
|---|---|---|
| Four corner points | — | **8** |
| Top and bottom are horizontal | 2 | 6 |
| Left and right are vertical | 2 | 4 |
| Pin one corner (fix) | 2 | 2 |
| Width dimension | 1 | 1 |
| Height dimension | 1 | **0** — fully defined |

Because the corners are *shared*, the eight degrees of freedom the plan's
worked example removes with corner coincidences never exist in the first place.
Same destination, fewer steps.

You can watch this happen: draw a rectangle, then add the relations one at a
time and read the status bar. The test that does it for you:

- `relations.test.ts` → `"goes from 8 DOF and blue to 0 DOF and black"`

### Worked example: a slot

Two straight sides, two arcs, tangent at all four joins.

| | Removes | Left |
|---|---|---|
| Six points (two centres, four join points) | — | **12** |
| Two arcs' built-in equal-radius equations | 2 | 10 |
| Pin the left centre | 2 | 8 |
| The two centres are level | 1 | 7 |
| Length between centres | 1 | 6 |
| Radius (centre to a join point) | 1 | 5 |
| Four tangent joins | 4 | 1 |
| Equal radius, left arc to right | 1 | **0** |

Every figure in that column was read out of the solver rather than worked out
on paper, which is worth doing for a table this easy to get wrong.

- `v2-solve.test.ts` → `"a slot can be fully defined"`, and the two tests after
  it that drive its length and radius

---

## 4. Why you cannot just count constraints

Subtraction only works if every statement says something *new*. Two ways it
goes wrong:

**Redundant** — you say something twice, or say something that already
follows. Dimension a width as 480, then dimension it 480 again. Both are true;
the second tells the sketch nothing.

**Conflicting** — you say two things that cannot both hold. Dimension the same
width 480 and 300.

Both come out the same way in the arithmetic: **more statements than the sketch
has independent things to say.** The editor calls that over defined and turns
the affected geometry red. It cannot tell you which one is wrong, because it
doesn't know what you meant — so it names *every* relation whose removal
wouldn't change anything, and leaves the choice to you.

- `solve.test.ts` → `"calls a consistent but redundant constraint over defined"`
- `solve.test.ts` → `"calls a contradiction over defined and names both culprits"`
- `solve.test.ts` → `"does not blame constraints that are pulling their weight"`

### How the editor actually measures it

Each constraint becomes an equation that should equal zero. "These two points
are level" becomes `y₂ − y₁ = 0`. That number is the **residual** — how wrong
the sketch currently is about that statement.

Stack the rate-of-change of every residual with respect to every variable and
you get a matrix — the **Jacobian**. One row per equation, one column per
variable.

The number of genuinely independent equations is that matrix's **rank**, and:

```
degrees of freedom = number of variables − rank of the Jacobian
```

Rank is what makes "I said it twice" and "I said it once" come out the same:
the duplicate row adds nothing new, so the rank does not go up.

The **nullspace** — the directions the geometry can still move without
breaking anything — is what lets the editor colour one line black while its
neighbour is blue. If none of a line's variables appear in any of those free
directions, that line cannot move, whatever the rest of the sketch is doing.

- `src/core/solver/linalg.ts` — rank and nullspace, from a pivoted Householder QR
- `linalg.test.ts` → `"the rectangle Jacobian from the plan"`, which works the
  whole thing by hand
- `solve.test.ts` → `"knows which lines are still loose without the width dimension"`

### A real case where counting would have lied

Building the slot above, the first attempt reported **4 degrees of freedom
with all four tangent relations flagged as redundant** — even though each was
plainly doing something.

The reason is worth understanding, because it is the whole argument for using
rank. Tangency was written as *"the distance from the centre to the line equals
the radius"*. Where a line **ends on** the arc, that statement is always
*nearly* true: the distance from a centre to a line is never more than the
distance to a point on that line, so the equation sits exactly at the edge of
what is possible. An equation at that edge has a rate of change of zero in
every direction — so it appears in the matrix as a row of zeros and constrains
nothing at all.

Rewritten as *"the radius at the shared point meets the line at a right
angle"*, it is an ordinary equation with an ordinary rate of change, and the
slot pins down.

So tangency has two forms, and which one applies depends on whether the two
shapes share a point:

| | Statement used |
|---|---|
| A line **ending on** an arc (a join — what slots and fillets are made of) | the radius there is perpendicular to the line |
| A line that merely **touches** a circle | distance from centre to line = radius |
| Two arcs **meeting** at a point | their radii there are in line with each other |

- `v2-solve.test.ts` → `"a tangent join removes a degree of freedom"`
- `v2-solve.test.ts` → `"a line that merely touches a circle uses the distance form"`

---

## 5. Actually moving the geometry

Knowing the sketch is wrong is not the same as fixing it. The equations are not
linear — a distance involves a square root — so there is no formula to solve
them in one go. The solver iterates:

1. Work out how wrong every statement currently is.
2. Work out which way to nudge each variable to make things less wrong.
3. Take a step. If it helped, take bigger steps. If it didn't, take smaller
   ones.
4. Stop when nothing is wrong by more than a billionth of a pixel.

That "bigger or smaller steps" part is **Levenberg-Marquardt**: a damping
factor that slides between confident big jumps and cautious small ones
depending on whether the last step helped. It is what lets the solver converge
from a badly drawn starting point rather than only from a nearly-correct one.

Settings, in `src/core/solver/solve.ts`: convergence at `1e-9`, at most `100`
iterations, damping starting at `1e-6`.

- `solve.test.ts` → `"converges from a poor starting guess"`

### Dragging is two passes, not one

When you drag a point, the cursor is a **goal, not a constraint**.

The first attempt treated it as just another equation, and a test caught what
that means: dragging a corner pulled the *fixed* corner off the origin, because
in one big least-squares compromise everything negotiates — including a
relation you explicitly asked for.

So a drag runs twice. First it pulls toward the cursor, which is allowed to
break things. Then it re-solves the real relations *on their own*, which puts
the sketch back on its constraints at whatever point is nearest the cursor. A
drag can never break a relation to reach the mouse, and dragging fully defined
geometry does nothing at all.

- `solve.test.ts` → `"will not break a constraint to reach the cursor"`
- `solve.test.ts` → `"moves fully defined geometry not at all, and still calls it fully defined"`
- `solve.test.ts` → `"only moves along directions that are still free"`

### One thing that is not in px

Every distance residual is in pixels, which keeps the solver's damping
meaningful. Angular ones can't be: "parallel" is about directions, and its
natural residual is the sine of the angle between them — a number between −1
and 1 with no units. Forcing it into pixels would mean choosing *which* length
to scale by, and the answer would come out different for a short line and a
long one.

The practical consequence: the `1e-9` tolerance is a far tighter test for an
angle than for a distance. A sine of `1e-9` is about `6e-8` of a degree.

---

## 6. What you see, and what it means

| On screen | Means |
|---|---|
| **Blue** geometry | Still free to move in some direction |
| **Black** geometry | Cannot move; every one of its variables is pinned |
| **Red** geometry | Touched by a relation the solver reported as redundant or conflicting |
| **Yellow** status dot | The solver could not find a solution from where the sketch currently is |
| Blue dot, black line | Impossible. A line is only black when both its ends are |
| Black dot, blue line | Normal — that end is pinned, the other isn't |
| Status bar: *N degrees of freedom* | Exactly the number from §3. 0 means done |
| Status bar: *Empty sketch* | No geometry. Technically 0 degrees of freedom, but saying "fully defined" over a blank canvas reads wrong |
| A relation greyed out in the panel | Your selection does not suit it — or it is already there |
| Relations list, red text | This is one of the relations the solver is blaming |

**Points and entities are coloured separately**, and for a reason: a line is
under defined when *either* end can move, so its colour cannot tell you *which*
end is loose.

Take the fully defined rectangle from §3 and delete just the width dimension.
One degree of freedom comes back — the width — and the two right-hand corners
can slide. Three edges turn blue; the **left edge stays black**, because it is
the only one touching neither of the sliding corners. The two left corners stay
black dots too, while the right pair turn blue.

- `render.test.ts` → `"is blue while loose"`
- `render.test.ts` → `"colours individual points by their own freedom"`
- `render.test.ts` → `"turns the implicated geometry red when over defined"`

### Things the UI does that are not the solver

Worth separating, because they look like solving and aren't:

- **Snapping** rounds a click to the grid *before* anything is solved. It never
  overrides an existing point — joining to real geometry matters more than a
  round number.
- **Inference** watches you draw and, when a segment is within 5° of level or
  plumb, both moves the point onto the axis *and* records the relation. Doing
  only the second leaves a visible kink for the next solve to pull out; doing
  only the first gives you a sketch that looks right and falls apart when
  anything moves.
- **Dimension placement** is a drawing rule, not a solved value: annotations go
  outward from the middle of the drawing, and repeats on the same pair stack.

- `inference.test.ts` → `"infers horizontal for a nearly level segment, and levels it exactly"`
- `inference-tool.test.ts` → `"lands the point exactly level, not three pixels off"`
- `grid-delete.test.ts` → `"reuses an off-grid point rather than snapping past it"`

---

## 7. Where it lives

```
src/core/model/      what a sketch is: types, validate, edit helpers
src/core/solver/
  variables.ts       document → the list of numbers to solve for
  residuals.ts       the v1 equations and their hand-derived derivatives
  v2-residuals.ts    the v2 equations, derivatives from autodiff
  autodiff.ts        forward-mode differentiation over sparse gradients
  linalg.ts          QR, rank, nullspace, least squares
  solve.ts           the iteration, plus DOF, status and conflicts
src/ui/render/       drawing it, including the status colours
src/ui/editor/       the editor shell, the drawing tools, hit testing,
                     relation commands, inference
src/ui/chrome/       the panels around it, and the words they show
```

The v1 derivatives are hand-written; the v2 ones come from a small
forward-mode autodiff, because eight more hand derivations is where a sign
error hides until a sketch quietly refuses to solve. Both are checked the same
way — against finite differences, at fixed *and* random configurations. That
test is the single most load-bearing one in the project: **a solver with a
wrong derivative usually still converges, just slowly**, so nothing else would
catch it.

- `residuals.test.ts` → `"analytic Jacobian matches finite differences"`
- `v2-residuals.test.ts` → `"v2 Jacobians match finite differences"`
- `autodiff.test.ts` → the differentiation rules themselves

---

## 8. Known rough edges

- **Every solve touches the whole sketch.** Splitting it into independent
  clusters is the planned optimisation and is not built.
- **Two circles touching**: outside or inside is read from where they currently
  sit, because the constraint does not record which you meant. Dragging one
  through the other can flip the meaning between solves.
- **Over defined geometry keeps your positions.** A solve that fails to
  converge is deliberately *not* written back, so you see your own drawing in
  red rather than a least-squares compromise you never asked for.
- **A drag assumes small steps.** The second pass could in principle settle
  into a different solution than the one nearest the cursor if a single drag
  step were enormous. Real drags are many small steps.
- **No angle, radius or diameter dimensions yet** (Step 11). A radius has to be
  dimensioned as a distance from the centre to a point on the rim.
