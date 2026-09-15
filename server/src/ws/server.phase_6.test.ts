import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { isRateLimited, rateLimitDispatch, wrapperErrorDispatch } from './server.js';

// Cluster A Phase 6: pure-function unit tests for the two dispatch helpers
// extracted from `runOneTurn`. These exist so each branch of the §7-floor
// vocabulary routing is asserted in isolation — without spinning up the WS
// server, the SDK, or the dispatcher LRU. The integration is exercised by
// `ci_smoke.ts` end-to-end after this PR lands.

describe('rateLimitDispatch — hit vs cleared vs silence (Cluster A Phase 6; Cebab-mo7j)', () => {
  // Stable "now" so the test doesn't race the wall clock.
  const NOW = 1_700_000_000_000;

  /**
   * Cebab-mo7j. THE CASE THIS SUITE DID NOT HAVE, and the reason it stayed
   * green through the defect: every assertion below used `status: 'limited'`,
   * a value no SDK release emits, while the ONE case using the real value
   * (`'allowed'`) omitted `resetsAtMs` — the field a real event always
   * carries. So the suite exercised two shapes that do not occur and never the
   * one that occurs on every healthy turn.
   *
   * This is that shape, copied from the repo's own captured fixture
   * (`fixtures/hello.jsonl`), converted to the ms field the dispatch reads.
   */
  test('the real healthy-turn event says nothing at all', () => {
    const healthy = { status: 'allowed', resetsAtMs: NOW + 7 * 60 * 60 * 1000 };
    expect(isRateLimited(healthy, NOW)).toBe(false);
    expect(rateLimitDispatch(healthy, NOW)).toBeNull();
  });

  // The anti-vacuity control for the case above: the same future reset time
  // with a status that is NOT the known-good value must still warn. Without
  // this, "return null" would pass the test above while silencing real limits.
  test('the same future reset with a non-allowed status still warns', () => {
    const out = rateLimitDispatch({ status: 'limited', resetsAtMs: NOW + 60_000 }, NOW);
    expect(out?.subCode).toBe('hit');
    expect(out?.severity).toBe('warn');
    expect(out?.title).toBe('Rate limit');
    // The message embeds the formatted local-time "Retry after …" — we
    // assert the prefix + the presence of "Retry after" rather than the
    // exact locale formatting (test machines may render different locales).
    expect(out?.message).toContain('limited');
    expect(out?.message).toContain('Retry after');
  });

  // The direction of the rule, stated as a test: one known-good value, and
  // anything unrecognised counts as a limit. An allow-list of BAD statuses
  // would make the first limit variant the SDK invents silently invisible.
  test('an unknown status with a future reset is treated as a limit, not as healthy', () => {
    const out = rateLimitDispatch({ status: 'some_future_variant', resetsAtMs: NOW + 60_000 }, NOW);
    expect(out?.subCode).toBe('hit');
    expect(out?.severity).toBe('warn');
  });

  test('status defaults to "limited" when only resetsAtMs is set (hit path)', () => {
    const out = rateLimitDispatch({ resetsAtMs: NOW + 10_000 }, NOW);
    expect(out?.subCode).toBe('hit');
    expect(out?.message.startsWith('limited')).toBe(true);
  });

  /**
   * `cleared` is a TRANSITION, so it needs a session that was told about a
   * limit. Previously every non-hit event produced one, which would have moved
   * the per-turn announcement from warn to info rather than removing it.
   */
  test('a lifted limit is announced only to a session that was told about one', () => {
    const lifted = { status: 'allowed', resetsAtMs: NOW + 60_000 };
    expect(rateLimitDispatch(lifted, NOW, { limitWasActive: true })).toMatchObject({
      subCode: 'cleared',
      severity: 'info',
      title: 'Rate limit cleared',
      // Status string is passed through verbatim — forward-compat with the SDK
      // adding new status variants.
      message: 'allowed',
    });
    expect(rateLimitDispatch(lifted, NOW, { limitWasActive: false })).toBeNull();
  });

  test('an expired reset clears a session that was limited, and is silent otherwise', () => {
    const expired = { status: 'limited', resetsAtMs: NOW - 60_000 };
    expect(rateLimitDispatch(expired, NOW, { limitWasActive: true })?.subCode).toBe('cleared');
    expect(rateLimitDispatch(expired, NOW)).toBeNull();
  });

  test('an empty payload falls back to the default cleared message', () => {
    expect(rateLimitDispatch({}, NOW, { limitWasActive: true })?.message).toBe('limit lifted');
    expect(rateLimitDispatch({}, NOW)).toBeNull();
  });

  // Register S01. The event carries BOTH `resetsAt` (raw SDK seconds) and
  // `resetsAtMs`, and this function used to take the seconds one. Seconds are
  // always "in the past" against a millisecond clock, so an ACTIVE limit was
  // reported as `cleared` — every single time. The operator was told the limit
  // had lifted at the exact moment they hit it.
  test('an active limit is reported as hit, not cleared', () => {
    // The realistic shape: SDK seconds ~1.7e9, ms clock ~1.7e12.
    const resetsAtSeconds = Math.floor(NOW / 1000) + 60;
    const out = rateLimitDispatch({ status: 'limited', resetsAtMs: resetsAtSeconds * 1000 }, NOW);
    expect(out?.subCode).toBe('hit');
    expect(out?.severity).toBe('warn');
  });

  test('a raw-seconds value is NOT silently treated as a live limit', () => {
    // The regression guard: if someone reintroduces a seconds-valued field,
    // this reads as long-expired rather than quietly re-breaking the branch.
    // (Fails loudly here instead of shipping a permanently-cleared banner.)
    const resetsAtSeconds = Math.floor(NOW / 1000) + 60;
    const out = rateLimitDispatch({ status: 'limited', resetsAtMs: resetsAtSeconds }, NOW, {
      limitWasActive: true,
    });
    expect(out?.subCode).toBe('cleared');
  });

  test('the retry-after text renders the reset time, not the epoch', () => {
    // With seconds this formatted a 1970 timestamp — unreachable before the
    // fix, wrong the moment it became reachable.
    const out = rateLimitDispatch({ status: 'limited', resetsAtMs: NOW + 60_000 }, NOW);
    expect(out?.message).toContain(new Date(NOW + 60_000).toLocaleTimeString());
  });
});

