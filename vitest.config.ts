import { defineConfig } from 'vitest/config';

/**
 * Root vitest config. Kept minimal: just enables `?raw` CSS imports so
 * tests can assert on stylesheet structure without depending on Node
 * fs from non-Node workspaces (web's tsconfig deliberately excludes
 * `@types/node`). Tests still default to the node environment;
 * individual tests can opt into jsdom via `// @vitest-environment`.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    // Vitest mocks CSS imports to an empty string by default. Enabling
    // CSS processing lets the `?raw` query suffix resolve to the file's
    // literal text — needed by cssGate.test.ts to scan the stylesheet
    // for stray .tpl-* animations outside the no-preference media block.
    css: true,
  },
});
