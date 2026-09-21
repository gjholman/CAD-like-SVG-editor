import { defineConfig } from 'vitest/config';

// One config file for both Vite (dev server, build) and Vitest (tests).
export default defineConfig({
  build: {
    rollupOptions: {
      // Paths are relative to the Vite root, which avoids needing node types
      // here just to call resolve().
      input: {
        // The landing page, and the editing sandbox that mounts the editor.
        index: 'index.html',
        sketch: 'sketch.html',
      },
    },
  },
  test: {
    // Default to plain Node: src/core must never depend on the DOM.
    // A test that needs a DOM opts in with a comment on its first line:
    //   // @vitest-environment jsdom
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
