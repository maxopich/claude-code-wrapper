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
];

/**
 * `sendServerMsg` WAS IN THAT LIST, AND THAT IS WHAT BROKE BOTH BUS MODES
 * (`Cebab-gejh`). Keeping the record, because the list above still looks like
 * somewhere it belongs.
 *
 * It is not a run-scoped callback that needs to FIND the session's sink: it IS
 * that sink. Both routers register `sendServerMsg: (m) => router.sendServerMsg(m)`,
 * and the router forwards to the sink this connection supplied — so resolving
 * from inside it closed a loop through the registry:
 *
 *   toLiveSink → owner.sendServerMsg → router.sendServerMsg → this callback → …
 *
 * `RangeError: Maximum call stack size exceeded`, on the orchestrator's FIRST
 * turn, every multi-agent run from 2026-09-09 to 2026-09-18. The activity
 * observer fires on the first SDK message, so nothing else had to happen.
 *
 * The distinction this file exists to enforce is real and this entry inverted
 * it: the other six may fire from a window that has since been replaced and
 * must resolve; this one is the resolved destination. So it gets the opposite
 * assertion below rather than being quietly dropped from the list.
 */
const TERMINAL_CALLBACK = 'sendServerMsg';

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

  test('the TERMINAL sender is not hand-written here at all', () => {
    // Stronger than "it does not call the resolver": the handler no longer
    // DECLARES it. `sendServerMsg` is destructured from `createLiveSink`, whose
    // implementation delivers to the socket and cannot resolve — so the wiring
    // that caused `Cebab-gejh` is not expressible at this call site.
    //
    // Re-declare it locally and this reddens, whatever body it is given, which
    // is the point: the previous version of this file asserted that
    // `sendServerMsg` DID route through the resolver, and that assertion is
    // what kept the loop in place for nine days.
    expect(
      callbackBody(source, TERMINAL_CALLBACK),
      `${TERMINAL_CALLBACK} is declared in server.ts again. It is the session's ` +
        'sink, not a callback that looks one up; a local definition here is how ' +
        'the registry loop comes back. It belongs to ws/live_sink.ts.',
    ).toBeNull();
    const stripped = stripComments(source);
    // …and it really is coming from the seam, so the assertion above is not
    // passing merely because nothing supplies it.
    expect(stripped).toContain('const { toLiveSink, sendServerMsg } = createLiveSink({');
  });

  test('the resolver still falls back to the connection before the session is registered', () => {
    // Callbacks can fire before `registerLiveSession` runs, and at that moment
    // `conn.ws` IS the right destination. Losing that fallback would trade a
    // late blackout for an early one.
    //
    // The resolver moved into `ws/live_sink.ts` (`Cebab-gejh`) so the cycle
    // could be reproduced in a test at all, so what this file checks now is the
    // WIRING: that the handler builds it, and builds it with the registry and
    // this connection's socket. The behaviour of the thing wired is
    // `ws/live_sink.test.ts`'s job.
    const stripped = stripComments(source);
    expect(stripped).toContain('createLiveSink({');
    expect(stripped).toContain('getLiveSession(id)');
    expect(stripped).toContain('send(conn.ws, out)');
  });

  test('the session id is actually assigned, on both arms', () => {
    // Without this the resolver would fall back forever and the fix would be a
    // no-op that reads as done — the single most likely way to regress it.
    const stripped = stripComments(source);
    expect(stripped.match(/liveSessionId = handle\.sessionId;/g)).toHaveLength(2);
  });
});
