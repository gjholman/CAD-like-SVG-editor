# ui

SVG DOM rendering, tools (select, line, dimension), panels, keyboard shortcuts.

May import from `core/` and `io/`. Every change to the document goes through the
history `dispatch` function; UI code never mutates the model directly.
