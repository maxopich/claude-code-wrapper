/**
 * `Cebab-gejh`: the sink that resolved to itself.
 *
 * THE CASE THAT MATTERS IS `the cycle` BELOW, and it is built the way the real
 * system builds it: a registry in the middle. That is the whole reason the
 * production bug survived nine days and several live reproductions — every bus
 * test drives the router with a hand-built sink, and a hand-built sink cannot
 * close the loop. Reproduce the loop or reproduce nothing.
 *
 * The live shape, for the reader who wants to check this fake is faithful:
 *
 *   ws/server.ts     sink.sendServerMsg          ← registered as the session's
 *   orchestrator.ts  registerLiveSession({ sendServerMsg: m => router.sendServerMsg(m) })
 *   orchestrator.ts  router.sendServerMsg = m => sink.sendServerMsg?.(m)
 *
 * so "the session's sendServerMsg" leads back to this connection's sink. Both
 * modes register it identically (`chain.ts` too), which is why one seam fixes
 * both.
 */
import { describe, expect, test } from 'vitest';

import type { ServerMsg } from '@cebab/shared/protocol';
import { createLiveSink, LiveSinkCycleError, type LiveSinkOwner } from './live_sink.js';

const MSG = { type: 'router_drop' } as unknown as ServerMsg;

/** A registry + router wired exactly as production wires them: the session's
 *  `sendServerMsg` forwards to whatever sink the router currently holds. */
function liveSystem(opts: { registered: boolean }) {
  const socket: ServerMsg[] = [];
  const registry = new Map<string, LiveSinkOwner>();

  const sink = createLiveSink({
    sendToSocket: (m) => socket.push(m),
    getSessionId: () => 'sess-1',
    lookup: (id) => registry.get(id),
  });

  if (opts.registered) {
    // `router.sendServerMsg` → the sink this connection supplied. This is the
    // link that closes the loop, and it is not a contrivance: it is
    // `orchestrator.ts:1338` and `chain.ts` verbatim in shape.
    registry.set('sess-1', { sendServerMsg: (m) => sink.sendServerMsg(m) });
  }
  return { sink, socket, registry };
}

describe('createLiveSink', () => {
  test('THE BUG: a resolving dispatch through the registry terminates', () => {
    const { sink, socket } = liveSystem({ registered: true });
    // Before the fix this recursed until `RangeError: Maximum call stack size
    // exceeded` and took the whole turn with it. One delivery, no throw.
    expect(() => sink.toLiveSink(MSG)).not.toThrow();
    expect(socket).toHaveLength(1);
  });

  test("the connection's own sender delivers and never resolves", () => {
    const { sink, socket, registry } = liveSystem({ registered: true });
    let resolved = 0;
    registry.set('sess-1', {
      sendServerMsg: () => {
        resolved += 1;
      },
    });
    sink.sendServerMsg(MSG);
    expect(socket).toHaveLength(1);
    // The load-bearing half: it must not have gone near the registry. Make
    // `sendServerMsg` resolve again and this is the assertion that reddens.
    expect(resolved).toBe(0);
  });

  test('with no registered owner it falls back to the socket, which is not an error', () => {
    // Callbacks can fire before `registerLiveSession` runs, and at that moment
    // this connection's socket IS the right destination (`Cebab-6fax.14`).
    const { sink, socket } = liveSystem({ registered: false });
    sink.toLiveSink(MSG);
    expect(socket).toHaveLength(1);
  });

  test('a resolving dispatch reaches the CURRENT owner, not the captured socket', () => {
    // The property `Cebab-6fax.14` bought and that the fix must not undo: a
    // callback created for a window that has since been replaced delivers to
    // whoever owns the session now.
    const { sink, socket, registry } = liveSystem({ registered: true });
    const reattached: ServerMsg[] = [];
    registry.set('sess-1', { sendServerMsg: (m) => reattached.push(m) });
    sink.toLiveSink(MSG);
    expect(reattached).toHaveLength(1);
    expect(socket).toHaveLength(0);
  });

  test('a genuinely re-entrant owner throws a NAMED error, not a stack overflow', () => {
    // The last resort, asserted so it cannot rot. If some future wiring
    // recreates the cycle, the first frame should say what happened — the
    // production failure said `Maximum call stack size exceeded` and named
    // nothing, which is how it stayed undiagnosed through three live repros.
    const socket: ServerMsg[] = [];
    const registry = new Map<string, LiveSinkOwner>();
    const sink = createLiveSink({
      sendToSocket: (m) => socket.push(m),
      getSessionId: () => 'sess-1',
      lookup: (id) => registry.get(id),
    });
    // An owner that resolves instead of delivering — the pre-fix shape.
    registry.set('sess-1', { sendServerMsg: (m) => sink.toLiveSink(m) });
    expect(() => sink.toLiveSink(MSG)).toThrow(LiveSinkCycleError);
    expect(() => sink.toLiveSink(MSG)).toThrow(/resolved to itself/);
  });

  test('the depth guard resets, so one cycle does not poison later sends', () => {
    // A thrown cycle must leave the sink usable: the operator's next event is
    // not the one that broke it.
    const socket: ServerMsg[] = [];
    const registry = new Map<string, LiveSinkOwner>();
    const sink = createLiveSink({
      sendToSocket: (m) => socket.push(m),
      getSessionId: () => 'sess-1',
      lookup: (id) => registry.get(id),
    });
    registry.set('sess-1', { sendServerMsg: (m) => sink.toLiveSink(m) });
    expect(() => sink.toLiveSink(MSG)).toThrow(LiveSinkCycleError);

    registry.set('sess-1', { sendServerMsg: (m) => socket.push(m) });
    sink.toLiveSink(MSG);
    expect(socket).toHaveLength(1);
  });
});
