import { defineConfig } from 'vitest/config';

// One config file for both Vite (dev server, build) and Vitest (tests).
export default defineConfig({
  build: {
    rollupOptions: {
      // Paths are relative to the Vite root, which avoids needing node types
      // here just to call resolve().
      input: {
        // The editor itself, and the landing page it links back to.
        index: 'index.html',
        about: 'about.html',
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
