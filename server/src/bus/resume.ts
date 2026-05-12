/**
 * Cebab-restart resume for multi-agent sessions.
 *
 * The bus runtime spawns long-lived `claude` TUIs in tmux. They keep running
 * across Cebab restarts. On the next WS connect we want to:
 *
 *   1. Find any DB row in `multi_agent_sessions` with `status='running'`.
 *   2. For each, check `tmux has-session` against the row's `tmux_session`:
 *        - alive → re-attach via `resumeChainSession` / `resumeOrchestratorSession`,
 *          replay persisted events to the browser so the scrollback fills in
 *          the order the operator saw originally
 *        - dead → mark the row `crashed` so the iteration browser shows the
 *          correct status. No event is replayed (the browser had no live
 *          state to update on the fresh WS).
 *
 * Single-active-session invariant: v1 only supports one active multi-agent
 * session per Conn. If multiple `running` rows exist (operator manually
 * spawned a second one, or some edge case), we re-attach the most recently
 * started one and mark the rest crashed. Defensive — should not normally
 * happen.
 *
 * Event replay vs the live tailer: re-attach starts the tailer at EOF on
 * `bus.log`, so events appended during Cebab downtime are NOT picked up.
 * This is a known gap — typically negligible since Cebab restarts are
 * seconds and Claude turns are minutes, but a worker that finishes a turn
 * mid-restart could lose one or two events. Documented in the plan as a
 * follow-up.
 */
import {
  endMultiAgentSession,
  getActiveMultiAgentSession,
  getMultiAgentSession,
  listMultiAgentEvents,
  type MultiAgentSessionRow,
} from '../repo/multi_agent.js';
import { getDb } from '../db.js';
import { hasSession, tmuxAvailable } from './tmux.js';
import { resumeChainSession, type ChainSessionHandle, type ResumeChainOpts } from './chain.js';
import { resumeOrchestratorSession, type OrchestratorSessionHandle } from './orchestrator.js';

/**
 * One persisted event, replayed to the browser after a resume so the
 * scrollback rebuilds. Mirrors the runtime `BusLogEvent` plus the DB id
 * (so the browser-side de-dupe key matches what the live path uses).
 */
export type PersistedEvent = {
  ts: number;
  source: string;
  destination: string;
  kind: string;
  text: string;
  dbEventId: number;
};

export type ResumeCallbacks = {
  /** Same shape as `StartChainOpts.onEvent`. Used both for live events
   *  picked up by the re-attached tailer AND for replayed history. */
  onEvent: ResumeChainOpts['onEvent'];
  onEnded: ResumeChainOpts['onEnded'];
};

export type ResumedSession = {
  handle: ChainSessionHandle | OrchestratorSessionHandle;
  mode: 'chain' | 'orchestrator';
  row: MultiAgentSessionRow;
  /** All persisted events for the resumed session, ordered by DB id —
   *  caller replays these to the browser BEFORE expecting any live event
   *  from `onEvent`. */
  replayEvents: PersistedEvent[];
};

/**
 * Find any active multi-agent session in the DB, validate it against tmux,
 * and either re-attach or mark crashed. Returns the resumed session (with
 * a fresh handle + the events to replay), or null when nothing was active
 * or the session couldn't be recovered.
 *
 * Marking-crashed is silent — the row is updated but no ServerMsg is
 * emitted, because a fresh WS connect has no UI state attached to a stale
 * session and emitting `multi_agent_ended` would be noise.
 */
export async function attemptResumeMultiAgent(
  callbacks: ResumeCallbacks,
): Promise<ResumedSession | null> {
  // Find every active row, not just the top one — we may need to mark the
  // older ones crashed individually.
  const activeRows = listActiveMultiAgentSessions();
  if (activeRows.length === 0) return null;

  if (!(await tmuxAvailable())) {
    // No tmux means nothing is recoverable. Mark all running rows crashed.
    for (const r of activeRows) {
      markCrashedSilent(r.id);
    }
    return null;
  }

  // The most recently started row is the most likely candidate. Older
  // rows that are still `running` AND still alive in tmux are treated as
  // orphans — we mark them crashed (single-active invariant). Operator
  // can manually `tmux kill-session` if they want to clean up.
  const candidate = activeRows[0]!;
  for (const r of activeRows.slice(1)) {
    markCrashedSilent(r.id);
  }

  if (!candidate.tmux_session || !candidate.iteration_id) {
    // Pre-006 row, or one that was created without these fields. Can't
    // resume — mark crashed.
    markCrashedSilent(candidate.id);
    return null;
  }
  if (!(await hasSession(candidate.tmux_session))) {
    markCrashedSilent(candidate.id);
    return null;
  }

  let handle: ChainSessionHandle | OrchestratorSessionHandle | null = null;
  if (candidate.mode === 'chain') {
    handle = await resumeChainSession({
      sessionId: candidate.id,
      onEvent: callbacks.onEvent,
      onEnded: callbacks.onEnded,
    });
  } else if (candidate.mode === 'orchestrator') {
    handle = await resumeOrchestratorSession({
      sessionId: candidate.id,
      onEvent: callbacks.onEvent,
      onEnded: callbacks.onEnded,
    });
  } else {
    console.warn(`[resume] unknown mode for session ${candidate.id}: ${candidate.mode}`);
  }

  if (!handle) {
    // Reattach failed despite tmux being alive — likely a participant lost
    // bus integration. Mark crashed and bail.
    markCrashedSilent(candidate.id);
    return null;
  }

  // Read persisted events for the resumed session so the WS layer can
  // replay them to the browser, populating the scrollback.
  const rows = listMultiAgentEvents(candidate.id);
  const replayEvents: PersistedEvent[] = rows.map((r) => ({
    ts: r.ts,
    source: r.source,
    destination: r.destination,
    kind: r.kind,
    text: r.text,
    dbEventId: r.id,
  }));

  return {
    handle,
    mode: candidate.mode as 'chain' | 'orchestrator',
    row: candidate,
    replayEvents,
  };
}

/** List every running multi-agent session, most recent first. */
function listActiveMultiAgentSessions(): MultiAgentSessionRow[] {
  // Bypass `getActiveMultiAgentSession` (LIMIT 1) — we want every row.
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

/** Re-export for callers that only need to look up a single session. */
export { getMultiAgentSession, getActiveMultiAgentSession };
