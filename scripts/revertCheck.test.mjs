/**
 * The revert-check verdict, and the trap that makes a naive version worse than
 * no check at all.
 *
 * WHAT WENT WRONG. `build-prompt.md` has required "a test that fails before
 * your change and passes after it" since the loop was written, and nothing
 * ever checked it. `Cebab-dwcq` measured the cost on the run of 2026-09-01:
 * three tests pass with their own fix reverted. All three are web-side, and
 * `web/` is the tier exempt from the Playground by operator decision — so it
 * had no runtime verification at all.
 *
 * THE FIXTURES BELOW ARE MEASURED, NOT INVENTED. Both shapes were produced by
 * running vitest 4.1.10 against real files in this repo, on 2026-09-02:
 *
 *   A) a test file importing a module that does not exist
 *   B) a test file with one failing assertion and one passing test
 *
 *                        exit  numTotalTests  numPassedTests  numFailedTests  numFailedTestSuites
 *   A collection error     1         0              0               0                  1
 *   B assertion failure    1         2              1               1                  2
 *
 * Both exit 1. That is the whole point: a check keyed on the exit code reads
 * (A) — a file that never ran — as "the test failed without the fix, good", and
 * then certifies a genuinely vacuous test in that same file as sound. The
 * fixture table is the asset here; if these two rows ever stop being true the
 * discriminator has to be re-derived, not patched.
 */
import { describe, expect, test } from 'vitest';

import {
  FAILING_VERDICTS,
  addedTestTitles,
  classifyAddedCases,
  SKIPPED_VERDICTS,
  classifyRevertRun,
  sourceFilesInDiff,
  stepFromVerdict,
  testFilesInDiff,
} from './lib/loop/revert_check.mjs';

/** (A) verbatim shape of a vitest run whose only file failed to import. */
const COLLECTION_ERROR = {
  numTotalTests: 0,
  numPassedTests: 0,
  numFailedTests: 0,
  numTotalTestSuites: 1,
  numFailedTestSuites: 1,
  success: false,
};

/** (B) verbatim shape of a vitest run with a real assertion failure. */
const ASSERTION_FAILURE = {
  numTotalTests: 2,
  numPassedTests: 1,
  numFailedTests: 1,
  numTotalTestSuites: 1,
  numFailedTestSuites: 2,
  success: false,
};

describe('classifyRevertRun — the exit code is never the answer', () => {
  test('a real failure against the base tree means the test depends on the change', () => {
    const out = classifyRevertRun(ASSERTION_FAILURE);
    expect(out.verdict).toBe('depends');
    expect(out.executed).toBe(2);
  });

  test('THE TRAP: a collection error is NOT a pass, even though vitest exits 1', () => {
    // The single most important case in this file. (A) and (B) are
    // indistinguishable by exit code — both 1 — and opposite in meaning.
    const out = classifyRevertRun(COLLECTION_ERROR);
    expect(out.verdict).not.toBe('depends');
    expect(out.verdict).toBe('uncollectable');
    expect(SKIPPED_VERDICTS).toContain(out.verdict);
  });

  test('tests that PASS without the change are the defect this exists to catch', () => {
    const out = classifyRevertRun({ numTotalTests: 4, numPassedTests: 4, numFailedTests: 0 });
    expect(out.verdict).toBe('vacuous');
    expect(FAILING_VERDICTS).toContain(out.verdict);
    expect(out.reason).toMatch(/not evidence of the fix/);
  });

  test('numTotalTests is not consulted — skipped tests inflate it', () => {
    // `security-test-gate.mjs` documents the same trap from the other side: a
    // renamed tag produced `numTotalTests: 3048` on a run that executed
    // nothing. Reading the total here would call that `vacuous` and fail a
    // bead for a filter problem.
    const out = classifyRevertRun({
      numTotalTests: 3048,
      numPassedTests: 0,
      numFailedTests: 0,
      numFailedTestSuites: 0,
    });
    expect(out.executed).toBe(0);
    expect(out.verdict).toBe('empty');
    expect(FAILING_VERDICTS).not.toContain(out.verdict);
  });

  test('an unparseable summary is inconclusive, never a pass and never a bead failure', () => {
    // The harness failed, not the diff. Failing the bead for it teaches the
    // operator to switch the step off, which costs more than the step is worth.
    for (const bad of [null, undefined, '', 0, 'not json']) {
      const out = classifyRevertRun(bad);
      expect(out.verdict, String(bad)).toBe('inconclusive');
      expect(FAILING_VERDICTS).not.toContain(out.verdict);
    }
  });

  test('exactly one verdict fails the gate', () => {
    // A guard on the classification itself: if a later edit adds a verdict and
    // forgets to place it, this names the omission rather than letting it
    // default to "passes".
    const all = ['depends', 'vacuous', 'uncollectable', 'empty', 'inconclusive'];
    for (const v of all) {
      const placed =
        FAILING_VERDICTS.includes(v) || SKIPPED_VERDICTS.includes(v) || v === 'depends';
      expect(placed, `verdict '${v}' is in neither list and is not the pass case`).toBe(true);
    }
    expect(FAILING_VERDICTS).toEqual(['vacuous']);
  });
});

