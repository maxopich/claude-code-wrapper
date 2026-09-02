/**
 * Autonomous loop — does each new test actually depend on the change it ships with?
 *
 * `build-prompt.md` has required "a test that fails before your change and
 * passes after it" since the loop was written, and nothing ever checked it.
 * `Cebab-dwcq` measured what that costs: three tests in the run of 2026-09-01
 * pass with their own fix reverted. All three are web-side, and `web/` is
 * exempt from the Playground tier by operator decision — so it is precisely
 * the tier with no runtime verification of its own. This is that substitute,
 * and it costs no subscription quota.
 *
 * THE PURE HALF LIVES HERE. `classifyRevertRun` is the whole decision and takes
 * a vitest JSON summary; the process plumbing (a scratch worktree, a vitest
 * spawn) is `makeRevertCheck` below and is injected. Same split, and the same
 * reason, as `security-test-gate.mjs`'s `evaluateRun`: the interesting branches
 * have to be reachable without spawning anything.
 *
 * WHY THE EXIT CODE IS NOT THE ANSWER, which is the trap that makes a naive
 * version WORSE than no check at all.
 *
 * A test file for a module the change ADDS cannot be collected against the base
 * tree — the import does not resolve. Measured on vitest 4.1.10, both cases
 * exit 1:
 *
 *                        exit  numTotalTests  numPassedTests  numFailedTests  numFailedTestSuites
 *   collection error       1         0              0               0                  1
 *   assertion failure      1         2              1               1                  2
 *
 * So a check keyed on the exit code reads a file that never ran as "it failed
 * without the fix, good" — and certifies a genuinely vacuous test in that same
 * file as sound. `numFailedTests > 0` separates them exactly, which is why it
 * is the discriminator and the exit code is not consulted at all.
 *
 * The `numTotalTests` trap next door is the one `security-test-gate.mjs`
 * documents: vitest counts SKIPPED tests in the total, so a total above zero
 * does not mean anything executed. Executed is `passed + failed`.
 */

/** A vitest JSON summary, as much of it as this module reads. */
/**
 * @typedef {object} VitestSummary
 * @property {number=} numPassedTests
 * @property {number=} numFailedTests
 * @property {number=} numTotalTests
 * @property {number=} numFailedTestSuites
 */

/**
 * Which files in a diff are tests?
 *
 * Deliberately the same extensions vitest itself discovers, and deliberately
 * NOT a check on whether the file is new: an EDITED test is exactly as likely
 * to be vacuous as an added one, and the run's own three findings include a
 * case where three of four new cases in one file reddened correctly and the
 * fourth did not.
 */
export function testFilesInDiff(changedPaths = []) {
  return changedPaths.filter((p) => /\.test\.(ts|tsx|mts|mjs|js|jsx)$/.test(p));
}

/**
 * The non-test half of a diff — what gets left out of the base tree, i.e. the
 * change the tests are supposed to depend on.
 */
export function sourceFilesInDiff(changedPaths = []) {
  const tests = new Set(testFilesInDiff(changedPaths));
  return changedPaths.filter((p) => !tests.has(p));
}

/**
 * The verdict, from a vitest run of the changed test files against a tree
 * WITHOUT the change.
 *
 * Five outcomes rather than a boolean, because three of them are neither a
 * pass nor a bead failure and collapsing them is how a gate starts reporting
 * success it did not measure:
 *
 *   `depends`       tests ran and failed — the test needs the change. PASS.
 *   `vacuous`       tests ran and PASSED without the change. FAIL: the test
 *                   does not test what it shipped with.
 *   `uncollectable` nothing ran and a suite errored — the test imports
 *                   something the base tree does not have, which is the normal
 *                   shape for a new module. SKIP, never a pass.
 *   `empty`         nothing ran and nothing errored — the filter matched no
 *                   test at all. SKIP, and say so: this is the shape a bad
 *                   file list takes.
 *   `inconclusive`  no parseable summary. SKIP; the harness failed, not the
 *                   bead, and failing the bead for it would train the operator
 *                   to disable the step.
 *
 * @param {VitestSummary | null | undefined} summary
 * @returns {{verdict: string, executed: number, reason: string}}
 */
