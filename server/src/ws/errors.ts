import type { WrapperErrorKind } from '@cebab/shared/protocol';

type ErrLike = {
  name?: string;
  code?: string;
  syscall?: string;
  message?: string;
};

/**
 * Map an unknown error into a WrapperErrorKind. Branches on instance shape
 * first (Node syscall errors have `.code`, AbortError has `.name`), then falls
 * back to message-substring matching. Tightened regexes to avoid false-positives
 * (e.g. "json" appearing in an unrelated SDK validation error).
 */
export function classifyError(err: unknown): { kind: WrapperErrorKind; message: string } {
  const e = (err && typeof err === 'object' ? err : {}) as ErrLike;
  const message = err instanceof Error ? err.message : String(err);

  if (e.code === 'ENOENT' && (e.syscall === 'spawn' || /claude/i.test(message))) {
    return { kind: 'claude_not_found', message };
  }
  // Register S02b: an abort is a deliberate end, not a failure. This used to
  // return `process_crashed`, so closing the browser mid-turn — or a Stop
  // whose interrupt rejects — left the operator a sticky "Turn failed" inbox
  // row with a Restart button for a turn they ended themselves. Sticky
  // operational notifications are persisted by the dispatcher, so the false
  // failure survived reload.
  if (e.name === 'AbortError') {
    return { kind: 'aborted', message };
  }

  if (/(^|\s)(claude.*not.*found|spawn.*claude.*ENOENT)/i.test(message)) {
    return { kind: 'claude_not_found', message };
  }
  // Register S14: `oauth` on its own is NOT an expiry.
  //
  // This used to be `oauth(?:.*expired)?` — the group is optional, so the
  // `expired` half never constrained anything and any message containing the
  // substring classified as `auth_expired`. An MCP server that needs OAuth
  // configuring, a discovery failure, a tool error naming an OAuth endpoint:
  // all of them said the operator's login had lapsed.
  //
  // That is not just a wrong label. `auth_expired` raises a sticky banner,
  // writes a persisted error-severity inbox row AND an `auth.transition` row
  // in the hash-chained safety audit, and offers a Re-authenticate button that
  // opens the refresh modal — see `wrapperErrorDispatch`. A false positive
  // sends the operator to re-authenticate a session that was never expired,
  // and puts a claim in the audit log that did not happen.
  //
  // `oauth` now has to arrive within a bounded distance of a word that means
  // "this credential is no longer good". The two unambiguous phrases keep
  // matching on their own, and `invalid_grant` joins them: it is the OAuth
  // error code whose entire meaning is that the grant is no longer valid, and
  // it can appear without the word `oauth` anywhere near it.
  //
  // The old comment argued the pattern's backtracking was bounded despite the
  // `.*`. The gap here is explicitly capped instead, so the argument no longer
  // has to be made — and the eslint suppression it justified is gone with it.
  if (
    /please log in|not authenticated|invalid_grant|oauth[\s\S]{0,80}?(?:expired|revoked)/i.test(
      message,
    )
  ) {
    return { kind: 'auth_expired', message };
  }
  // `Cebab-6fax.39`. MEASURED 2026-09-08: the account's hard usage limit
  // arrives from the SDK as a generic `error_result` whose message begins
  // "You've hit your monthly spend limit … your session limit resets 7:10pm".
  // It contains no `rate limit` anywhere, so it fell through to
  // `process_crashed` — a wait-then-retry condition reported as a crash, on
  // both the bus (where Retry would simply fail again until the window resets)
  // and the single-agent path (where the held-prompt retry is reachable only
  // from a THROWN rate-limit and a result-terminated one drops what the
  // operator typed).
  //
  // Matched on the shapes the CLI actually produces rather than a broad word:
  // `usage limit` and `spend limit` are the account-level ceilings, and
  // `session limit resets` is the sentence's own tail, which appears even when
  // the leading phrase is worded differently. Kept alongside `rate limit`
  // rather than replacing it — that one is the per-minute API condition and
  // still means the same thing to a caller.
  if (/rate[ -]?limit|usage limit|spend limit|session limit resets/i.test(message)) {
    return { kind: 'rate_limited', message };
  }
  // Tightened: was /parse|json/i which matched any error mentioning JSON.
  if (/^(JSON\.parse|parse error|unexpected token|invalid JSON)/i.test(message)) {
    return { kind: 'parse_error', message };
  }
  return { kind: 'process_crashed', message };
}