describe('stepFromVerdict — a skip must never read as a pass', () => {
  test('a vacuous verdict is a non-zero exit', () => {
    expect(stepFromVerdict('revert-check', classifyRevertRun({ numPassedTests: 2 }))).toMatchObject(
      {
        exitCode: 1,
      },
    );
  });

  test('every skipped verdict carries `skipped`, so the ledger can tell it from a pass', () => {
    // Same shape `audit-gate`'s network skip uses. Without the marker a step
    // that measured nothing is indistinguishable in the ledger from one that
    // measured everything and was happy.
    for (const summary of [COLLECTION_ERROR, null, { numTotalTests: 9 }]) {
      const step = stepFromVerdict('revert-check', classifyRevertRun(summary));
      expect(step.exitCode).toBe(0);
      expect(step.skipped, JSON.stringify(summary)).toBeTruthy();
    }
  });

  test('a passing verdict carries no `skipped` marker', () => {
    // The other direction: without this, marking everything skipped would
    // satisfy the assertion above and disarm the step entirely.
    const step = stepFromVerdict('revert-check', classifyRevertRun(ASSERTION_FAILURE));
    expect(step.exitCode).toBe(0);
    expect(step.skipped).toBeUndefined();
  });

  test('the reason travels, so the ledger row says which of the five it was', () => {
    const step = stepFromVerdict('revert-check', classifyRevertRun(COLLECTION_ERROR));
    expect(step.reason).toMatch(/could not be collected/);
  });
});

describe('splitting a diff into tests and the change they should depend on', () => {
  const DIFF = [
    'server/src/ws/permission.ts',
    'server/src/ws/permission.test.ts',
    'web/src/components/ManagedCopyModal.tsx',
    'web/src/components/ManagedCopyModal.test.tsx',
    'scripts/loop.test.mjs',
    'docs/README.md',
    'shared/src/protocol.ts',
  ];

  test('every vitest extension is recognised', () => {
    expect(testFilesInDiff(DIFF)).toEqual([
      'server/src/ws/permission.test.ts',
      'web/src/components/ManagedCopyModal.test.tsx',
      'scripts/loop.test.mjs',
    ]);
  });

  test('the two halves partition the diff — nothing is dropped or counted twice', () => {
    const tests = testFilesInDiff(DIFF);
    const source = sourceFilesInDiff(DIFF);
    expect([...tests, ...source].sort()).toEqual([...DIFF].sort());
    expect(tests.filter((t) => source.includes(t))).toEqual([]);
  });

  test('a file merely NAMED like a test is not one', () => {
    // `latest.ts` ends in `test.ts` on a naive substring match, and
    // `contest.tsx` on a naive `.test` search. Both are real-looking names.
    expect(testFilesInDiff(['src/latest.ts', 'src/contest.tsx', 'src/testing.ts'])).toEqual([]);
  });

  test('an empty diff yields empty halves rather than throwing', () => {
    expect(testFilesInDiff([])).toEqual([]);
    expect(sourceFilesInDiff([])).toEqual([]);
  });
});

