/**
 * `Cebab-gejh`: the two directions a run-scoped callback can send, and why
 * confusing them killed every multi-agent run for nine days.
 *
 * A bus run has run-scoped callbacks (the activity pulse, the mutation lane,
 * pending-retry, router drops) created ONCE at session start, closing over the
 * socket that existed then. `Cebab-6fax.14` measured what that costs after a
 * browser reload: 296 activity ticks and every mutation message went into a
 * dead socket while the run carried on. So those callbacks stopped writing to
 * their captured socket and started asking the registry who owns the session
 * NOW. That is the RESOLVING direction, and it is right.
 *
 * The connection's own generic sender was migrated along with them, and it is
 * the one callback for which that is wrong. It does not need to find the
 * session's sink: it IS the session's sink — the object `rebind` swaps and the
 * registry hands out. Resolving from inside it produced a closed loop:
 *
 *     toLiveSink → getLiveSession(id).sendServerMsg
 *                → router.sendServerMsg → sink.sendServerMsg
 *                → toLiveSink → …
 *
 * ending in `RangeError: Maximum call stack size exceeded` on the orchestrator's
 * FIRST turn, because the activity observer fires on the first SDK message and
 * that was enough. Both modes were affected: `orchestrator.ts` and `chain.ts`
 * register the identical `sendServerMsg: (m) => router.sendServerMsg(m)`.
 *
 * WHY IT LIVED NINE DAYS. Nothing ran a bus session in the window, and no test
 * could have caught it: the cycle closes through the REGISTRY, and every bus
 * test drives the router with a hand-built sink that never goes near it. That
 * is the reason this seam is a module with its own tests instead of two
 * closures inside a 7,000-line request handler — the bug was not subtle, it
 * was unreachable.
 */
import type { ServerMsg } from '@cebab/shared/protocol';

/** The half of a registered live session this seam needs. Structural on
 *  purpose: the test supplies its own, and a fake that matches the real
 *  registry's shape is the whole point. */
export type LiveSinkOwner = { sendServerMsg: (msg: ServerMsg) => void };

export type LiveSinkDeps = {
  /** Terminal delivery: this connection's socket. */
  sendToSocket: (msg: ServerMsg) => void;
  /** The live session id, read at CALL time — it is null until
   *  `registerLiveSession` has run, and callbacks can fire before that. */
  getSessionId: () => string | null;
  /** The registry lookup. */
  lookup: (sessionId: string) => LiveSinkOwner | undefined;
};

export type LiveSink = {
  /**
   * RESOLVING. For run-scoped callbacks that may outlive the window they were
   * created in: deliver to whoever owns the session now, falling back to this
   * connection's socket when no owner is registered yet.
   */
  toLiveSink: (msg: ServerMsg) => void;
  /**
   * TERMINAL. This connection's own sink, the one handed to the bus runtime
   * and swapped by `rebind`. It writes to the socket and must never resolve —
   * see the header.
   */
  sendServerMsg: (msg: ServerMsg) => void;
};

/**
 * Thrown when a resolving dispatch re-enters itself.
 *
 * A sentinel rather than a silent drop, and the rule is this repo's existing
 * one: Cebab raises a named error exactly when Cebab itself made the decision
 * that stopped the work. Dropping the message instead would trade a loud
 * failure for a quiet one — an AskUserQuestion card that never appears and a
 * run that waits forever on an operator who was never asked, which is the very
 * outcome `Cebab-6fax.14` existed to prevent.
 *
 * It is a LAST RESORT and not the design. The structural guarantee is that
 * `sendServerMsg` is terminal; this exists so that if some future wiring
 * recreates the cycle anyway, the first frame says so by name instead of the
 * ten-thousandth saying `Maximum call stack size exceeded`.
 */
export class LiveSinkCycleError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `live sink for session ${sessionId} resolved to itself — a registered ` +
        `sendServerMsg must deliver, not resolve (Cebab-gejh)`,
    );
    this.name = 'LiveSinkCycleError';
    this.sessionId = sessionId;
  }
}

/**
 * One nested resolve is already a cycle: a resolving dispatch reaches the
 * owner's sink, and a correct owner's sink delivers. There is no legitimate
 * shape in which delivering re-enters the resolver.
 */
const MAX_RESOLVE_DEPTH = 1;

export function createLiveSink(deps: LiveSinkDeps): LiveSink {
  let depth = 0;

  const toLiveSink = (msg: ServerMsg): void => {
    const sessionId = deps.getSessionId();
    const owner = sessionId === null ? undefined : deps.lookup(sessionId);
    // No owner yet: the callback fired before `registerLiveSession`, and this
    // connection's socket IS the right destination. Not an error.
    if (!owner) {
      deps.sendToSocket(msg);
      return;
    }
    if (depth >= MAX_RESOLVE_DEPTH) throw new LiveSinkCycleError(sessionId as string);
    depth += 1;
    try {
      owner.sendServerMsg(msg);
    } finally {
      depth -= 1;
    }
  };

  // Terminal by construction. If this ever needs to become conditional, the
  // condition belongs in `toLiveSink`, not here.
  const sendServerMsg = (msg: ServerMsg): void => {
    deps.sendToSocket(msg);
  };

  return { toLiveSink, sendServerMsg };
}
