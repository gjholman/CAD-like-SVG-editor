# CAD-like SVG editor

A web app for editing SVGs the way you work in a CAD sketch: add relations and
dimensions, and a solver keeps the geometry consistent.

- Plan and decisions: [`docs/svg-cad-plan.md`](docs/svg-cad-plan.md)
- How we build it, step by step: [`docs/EXECUTION.md`](docs/EXECUTION.md)

## Quick start

```bash
npm install -D vite vitest typescript   # first time only
npm run dev        # dev server with the landing page
npm test           # tests in watch mode
npm run test:run   # tests once
npm run typecheck  # TypeScript check
npm run build      # typecheck + production build into dist/
```

## Layout

```
src/core/   pure logic (model, solver, history): no DOM
src/io/     native JSON, SVG import/export
src/ui/     rendering, tools, panels
tests/      integration tests and fixtures
docs/       plan and execution docs
```
