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
 *   - Cebab SERVER restart → the registry is empty (process died) → nothing
 *     to re-attach → mark the row `crashed` (decision R-A). Single-agent
 *     resume is a different path and is unaffected.
 *
 * Exported signatures are unchanged so the WS layer needs no edits. The
 * `ResumeFailureReason` union is kept intact (the WS message map references
 * all variants); the registry-miss case maps to `'reattach-failed'`.
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
 * Reason an auto-resume couldn't bring back a `running` DB row. Union kept
 * intact for the WS message map; the pure-SDK runtime only ever produces
 * `'reattach-failed'` (registry miss = the process that owned the session is
 * gone — i.e. a Cebab restart, decision R-A).
 */
export type ResumeFailureReason =
  | 'tmux-unavailable'
  | 'legacy-row'
  | 'tmux-missing'
  | 'reattach-failed';

export type ResumeCallbacks = {
  onEvent: ResumeChainOpts['onEvent'];
  onEnded: ResumeChainOpts['onEnded'];
  onResumeFailed?: (sessionId: string, reason: ResumeFailureReason) => void;
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

  const live = getLiveSession(candidate.id);
  if (!live) {
    // Process that owned this session is gone (Cebab restarted) — R-A.
    markCrashedSilent(candidate.id);
    callbacks.onResumeFailed?.(candidate.id, 'reattach-failed');
    return null;
  }

  const sink: BusSink = { onEvent: callbacks.onEvent, onEnded: callbacks.onEnded };
  live.rebind(sink);

  return {
    handle: live.handle as unknown as ChainSessionHandle | OrchestratorSessionHandle,
    mode: live.mode,
    row: candidate,
    replayEvents: replayFor(candidate.id),
  };
}

/** Why a targeted `resumeMultiAgentTarget` couldn't bring a row back. */
export type TargetResumeFailure =
  | 'not-found'
  | 'already-running'
  | 'tmux-missing'
  | 'reattach-failed';

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
  callbacks: Pick<ResumeCallbacks, 'onEvent' | 'onEnded'>,
): Promise<TargetResumeResult> {
  const row = getMultiAgentSession(sessionId);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.status === 'running') return { ok: false, reason: 'already-running' };

  const live = getLiveSession(sessionId);
  if (!live) return { ok: false, reason: 'reattach-failed' };

  const prevStatus = row.status as MultiAgentStatus;
  reactivateMultiAgentSession(sessionId);
  try {
    live.rebind({ onEvent: callbacks.onEvent, onEnded: callbacks.onEnded });
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
