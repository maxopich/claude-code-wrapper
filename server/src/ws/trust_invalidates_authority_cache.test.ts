import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from '../test_support/strip_comments.js';

/**
 * [security] `Cebab-6fax.26` — flipping Trust must drop this connection's
 * cached authority snapshot for that project.
 *
 * WHY. Trust decides `settingSources`, so the cached `system/init` snapshot
 * was measured under the OTHER scope set. `respondWithProjectAuthority` serves
 * it and the panel labels it live, because `fromProbe` is genuinely true of it
 * — it IS from a probe, just a probe of a different configuration. That is the
 * same lie `Cebab-ws0.7` closed for a timed-out probe, reached by a different
 * route, and it lands at the moment the operator is most likely to look at the
 * panel: right after changing what the agent is allowed to do.
 *
 * WHY A SOURCE TEST. `set_trusted` lives inside the WS dispatcher's switch,
 * behind an audit-append, a DB write and a workspace sync; reaching it in a
 * unit test means standing up a connection and a database to observe the
 * absence of a map entry. The decision that actually matters is one line's
 * presence in one branch, so this asks about that directly — the same trade
 * `bus_cap_sites.test.ts` makes for the two bus ceilings.
 *
 * Deliberately NOT asserting a re-probe: dropping the entry is the fix, and
 * re-probing on every toggle would spend a process the resolver does not need.
 */

const SERVER_TS = fileURLToPath(new URL('./server.ts', import.meta.url));

/** The body of `case 'set_trusted':` up to its `return`, comments stripped. */
export function setTrustedBranch(source: string): string | null {
  const stripped = stripComments(source);
  const start = stripped.indexOf("case 'set_trusted':");
  if (start === -1) return null;
  const end = stripped.indexOf("case '", start + 20);
  return stripped.slice(start, end === -1 ? undefined : end);
}

describe('[security] set_trusted invalidates the authority cache', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');
  const branch = setTrustedBranch(source);

  test('the branch is found and writes the trust flag — anti-vacuity', () => {
    // A rename would make every assertion below scan an empty string
    // (`project_gates_pass_vacuously`).
    expect(branch).not.toBeNull();
    expect(branch).toContain('setProjectTrusted(');
  });

  test('it drops the cached snapshot for that project', () => {
    expect(
      branch,
      'set_trusted changes settingSources, so any cached system/init snapshot ' +
        'for that project was measured under the other scope set. Leaving it ' +
        'makes the authority panel present it as a live reading of the new ' +
        'posture.',
    ).toContain('authorityCache.delete(msg.projectId)');
  });

  test('the predicate rejects a branch that does not drop it', () => {
    // The other direction: a checker that found the string anywhere in the
    // file would pass even if the call sat in an unrelated handler.
    const withoutDrop = [
      "case 'set_trusted': {",
      '  setProjectTrusted(msg.projectId, msg.trusted);',
      '  return;',
      '}',
      "case 'something_else': {",
      '  conn.authorityCache.delete(msg.projectId);',
      '  return;',
      '}',
    ].join('\n');
    expect(setTrustedBranch(withoutDrop)).not.toContain('authorityCache.delete(msg.projectId)');
  });
});
