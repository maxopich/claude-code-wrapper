import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from '../test_support/strip_comments.js';

/**
 * `Cebab-6fax.40` — `runOneTurn`'s registrations must be inside the block
 * whose `finally` undoes them.
 *
 * WHAT WENT WRONG. Three statements sat between the lifecycle registration and
 * the `try`: `setSessionPermissionMode` (a better-sqlite3 UPDATE) and two
 * `ws.send` calls. None of them is awaited — this is NOT the await-before-try
 * shape two sibling beads describe, and anyone grepping for an await to move
 * would conclude the finding was wrong. They throw synchronously instead, on
 * SQLITE_BUSY / READONLY / IOERR and on a socket that has gone away.
 *
 * A throw there escaped to `handleClientMsg(...).catch(...)`, which logs and
 * sends a SESSIONLESS `wrapper_error` — so the process survived and the leak
 * was permanent. Permanent and process-wide, not merely a stray Map entry:
 * `describeConcurrentSingleTurn` consults the global in-flight registry, so
 * the leaked `registerQuery` made that session id unstartable for the life of
 * the server, across reconnects, while `active_runs` showed a phantom run and
 * the client never received `session_running: false`. The CLI is spawned by
 * that point, so a real turn was also spent unread.
 *
 * WHY A SOURCE TEST. The leak is a property of STATEMENT PLACEMENT. The
 * registry is process-global module state, `runOneTurn` is module-private with
 * no injectable runner (`single_agent_model_wiring.test.ts` documents that same
 * constraint), and the only behavioural observable is a refusal one user action
 * later. This asks the question that decides it directly: is the `try` above
 * the statements that can throw?
 *
 * Same family as `start_claim_release.test.ts` on the bus start path.
 */

const SERVER_TS = fileURLToPath(new URL('./server.ts', import.meta.url));

/** The body of `runOneTurn`, comments stripped. */
export function runOneTurnBody(source: string): string {
  const stripped = stripComments(source);
  const at = stripped.indexOf('async function runOneTurn(');
  if (at === -1) return '';
  // The next top-level `async function` declaration ends it. Every function in
  // this module is declared at column 0, so a bare newline + `async function`
  // is an unambiguous terminator.
  const end = stripped.indexOf('\nasync function ', at + 1);
  return end === -1 ? stripped.slice(at) : stripped.slice(at, end);
}

/**
 * The offset of the MAIN turn try — the one whose `finally` undoes the
 * lifecycle registrations. `Cebab-6fax.17` added an EARLIER `try` around the
 * spawn gate (a cancelled gate is caught and reported, not left to propagate),
 * so `indexOf('try {')` no longer resolves to the block these assertions are
 * about. The main try is the one wrapping the SDK stream loop, so anchor on the
 * `for await` and walk back to its opening `try`.
 */
export function mainTurnTryAt(body: string): number {
  const forAwaitAt = body.indexOf('for await');
  if (forAwaitAt === -1) return -1;
  return body.lastIndexOf('try {', forAwaitAt);
}

describe('[security] runOneTurn registers inside the block that unregisters', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');
  const body = runOneTurnBody(source);

  test('the scan finds the function — anti-vacuity', () => {
    // A rename would make every assertion below run over an empty string and
    // pass (`project_gates_pass_vacuously`).
    expect(body.length).toBeGreaterThan(2000);
    expect(body).toContain('registerQuery(');
    expect(body).toContain('conn.inFlight.set(sessionId');
  });

  test('the try opens before the statements that can throw', () => {
    const tryAt = mainTurnTryAt(body);
    expect(tryAt, 'no main turn try in runOneTurn — this gate is stale').toBeGreaterThan(-1);
    // `setSessionPermissionMode` is the first throwing statement inside the main
    // try and appears only there, so it anchors the block unambiguously.
    const permAt = body.indexOf('setSessionPermissionMode(sessionId');
    expect(permAt, 'setSessionPermissionMode is gone — this gate is stale').toBeGreaterThan(-1);
    expect(
      permAt,
      'setSessionPermissionMode runs before the try that would clean up after it',
    ).toBeGreaterThan(tryAt);
    // The two sends follow it, inside the same try. Search FROM `permAt` so the
    // running:false / wrapper_error sends that `Cebab-6fax.17` added to the
    // earlier gate-cancel catch — a different block, before the main try — are
    // not what these match.
    for (const stmt of ["type: 'session_running'", "type: 'permission_mode_changed'"]) {
      const at = body.indexOf(stmt, permAt);
      expect(at, `${stmt} is gone — this gate is stale`).toBeGreaterThan(-1);
      expect(at, `${stmt} runs inside the try that would clean up after it`).toBeGreaterThan(tryAt);
    }
  });

  test('and the registrations the finally undoes happen before it', () => {
    // The other side of the same window. `registerQuery` and
    // `conn.inFlight.set` are deliberately OUTSIDE: they are a map write and a
    // registry write with nothing between them that can throw, and the
    // `finally` needs `unregister` in scope. What must not drift is a THIRD
    // statement appearing in that gap.
    const tryAt = mainTurnTryAt(body);
    expect(body.indexOf('registerQuery(')).toBeLessThan(tryAt);
    expect(body.indexOf('conn.inFlight.set(sessionId')).toBeLessThan(tryAt);
    const between = body.slice(body.indexOf('conn.inFlight.set(sessionId'), tryAt);
    expect(
      between.replace(/conn\.inFlight\.set\(sessionId[^;]*;/, '').trim(),
      'a statement appeared between the inFlight registration and the try',
    ).toBe('');
  });

  test('the locator returns nothing for a source without the function', () => {
    // The predicate in the other direction: a checker that returned the whole
    // file regardless would pass every case above forever.
    expect(runOneTurnBody('const x = 1;\n')).toBe('');
  });
});