/**
 * Cebab-mo7j: `isRateLimited` exists so the notification and the
 * `session_running { status: 'rate_limited' }` banner cannot disagree. The
 * banner's own predicate used to be `out.status === 'hard'`, which no SDK
 * release emits — so it never fired. These pin the shared answer directly.
 */
describe('isRateLimited — the single predicate both surfaces read (Cebab-mo7j)', () => {
  const NOW = 1_700_000_000_000;

  test("the string 'hard' is not special, and a real limit does not need it", () => {
    // The dead comparison would have answered false for this; the whole point
    // is that an actual limit is recognised whatever the SDK calls it.
    expect(isRateLimited({ status: 'hard', resetsAtMs: NOW + 60_000 }, NOW)).toBe(true);
    expect(isRateLimited({ status: 'five_hour_limit', resetsAtMs: NOW + 60_000 }, NOW)).toBe(true);
  });

  test('allowed is the one value that means no limit, whatever the clock says', () => {
    expect(isRateLimited({ status: 'allowed', resetsAtMs: NOW + 60_000 }, NOW)).toBe(false);
    expect(isRateLimited({ status: 'allowed' }, NOW)).toBe(false);
  });

  test('no reset time means no limit to wait out', () => {
    expect(isRateLimited({ status: 'limited' }, NOW)).toBe(false);
    expect(isRateLimited({}, NOW)).toBe(false);
  });
});

