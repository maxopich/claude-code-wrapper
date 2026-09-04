/**
 * Tests for the CI audit gate. The two halves worth pinning down are the
 * osv-scanner.toml reader (a narrow regex reader, so its failure modes
 * need to be loud) and the expiry branch — an `ignoreUntil` that has
 * lapsed must block, or writing a date down means nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  collectAdvisories,
  evaluate,
  isDirectInvocation,
  nearestExpiry,
  parseIgnoreFile,
} from './audit-gate.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TOML = `
# leading comment
[[IgnoredVulns]]
id = "GHSA-aaaa-bbbb-cccc"
ignoreUntil = "2026-08-07T00:00:00Z"
reason = "held behind min-release-age"

[[IgnoredVulns]]
id = "GHSA-dddd-eeee-ffff"
ignoreUntil = "2026-10-28T00:00:00Z"
reason = "upstream bump pending"
`;

const audit = (vulnerabilities) => ({ vulnerabilities });

const advisory = (id, severity, pkg = 'somepkg') =>
  audit({
    [pkg]: {
      severity,
      via: [{ url: `https://github.com/advisories/${id}`, severity, title: 't', range: '<1' }],
    },
  });

describe('parseIgnoreFile', () => {
  it('reads every entry with its id and expiry', () => {
    const out = parseIgnoreFile(TOML);
    expect(out.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff']);
    expect(out[0].expiry.toISOString()).toBe('2026-08-07T00:00:00.000Z');
  });

  it('returns nothing for a file with no entries', () => {
    expect(parseIgnoreFile('# just a comment\n')).toEqual([]);
  });

  it('throws rather than silently skipping an entry with no id', () => {
    expect(() =>
      parseIgnoreFile('[[IgnoredVulns]]\nignoreUntil = "2026-01-01T00:00:00Z"\n'),
    ).toThrow(/has no `id`/);
  });

  it('throws rather than silently skipping an entry with no ignoreUntil', () => {
    expect(() => parseIgnoreFile('[[IgnoredVulns]]\nid = "GHSA-x"\n')).toThrow(
      /has no `ignoreUntil`/,
    );
  });

  it('throws on an unparseable date', () => {
    expect(() =>
      parseIgnoreFile('[[IgnoredVulns]]\nid = "GHSA-x"\nignoreUntil = "whenever"\n'),
    ).toThrow(/unparseable ignoreUntil/);
  });

  it('throws on an entry with no reason', () => {
    // An excuse with no written justification is an unexplained hole in two
    // required security checks. Checked after the date so the existing error
    // precedence — most structural field first — is unchanged.
    expect(() =>
      parseIgnoreFile('[[IgnoredVulns]]\nid = "GHSA-x"\nignoreUntil = "2026-08-20T00:00:00Z"\n'),
    ).toThrow(/has no `reason`/);
  });

  it('returns the reason it parsed', () => {
    expect(parseIgnoreFile(TOML).map((e) => e.reason)).toEqual([
      'held behind min-release-age',
      'upstream bump pending',
    ]);
  });

  it('does not let a following table leak keys into the last entry', () => {
    const out = parseIgnoreFile(`${TOML}\n[SomethingElse]\nid = "GHSA-leak"\n`);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.id)).not.toContain('GHSA-leak');
  });

  it('parses the real osv-scanner.toml [security]', () => {
    // The loop below asserts nothing when the file is empty, and the empty
    // state is the file's INTENDED resting state — every entry is a temporary
    // excuse. So from #519, when the last two `qs` holds were retired, this
    // case ran zero assertions and passed. A test whose corpus can legitimately
    // be empty needs something to check that is true at zero.
    //
    // That something is the parser agreeing with the raw text about HOW MANY
    // entries there are. Verified: declare one entry and make `parseIgnoreFile`
    // return nothing, and this fails where the bare loop passed.
    //
    // BE HONEST ABOUT THE BOUNDARY. At zero entries `0 === 0`, so a parser that
    // returns nothing still satisfies this line. What that case is really for
    // is the REAL FILE's well-formedness — `parseIgnoreFile` throws on an entry
    // with no id, no `ignoreUntil`, or an unparseable date, so a malformed hold
    // fails here the moment one is added. The parser itself is pinned by the
    // fixtures above, which do not depend on what the committed file happens to
    // contain today.
    const raw = readFileSync(join(REPO_ROOT, 'osv-scanner.toml'), 'utf8');
    const real = parseIgnoreFile(raw);
    const declared = (raw.match(/^\s*\[\[IgnoredVulns\]\]\s*$/gm) ?? []).length;
    expect(real).toHaveLength(declared);

    for (const entry of real) {
      expect(entry.id).toMatch(/^GHSA-/);
      expect(Number.isNaN(entry.expiry.getTime())).toBe(false);
    }
  });
});

describe('collectAdvisories', () => {
  it('emits one row per advisory object', () => {
    const out = collectAdvisories(advisory('GHSA-aaaa-bbbb-cccc', 'high', 'brace-expansion'));
    expect(out).toEqual([
      expect.objectContaining({
        id: 'GHSA-aaaa-bbbb-cccc',
        pkg: 'brace-expansion',
        severity: 'high',
      }),
    ]);
  });

  it('skips string `via` entries (vulnerable-only-via-a-dependency)', () => {
    const out = collectAdvisories(
      audit({ parent: { severity: 'high', range: '<1', via: ['child'] } }),
    );
    expect(out).toEqual([]);
  });

  it('handles an empty report', () => {
    expect(collectAdvisories({})).toEqual([]);
  });
});

describe('evaluate', () => {
  const ignores = parseIgnoreFile(TOML);
  const before = new Date('2026-07-28T00:00:00Z');
  const after = new Date('2026-09-01T00:00:00Z');

  it('blocks an unexcused high', () => {
    const r = evaluate(collectAdvisories(advisory('GHSA-9999', 'high')), ignores, before);
    expect(r.ok).toBe(false);
    expect(r.blocked.map((a) => a.id)).toEqual(['GHSA-9999']);
  });

  it('blocks an unexcused critical', () => {
    const r = evaluate(collectAdvisories(advisory('GHSA-9999', 'critical')), ignores, before);
    expect(r.ok).toBe(false);
  });

  it('passes an excused high while the date holds', () => {
    const r = evaluate(collectAdvisories(advisory('GHSA-aaaa-bbbb-cccc', 'high')), ignores, before);
    expect(r.ok).toBe(true);
    expect(r.excused.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('blocks the same advisory once ignoreUntil has passed [security]', () => {
    const r = evaluate(collectAdvisories(advisory('GHSA-aaaa-bbbb-cccc', 'high')), ignores, after);
    expect(r.ok).toBe(false);
    expect(r.expired.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    expect(r.blocked).toEqual([]);
  });

  it('ignores moderate and low regardless of the allowlist', () => {
    const r = evaluate(
      collectAdvisories(advisory('GHSA-moderate-only', 'moderate')),
      ignores,
      before,
    );
    expect(r.ok).toBe(true);
    expect(r.blocked).toEqual([]);
  });

  // Register C17. `GHSA-dddd-eeee-ffff` is the allowlist's moderate entry, and
  // the cases in this block are the whole of the fix: the DATE follows the
  // entry, the BLOCK follows the severity. Before this, the severity filter
  // ran first and an expired moderate entry was silently excused — while the
  // script's header promised a lapsed date exits 1. When C17 was written, four
  // of the seven live entries in osv-scanner.toml were moderate or low, so
  // most of the allowlist's dates were decoration. The live allowlist is empty
  // today — that count is history, and these fixtures are what keep the branch
  // measured while it is.
  // Deliberately the SAME entry and clock as 'blocks the same advisory once
  // ignoreUntil has passed' above, which covers it at `high`. Severity is then
  // the only variable between that passing test and these — which is exactly
  // the confusion C17 was.
  it('blocks a moderate advisory once its ignoreUntil has passed [security]', () => {
    const r = evaluate(
      collectAdvisories(advisory('GHSA-aaaa-bbbb-cccc', 'moderate')),
      ignores,
      after,
    );
    expect(r.ok).toBe(false);
    expect(r.expired.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    // Not `blocked` — the severity policy is untouched. It fails because the
    // deadline lapsed, which is a different and clearly-reported reason.
    expect(r.blocked).toEqual([]);
  });

  it('blocks a low advisory once its ignoreUntil has passed [security]', () => {
    // Low is the weakest severity an entry can cover and the easiest to argue
    // does not matter. It matters for the same reason: OSV-Scanner exits
    // non-zero on ANY unfiltered finding, so this entry is load-bearing for
    // the other required check, and a load-bearing entry has a real deadline.
    const r = evaluate(collectAdvisories(advisory('GHSA-aaaa-bbbb-cccc', 'low')), ignores, after);
    expect(r.ok).toBe(false);
    expect(r.expired.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('still passes a moderate whose ignoreUntil has not passed', () => {
    // The inverse, so the fix cannot be "fail on every moderate with an
    // entry". Same advisory, same allowlist, earlier clock.
    const r = evaluate(
      collectAdvisories(advisory('GHSA-dddd-eeee-ffff', 'moderate')),
      ignores,
      before,
    );
    expect(r.ok).toBe(true);
    expect(r.expired).toEqual([]);
    // And it is now REPORTED as excused rather than silently dropped, so the
    // gate's output stops omitting half the allowlist it is enforcing.
    expect(r.excused.map((a) => a.id)).toEqual(['GHSA-dddd-eeee-ffff']);
  });

  it('does not block an unexcused moderate even after the allowlist dates pass', () => {
    // The severity policy, pinned against the fix over-reaching. An advisory
    // with NO entry has no deadline to miss, whatever the clock says.
    //
    // Rewritten 2026-09-04. This case used to pass `ignores` and assert
    // `ok === true` at `after` — which reads as "the severity policy holds"
    // and was ALSO asserting that the fixture's own lapsed entries do not
    // expire, because nothing then expired an entry `npm audit` had not
    // reported. It was defending that hole. The severity claim is what the
    // case is for, so it is now made against an EMPTY allowlist, where the two
    // questions cannot be confused; the entry-deadline half is the case below.
    const r = evaluate(collectAdvisories(advisory('GHSA-no-entry', 'moderate')), [], after);
    expect(r.ok).toBe(true);
    expect(r.blocked).toEqual([]);
    expect(r.expired).toEqual([]);
  });

  it('expires a lapsed entry npm audit never reported [security]', () => {
    // The hole the case above was hiding. `expired` used to be filled only
    // inside the loop over reported advisories, so an entry whose advisory npm
    // cannot see — every OSV-only hold, by construction — had a date that
    // could never lapse. `scripts/audit-gate.mjs`'s own header records
    // GHSA-frvp-7c67-39w9 as exactly such a finding, so this is not a corner.
    const r = evaluate([], ignores, after);
    expect(r.ok).toBe(false);
    // Only the one whose date has actually passed. `GHSA-dddd-eeee-ffff` runs
    // to 2026-10-28, so it stays a warning — which is what stops this case
    // being satisfied by expiring every unmatched entry.
    expect(r.expired.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    expect(r.unused.map((ig) => ig.id)).toEqual(['GHSA-dddd-eeee-ffff']);
    // Reported as unmatched, so `main`'s output does not name a package and a
    // severity it was never told.
    for (const e of r.expired) {
      expect(e.matched).toBe(false);
      expect(e.pkg).toBeNull();
    }
  });

  it('an unmatched entry still inside its date is a warning, not a failure', () => {
    // The other side of the same line, so the change above cannot be satisfied
    // by expiring every unmatched entry regardless of its date.
    const r = evaluate([], ignores, before);
    expect(r.ok).toBe(true);
    expect(r.expired).toEqual([]);
    expect(r.unused.map((ig) => ig.id).sort()).toEqual(ignores.map((ig) => ig.id).sort());
  });

  it('a lapsed entry and an unrelated blocking advisory are counted separately', () => {
    const r = evaluate(collectAdvisories(advisory('GHSA-9999', 'high')), ignores, after);
    expect(r.ok).toBe(false);
    expect(r.blocked.map((a) => a.id)).toEqual(['GHSA-9999']);
    expect(r.expired.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('reports an unused ignore without failing the run', () => {
    const r = evaluate([], ignores, before);
    expect(r.ok).toBe(true);
    expect(r.unused.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff']);
  });

  it('does not call an ignore unused when it covers a non-blocking advisory', () => {
    // GHSA-dddd covers a moderate: below this gate's threshold, but OSV
    // still blocks on it, so the entry must not be flagged for retirement.
    const r = evaluate(
      collectAdvisories(advisory('GHSA-dddd-eeee-ffff', 'moderate')),
      ignores,
      before,
    );
    expect(r.ok).toBe(true);
    expect(r.unused.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('passes cleanly on an empty report', () => {
    expect(evaluate([], [], before).ok).toBe(true);
  });
});

// Register C17 armed these dates; nothing showed how close one was. The gate
// passed silently at 12 days out and at 1 day out with identical output, so
// the first sign of a lapsed hold was a red required check on an unrelated PR.
describe('nearestExpiry', () => {
  const ignores = parseIgnoreFile(TOML);
  const before = new Date('2026-07-28T00:00:00Z');
  const after = new Date('2026-09-01T00:00:00Z');

  it('picks the soonest entry, not the first one listed', () => {
    // Order matters and the fixture is already in soonest-first order, which
    // would let a `[0]` implementation pass. Assert the id AND the day count
    // so "returns something" is not enough.
    const next = nearestExpiry(ignores, before);
    expect(next.id).toBe('GHSA-aaaa-bbbb-cccc');
    expect(next.days).toBe(10);
  });

  it('picks the soonest entry when the fixture order is reversed', () => {
    // The positive control for the case above: same data, opposite order. A
    // `[0]` implementation passes one of these two and fails the other.
    const next = nearestExpiry([...ignores].reverse(), before);
    expect(next.id).toBe('GHSA-aaaa-bbbb-cccc');
  });

  it('skips entries already past their date', () => {
    // A "next deadline" pointing backwards is not a deadline. At this instant
    // GHSA-aaaa has lapsed, so the answer must be the one still ahead.
    const next = nearestExpiry(ignores, after);
    expect(next.id).toBe('GHSA-dddd-eeee-ffff');
  });

  it('returns null when every entry has lapsed', () => {
    expect(nearestExpiry(ignores, new Date('2026-11-01T00:00:00Z'))).toBeNull();
  });

  it('returns null for an empty allowlist', () => {
    expect(nearestExpiry([], before)).toBeNull();
  });

  it('the fixture really does straddle the two instants — anti-vacuity', () => {
    // Every case above depends on GHSA-aaaa being ahead at `before` and behind
    // at `after`. If the fixture dates drifted, several would pass by
    // accident — "returns null" is satisfied by an allowlist that parsed as
    // empty just as happily as by one whose entries all lapsed.
    expect(ignores).toHaveLength(2);
    expect(nearestExpiry(ignores, before).id).not.toBe(nearestExpiry(ignores, after).id);
  });
});

// Register C01 [security]. The entry guard was `if (import.meta.main) main()`.
// `import.meta.main` arrived in Node 22.18 and is `undefined` on Node 20 —
// which is what ci.yml pinned AT THE TIME. So on CI the guard was always
// falsy: the `Audit dependencies` step ran this file, printed nothing, exited
// 0, and audited nothing. Every PR merged in that era had a green audit check
// that never looked at a single advisory.
//
// `Cebab-mfvu` MOVED CI TO NODE 24, which means the Node version that made
// this bug bite is no longer reachable from any of our runners. That does not
// make the guard unnecessary — it makes the END-TO-END case below unable to
// see a regression, so the version-independent cases have to carry it. See
// the note on that case for what was done instead of leaving a comment
// claiming a protection that had quietly expired.
//
// These cases pin the replacement predicate directly, so they are meaningful
// on every Node version rather than only on the one where the bug bites.
describe('[security] isDirectInvocation — the entry guard', () => {
  // Paths have to be platform-shaped, and the module URL DERIVED from the
  // path rather than hand-written. A hardcoded `file:///repo/...` fixture is
  // POSIX-only: on Windows `pathToFileURL('/repo/x')` resolves against the
  // current DRIVE and yields `file:///D:/repo/x`, so the comparison fails and
  // the test reports a bug that isn't there. (It did exactly that on
  // windows-2022 before this was fixed.)
  const ENTRY_PATH =
    process.platform === 'win32'
      ? 'C:\\repo\\scripts\\audit-gate.mjs'
      : '/repo/scripts/audit-gate.mjs';
  const MODULE_URL = pathToFileURL(ENTRY_PATH).href;

  it('runs main() when the script IS the process entry point', () => {
    expect(isDirectInvocation(MODULE_URL, ENTRY_PATH)).toBe(true);
  });

  it('stays inert when the module is merely imported (the vitest case)', () => {
    // This very test file imports audit-gate.mjs. If the guard returned true
    // here, importing the module would run `npm audit` as a side effect of
    // collecting tests.
    const vitestBin =
      process.platform === 'win32'
        ? 'C:\\repo\\node_modules\\.bin\\vitest'
        : '/repo/node_modules/.bin/vitest';
    expect(isDirectInvocation(MODULE_URL, vitestBin)).toBe(false);
  });

  it('stays inert when argv[1] is absent', () => {
    // `node --eval` and some embeddings leave argv[1] undefined. Fail closed:
    // an unknown entry point is not a direct invocation.
    expect(isDirectInvocation(MODULE_URL, undefined)).toBe(false);
    expect(isDirectInvocation(MODULE_URL, '')).toBe(false);
  });

  it('matches a real path through pathToFileURL rather than string compare', () => {
    // The reason for pathToFileURL: on Windows argv[1] is `C:\repo\...` while
    // import.meta.url is `file:///C:/repo/...`. A `===` on the raw strings
    // would never match, silently disabling the gate on windows-2022 — the
    // same class of bug as the original, just on the other OS.
    expect(MODULE_URL).not.toBe(ENTRY_PATH);
    expect(isDirectInvocation(MODULE_URL, ENTRY_PATH)).toBe(true);
  });

  it('does not match a different file with a similar path', () => {
    expect(isDirectInvocation(MODULE_URL, `${ENTRY_PATH}.bak`)).toBe(false);
  });
});

describe('[security] the audit gate actually runs when invoked', () => {
  it('emits a verdict on stdout instead of exiting silently', () => {
    // The end-to-end shape of C01: before the fix this produced EMPTY output
    // and exit 0 on Node 20.
    //
    // `Cebab-mfvu`: this case is now a SMOKE TEST EVERYWHERE, and saying so is
    // the point. Its old caveat read "on CI's Node 20 it is the regression
    // guard, and CI is where the bug lived" — true when written, and made
    // false by moving CI to Node 24, where `import.meta.main` exists and the
    // reverted code would pass this case too. A comment claiming a protection
    // that has silently expired is worse than no comment, because the next
    // reader budgets for a guard that is not there.
    //
    // What guards C01 now: the `isDirectInvocation` cases above (which pin the
    // predicate on every Node), plus `the entry point still uses the tested
    // predicate` below — a source-derived check that is version-independent by
    // construction and is what actually reddens on a revert.
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'audit-gate.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // npm audit reaches the network; give it room and let a failure surface
      // as a test failure rather than a hang.
      timeout: 120_000,
    });
    expect(out.trim()).not.toBe('');
    expect(out).toMatch(/Audit gate passed/);
  });

  it('the entry point still uses the tested predicate, not `import.meta.main`', () => {
    // THE REPLACEMENT GUARD FOR C01, and it exists because the old one expired
    // silently. The unit cases above prove `isDirectInvocation` is correct; the
    // end-to-end case above can no longer prove the script CALLS it, because on
    // Node >= 22.18 the reverted `import.meta.main` form works too. Between
    // those two there was a gap exactly the shape of the original bug: a
    // correct, well-tested predicate that nothing was obliged to use.
    //
    // Derived from the source, in the same idiom as
    // `errors.control_signal_registry.test.ts` and `ci_setup_steps_match`:
    // asking the file rather than asking the reader to remember. Reddens on a
    // revert to `import.meta.main` on EVERY Node version, which is the property
    // the version-dependent case never had.
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'audit-gate.mjs'), 'utf8');
    // Premise first — an empty or unreadable file would satisfy the negative
    // assertion below for entirely the wrong reason.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toMatch(
      /^if \(isDirectInvocation\(import\.meta\.url, process\.argv\[1\]\)\) main\(\);$/m,
    );
    // `import.meta.main` must not be the thing being branched on anywhere.
    expect(src).not.toMatch(/if\s*\(\s*import\.meta\.main/);
  });
});
