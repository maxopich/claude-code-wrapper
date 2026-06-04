import { configDefaults, defineConfig } from 'vitest/config';

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
    // Discovery runs from the repo root, so without an explicit exclude
    // vitest's default include glob descends into the sibling checkouts
    // under `.claude/worktrees/**` — each a full copy of the repo (~9k
    // duplicate test files, stale better-sqlite3 ABIs in their bundled
    // node_modules, and contention on the shared ~/.cebab/cebab.sqlite),
    // which makes a root `npm test` unusable. vitest 4's default exclude
    // is only node_modules + .git, so we also re-add dist/build to keep
    // stale compiled tests out (see CLAUDE.md's tsc-emit warning). eslint
    // already ignores `.claude/**` for the same worktree-shadowing reason.
    exclude: [...configDefaults.exclude, '**/dist/**', '**/build/**', '**/.claude/**'],
    // Vitest mocks CSS imports to an empty string by default. Enabling
    // CSS processing lets the `?raw` query suffix resolve to the file's
    // literal text — needed by cssGate.test.ts to scan the stylesheet
    // for stray .tpl-* animations outside the no-preference media block.
    css: true,
    environmentOptions: {
      // jsdom-env tests need a real origin for localStorage (and other
      // origin-keyed Web APIs) to be initialised. Without a `url`, jsdom
      // defaults to `about:blank` and exposes localStorage as `null`,
      // which breaks the PR-5 modal tests' pref-persistence checks.
      jsdom: {
        url: 'http://localhost/',
      },
    },
  },
});