describe('wrapperErrorDispatch — sub-code routing (Cluster A Phase 6)', () => {
  test('auth_expired → error severity + reauth action + auth.transition audit kind', () => {
    const d = wrapperErrorDispatch('auth_expired', 'sess-1')!;
    expect(d.severity).toBe('error');
    expect(d.reasonCode).toBe('auth_expired');
    expect(d.auditKind).toBe('auth.transition');
    // UX-3: Re-authenticate primary action.
    expect(d.action).toEqual({ kind: 'reauth' });
  });

  test('parse_error → error severity + session.crashed kind + no action', () => {
    const d = wrapperErrorDispatch('parse_error', 'sess-1')!;
    expect(d.severity).toBe('error');
    expect(d.reasonCode).toBe('parse_error');
    expect(d.auditKind).toBe('session.crashed');
    // No CTA — a parse error from the SDK isn't recoverable by retry.
    expect(d.action).toBeUndefined();
  });

  test('process_crashed → error severity + restart_agent action carrying sessionId', () => {
    const d = wrapperErrorDispatch('process_crashed', 'sess-42')!;
    expect(d.severity).toBe('error');
    expect(d.reasonCode).toBe('process_crash');
    expect(d.auditKind).toBe('session.crashed');
    // sessionId must thread through so the dock CTA can target the right
    // session — empty sessionId would break NotificationAction's contract.
    expect(d.action).toEqual({ kind: 'restart_agent', sessionId: 'sess-42' });
  });

  test('claude_not_found → error severity + open_settings action', () => {
    const d = wrapperErrorDispatch('claude_not_found', 'sess-1')!;
    expect(d.severity).toBe('error');
    expect(d.reasonCode).toBe('claude_not_found');
    // The recovery action is "open Settings" so the operator can confirm
    // the install path / re-run setup.
    expect(d.action).toEqual({ kind: 'open_settings' });
  });

  test('rate_limited → warn severity (fallback; live stream handles the typical case)', () => {
    // rate_limited is handled via the typed `rate_limit_event` stream;
    // this branch fires only if classifyError reaches it from an
    // exception (rare). It should still produce a usable notification
    // rather than fall through silently.
    const d = wrapperErrorDispatch('rate_limited', 'sess-1')!;
    expect(d.severity).toBe('warn');
    expect(d.title).toBe('Rate limit');
  });

  // Register S02b [security]. `AbortError` classified as `process_crashed`,
  // so pressing Stop — or just closing the browser mid-turn — produced the
  // `process_crashed` dispatch below: severity error, title "Turn failed",
  // and a `restart_agent` CTA. Because that notification is operational AND
  // sticky, the dispatcher PERSISTS it, so the false failure survived reload
  // and sat in the operator's inbox offering to restart a turn they ended on
  // purpose.
  test('[security] aborted produces NO notification at all', () => {
    expect(wrapperErrorDispatch('aborted', 'sess-1')).toBeNull();
  });

  test('[security] aborted never offers a restart CTA', () => {
    // The specific harm: a Restart button for a deliberate stop invites the
    // operator to re-run work they chose to abandon. Asserted separately from
    // the null check so a future change that returns a dispatch for `aborted`
    // still has to justify the action explicitly.
    const d = wrapperErrorDispatch('aborted', 'sess-42');
    expect(d?.action).toBeUndefined();
  });

  test('every other kind still notifies — the suppression is narrow', () => {
    for (const kind of [
      'auth_expired',
      'parse_error',
      'process_crashed',
      'claude_not_found',
    ] as const) {
      expect(wrapperErrorDispatch(kind, 'sess-1')).not.toBeNull();
    }
  });
});

/**
 * Cebab-mo7j: a SOURCE scan, because the unit tests above cannot see this.
 *
 * The defect being pinned was not in the pure function — it was at the call
 * site, where the `session_running { status: 'rate_limited' }` banner was
 * gated on `out.status === 'hard'`. Reverting that comparison leaves every
 * behavioural test in this file green, because `runOneTurn` is a several
 * -thousand-line function inside a live SDK stream and nothing here reaches
 * it. The measured revert-check is what makes this test exist rather than a
 * comment asking the next author to remember: mutation 1 (the pure rule)
 * reddens three cases; mutation 2 (this call site) reddened none.
 *
 * The same shape as `[security] no bus gate call site pins its own scopes` in
 * `bus/scope_conformance.test.ts`, and for the same reason: some invariants
 * live in which function a call site calls, and a scan is the only reader.
 */
