import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from '../test_support/strip_comments.js';

/**
 * [security] `Cebab-6fax.16` — the process-wide bus start claim must be taken
 * INSIDE the block whose `finally` releases it.
 *
 * WHAT WENT WRONG. Both `start_multi_agent` arms did this:
 *
 *   conn.multiAgentStartClaim = startClaimId;
 *   const denials = await gateProjectsForSpawn(...);   // <-- outside the try
 *   try { ... } finally { releaseSessionStart(startClaimId); ... }
 *
 * `gateProjectsForSpawn` parks on the operator, and the `cancel_gate` path is
 * an operator DECLINING a trust prompt — a normal, deliberate action. That
 * return left the claim held, so every later bus start from that connection was
 * refused ("another multi-agent session is starting") until the tab was closed.
 * The operator's own refusal bricked the feature, with nothing saying why.
 *
 * WHY A SOURCE TEST. The leak is a property of STATEMENT PLACEMENT, not of any
 * value a behavioural test can read: the claim is process-global module state,
 * the gate parks on a WS round-trip, and the only observable is a refusal one
 * user action later. A behavioural test would need a full second start attempt
 * through the WS handler after a cancelled gate; this asks the one question
 * that actually decides it — is the next statement after the claim the `try`?
 *
 * Same await-before-try shape as `Cebab-0s4d` on the single-agent path.
 * Deliberately NOT a check that the `finally` releases (the compiler and
 * `start_guard_global.test.ts` cover the release itself) — only that nothing
 * can return between taking the claim and entering the block.
 */

const SERVER_TS = fileURLToPath(new URL('./server.ts', import.meta.url));

/**
 * 1-based line numbers of every site that TAKES the claim.
 *
 * Matched on the ASSIGNMENT, not on one token name. This used to require the
 * literal `startClaimId`, which made it blind to any site that named its token
 * something else — and `resume_multi_agent` became exactly that site
 * (`Cebab-6fax.41`), so a gate whose subject is "every claim site" would have
 * silently skipped the newest one while its anti-vacuity count still passed.
 *
 * `null` is excluded explicitly: the RELEASE sites assign it, and a pattern
 * loose enough to catch any token name is loose enough to catch those too.
 */
export function claimSites(source: string): number[] {
  return stripComments(source)
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /^conn\.multiAgentStartClaim = (?!null;)[A-Za-z_$][\w$]*;$/.test(line))
    .map(({ n }) => n);
}

/** Claim sites whose next non-blank statement is not `try {`. */
export function sitesNotFollowedByTry(source: string): number[] {
  const lines = stripComments(source).split('\n');
  return claimSites(source).filter((n) => {
    // `n` is 1-based; start at the line after it and skip blanks.
    let i = n; // index of the NEXT line in the 0-based array
    while (i < lines.length && lines[i]!.trim() === '') i++;
    return lines[i]?.trim() !== 'try {';
  });
}

describe('[security] the bus start claim is taken inside its release block', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');

  test('the scan finds all three claim sites — anti-vacuity', () => {
    // `start_multi_agent`'s two arms (orchestrator and chain) plus
    // `resume_multi_agent`, which took the process-wide claim in
    // `Cebab-6fax.41` — before that it guarded on `conn.multiAgent`, i.e. per
    // CONNECTION, which is the pre-B02 posture its own comment claimed to
    // mirror. If a rename made this zero, every assertion below would pass
    // over an empty list (`project_gates_pass_vacuously`).
    expect(claimSites(source)).toHaveLength(3);
  });

  test('resume_multi_agent guards process-wide, not on conn.multiAgent', () => {
    // The specific regression: a second browser window has no
    // `conn.multiAgent` of its own, so a per-connection guard let it bring a
    // second session live in this process — which is the state
    // `describeLiveSessionConflict`'s header describes the consequences of.
    const body = stripComments(source);
    const at = body.indexOf("case 'resume_multi_agent': {");
    expect(
      at,
      "the resume case moved or was renamed — this gate's anchor is stale",
    ).toBeGreaterThan(-1);
    const head = body.slice(at, at + 1200);
    expect(head).toContain('claimSessionStart(');
    expect(head).not.toContain('if (conn.multiAgent) {');
  });

  test('every claim site is immediately followed by the try', () => {
    expect(
      sitesNotFollowedByTry(source),
      'A statement sits between the start claim and the try/finally that ' +
        'releases it. Anything that can return or throw there leaks the ' +
        'process-wide claim and refuses every later bus start on this ' +
        'connection until the socket closes. Move it inside the try.',
    ).toEqual([]);
  });

  test('the predicate detects a site that is NOT followed by the try', () => {
    // The other direction: a checker that returned [] for all input would pass
    // the case above forever. Feed it the pre-fix shape.
    const broken = [
      'conn.multiAgentStartClaim = someClaimId;',
      'const denials = await gateProjectsForSpawn(conn, ids, SCOPES);',
      'try {',
      '} finally {',
      '}',
    ].join('\n');
    expect(claimSites(broken)).toEqual([1]);
    expect(sitesNotFollowedByTry(broken)).toEqual([1]);
  });

  test('the predicate accepts the fixed shape, blank lines included', () => {
    const fixed = [
      'conn.multiAgentStartClaim = startClaimId;',
      '',
      'try {',
      '} finally {',
      '}',
    ].join('\n');
    expect(sitesNotFollowedByTry(fixed)).toEqual([]);
  });
});
