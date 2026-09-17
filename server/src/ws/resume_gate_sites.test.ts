import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from '../test_support/strip_comments.js';

/**
 * [security] `Cebab-faoa` — every resume seam gates its participants' MCP
 * servers, and the seam that matters most is the one no behavioural test
 * reaches.
 *
 * A bus run that survives a server restart is rebuilt read-only by
 * `resumeOnConnect`, and before `Cebab-faoa` that rebuild passed no denials —
 * so a server the operator had refused started again on the resumed hop.
 * Upgrading Cebab IS a restart, which is what makes the automatic sweep the
 * common path rather than the exotic one.
 *
 * WHY A SOURCE SCAN. The threading is pinned behaviourally — reconstruct's
 * suite drives a real runner factory and asserts a denied server reaches the
 * resumed turn's `deniedMcpServers`, in both modes — and the sweep's gate
 * function has its own `[security]` cases. The WIRING between them has
 * neither. Measured on this branch: replacing the sweep's
 * `gateParticipants` with `() => Promise.resolve(new Map())` left every test
 * under `bus/` and `ws/` green (1477 passing). `gateParticipants` is an
 * OPTIONAL field on `ResumeCallbacks`, so the compiler says nothing either;
 * making it required is `Cebab-mccp`, and until that lands this scan is what
 * stands in for it.
 *
 * The rule is deliberately narrow: a site that builds resume callbacks must
 * also name the gate. It asserts nothing about WHICH variant — the prompting
 * `gateProjectsForSpawn` for an operator-initiated resume, the silent
 * `refuseUnapprovedForResume` for the sweep — because that choice is a
 * judgement about who is watching, and a scan cannot make it. What a scan can
 * do is refuse to let a fourth seam forget the question, which is exactly how
 * `retry_worker` and chain resume came to bypass `continue_multi_agent`'s
 * check in the first place.
 */

const SERVER_TS = fileURLToPath(new URL('./server.ts', import.meta.url));

/** How far below a `...resumeCallbacks(` spread its `gateParticipants` may sit. */
const WINDOW_LINES = 40;

/** Line numbers (1-based) of every site that spreads the resume callbacks. */
export function resumeSeams(source: string): number[] {
  return stripComments(source)
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('...resumeCallbacks('))
    .map(({ n }) => n);
}

/** The subset of `resumeSeams` with no `gateParticipants` within the window. */
export function ungatedSeams(source: string): number[] {
  const lines = stripComments(source).split('\n');
  return resumeSeams(source).filter((n) => {
    const from = Math.max(0, n - 1 - WINDOW_LINES);
    const to = Math.min(lines.length, n + WINDOW_LINES);
    return !lines.slice(from, to).some((l) => l.includes('gateParticipants'));
  });
}

describe('[security] every resume seam gates the participants it rebuilds', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');

  test('the scan found the seams it is meant to be checking', () => {
    // Anti-vacuity floor. Without it, renaming `resumeCallbacks` turns the
    // assertion below into "[] equals []" — green, and measuring nothing.
    // Three today: the automatic sweep on connect, the operator's Resume, and
    // Reopen.
    expect(resumeSeams(source).length).toBeGreaterThanOrEqual(3);
  });

  test('no seam rebuilds a run without gating it', () => {
    expect(ungatedSeams(source)).toEqual([]);
  });
});

describe('[security] the scanner reports an ungated seam rather than skipping it', () => {
  // Both halves required, failing for opposite reasons: the first would pass
  // if the scan found nothing, the second if it waved everything through.

  test('a lone resume seam is reported at its own line', () => {
    const src = ['const a = 1;', '...resumeCallbacks(conn),', 'const b = 2;'].join('\n');
    expect(ungatedSeams(src)).toEqual([2]);
  });

  test('a gated one is not', () => {
    const src = ['...resumeCallbacks(conn),', 'gateParticipants: (ids) => gate(ids),'].join('\n');
    expect(ungatedSeams(src)).toEqual([]);
  });

  test('a commented-out gate does not count as gating', () => {
    // `stripComments` is what makes this true; without it a seam could be
    // "gated" by the comment explaining why it is not.
    const src = ['...resumeCallbacks(conn),', '// gateParticipants: TODO', 'const b = 2;'].join(
      '\n',
    );
    expect(ungatedSeams(src)).toEqual([1]);
  });
});