describe('[security] the rate-limit banner reads the shared predicate (Cebab-mo7j)', () => {
  const raw = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

  /**
   * Comments are not call sites. This file's own prose quotes the dead
   * comparison in order to explain it, so a scan of the raw text would fail on
   * the very commit that removes the defect — and the tempting fix (rewording
   * the comment) would leave a gate that any future comment can break.
   *
   * Replaced with spaces rather than deleted so byte offsets still line up
   * with the raw file, which is what lets the second test walk backwards from
   * a marker to its enclosing guard.
   */
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

  test('the comment stripper leaves the code it is supposed to scan', () => {
    // The stripper is the part of this gate most able to fail open: one that
    // returned empty would satisfy every `not.toMatch` below while measuring
    // nothing. So pin what must SURVIVE it, not just what must be absent.
    expect(code).toContain('export function isRateLimited(');
    expect(code).toContain("status: 'rate_limited',");
    expect(code.length).toBeGreaterThan(raw.length / 2);
    // And pin that it really did remove the prose: the explanatory comment
    // above the guard quotes the dead comparison, and the raw file therefore
    // still contains it.
    expect(raw).toMatch(/status\s*===\s*'hard'/);
  });

  test("no call site compares a rate-limit status to a literal 'hard'", () => {
    expect(code).not.toMatch(/status\s*===\s*'hard'/);
  });

  test('the rate_limited banner emit is guarded by isRateLimited', () => {
    const at = code.indexOf("status: 'rate_limited',");
    // Anti-vacuity, and the half that matters most: if the banner emit is ever
    // renamed or removed, this must fail rather than pass by finding nothing.
    expect(at).toBeGreaterThan(-1);

    const before = code.slice(0, at);
    const guardAt = before.lastIndexOf('if (');
    expect(guardAt).toBeGreaterThan(-1);
    const guard = before.slice(guardAt, before.indexOf('\n', guardAt));
    expect(guard).toContain('isRateLimited(');
  });
});

/**
 * Cebab-qz7m: a SOURCE scan, for the same reason as the rate-limit one above —
 * the saving is invisible to any behavioural test reachable from here.
 *
 * `gateProjectsForSpawn` reads three fields of the resolved authority
 * (`mcpServers`, `detectedEnvInjections`, `hooks`) and discards `tools`. The
 * usage tally decorates `tools` only, so skipping it changes nothing the gate
 * returns — which is exactly why it was free to be wasteful, and exactly why no
 * assertion on the gate's OUTPUT can notice if the skip is removed.
 *
 * What it cost, measured synthetically at realistic row sizes: 16 ms at 10k
 * events, 150 ms at 100k, 281 ms at 200k — synchronous, before every message,
 * growing with how long the project had been used.
 */
describe('[security] the pre-spawn gate does not pay for a tally it discards (Cebab-qz7m)', () => {
  const raw = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

  test('the stripper leaves the code it is supposed to scan', () => {
    // Same fail-open hazard as the scan above: a stripper returning empty
    // satisfies every assertion below while measuring nothing.
    expect(code).toContain('resolveProjectAuthority(');
    expect(code.length).toBeGreaterThan(raw.length / 2);
  });

  test("the gate's resolve passes toolUsage: 'skip'", () => {
    // Anchor on the gate's own call, not on "the file contains the string" —
    // the panel's resolve is in the same file and must NOT carry it.
    const at = code.indexOf('reportHookObservations(');
    expect(at).toBeGreaterThan(-1);
    // Walk back to the resolve that produced the authority this line reads.
    const before = code.slice(0, at);
    const resolveAt = before.lastIndexOf('resolveProjectAuthority({');
    expect(resolveAt).toBeGreaterThan(-1);
    const call = before.slice(resolveAt, before.indexOf('});', resolveAt));
    expect(call).toContain("toolUsage: 'skip'");
  });

  test('the panel resolve does NOT skip the tally', () => {
    // The other direction, and the one that matters if someone "optimises"
    // further: the usage-diff columns are the tally's only reader, and a panel
    // that skipped it would render them empty — a wrong answer, not a slow one.
    const panelAt = code.lastIndexOf('resolveProjectAuthority({');
    expect(panelAt).toBeGreaterThan(-1);
    const panelCall = code.slice(panelAt, code.indexOf('});', panelAt));
    expect(panelCall).not.toContain("toolUsage: 'skip'");
  });
});
