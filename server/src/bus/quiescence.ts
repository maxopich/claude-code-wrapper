/**
 * `Cebab-vie.8` — "nobody is running, and the transcript does not say so".
 *
 * Mute a worker while the orchestrator is waiting on it. The worker finishes a
 * full tool-capable turn; its reply reaches `handleEvent` and is dropped there
 * (`muted_source`), which is BEFORE the persist and before the deliver branch.
 * Nothing is woken. The session row stays `running`, the hop counter stays
 * frozen (a dropped event is deliberately "as if it never happened", so the
 * budget brake can never fire either), and the last persisted event is still
 * `orchestrator → scribe prompt`.
 *
 * That tail is what the web activity bar reads to name the working agent, so
 * the operator is shown `scribe working` with a timer that counts past seven
 * minutes on a session where zero `claude` processes exist. Reproduced live on
 * a 4-agent run; the bead has the measurements.
 *
 * The drop itself is not the defect and is not changed here. It is audited, it
 * raises a danger notification, and dropping outbound events is the documented
 * job of mute. The defect is that Cebab then asserts the opposite of the truth
 * and offers no reason to reach for the recovery that does exist (in
 * orchestrator mode, the prompt composer is rendered in exactly this state).
 *
 * SO THE FIX IS A SENTENCE, NOT A ROUTING CHANGE. Waking the orchestrator to
 * tell it about the drop would be the tempting alternative and is the wrong
 * one: it spends quota, it hands a muted worker's existence back to the agent
 * layer, and an orchestrator that re-delegates to the same muted worker loops
 * forever. Cebab writes a `cebab → user` row instead — durable, so it survives
 * a reload that the ephemeral `agent_activity` pulse does not, and addressed to
 * the operator, so no agent reads it.
 *
 * THE PREDICATE IS DELIBERATELY THE BAR'S OWN. `tailAwaitsAgent` (in
 * `@cebab/shared`) is the same function `web/src/store.ts:activeAgent` uses, so
 * this fires on exactly the tails that would otherwise be labelled "working".
 * A "false positive" of this note is by construction a true positive of the
 * lie — which is the property that makes a general detector safe here rather
 * than a mute-specific patch.
 *
 * Note what makes it self-limiting: the note's own row lands with
 * `destination = 'user'`, so `tailAwaitsAgent` goes false the moment it exists.
 * The state cannot be reported twice, without a flag to keep in sync.
 */
import type { RouterDropReasonCode } from '@cebab/shared/protocol';
import { tailAwaitsAgent, type BusTailEvent } from '@cebab/shared';

/**
 * The last message the router threw away, when that is still the most recent
 * thing to have happened in the session.
 *
 * Recorded at `dispatchRouterDrop` — the single funnel every drop in both
 * routers already goes through — and cleared when a turn starts, because a
 * turn starting means the drop is no longer the last thing that happened. So
 * "still set when the run goes quiet" is exactly "this drop is why".
 *
 * `null` is a real answer rather than a gap: it means the woken agent's turn
 * ended without sending anything on the bus, which strands the run just as
 * effectively and by a different route.
 */
export type StrandedCause = {
  reasonCode: RouterDropReasonCode;
  source: string;
  destination: string;
  kind: string;
};

/**
 * What the operator can still do. The two modes genuinely differ and saying
 * otherwise would repeat the mistake this bead's own notes made: an
 * orchestrator handle has `sendUserPrompt` and renders the composer in exactly
 * this state, while a chain handle carries `sendUserPrompt: null`
 * (`ws/server.ts`), so there Stop really is the only way out.
 */
export type StrandedRecovery = 'orchestrator-prompt' | 'stop-only';

export type StrandedRunDecision = { awaitingAgent: string; cause: StrandedCause | null };

/**
 * All four conjuncts, in one function, so that dropping one is a visible edit
 * rather than a missing line in a router.
 *
 * Each excludes a measured case that is NOT a wedged run:
 *
 *  - `turnsInFlight > 0` — something is still computing. The caller counts
 *    deliveries rather than passing a boolean so the check cannot be spelled
 *    "the turn I just watched end", which would fire on every parallel hop.
 *  - `ended` — teardown. Both routers set it synchronously at the top of
 *    `teardown`, so this is a reliable read from inside a `.finally`.
 *  - `anyGateHeld` — the pause-on-dangerous hold or an operator pause. Both
 *    end (or park) a turn while the tail still points at the held agent, and
 *    both hand the operator a Continue/Resume button.
 *  - `tailAwaitsAgent` — the big one. It excludes the orchestrator's ordinary
 *    `→ user` answer (idle awaiting the operator, nothing wrong), the
 *    `onWorkerFailed` path (which writes its own `cebab → user` row first, and
 *    parks a Retry/Abandon slot), and the budget-exhaust row addressed to
 *    `_sink`.
 *
 * `AskUserQuestion` needs no conjunct: a parked question keeps the turn open,
 * so `turnsInFlight` never reaches zero while the operator is being asked.
 */
export function decideStrandedRun(input: {
  turnsInFlight: number;
  ended: boolean;
  anyGateHeld: boolean;
  tail: BusTailEvent | null | undefined;
  cause: StrandedCause | null;
}): StrandedRunDecision | null {
  if (input.turnsInFlight > 0) return null;
  if (input.ended) return null;
  if (input.anyGateHeld) return null;
  if (!tailAwaitsAgent(input.tail)) return null;
  return { awaitingAgent: input.tail!.destination, cause: input.cause };
}

/**
 * The row the operator reads. Kept here rather than in the routers for the
 * reason `turn_guard.ts` gives about its own refusal strings: two spellings of
 * one sentence means the copy nobody is testing is the one that rots.
 *
 * Three things it must get right, all of which the bead's own write-up got
 * wrong at least once:
 *
 *  1. the agent is NOT working — that is the whole point;
 *  2. the dropped message is gone, and reversing the control does not bring it
 *     back (Unmute does not replay — pinned at `orchestrator.mute.test.ts`);
 *  3. the hop budget will not rescue this. The counter only advances on a
 *     persisted hop, and an idle session has none, so the cap can never be
 *     reached — the run would sit `running` indefinitely.
 *
 * Interpolates agent slugs and a closed-set reason code, and nothing an agent
 * wrote. The row is addressed to `user`, so it reaches no model either way.
 */
export function strandedRunText(input: {
  awaitingAgent: string;
  cause: StrandedCause | null;
  recovery: StrandedRecovery;
}): string {
  const { awaitingAgent, cause, recovery } = input;
  const why = cause
    ? `\`${cause.source}\` → \`${cause.destination}\` (${cause.kind}) was dropped at the router — ` +
      `${cause.reasonCode}. A dropped message is never re-delivered, and reversing the control that ` +
      `caused the drop does not bring it back.`
    : `\`${awaitingAgent}\`'s turn ended without sending anything on the bus, so no next hop was ` +
      `triggered.`;
  const recover =
    recovery === 'orchestrator-prompt'
      ? `Send a prompt below to wake the orchestrator and carry on, or Stop the session.`
      : `A chain run has no operator prompt, so Stop is the only way out of this session.`;
  return (
    `Nothing is running in this session. The last hop was a message to \`${awaitingAgent}\`, so the ` +
    `trail reads as if it were still working — it is not, and its turn has ended. ` +
    `${why} ` +
    `The hop budget will not stop the run either: the counter only advances on a hop that happened, ` +
    `and an idle session has none. ` +
    `${recover}`
  );
}