describe('addedTestTitles — the unit is the case, not the file', () => {
  // WHY PER-CASE. The first design classified whole FILES: run the changed
  // test files against the base and ask whether any test failed. Verified
  // against the corpus `Cebab-dwcq` had already measured, that was too coarse
  // to catch what it was built for — on `a009f68` it reported `depends`,
  // because 4 of 52 tests did fail, while the one case dwcq names still passed
  // with the fix reverted. "Some test in this file fails" is a much weaker
  // claim than "the test that shipped with this fix fails".

  test('added cases are picked up; removed and context lines are not', () => {
    const patch = [
      '+++ b/x.test.ts',
      "+  test('alpha does a thing', () => {",
      "-  test('deleted case', () => {",
      "   test('untouched context', () => {",
      "+  it('beta', () => {",
    ].join('\n');
    expect(addedTestTitles(patch)).toEqual(['alpha does a thing', 'beta']);
  });

  test('the +++ header is not mistaken for an added line', () => {
    // `+++ b/...` starts with `+` and is not a content line. Without the guard
    // a path containing the word `test(` would register as a case.
    expect(addedTestTitles("+++ b/src/test('x').ts")).toEqual([]);
  });

  test('modifier forms are recognised, `.each` deliberately is not', () => {
    const patch = [
      "+  test.skip('skipped one', () => {",
      "+  it.only('focused one', () => {",
      '+  test.each(TABLE)(`templated ${n}`, () => {',
    ].join('\n');
    // `.each` titles are templates with no static text to look up in the
    // results, so they are out of range by design rather than by omission —
    // and `classifyAddedCases` reports anything it cannot match as unmatched.
    expect(addedTestTitles(patch)).toEqual(['skipped one', 'focused one']);
  });

  test('both quote styles, and a title containing the other quote', () => {
    const patch = [
      '+  test(\'it says "stopping" now\', () => {',
      '+  test("single \' inside", () => {',
    ].join('\n');
    expect(addedTestTitles(patch)).toEqual(['it says "stopping" now', "single ' inside"]);
  });

  test('duplicates collapse — the same title added twice is one case to check', () => {
    const patch = ["+  test('same', () => {", "+  test('same', () => {"].join('\n');
    expect(addedTestTitles(patch)).toEqual(['same']);
  });
});

describe('classifyAddedCases — which of the added cases actually depend on the change', () => {
  const summaryOf = (pairs) => ({
    testResults: [{ assertionResults: pairs.map(([title, status]) => ({ title, status })) }],
  });

  test('a case that PASSES against the base tree is the defect', () => {
    const out = classifyAddedCases(summaryOf([['vacuous one', 'passed']]), ['vacuous one']);
    expect(out.vacuous).toEqual(['vacuous one']);
    expect(out.depends).toEqual([]);
  });

  test('a case that FAILS against the base tree is doing its job', () => {
    const out = classifyAddedCases(summaryOf([['good one', 'failed']]), ['good one']);
    expect(out.depends).toEqual(['good one']);
    expect(out.vacuous).toEqual([]);
  });

  test('a case with no result at all is unmatched, never assumed sound', () => {
    // The quiet failure mode: a title the extractor produced but the run never
    // reported. Counting it as `depends` would let a renamed test disappear
    // into a pass.
    const out = classifyAddedCases(summaryOf([['other', 'passed']]), ['ghost']);
    expect(out.unmatched).toEqual(['ghost']);
    expect(out.vacuous).toEqual([]);
    expect(out.depends).toEqual([]);
  });

  test('a duplicated title counts as depending if ANY instance failed', () => {
    // Two `describe` blocks can hold the same case name. Flagging the pair as
    // vacuous because one namesake passed would fail a sound test; the
    // conservative reading is the right one here because the vacuous verdict
    // reddens the gate.
    const out = classifyAddedCases(
      summaryOf([
        ['shared name', 'passed'],
        ['shared name', 'failed'],
      ]),
      ['shared name'],
    );
    expect(out.depends).toEqual(['shared name']);
    expect(out.vacuous).toEqual([]);
  });

  test('a summary with no testResults yields everything unmatched, not everything sound', () => {
    for (const s of [null, {}, { testResults: [] }, { testResults: [{}] }]) {
      const out = classifyAddedCases(s, ['a', 'b']);
      expect(out.unmatched, JSON.stringify(s)).toEqual(['a', 'b']);
      expect(out.vacuous).toEqual([]);
    }
  });
});
