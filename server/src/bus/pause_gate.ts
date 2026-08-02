import type { MutationCategory } from '@cebab/shared';

import {
  findUnconsumedApproval,
  getMultiAgentSession,
  hasPendingMutation,
  listPendingMutations,
  setMutationPauseState,
  type MutationRecord,
} from '../repo/multi_agent.js';
import { PausedForMutationError } from './errors.js';

/**
 * What the gate decided for one tool call.
 *
 * - `run` — dispatch it. Either the gate isn't armed, the call isn't
 *   `dangerous`, or the agent is already halted on an earlier pause.
 * - `pause` — halt this agent's turn and put the call in front of the operator.
 * - `consume-approval` — the operator already approved this exact call; run it
 *   and burn the grant (`approvalId` is the row carrying it).
 */
export type PauseDecision =
  { action: 'run' } | { action: 'pause' } | { action: 'consume-approval'; approvalId: number };

/**
 * The bus pause gate fires ONLY on `dangerous`-category mutations. The
 * operator opts into pausing on *dangerous commands* (rm, sudo, force-push,
 * `curl | sh`, writes to system/secret paths, infra/cluster/DB destructive
 * ops, …) — NOT on every mutation. MCP tool calls and ordinary edits classify
 * as `mutate` and run free; their safety relies on the MCP server's own
 * permissions and the hash-chained audit log.
 *
 * Shared by orchestrator.ts and chain.ts so the two routers' gate decisions
 * cannot drift. Pure function — unit-tested in `pause_gate.test.ts`.
 *
 * **Per-agent and re-arming** (migration 031, register B06/B07). The state used
 * to be two columns on the session: one pending slot and one
 * `mutations_acknowledged` flag. Both were session-scoped, so worker B's
 * `rm -rf` ran free while worker A was paused, and one Continue disarmed the
 * gate for the rest of the run. State now lives on the mutation row, so every
 * agent is gated independently and every dangerous command needs its own
 * approval.
 *
 * **Why `consume-approval` exists.** Resuming a pause is a REPLAY: the gate
 * halts an agent by throwing out of the mutation tap, which kills its SDK turn,
 * and Continue re-delivers the captured prompt. The fresh turn re-issues the
 * same dangerous command. Without a grant that survives the replay, re-arming
 * would livelock — pause → Continue → replay → pause → … The grant covers one
 * command, from one agent, once; anything else the replayed turn does still
 * pauses.
 *
 * The caller reads the session row and both per-agent facts fresh from the DB
 * on every dangerous call (handles a Continue landing mid-turn, and R-B
 * reconstructed sessions where the in-memory closure has no value to read).
 */
export function decidePauseForMutation(
  category: MutationCategory,
  session: { pause_on_dangerous: number } | undefined,
  agent: {
    /** This agent already has a halted turn (`pause_state = 'pending'`). */
    hasPendingPause: boolean;
    /** Row id of an unconsumed Continue grant matching this exact call. */
    unconsumedApprovalId: number | null;
  },
): PauseDecision {
  if (category !== 'dangerous' || session?.pause_on_dangerous !== 1) return { action: 'run' };
  if (agent.unconsumedApprovalId !== null) {
    return { action: 'consume-approval', approvalId: agent.unconsumedApprovalId };
  }
  // Already waiting on the operator: this agent's turn is dead, so there is
  // nothing left to halt and a second pending row would only duplicate the
  // banner. Defensive — the tap shouldn't see another call from a dead turn.
  if (agent.hasPendingPause) return { action: 'run' };
  return { action: 'pause' };
}

/**
 * The impure half: read the gate's inputs, apply `decidePauseForMutation`, and
 * carry out the verdict. Lives here rather than in each router so
 * orchestrator.ts and chain.ts run byte-identical gate logic — the whole point
 * of this module.
 *
 * Throws `PausedForMutationError` on a pause, which unwinds the runner's
 * mutation tap and kills the agent's turn. The caller must let it propagate.
 *
 * `row` is the already-persisted mutation (the tap appends before gating), so
 * it carries every fact the gate needs: session, agent, tool, summary, category.
 */
export function applyPauseGate(
  row: MutationRecord,
  onPendingMutation?: (sessionId: string, pending: MutationRecord[]) => void,
): void {
  const { sessionId, agentName } = row;
  const session = getMultiAgentSession(sessionId);
  // Cheap exit before either per-agent query: with the toggle off (the common
  // case) the gate costs one session read, exactly as it did before 031.
  if (row.category !== 'dangerous' || session?.pause_on_dangerous !== 1) return;

  const approval = findUnconsumedApproval(sessionId, agentName, row.toolName, row.summary);
  const decision = decidePauseForMutation(row.category, session, {
    hasPendingPause: hasPendingMutation(sessionId, agentName),
    unconsumedApprovalId: approval?.id ?? null,
  });

  if (decision.action === 'consume-approval') {
    // Burn the grant so the NEXT identical command from this agent pauses
    // again. Failing to burn it would silently un-arm the gate for that
    // command, so the write is deliberately not swallowed.
    setMutationPauseState(decision.approvalId, 'consumed');
    return;
  }
  if (decision.action === 'run') return;

  try {
    setMutationPauseState(row.id, 'pending');
  } catch (err) {
    // The throw below still halts the turn, so the operator is protected even
    // if the row didn't persist — they just won't see the banner survive a
    // reconnect. Log and continue to the throw rather than letting the call run.
    console.error('[bus] persist pending-mutation failed', err);
  }
  try {
    onPendingMutation?.(sessionId, listPendingMutations(sessionId));
  } catch (err) {
    console.error('[bus] onPendingMutation sink threw', err);
  }
  throw new PausedForMutationError(`paused before ${row.summary}`);
}

/**
 * Operator clicked Continue on one banner: move that mutation from `pending` to
 * `approved` and broadcast what is still waiting. Returns the released record
 * so the caller can replay that agent's captured prompt, or `null` when there
 * is nothing to release (a racing second click, or a stale `mutationId` from a
 * client that missed a broadcast) — which makes Continue idempotent.
 *
 * The row stays `approved` rather than being cleared: it IS the one-shot grant
 * that lets the replayed turn re-issue the same command exactly once.
 */
export function releasePauseForMutation(
  sessionId: string,
  mutationId: number,
  onPendingMutation?: (sessionId: string, pending: MutationRecord[]) => void,
): MutationRecord | null {
  const pending = listPendingMutations(sessionId).find((m) => m.id === mutationId);
  if (!pending) return null;
  try {
    setMutationPauseState(mutationId, 'approved');
  } catch (err) {
    // Without the grant the replayed turn would re-pause on the same command,
    // so refuse to replay rather than hand the operator a loop.
    console.error('[bus] persist continue-through-mutation failed', err);
    return null;
  }
  try {
    onPendingMutation?.(sessionId, listPendingMutations(sessionId));
  } catch (err) {
    console.error('[bus] continue onPendingMutation sink threw', err);
  }
  return pending;
}
