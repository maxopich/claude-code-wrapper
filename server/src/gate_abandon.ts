/**
 * Register B20 + H15: releasing a parked spawn gate when its operator leaves.
 *
 * Three gates park a promise and block a spawn on an operator decision — the
 * MCP TOFU gate (`repo/mcp_trust_gate.ts`), the bus-install TOFU gate
 * (`bus/install_trust_gate.ts`) and the env-injection start gate
 * (`repo/session_start_gate.ts`). Each kept its parked entries in a `Map` on
 * the `Conn`, and each said, in its own words, that a disconnect took care of
 * them:
 *
 *   - `Conn.trustGate` / `Conn.busTrustGate` — "Cleared implicitly on
 *     disconnect via Conn drop."
 *   - `install_trust_gate.ts` — "A WS disconnect upstream blows away the
 *     `Conn` … which is the only structural way out."
 *   - `session_start_gate.ts` — "The WS disconnect upstream is the only
 *     escape hatch."
 *
 * None of that was true, and the reasoning is the interesting part: dropping a
 * reference does not settle a promise. The `await` inside the spawn path is a
 * suspended async frame, the unresolved promise keeps that frame alive, and
 * the frame retains everything reachable from it — including the very `Conn`
 * the comments say it died with. So the documented escape hatch did not merely
 * work unreliably; there was no way out at all, and the leaked object was the
 * one the comment claimed had been collected.
 *
 * `ws.on('close')` now drains all three explicitly, the same way it has always
 * drained `pendingPermissions` and `inFlight`.
 *
 * WHY REJECT RATHER THAN RESOLVE. Each gate's `resolve` carries an operator
 * DECISION and runs the persistence that goes with it — `recordTrustDecision`,
 * `recordSilentRefusal`, the `denyOnce` set. Draining by resolving would write
 * decisions the operator never made into the trust history, and for the start
 * gate (whose `resolve()` means *acknowledged, proceed*) it would spawn a
 * session whose credential-injection acknowledgment nobody gave. Rejecting
 * says the true thing: nobody decided, and the spawn must not continue.
 *
 * The error is named `AbortError` because that is what `ws/errors.ts`'s
 * `classifyError` maps to `WrapperErrorKind: 'aborted'` — and register S02b
 * already established the posture this needs: closing the browser mid-turn is
 * a deliberate end, not a failure, and must not leave the operator a sticky
 * "Turn failed" row for something they did on purpose.
 */

/**
 * Thrown into a spawn that was waiting on an operator decision which will
 * never arrive. `name` is `AbortError` deliberately — see the note above.
 */
export class GateAbandonedError extends Error {
  constructor(gateName: string, reason: string) {
    super(`${gateName} gate abandoned: ${reason}`);
    this.name = 'AbortError';
  }
}

/**
 * Ceiling on parked entries per gate, per connection.
 *
 * H15's second half: each entry holds a promise plus the snapshot that
 * described it, and nothing bounded how many could accumulate. A legitimate
 * spawn parks one per unfamiliar MCP server or one per project — a handful.
 * 64 is far above any real use and still a bound, so a client that raises
 * gates faster than a human answers them cannot grow the map without limit.
 *
 * Over the cap the gate fails CLOSED (refuses rather than parks), which is the
 * same direction every other unanswered-gate path takes.
 */
export const MAX_PENDING_GATES = 64;

/**
 * Reject every parked entry and empty the map. Returns how many were
 * released, so the caller can log a number that means something.
 *
 * Each entry's `abandon` is the promise's own `reject`, captured at park time
 * — deliberately NOT its `resolve`, which would run the decision-application
 * path. Failures are swallowed per entry so one bad handler cannot strand the
 * rest, which matters because this runs during teardown.
 */
export function abandonPendingGates<T extends { abandon: (err: Error) => void }>(
  pending: Map<string, T>,
  gateName: string,
  reason: string,
): number {
  if (pending.size === 0) return 0;
  const entries = [...pending.values()];
  // Clear first: an `abandon` that reaches back into the map (it should not,
  // but the entries' `resolve` siblings all delete themselves) then finds it
  // already empty rather than mutating what we are iterating.
  pending.clear();
  let released = 0;
  for (const entry of entries) {
    try {
      entry.abandon(new GateAbandonedError(gateName, reason));
      released += 1;
    } catch (err) {
      console.error(`[gate] abandoning a parked ${gateName} entry threw`, err);
    }
  }
  return released;
}
