/**
 * [security] Register C02 — the guard that stops `npm run test:security` from
 * passing while running nothing.
 *
 * The shapes below are real vitest JSON-reporter output from this repo, not
 * invented fixtures. The numbers are a RECORD of one run, not a live count —
 * the suite was 3,048 tests then and is 6,146 as of 2026-09-04:
 *
 *   with the tag intact      numTotalTests 3048, numPassedTests  337
 *   with the tag renamed     numTotalTests 3048, numPassedTests    0   → exit 0
 *
 * That second row is the whole problem. Vitest exits 0 when a `-t` filter
 * matches nothing, so renaming the tag silently disarms the security suite on
 * a REQUIRED check while CI stays green — and `numTotalTests` is IDENTICAL in
 * both rows, so a guard that read the total would report 3048 tests and wave
 * the disarmed run straight through.
 */
import { describe, expect, it } from 'vitest';

import { evaluateRun, SECURITY_TAG_PATTERN } from './security-test-gate.mjs';

describe('[security] evaluateRun — the disarmed-suite guard', () => {
  it('passes a healthy run', () => {
    const v = evaluateRun({ numTotalTests: 3048, numPassedTests: 337, numFailedTests: 0 });
    expect(v.ok).toBe(true);
    expect(v.executed).toBe(337);
  });

  it('FAILS when the tag matched nothing, despite a large collected total', () => {
    // The exact captured shape of a renamed tag. `numTotalTests` is 3048 —
    // reading that field is how this bug survives a "fix".
    const v = evaluateRun({ numTotalTests: 3048, numPassedTests: 0, numFailedTests: 0 });
    expect(v.ok).toBe(false);
    expect(v.executed).toBe(0);
    // The message has to point at the cause, or the next person reads
    // "0 tests" as an infrastructure blip and reruns the job.
    expect(v.reason).toMatch(/renamed or removed/);
  });

  it('FAILS when the filter selected the WHOLE suite — the unescaped-`-t` shape', () => {
    // The other half of C02, and the half the file only CLAIMED to check until
    // this case existed. A bare `[security]` passed to `-t` is a character
    // class matching nearly every name in the repo, so every test runs and the
    // gate reports a large, healthy-looking green. Nothing distinguished that
    // from a working filter except the ratio.
    const r = evaluateRun({ numPassedTests: 6135, numFailedTests: 0, numTotalTests: 6135 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/every collected test ran/);
  });

  it('a genuine subset still passes — the guard is a ratio, not a cap', () => {
    // Guards the other direction: the check must not fire on a healthy run,
    // however many security tests there are. ~1.3k of ~6.1k today.
    expect(evaluateRun({ numPassedTests: 1351, numFailedTests: 0, numTotalTests: 6135 }).ok).toBe(
      true,
    );
    // Even a very high proportion is fine as long as it is not the whole suite.
    expect(evaluateRun({ numPassedTests: 6134, numFailedTests: 0, numTotalTests: 6135 }).ok).toBe(
      true,
    );
  });

  it('fails an empty report rather than treating it as nothing-to-do', () => {
    const v = evaluateRun({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0 });
    expect(v.ok).toBe(false);
  });

  it('fails closed when vitest produced no parseable summary', () => {
    // A missing or corrupt report means we cannot prove anything ran, and
    // this gate exists precisely to refuse unproven runs.
    expect(evaluateRun(null).ok).toBe(false);
    expect(evaluateRun(undefined).ok).toBe(false);
  });

  it('fails when security tests actually failed', () => {
    const v = evaluateRun({ numTotalTests: 3048, numPassedTests: 330, numFailedTests: 7 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/7 security test\(s\) failed/);
  });

  it('counts a failed test as executed — the gate is not "did anything pass"', () => {
    // Distinguishes the two failure modes: 0-executed is a DISARMED suite,
    // which is a different emergency from a suite that ran and found bugs.
    const v = evaluateRun({ numTotalTests: 3048, numPassedTests: 0, numFailedTests: 5 });
    expect(v.executed).toBe(5);
    expect(v.reason).not.toMatch(/renamed or removed/);
  });

  it('treats missing counter fields as zero rather than NaN', () => {
    // A reporter-shape change must fail closed, not produce NaN > 0 === false
    // by accident and pass for the wrong reason.
    const v = evaluateRun({});
    expect(v.ok).toBe(false);
    expect(v.executed).toBe(0);
  });
});

describe('[security] the -t pattern stays regex-escaped', () => {
  it('escapes the brackets', () => {
    // Caught during implementation: passing a bare `[security]` to `-t` makes
    // vitest read it as the CHARACTER CLASS [security], which matches any
    // test name containing s, e, c, u, r, i, t or y — i.e. nearly every test
    // in the repo. The gate then "passes" having run the entire suite under
    // the security check's name. (This line used to put a number on it, 3028,
    // which was neither the header's recorded 3048 nor any live count — two
    // stale figures in one file, disagreeing.) The old npm script got this escaping from the
    // shell; spawning vitest directly means it has to live in the script.
    expect(SECURITY_TAG_PATTERN).toBe('\\[security\\]');
    // Pinned against a regex LITERAL rather than `new RegExp(pattern)`: the
    // literal is what the assertion is really about, and building one
    // dynamically here would only be re-deriving the value under test.
    const escaped = /\[security\]/;
    expect(escaped.source).toBe(SECURITY_TAG_PATTERN);
    expect(escaped.test('does a thing [security]')).toBe(true);
    // The load-bearing assertion: a name with no tag must NOT match. The
    // unescaped form — the character class [security] — matches this.
    expect(escaped.test('renders the sidebar')).toBe(false);
    expect(/[security]/.test('renders the sidebar')).toBe(true);
  });
});
