/**
 * `Cebab-vie.9` / `Cebab-vie.10` / `Cebab-vie.18` — the refusal vocabulary the
 * two operator replay seams share.
 *
 * Almost every turn in the bus is started by the router, from a `BusEvent`, and
 * therefore downstream of the checks the router already runs: the `kickedSet`
 * drops, the `ended` flag, the hop-budget cap. `handle.retry()` and
 * `handle.continueThroughMutation()` are the exceptions — operator-triggered
 * turn-starters that do not originate from an event at all, so none of that
 * enforcement is structurally in their path. They ran a full tool-capable turn
 * for a kicked worker, for an ended session, and past the hop cap.
 *
 * The decision itself cannot live here: it reads `kickedSet` / `ended` /
 * `hopsCount`, which are closure state inside each router. What CAN drift is
 * the wording an operator reads, and the set of reasons — so those live here,
 * for the same reason `pause_gate.ts` holds the gate decision: two spellings of
 * one rule means the copy nobody is testing is the one that rots.
 */

/**
 * Why a turn was refused. `budget` is distinct from `ended` because reaching
 * the cap TEARS THE SESSION DOWN as it refuses (that is what the router does at
 * the cap on every other wake attempt), while `ended` merely observes that it
 * already happened.
 */
export type TurnRefusalReason = 'kicked' | 'ended' | 'budget';

/**
 * The operator-facing sentence for the two reasons that have no message of
 * their own. `budget` is absent on purpose: it has counts in it, so it lives in
 * `hopBudgetExhaustedText` below rather than taking an `agentName`.
 */
export function turnRefusalText(reason: 'kicked' | 'ended', agentName: string): string {
  if (reason === 'kicked') {
    return `\`${agentName}\` was removed from this session, so nothing was run. A kicked participant never starts another turn — Retry and Continue included.`;
  }
  return `This session has ended, so \`${agentName}\` was not woken and nothing was run.`;
}

/**
 * The sentence an operator reads when the hop budget stops a run.
 *
 * It lived inline in both routers' `checkBudgetExhausted`, byte-identical, and
 * `Cebab-vie.17` was about to add a THIRD copy — the safety notification, which
 * must say the same thing the persisted `cebab → _sink` row says or the audit
 * log and the transcript disagree about why a session stopped. Same reasoning
 * as the two strings above: two spellings of one rule means the copy nobody is
 * testing is the one that rots.
 */
export function hopBudgetExhaustedText(hopsCount: number, hopBudget: number): string {
  return (
    `Hop budget exhausted (${hopsCount}/${hopBudget}). The session was stopped to prevent a ` +
    `runaway loop. Raise the limit in Settings or via the CEBAB_HOP_BUDGET env var to extend.`
  );
}
