/**
 * Cebab-1513: the lint gate must not trip over gitignored files.
 *
 * `eslint .` walks the directory tree, and its ignore list is a SEPARATE
 * mechanism from `.gitignore`. So a gitignored file eslint can parse — a helper
 * script dropped into `.loop/`, `.cebab/`, or any other gitignored directory —
 * still fails `npm run lint`, in a bead that never touched lint, with nothing in
 * `git status`, the diff, or the loop guard to explain it. That is exactly how
 * this was found: a supervisor written to `.loop/supervisor.mjs` (gitignored,
 * invisible everywhere) reddened the gate at the lint step and cost a full
 * repair attempt.
 *
 * `eslint.config.js` now derives its ignore list from `.gitignore`, so the two
 * agree by construction. This gate keeps them agreeing, and — because the fix
 * is a general one — protects the NEXT gitignored directory, not just `.loop/`.
 *
 * WHY A TEST AND NOT JUST THE CONFIG. Reverting the config edit is silent: the
 * config still parses, `npm run lint` still passes on the committed tree (which
 * carries no gitignored JS), and the failure only reappears when someone drops a
 * file into a gitignored directory in a live checkout — the same invisible
 * failure this bead is about. This test makes the property observable.
 *
 * ANTI-VACUITY. The fix could be "green" by ignoring everything. The negative
 * controls below assert that real, committed source is STILL linted, so a config
 * that over-ignores reddens here instead of silently disabling the lint pass.
 */
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';

// Uses the real `eslint.config.js` via default resolution — this is the actual
// config `npm run lint` runs with, not a reconstruction of it.
const eslint = new ESLint();

// Representative gitignored paths that eslint would otherwise parse. `.loop/…`
// is the exact case that caused this bead; the rest are other gitignored
// directories that can accumulate lintable helper scripts.
const MUST_BE_IGNORED = [
  '.loop/supervisor.mjs', // the file that caused Cebab-1513
  '.loop/deep/nested/helper.mjs', // arbitrary depth under a gitignored dir
  'scripts/loop.mjs', // gitignored loop driver
  'scripts/lib/loop/helper.mjs', // gitignored loop internals
  'scripts/kanban-sync.mjs', // gitignored workshop script
  '.cebab/notes.mjs', // gitignored per-checkout state
  '.beads/hook.mjs', // gitignored issue-tracker state
  'coverage/coverage.js', // gitignored, regenerated on demand
];

// Committed source and real launchers that MUST stay in the lint pass. If the
// derived ignore list ever swallows these, the lint gate has quietly stopped
// checking real code — the failure mode this test exists to catch.
const MUST_BE_LINTED = [
  'server/src/index.ts',
  'shared/src/index.ts',
  'web/src/App.tsx',
  'scripts/dev.mjs', // a real, committed launcher in scripts/
  'scripts/bootstrap.mjs',
  'vitest.setup.mjs', // real code that runs before every test
];

describe('eslint ignores agree with .gitignore (Cebab-1513)', () => {
  for (const file of MUST_BE_IGNORED) {
    it(`ignores gitignored path: ${file}`, async () => {
      expect(await eslint.isPathIgnored(file)).toBe(true);
    });
  }

  for (const file of MUST_BE_LINTED) {
    it(`still lints committed source: ${file}`, async () => {
      expect(await eslint.isPathIgnored(file)).toBe(false);
    });
  }
});
