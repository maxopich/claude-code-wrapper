/**
 * Reconnect / resume for multi-agent sessions — pure-SDK model.
 *
 * The tmux bus kept agents alive OUTSIDE Cebab, so resume rebuilt a router by
 * reading `tmux has-session`. The pure-SDK bus keeps agents IN this process
 * (the AgentRunner + router live in `session_registry`). So "is it still
 * alive?" is now a registry lookup, not a tmux probe:
 *
 *   - browser refresh / second window, SAME server process → the session is
 *     in the registry → re-attach by swapping its WS sink (`rebind`), replay
 *     persisted events so the scrollback rebuilds.
 *   - Cebab SERVER restart → the registry is empty (process died). R-B:
 *     for an *orchestrated* run we rebuild it from persisted state
 *     (`reconstruct.ts`) and re-attach it READ-ONLY — paused until the
 *     operator continues (`awaiting_continue`). Only when reconstruction
 *     is impossible (chain mode, or a guard fails: no persisted session
 *     map / no folder / deleted participant / …) do we fall back to
 *     marking the row `crashed` (the old R-A behavior). Single-agent
 *     resume is a different path and is unaffected.
 *
 * An auto-resume still only fails one way — reconstruction couldn't bring
 * the row back — so `ResumeFailureReason` stays the single
 * `'reattach-failed'`.
 */
import {
  endMultiAgentSession,
  getActiveMultiAgentSession,
  getMultiAgentSession,
  listMultiAgentEvents,
  reactivateMultiAgentSession,
  type MultiAgentSessionRow,
  type MultiAgentStatus,
} from '../repo/multi_agent.js';
import { getDb } from '../db.js';
import { getLiveSession, type BusSink } from './session_registry.js';
import { reconstructOrchestratorSession } from './reconstruct.js';
import type { ChainSessionHandle, ResumeChainOpts } from './chain.js';
import type { OrchestratorSessionHandle } from './orchestrator.js';

/**
 * One persisted event, replayed to the browser after a resume so the
 * scrollback rebuilds. Mirrors the runtime event plus the DB id (so the
 * browser-side de-dupe key matches the live path).
 */
export type PersistedEvent = {
  ts: number;
  source: string;
  destination: string;
  kind: string;
  text: string;
  dbEventId: number;
};

/**
 * Reason an auto-resume couldn't bring back a `running` DB row. Still a
 * single value: a registry miss that R-B reconstruction also couldn't
 * recover (chain mode, or a guard failed). Orchestrated runs that *can* be
 * rebuilt no longer reach this path.
 */
export type ResumeFailureReason = 'reattach-failed';

export type ResumeCallbacks = {
  onEvent: ResumeChainOpts['onEvent'];
  onEnded: ResumeChainOpts['onEnded'];
  onResumeFailed?: (sessionId: string, reason: ResumeFailureReason) => void;
  /** Re-resolved hop budget for any reconstructed (R-B) session. The WS
   *  layer reads the value fresh on every reconnect, so a budget change
   *  between runs takes effect immediately. The router seeds its in-memory
   *  `hopsCount` from the DB so enforcement carries over the restart. */
  hopBudget: number;
  /** Item #4: pending-retry set/clear callback for a reconstructed router.
   *  Forwarded into `wireOrchestratorSession`; the initial banner restore
   *  travels on `multi_agent_started.pendingRetry` (hydrated from the
   *  persisted columns), so this fires only on AFTER-reconstruct
   *  transitions (a Continue+turn that re-fails, or an explicit Retry
   *  that re-fails). Optional — chain-mode reconstruct stays absent. */
  onPendingRetry?: BusSink['onPendingRetry'];
  /** Item #5: per-mutation forwarding for AFTER-reconstruct transitions.
   *  Initial mutations array ships on `multi_agent_started.mutations`. */
  onMutation?: BusSink['onMutation'];
  /** Item #5: pause-on-mutation slot set/clear for AFTER-reconstruct.
   *  Initial pending value ships on `multi_agent_started.pendingMutation`. */
  onPendingMutation?: BusSink['onPendingMutation'];
};

export type ResumedSession = {
  handle: ChainSessionHandle | OrchestratorSessionHandle;
  mode: 'chain' | 'orchestrator';
  row: MultiAgentSessionRow;
  replayEvents: PersistedEvent[];
};

function replayFor(sessionId: string): PersistedEvent[] {
  return listMultiAgentEvents(sessionId).map((r) => ({
    ts: r.ts,
    source: r.source,
    destination: r.destination,
    kind: r.kind,
    text: r.text,
    dbEventId: r.id,
  }));
}

/**
 * Find the active multi-agent session, re-attach if it's still live in this
 * process, else mark it (and any orphan running rows) crashed. Returns the
 * resumed session (original handle + events to replay) or null.
 */
