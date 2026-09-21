import { defineConfig } from 'vitest/config';

// One config file for both Vite (dev server, build) and Vitest (tests).
export default defineConfig({
  test: {
    // Default to plain Node: src/core must never depend on the DOM.
    // A test that needs a DOM opts in with a comment on its first line:
    //   // @vitest-environment jsdom
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
