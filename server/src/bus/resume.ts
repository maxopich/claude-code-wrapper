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
  reactivateMultiAgentSession,
  type MultiAgentSessionRow,
  type MultiAgentStatus,
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

/**
 * Reason an auto-resume couldn't bring back a `running` DB row. Bubbled
 * up to the WS layer so the operator sees a toast instead of silent
 * crash-marking. Reasons map 1:1 with the early-return branches in
 * `attemptResumeMultiAgent`; the WS layer renders them into a user-
 * readable `wrapper_error.message`.
 */
export type ResumeFailureReason =
  | 'tmux-unavailable' // `tmuxAvailable()` returned false
  | 'legacy-row' // pre-006: row missing `tmux_session` or `iteration_id`
  | 'tmux-missing' // `hasSession()` returned false for the row's tmux name
  | 'reattach-failed'; // resume{Chain,Orchestrator}Session returned null

export type ResumeCallbacks = {
  /** Same shape as `StartChainOpts.onEvent`. Used both for live events
   *  picked up by the re-attached tailer AND for replayed history. */
  onEvent: ResumeChainOpts['onEvent'];
  onEnded: ResumeChainOpts['onEnded'];
  /** Called once (at most) when the primary resume candidate can't be
   *  brought back — see `ResumeFailureReason`. Fires only for the
   *  candidate row the operator most likely cares about (the most-
   *  recently-started running row); secondary `running` rows that are
   *  marked crashed under the single-active invariant don't trigger
   *  this. Optional: callers that don't supply it just get the existing
   *  silent crash-mark behavior. */
  onResumeFailed?: (sessionId: string, reason: ResumeFailureReason) => void;
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

  // The most recently started row is the most likely candidate; we
  // resolve it before the tmux-availability check so we can attribute
  // the failure to a specific session id in any onResumeFailed call.
  const candidate = activeRows[0]!;

  if (!(await tmuxAvailable())) {
    // No tmux means nothing is recoverable. Mark all running rows crashed.
    for (const r of activeRows) {
      markCrashedSilent(r.id);
    }
    callbacks.onResumeFailed?.(candidate.id, 'tmux-unavailable');
    return null;
  }

  // Older rows that are still `running` AND still alive in tmux are
  // treated as orphans — we mark them crashed (single-active invariant).
  // No onResumeFailed for these: they're not what the operator's UI was
  // attached to, and emitting per-row would be toast spam.
  for (const r of activeRows.slice(1)) {
    markCrashedSilent(r.id);
  }

  if (!candidate.tmux_session || !candidate.iteration_id) {
    // Pre-006 row, or one that was created without these fields. Can't
    // resume — mark crashed.
    markCrashedSilent(candidate.id);
    callbacks.onResumeFailed?.(candidate.id, 'legacy-row');
    return null;
  }
  if (!(await hasSession(candidate.tmux_session))) {
    markCrashedSilent(candidate.id);
    callbacks.onResumeFailed?.(candidate.id, 'tmux-missing');
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
    callbacks.onResumeFailed?.(candidate.id, 'reattach-failed');
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

/** Why a targeted `resumeMultiAgentTarget` couldn't bring a row back. */
export type TargetResumeFailure =
  | 'not-found' // no DB row for that id
  | 'already-running' // row is already `running` (owned elsewhere / live)
  | 'tmux-missing' // pre-006 row, or tmux not alive
  | 'reattach-failed'; // resume{Chain,Orchestrator}Session returned null

export type TargetResumeResult =
  | { ok: true; resumed: ResumedSession }
  | { ok: false; reason: TargetResumeFailure };

/**
 * Operator-triggered re-attach for ONE specific session (the Iterations
 * "Resume" button). Unlike `attemptResumeMultiAgent` this targets a row by
 * id, only acts on terminal rows whose tmux is still alive, and on failure
 * RESTORES the prior terminal status (so the auto-resume sweep invariant is
 * preserved — no phantom `running` row left behind). Pure re-attach: never
 * spawns tmux/agents.
 */
export async function resumeMultiAgentTarget(
  sessionId: string,
  callbacks: Pick<ResumeCallbacks, 'onEvent' | 'onEnded'>,
): Promise<TargetResumeResult> {
  const row = getMultiAgentSession(sessionId);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.status === 'running') return { ok: false, reason: 'already-running' };
  // Re-validate liveness BEFORE any DB write so a stale list (tmux died
  // between list build and click) leaves the row untouched.
  if (
    !row.tmux_session ||
    !row.iteration_id ||
    !(await tmuxAvailable()) ||
    !(await hasSession(row.tmux_session))
  ) {
    return { ok: false, reason: 'tmux-missing' };
  }

  const prevStatus = row.status as MultiAgentStatus;
  reactivateMultiAgentSession(sessionId);

  let handle: ChainSessionHandle | OrchestratorSessionHandle | null = null;
  try {
    if (row.mode === 'chain') {
      handle = await resumeChainSession({
        sessionId,
        onEvent: callbacks.onEvent,
        onEnded: callbacks.onEnded,
      });
    } else if (row.mode === 'orchestrator') {
      handle = await resumeOrchestratorSession({
        sessionId,
        onEvent: callbacks.onEvent,
        onEnded: callbacks.onEnded,
      });
    }
  } catch (err) {
    console.error(`[resume] targeted resume threw for ${sessionId}`, err);
  }

  if (!handle) {
    // Restore the terminal status we flipped — otherwise a stuck `running`
    // row would be mis-handled by the next `resumeOnConnect` sweep.
    endMultiAgentSession(sessionId, prevStatus);
    return { ok: false, reason: 'reattach-failed' };
  }

  const replayEvents: PersistedEvent[] = listMultiAgentEvents(sessionId).map((r) => ({
    ts: r.ts,
    source: r.source,
    destination: r.destination,
    kind: r.kind,
    text: r.text,
    dbEventId: r.id,
  }));
  return {
    ok: true,
    resumed: { handle, mode: row.mode as 'chain' | 'orchestrator', row, replayEvents },
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