export async function attemptResumeMultiAgent(
  callbacks: ResumeCallbacks,
): Promise<ResumedSession | null> {
  const activeRows = listActiveMultiAgentSessions();
  if (activeRows.length === 0) return null;

  const candidate = activeRows[0]!;
  // Single-active invariant: any older running rows are orphans.
  for (const r of activeRows.slice(1)) markCrashedSilent(r.id);

  let live = getLiveSession(candidate.id);
  if (!live) {
    // The process that owned this session is gone (Cebab restarted). R-B:
    // rebuild an orchestrated run from persisted state instead of crashing.
    // Conservative — reconstruction re-attaches READ-ONLY and sets
    // awaiting_continue; nothing runs until the operator continues. Chain
    // mode / guard failures fall through to the crashed path below
    // (behavior never worse than R-A).
    if (
      reconstructOrchestratorSession(candidate, {
        onEvent: callbacks.onEvent,
        onEnded: callbacks.onEnded,
        hopBudget: callbacks.hopBudget,
        onPendingRetry: callbacks.onPendingRetry,
        onMutation: callbacks.onMutation,
        onPendingMutation: callbacks.onPendingMutation,
      })
    ) {
      live = getLiveSession(candidate.id);
    }
  }
  if (!live) {
    markCrashedSilent(candidate.id);
    callbacks.onResumeFailed?.(candidate.id, 'reattach-failed');
    return null;
  }

  const sink: BusSink = {
    onEvent: callbacks.onEvent,
    onEnded: callbacks.onEnded,
    onPendingRetry: callbacks.onPendingRetry,
    onMutation: callbacks.onMutation,
    onPendingMutation: callbacks.onPendingMutation,
  };
  live.rebind(sink);

  return {
    handle: live.handle as unknown as ChainSessionHandle | OrchestratorSessionHandle,
    mode: live.mode,
    row: candidate,
    replayEvents: replayFor(candidate.id),
  };
}

/** Why a targeted `resumeMultiAgentTarget` couldn't bring a row back. */
export type TargetResumeFailure = 'not-found' | 'already-running' | 'reattach-failed';

export type TargetResumeResult =
  | { ok: true; resumed: ResumedSession }
  | { ok: false; reason: TargetResumeFailure };

/**
 * Operator-triggered re-attach for ONE session (the Iterations "Resume"
 * button). Only succeeds if that session is still live in THIS process —
 * after a server restart it is gone and stays unrecoverable (matches the
 * documented expectation). Pure re-attach: never respawns agents.
 */
export async function resumeMultiAgentTarget(
  sessionId: string,
  callbacks: Pick<
    ResumeCallbacks,
    'onEvent' | 'onEnded' | 'hopBudget' | 'onPendingRetry' | 'onMutation' | 'onPendingMutation'
  >,
): Promise<TargetResumeResult> {
  const row = getMultiAgentSession(sessionId);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.status === 'running') return { ok: false, reason: 'already-running' };

  let live = getLiveSession(sessionId);
  if (!live) {
    // R-B: operator clicked Resume on a session whose owning process is
    // gone (Cebab restarted). Rebuild it read-only — same conservative
    // contract as the auto-resume path. Chain / guard failures keep the
    // old "reattach-failed" behavior.
    if (
      reconstructOrchestratorSession(row, {
        onEvent: callbacks.onEvent,
        onEnded: callbacks.onEnded,
        hopBudget: callbacks.hopBudget,
        onPendingRetry: callbacks.onPendingRetry,
        onMutation: callbacks.onMutation,
        onPendingMutation: callbacks.onPendingMutation,
      })
    ) {
      live = getLiveSession(sessionId);
    }
  }
  if (!live) return { ok: false, reason: 'reattach-failed' };

  const prevStatus = row.status as MultiAgentStatus;
  reactivateMultiAgentSession(sessionId);
  try {
    live.rebind({
      onEvent: callbacks.onEvent,
      onEnded: callbacks.onEnded,
      onPendingRetry: callbacks.onPendingRetry,
      onMutation: callbacks.onMutation,
      onPendingMutation: callbacks.onPendingMutation,
    });
  } catch (err) {
    console.error(`[resume] targeted resume threw for ${sessionId}`, err);
    endMultiAgentSession(sessionId, prevStatus);
    return { ok: false, reason: 'reattach-failed' };
  }

  return {
    ok: true,
    resumed: {
      handle: live.handle as unknown as ChainSessionHandle | OrchestratorSessionHandle,
      mode: row.mode as 'chain' | 'orchestrator',
      row,
      replayEvents: replayFor(sessionId),
    },
  };
}

/** List every running multi-agent session, most recent first. */
function listActiveMultiAgentSessions(): MultiAgentSessionRow[] {
  return getDb()
    .prepare<
      [],
      MultiAgentSessionRow
    >(`SELECT * FROM multi_agent_sessions WHERE status = 'running' ORDER BY started_at DESC`)
    .all();
}

/** Mark a row crashed without emitting any ServerMsg. */
function markCrashedSilent(sessionId: string): void {
  try {
    endMultiAgentSession(sessionId, 'crashed');
  } catch (err) {
    console.error(`[resume] failed to mark ${sessionId} crashed`, err);
  }
}

export { getMultiAgentSession, getActiveMultiAgentSession };
