import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Register B11: `ws/server.ts` builds TWO `onEnded` closures — the shared
 * sink used by resume / re-attach, and a separate one in the fresh-start
 * `start_multi_agent` handler. The shared one has cancelled the ending
 * session's pause-expiry timers since Phase 4c2; the fresh-start one did not.
 *
 * So a session started in this connection left its timers armed past
 * teardown. They then fired `executeExpireParticipant`, whose defensive
 * re-check returns `noop_diverged` — but only AFTER writing its trigger audit
 * row, so the hash-chained log accrued expiry events for a session that had
 * ended.
 *
 * The defect is a DIVERGENCE between two closures that must agree, and
 * neither closure is reachable from a unit test without standing up a live
 * WS session. So the honest guard reads them and requires them to agree —
 * and, per the sibling test in `bus/teardown_finalize.test.ts`, strips
 * comments first so the prose explaining `clearSession` cannot count as a
 * call to it.
 *
 * What this does NOT check: that `clearSession` does the right thing. That is
 * `pause_expiry.test.ts`'s job. This checks only that both closures call it,
 * which is the thing that drifted.
 */

const SERVER_TS = fileURLToPath(new URL('./server.ts', import.meta.url));

/** Source lines with comment-only lines removed. */
function codeLines(): string[] {
  // Split on \r?\n — no .gitattributes, so Windows CI reads this file CRLF.
  return fs
    .readFileSync(SERVER_TS, 'utf8')
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

/**
 * Index of every line that opens an `onEnded` callback, in either shape the
 * file uses: `onEnded: (…) => {` on a sink literal, and `const onEnded = (`
 * for the fresh-start closure.
 */
function onEndedStarts(lines: string[]): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('onEnded:') && t.includes('=>')) out.push(i);
    else if (t.startsWith('const onEnded =')) out.push(i);
  });
  return out;
}

describe('[security] every onEnded closure cancels the ending session pause timers', () => {
  const lines = codeLines();
  const starts = onEndedStarts(lines);

  test('the scan found both closures — anti-vacuity', () => {
    // Without this, a renamed callback or a changed arrow style makes the
    // assertion below iterate an empty list and pass over nothing. Two is
    // what exists today; more is fine, none or one means the scan broke or a
    // closure vanished, and either deserves a look.
    expect(starts.length).toBeGreaterThanOrEqual(2);
  });

  test.each([0, 1])('closure #%i calls getPauseExpiryRegistry().clearSession', (which) => {
    const start = starts[which]!;
    // A generous window: both closures are short, and overshooting into the
    // next function can only make this test PASS on a neighbour's call —
    // which the per-closure indexing makes unlikely and the anti-vacuity
    // case below rules out.
    const body = lines.slice(start, start + 30).join('\n');
    expect(body).toContain('clearSession');
  });

  test('and the window is not so wide that any slice would contain it', () => {
    // The complement of the case above: prove the string is scarce in this
    // file, so "found it within 30 lines" means the closure has it rather
    // than the file being littered with it.
    const hits = lines.filter((l) => l.includes('clearSession(')).length;
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThanOrEqual(4);
  });
});