export function classifyRevertRun(summary) {
  if (!summary || typeof summary !== 'object') {
    return {
      verdict: 'inconclusive',
      executed: 0,
      reason: 'vitest produced no parseable JSON summary',
    };
  }
  const passed = Number(summary.numPassedTests ?? 0);
  const failed = Number(summary.numFailedTests ?? 0);
  // NOT `numTotalTests`: it counts skipped tests, so it is above zero for a
  // run that executed nothing. See the header.
  const executed = passed + failed;

  if (failed > 0) {
    return {
      verdict: 'depends',
      executed,
      reason: `${failed} of ${executed} test(s) fail without the change, as they should`,
    };
  }
  if (executed > 0) {
    return {
      verdict: 'vacuous',
      executed,
      reason:
        `all ${executed} changed test(s) PASS against a tree without this change. ` +
        `A test that does not fail before the fix is not evidence of the fix.`,
    };
  }
  const failedSuites = Number(summary.numFailedTestSuites ?? 0);
  if (failedSuites > 0) {
    return {
      verdict: 'uncollectable',
      executed: 0,
      reason:
        `${failedSuites} test file(s) could not be collected against the base tree — ` +
        `normal when the change adds a module the test imports. Not checked.`,
    };
  }
  return {
    verdict: 'empty',
    executed: 0,
    reason: 'no tests ran and no suite errored — the file list matched nothing',
  };
}

/**
 * The titles of test CASES a patch ADDS, from the `+` lines of a unified diff.
 *
 * WHY THIS EXISTS, and it is a correction to this module's first design. The
 * first version classified a whole FILE: run the changed test files against the
 * base tree and ask whether any test failed. Verified against the corpus
 * `Cebab-dwcq` had already measured, that turned out too coarse to catch the
 * thing it was built for. On `a009f68` (#484, a recorded vacuous test) it
 * reported `depends` — 4 of 52 tests did fail without the change, so the file
 * as a whole looked sound, while the ONE case dwcq names still passed with the
 * fix reverted.
 *
 * "Some test in this file fails" is a much weaker claim than "the test that
 * shipped with this fix fails", and only the second is the rule in
 * `build-prompt.md`. So the unit is the case, not the file.
 *
 * WHAT IT DELIBERATELY DOES NOT MATCH. A title built from a template literal
 * with interpolation, or from a `.each` table, has no static text to look up in
 * the results — those are returned in `unmatched` rather than silently dropped,
 * because a case this cannot see must not be counted as checked.
 */
export function addedTestTitles(patch = '') {
  const titles = [];
  for (const raw of String(patch).split('\n')) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    // `test(`, `it(`, and their `.only` / `.skip` / `.fails` / `.concurrent`
    // forms. `.each` is excluded on purpose: its titles are templates.
    const m = /\b(?:test|it)(?:\.(?:only|skip|fails|concurrent|todo))*\s*\(\s*(['"])(.*?)\1/.exec(
      line,
    );
    if (m && m[2]) titles.push(m[2]);
  }
  return [...new Set(titles)];
}

/**
 * Per-case verdict: which of the ADDED tests pass against a tree without the
 * change, which fail as they should, and which could not be found at all.
 *
 * A title that appears more than once (two `describe`s, same case name) counts
 * as failing if ANY instance failed — the conservative reading, since the
 * alternative flags a sound test whenever a namesake elsewhere passes.
 *
 * @param {VitestSummary & {testResults?: Array<{assertionResults?: Array<{title?: string, status?: string}>}>}} summary
 * @param {string[]} addedTitles
 */
export function classifyAddedCases(summary, addedTitles = []) {
  const byTitle = new Map();
  for (const file of summary?.testResults ?? []) {
    for (const a of file?.assertionResults ?? []) {
      const t = a?.title;
      if (typeof t !== 'string') continue;
      if (!byTitle.has(t)) byTitle.set(t, []);
      byTitle.get(t).push(a.status);
    }
  }
  const vacuous = [];
  const depends = [];
  const unmatched = [];
  for (const title of addedTitles) {
    const statuses = byTitle.get(title);
    if (!statuses || statuses.length === 0) {
      unmatched.push(title);
      continue;
    }
    if (statuses.some((st) => st === 'failed')) depends.push(title);
    else vacuous.push(title);
  }
  return { vacuous, depends, unmatched };
}

/** Which verdicts fail the gate. Exactly one does. */
export const FAILING_VERDICTS = Object.freeze(['vacuous']);

/** Which verdicts are recorded as a skip rather than a pass or a failure. */
export const SKIPPED_VERDICTS = Object.freeze(['uncollectable', 'empty', 'inconclusive']);

/**
 * Turn a verdict into the gate's step record.
 *
 * A skip carries `skipped` and an exit code of 0 — the same shape
 * `audit-gate`'s network skip uses, and for the same reason: the ledger must
 * be able to tell "did not run" from "ran and passed", or the step reports a
 * success it never measured.
 */
export function stepFromVerdict(name, { verdict, reason }, ms = 0) {
  if (FAILING_VERDICTS.includes(verdict)) return { name, exitCode: 1, ms, reason };
  if (SKIPPED_VERDICTS.includes(verdict))
    return { name, exitCode: 0, ms, skipped: verdict, reason };
  return { name, exitCode: 0, ms, reason };
}
