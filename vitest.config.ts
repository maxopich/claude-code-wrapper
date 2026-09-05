import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Root vitest config. Kept minimal: just enables `?raw` CSS imports so
 * tests can assert on stylesheet structure without depending on Node
 * fs from non-Node workspaces (`web/tsconfig.json` sets `"types": []`, so
 * `@types/node` is not in the web program — register C12; that was
 * described here as deliberate for months while nothing configured it, and
 * `web/src/nodeTypeIsolation.test.ts` now fails typecheck if it stops being
 * true). Tests still default to the node environment; individual tests can
 * opt into jsdom via `// @vitest-environment`.
 */
export default defineConfig({
  test: {
    // Register C02: `passWithNoTests: true` used to live here (and as a flag
    // on the `test` script). It turned a discovery failure into a green
    // build: a bad include glob or workspace path found zero test files and
    // vitest printed "No test files found, exiting with code 0". Verified —
    // `vitest run --dir=<nonexistent>` exited 0 before this change and exits
    // 1 after it. Vitest's default is already fail-on-empty, so the fix is
    // simply not to opt out.
    //
    // This does NOT cover the other half: `test:security` filters by test
    // NAME (`-t '[security]'`), and a renamed tag leaves every file
    // discovered but every test skipped — which vitest exits 0 on no matter
    // what this flag says. `scripts/security-test-gate.mjs` is the guard for
    // that case; see its header.
    //
    // Discovery runs from the repo root, so without an explicit exclude
    // vitest's default include glob descends into the sibling checkouts
    // under `.claude/worktrees/**` — each a full copy of the repo (~9k
    // duplicate test files, stale better-sqlite3 ABIs in their bundled
    // node_modules, and contention on the shared ~/.cebab/cebab.sqlite),
    // which makes a root `npm test` unusable. vitest 4's default exclude
    // is only node_modules + .git, so we also re-add dist/build to keep
    // stale compiled tests out (`server/tsconfig.build.json` carries the why). eslint
    // already ignores `.claude/**` for the same worktree-shadowing reason.
    exclude: [...configDefaults.exclude, '**/dist/**', '**/build/**', '**/.claude/**'],
    // Register Cebab-cjm: point every worker at a throwaway data directory
    // before any test module loads, so a test that reaches getDb() without
    // arranging anything cannot open the operator's real ~/.cebab. See the
    // file's header for why it writes an env var instead of importing config,
    // and for the getDb() guard that makes this an invariant rather than a
    // default. Removing this line does not fail silently — DB-touching tests
    // that arrange nothing will throw with a message naming this line.
    setupFiles: ['./vitest.setup.mjs'],
    // Coverage is a MEASUREMENT TOOL here, not a gate — `npm run coverage`,
    // nothing in CI. It exists because "is this test reaching code?" was
    // unanswerable: there was no provider installed and no config anywhere, so
    // every judgement about the size of the suite was an opinion.
    //
    // Baseline on 2026-09-05, 6,146 tests over 281 product files:
    //   statements 79.43%   branches 74.40%   functions 76.55%   lines 80.82%
    // Eight files sit at zero, 204 statements between them, and four of those
    // are entry points and dev tools (`server/src/index.ts`, `smoke.ts`,
    // `runner_demo.ts`). The gap is concentrated rather than spread:
    // `ws/server.ts` is 49.3% of 1,440 statements and `web/src/App.tsx` is
    // 3.6% of 612 — the second by construction, since App.tsx has no test file
    // and its logic is extracted into `store.ts` to be testable at all
    // (`store.ts` is 83% of 789, which is that strategy working).
    //
    // WHAT THIS NUMBER CANNOT SEE, and it is specific rather than a caveat for
    // form's sake: 20 test files in this repo read PRODUCT SOURCE AS TEXT and
    // assert properties of it — 11 under `scripts/` (see `docs/source-gates.md`)
    // and 9 under `server/src/ws`. A source gate never EXECUTES the line it
    // protects, so v8 attributes nothing to it. Real assurance on those lines
    // is invisible here, and the total understates it by an amount nobody can
    // compute.
    //
    // `ws/server.ts` at 49.3% is the clearest case, and reading the report
    // before acting on it matters: its 730 uncovered statements are spread over
    // 332 ranges, the largest 24 lines. That is not a dead subsystem to delete
    // — it is switch-arm dispatch glue whose logic is extracted into helpers
    // that ARE tested (`executeContinueMultiAgent` and friends), with the
    // wiring pinned by source gates like `ws/bus_cap_sites.test.ts` and
    // `ws/single_agent_model_wiring.test.ts`. Same shape as App.tsx/store.ts,
    // one layer down. Chasing this number by executing those arms would be
    // work; deleting anything on the strength of it would be a mistake.
    //
    // NO THRESHOLD, deliberately. A floor pinned near the real number gets
    // raised until it notices nothing, and one pinned far below is a claim
    // nobody checks — the same trap the corpus floors in `scripts/` carry
    // comments about. If this ever becomes a gate, 70% statements is the
    // number that would catch a collapse without reddening on ordinary churn.
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      // Product source only. Tests measuring themselves inflates the number,
      // and the smokes are dev tools that spend live quota — they never run
      // under vitest, so they would read as permanently dead.
      include: ['server/src/**', 'web/src/**', 'shared/src/**'],
      exclude: ['**/*.test.*', '**/*_smoke.ts', '**/test_support/**', '**/migrations/**'],
    },
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
