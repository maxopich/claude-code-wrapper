import { describe, expect, test } from 'vitest';
import { rateLimitDispatch, wrapperErrorDispatch } from './server.js';

// Cluster A Phase 6: pure-function unit tests for the two dispatch helpers
// extracted from `runOneTurn`. These exist so each branch of the §7-floor
// vocabulary routing is asserted in isolation — without spinning up the WS
// server, the SDK, or the dispatcher LRU. The integration is exercised by
// `ci_smoke.ts` end-to-end after this PR lands.

describe('rateLimitDispatch — hit vs cleared split (Cluster A Phase 6)', () => {
  // Stable "now" so the test doesn't race the wall clock.
  const NOW = 1_700_000_000_000;

  test('resetsAtMs in the future → hit (warn) with retry-after time', () => {
    const out = rateLimitDispatch({ status: 'limited', resetsAtMs: NOW + 60_000 }, NOW);
    expect(out.subCode).toBe('hit');
    expect(out.severity).toBe('warn');
    expect(out.title).toBe('Rate limit');
    // The message embeds the formatted local-time "Retry after …" — we
    // assert the prefix + the presence of "Retry after" rather than the
    // exact locale formatting (test machines may render different locales).
    expect(out.message).toContain('limited');
    expect(out.message).toContain('Retry after');
  });

  test('resetsAtMs already in the past → cleared (info)', () => {
    const out = rateLimitDispatch({ status: 'limited', resetsAtMs: NOW - 60_000 }, NOW);
    expect(out.subCode).toBe('cleared');
    expect(out.severity).toBe('info');
    expect(out.title).toBe('Rate limit cleared');
    // Status string is passed through verbatim — forward-compat with SDK
    // adding new status variants.
    expect(out.message).toBe('limited');
  });

  test('resetsAtMs absent entirely → cleared (info) with default message', () => {
    const out = rateLimitDispatch({ status: 'allowed' }, NOW);
    expect(out.subCode).toBe('cleared');
    expect(out.severity).toBe('info');
    expect(out.message).toBe('allowed');
  });

  test('resetsAtMs absent AND status absent → cleared with fallback message', () => {
    const out = rateLimitDispatch({}, NOW);
    expect(out.subCode).toBe('cleared');
    expect(out.message).toBe('limit lifted');
  });

  test('status defaults to "limited" when only resetsAtMs is set (hit path)', () => {
    const out = rateLimitDispatch({ resetsAtMs: NOW + 10_000 }, NOW);
    expect(out.subCode).toBe('hit');
    expect(out.message.startsWith('limited')).toBe(true);
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
    expect(out.subCode).toBe('hit');
    expect(out.severity).toBe('warn');
  });

  test('a raw-seconds value is NOT silently treated as a live limit', () => {
    // The regression guard: if someone reintroduces a seconds-valued field,
    // this reads as long-expired rather than quietly re-breaking the branch.
    // (Fails loudly here instead of shipping a permanently-cleared banner.)
    const resetsAtSeconds = Math.floor(NOW / 1000) + 60;
    const out = rateLimitDispatch({ status: 'limited', resetsAtMs: resetsAtSeconds }, NOW);
    expect(out.subCode).toBe('cleared');
  });

  test('the retry-after text renders the reset time, not the epoch', () => {
    // With seconds this formatted a 1970 timestamp — unreachable before the
    // fix, wrong the moment it became reachable.
    const out = rateLimitDispatch({ status: 'limited', resetsAtMs: NOW + 60_000 }, NOW);
    expect(out.message).toContain(new Date(NOW + 60_000).toLocaleTimeString());
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
