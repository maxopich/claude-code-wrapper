import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from '../test_support/strip_comments.js';

/**
 * `Cebab-6fax.14` — a run-scoped callback must resolve its socket at CALL
 * time, not capture the one that existed when the run started.
 *
 * WHAT WENT WRONG. `start_multi_agent` builds its callbacks once and they close
 * over `conn.ws`. A browser re-attach calls `rebind`, which swaps the ROUTER's
 * sink — so routed `multi_agent_event`s keep arriving, which is exactly what
 * makes the defect invisible from the outside — but nothing swapped these, so
 * they wrote into a closed socket where `send` silently drops.
 *
 * MEASURED 2026-09-08, session 2b87882c, socket dropped at 150 s and
 * re-attached 1 s later: the new socket received the full replay (23 events,
 * hopsUsed 20/30) and every later routed event, and ZERO `agent_activity`
 * ticks — 296 had gone to the first socket — and ZERO `multi_agent_mutation`
 * messages, although the worker ran ToolSearch, Skill and Bash afterwards and
 * those rows are in the DB. The activity bar and the mutation lane went dark
 * for the rest of the run. `AskUserQuestion` cards and pause-on-dangerous
 * banners travel the same callbacks, which is a run that waits forever for an
 * operator who is never shown the prompt.
 *
 * WHY A SOURCE TEST. The property is which SOCKET a closure resolves, and the
 * failure is silence — `send` drops on a non-OPEN socket by design, so there is
 * no error, no return value and no state to observe. A behavioural test would
 * have to stand up a WS server, start a real bus session, drop and re-attach a
 * socket, and assert on messages that did NOT arrive on a socket that no longer
 * exists. This asks the question that decides it instead: does each of these
 * callbacks send through the call-time resolver?
 *
 * Deliberately NOT "no `conn.ws` anywhere in the handler". The guards at the
 * top — unknown participants, a workspace that vanished, a start refused
 * because another session is live — run synchronously before any session
 * exists, and `conn.ws` is the only correct destination for them.
 */

const SERVER_TS = fileURLToPath(new URL('./server.ts', import.meta.url));

/**
 * The callbacks handed to the bus runtime for the lifetime of a run. Each one
 * can fire after a re-attach; each one used to capture the socket.
 */
const RUN_SCOPED_CALLBACKS = [
  'onActivity',
  'onPendingRetry',
  'onMutation',
  'onPendingMutation',
  'sendNotification',
  'sendRouterDrop',
  'sendServerMsg',
];

/** Source of `const <name> = (…) => { … }` up to the closing `};` at its indent. */
export function callbackBody(source: string, name: string): string | null {
  const stripped = stripComments(source);
  const start = stripped.indexOf(`const ${name} = (`);
  if (start === -1) return null;
  const end = stripped.indexOf('\n      };', start);
  return end === -1 ? stripped.slice(start) : stripped.slice(start, end);
}

describe('[R-A] run-scoped callbacks resolve the socket at call time', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');

  test('every named callback is found — anti-vacuity', () => {
    // A rename would otherwise turn the assertion below into a scan of nothing,
    // which passes for any source at all (`project_gates_pass_vacuously`).
    const missing = RUN_SCOPED_CALLBACKS.filter((n) => callbackBody(source, n) === null);
    expect(missing).toEqual([]);
  });

  test('none of them writes to the captured socket', () => {
    const captured = RUN_SCOPED_CALLBACKS.filter((n) =>
      (callbackBody(source, n) ?? '').includes('send(conn.ws'),
    );
    expect(
      captured,
      'A run-scoped callback sends through `conn.ws`, the socket captured when ' +
        'the run started. After a browser re-attach that socket is closed and ' +
        '`send` drops silently, so this channel goes dark for the rest of the ' +
        'run. Send through `toLiveSink`, which resolves the session owner from ' +
        'the registry at call time.',
    ).toEqual([]);
  });

  test('and each one does route through the resolver', () => {
    // The other direction: a callback that sent nowhere at all would satisfy
    // the assertion above.
    const notRouted = RUN_SCOPED_CALLBACKS.filter(
      (n) => !(callbackBody(source, n) ?? '').includes('toLiveSink('),
    );
    expect(notRouted).toEqual([]);
  });

  test('the resolver falls back to the connection before the session is registered', () => {
    // Callbacks can fire before `registerLiveSession` runs, and at that moment
    // `conn.ws` IS the right destination. Losing that fallback would trade a
    // late blackout for an early one.
    const resolver = callbackBody(source, 'toLiveSink') ?? '';
    expect(resolver).toContain('getLiveSession(');
    expect(resolver).toContain('send(conn.ws, out)');
  });

  test('the session id is actually assigned, on both arms', () => {
    // Without this the resolver would fall back forever and the fix would be a
    // no-op that reads as done — the single most likely way to regress it.
    const stripped = stripComments(source);
    expect(stripped.match(/liveSessionId = handle\.sessionId;/g)).toHaveLength(2);
  });
});
