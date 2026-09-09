import { describe, expect, test } from 'vitest';
import { classifyError } from './errors.js';

describe('classifyError', () => {
  test('typed ENOENT spawn → claude_not_found', () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn claude',
    });
    expect(classifyError(err).kind).toBe('claude_not_found');
  });

  // Register S02b [security]. This asserted `process_crashed`, which is how a
  // deliberate Stop — or a browser closing mid-turn — came to be recorded as a
  // failure: the mapper turned that kind into a sticky, persisted "Turn
  // failed" inbox row with a Restart button. An abort is an intentional end,
  // and the classifier is where that distinction belongs.
  test('[security] AbortError (instance shape) → aborted, not process_crashed', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyError(err).kind).toBe('aborted');
  });

  test('the abort branch is keyed on the name, not on the message text', () => {
    // A genuine crash whose message happens to contain "abort" must still be
    // a crash — otherwise the narrow fix becomes a broad suppression.
    expect(classifyError(new Error('the process aborted unexpectedly')).kind).toBe(
      'process_crashed',
    );
  });

  test('rate-limit phrasing → rate_limited', () => {
    expect(classifyError(new Error('Rate-limit exceeded for 5h')).kind).toBe('rate_limited');
    expect(classifyError(new Error('You are rate limited')).kind).toBe('rate_limited');
  });

  test('auth-expired phrasing → auth_expired', () => {
    expect(classifyError(new Error('Please log in to continue')).kind).toBe('auth_expired');
    expect(classifyError(new Error('OAuth token expired')).kind).toBe('auth_expired');
  });

  // Register S14. The pattern was `oauth(?:.*expired)?` — the group is
  // optional, so `expired` never constrained anything and the bare substring
  // was enough. The cost is not a wrong label: `auth_expired` raises a sticky
  // banner, a persisted error-severity inbox row, an `auth.transition` row in
  // the hash-chained safety audit, and a Re-authenticate button. A false
  // positive sends the operator to re-authenticate a session that never
  // expired and writes a claim into the audit log that did not happen.
  test('[security] "oauth" without an expiry word is not an expired login', () => {
    const notExpiries = [
      'MCP server "notion" requires OAuth configuration',
      'Failed to discover OAuth metadata for https://example.test',
      'oauth callback port 8123 already in use',
      'Cannot read properties of undefined (reading "oauthToken")',
    ];
    for (const m of notExpiries) {
      expect(classifyError(new Error(m)).kind, m).toBe('process_crashed');
    }
  });

  test('[security] the phrasings that DO mean an expired credential still match', () => {
    // The negative test above is only worth having next to this one — a
    // classifier that returned `process_crashed` for everything would pass it.
    const expiries = [
      'OAuth token expired',
      'oauth: credential revoked, please re-run login',
      'refresh failed: invalid_grant',
      'Please log in to continue',
      'not authenticated',
    ];
    for (const m of expiries) {
      expect(classifyError(new Error(m)).kind, m).toBe('auth_expired');
    }
  });

  test('the expiry word has to be near the oauth mention, not anywhere in the message', () => {
    // The gap is capped at 80 chars. A stack trace that mentions oauth in one
    // frame and "expired" in an unrelated sentence 200 chars later is two
    // facts, not one diagnosis.
    const far = `oauth handshake step 1${' '.repeat(200)}the cached plan expired`;
    expect(classifyError(new Error(far)).kind).toBe('process_crashed');
  });

  test('JSON parse errors land in parse_error, not generic process_crashed', () => {
    expect(classifyError(new Error('JSON.parse: unexpected token')).kind).toBe('parse_error');
    expect(classifyError(new Error('Unexpected token < in JSON at position 0')).kind).toBe(
      'parse_error',
    );
  });

  test('messages that just mention "json" no longer false-match parse_error', () => {
    // Tightened regex was the whole point — used to be /parse|json/i which matched any
    // SDK validation error that happened to mention json.
    expect(classifyError(new Error('Invalid options: tools must be json-serializable')).kind).toBe(
      'process_crashed',
    );
  });

  test('unknown errors fall through to process_crashed', () => {
    expect(classifyError(new Error('something exploded')).kind).toBe('process_crashed');
    expect(classifyError('plain string').kind).toBe('process_crashed');
  });
});

describe('the account usage limit is a wait, not a crash (Cebab-6fax.39)', () => {
  // MEASURED 2026-09-08 on a live chain run: the SDK surfaced the account's
  // hard limit as a generic `error_result`, not a `rate_limit_event`, and its
  // message contains no "rate limit" anywhere — so it fell through to
  // `process_crashed`. The consequences differ per surface and both are wrong:
  // the bus parks a Retry that will simply fail again until the window resets,
  // and the single-agent path's held-prompt retry is reachable only from a
  // THROWN rate-limit, so a result-terminated one drops what the operator
  // typed. The loop's gate reads the same failure as a code defect
  // (`Cebab-weqo`).

  test('the exact sentence the CLI produced', () => {
    expect(
      classifyError(
        new Error(
          "Claude Code returned an error result: You've hit your monthly spend limit · " +
            'raise it at claude.ai/settings/usage, or your session limit resets 7:10pm',
        ),
      ).kind,
    ).toBe('rate_limited');
  });

  test('the shapes separately, so a reworded prefix still classifies', () => {
    expect(classifyError(new Error('usage limit reached for this account')).kind).toBe(
      'rate_limited',
    );
    expect(classifyError(new Error('your session limit resets 9:00pm')).kind).toBe('rate_limited');
  });

  test('the per-minute rate limit still classifies — the old rule is kept', () => {
    // Not replaced: `rate limit` is the API-level condition and means the same
    // thing to a caller. Both must land in the same bucket.
    expect(classifyError(new Error('Rate limit exceeded')).kind).toBe('rate_limited');
  });

  test('ANTI-VACUITY: an ordinary failure is still a crash', () => {
    // A matcher wide enough to catch everything would satisfy every case above
    // and turn every real failure into "wait a while".
    expect(classifyError(new Error('ENOENT: no such file or directory')).kind).toBe(
      'process_crashed',
    );
    expect(classifyError(new Error('the limit of this approach is clarity')).kind).toBe(
      'process_crashed',
    );
  });
});
