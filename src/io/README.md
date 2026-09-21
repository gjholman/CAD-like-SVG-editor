# io

Getting documents in and out: native JSON save/load, SVG import, SVG export.

May import from `core/`. May use DOM APIs (`DOMParser`) for SVG import.
Tests that need a DOM start with `// @vitest-environment jsdom`.

Imported SVG markup is only ever parsed and read. It is never inserted into the page.
