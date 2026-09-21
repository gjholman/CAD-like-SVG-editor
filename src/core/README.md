# core

Pure logic: the document model, the constraint solver, and undo/redo history.

**Rule: nothing in here may touch the DOM or import from `io/` or `ui/`.**
Tests run in plain Node by default, so a stray `document` or `window` fails fast.

Planned subfolders (each is created in its own step, see `docs/EXECUTION.md`):

- `model/` document types and the `validate` invariant checker
- `solver/` residuals, Jacobian, Newton/LM iteration, DOF and status
- `history/` transactions, snapshots, undo/redo
