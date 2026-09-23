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
 * under `bus/` and `ws/` green (1477 passing). `gateParticipants` is now a
 * REQUIRED field on `ResumeCallbacks` (`Cebab-mccp`), so the compiler enforces
 * that the field is PRESENT; this scan enforces what it cannot — that each seam
 * names a REAL gate beside its own `...resumeCallbacks(` spread. The two are not
 * redundant: a future author could satisfy the required field by folding a
 * default into `resumeCallbacks(conn)` far from a seam, and the compiler would
 * stay silent at all three while this scan reddens. Nor could the compiler see
 * whether the gate GATES — an `async () => new Map()` no-op type-checks as a
 * `gateParticipants` and gates nothing — so this scan reads the value too: a
 * seam's `gateParticipants` must resolve through one of the two real gates,
 * `refuseUnapprovedForResume` or `gateProjectsForSpawn`. Anything else, the
 * tests' own `async () => new Map()` stand-in included, fails and names the seam.
 *
 * The check does NOT decide WHICH of the two a seam should use — the prompting
 * `gateProjectsForSpawn` for an operator-initiated resume, the silent
 * `refuseUnapprovedForResume` for the sweep — because that choice is a
 * judgement about who is watching, and a scan cannot make it. What it can do is
 * refuse both the missing gate and the no-op that stands in for one, which is
 * exactly how `retry_worker` and chain resume came to bypass
 * `continue_multi_agent`'s check in the first place.
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

/** The two real gate helpers a production seam's `gateParticipants` may name. */
const REAL_GATES = ['refuseUnapprovedForResume', 'gateProjectsForSpawn'];

/** How far past a `gateParticipants:` key its value may reach (it wraps a line). */
const GATE_VALUE_LINES = 3;

/**
 * The subset of `resumeSeams` whose `gateParticipants` resolves through NEITHER
 * real gate — the `async () => new Map()` stand-in, or any other value that
 * satisfies the required field while gating nothing. A seam with no gate at all
 * counts too (it also names no real gate); the presence check reports that case
 * on its own line as well.
 */
export function seamsWithoutRealGate(source: string): number[] {
  const lines = stripComments(source).split('\n');
  return resumeSeams(source).filter((n) => {
    const from = Math.max(0, n - 1 - WINDOW_LINES);
    const to = Math.min(lines.length, n + WINDOW_LINES);
    const gateOffset = lines.slice(from, to).findIndex((l) => l.includes('gateParticipants'));
    if (gateOffset === -1) return true;
    const start = from + gateOffset;
    const value = lines.slice(start, Math.min(lines.length, start + GATE_VALUE_LINES));
    return !value.some((l) => REAL_GATES.some((gate) => l.includes(gate)));
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

  test('every seam gates through one of the two real gates, not a stand-in', () => {
    // Presence is not enough: a required field can be satisfied by a no-op that
    // gates nothing. Each production seam must name `refuseUnapprovedForResume`
    // or `gateProjectsForSpawn` beside its spread.
    expect(seamsWithoutRealGate(source)).toEqual([]);
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

describe('[security] the scanner reports a stand-in gate, not just a missing one', () => {
  test('a `new Map()` stand-in is reported while a real gate beside it passes', () => {
    // Two seams, far enough apart that their 40-line windows do not overlap and
    // borrow each other's gate. The first is the control — a real gate, which
    // must NOT be reported; the second uses the tests' own stand-in, which must.
    const filler = new Array(WINDOW_LINES + 5).fill('const gap = 0;');
    const src = [
      '...resumeCallbacks(conn),', // control seam (line 1)
      'gateParticipants: (ids) => gateProjectsForSpawn(conn, ids),',
      ...filler,
      '...resumeCallbacks(conn),', // stand-in seam
      'gateParticipants: async () => new Map(),',
    ].join('\n');
    const standInSeam = 2 + filler.length + 1;
    expect(seamsWithoutRealGate(src)).toEqual([standInSeam]);
  });
});
