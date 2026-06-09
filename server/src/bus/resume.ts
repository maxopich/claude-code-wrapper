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
import { emit as emitNotification } from '../notifications/dispatcher.js';

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
  /** Item #5: pause-on-dangerous slot set/clear for AFTER-reconstruct.
   *  Initial pending value ships on `multi_agent_started.pendingMutation`. */
  onPendingMutation?: BusSink['onPendingMutation'];
  /** Cluster A Phase 3 (D4): dispatcher notification fan-out for router
   *  drops in a reconstructed (R-B) or re-attached session. */
  sendNotification?: BusSink['sendNotification'];
  /** Cluster A Phase 3 (D4): typed router_drop fan-out. */
  sendRouterDrop?: BusSink['sendRouterDrop'];
  /** Cluster A Phase 4: generic ServerMsg sender. Used for the new typed
   *  events (`session_superseded`, `chain_not_reconstructed`,
   *  `bus_auto_installed`, dangerous-mutation safety toasts) and as the
   *  dispatcher.emit `send` callback (notification envelopes). */
  sendServerMsg?: BusSink['sendServerMsg'];
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
  // Single-active invariant: any older running rows are orphans. Phase 4
  // (D3): the older rows are SUPERSEDED by the candidate; surface that as
  // a typed `session_superseded` ServerMsg + warn-tier dock toast with a
  // "Reopen" CTA so the operator can recover (UX-6). The orphan row is
  // still marked `crashed` (same as the pre-Phase 4 silent sweep) — the
  // notification is additive, not a state change.
  for (const r of activeRows.slice(1)) {
    markCrashedAndAnnounceSuperseded(r.id, candidate.id, candidate.started_at, callbacks);
  }

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
        sendNotification: callbacks.sendNotification,
        sendRouterDrop: callbacks.sendRouterDrop,
        sendServerMsg: callbacks.sendServerMsg,
      })
    ) {
      live = getLiveSession(candidate.id);
    }
  }
  if (!live) {
    // Phase 4 (BE-11): chain mode reconstruction is deferred — surface that
    // BEFORE the crashed marker ships so the operator dock sees the
    // typed event ahead of `multi_agent_ended { reason: 'crashed' }`.
    // The check is intentionally narrow to chain mode; other bail reasons
    // (folder-missing, no-iteration, pre-007 row) stay silent for now and
    // are subsumed by Cluster D's wider session-recovery surface.
    if (candidate.mode === 'chain') {
      announceChainNotReconstructed(candidate.id, callbacks);
    }
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
    sendNotification: callbacks.sendNotification,
    sendRouterDrop: callbacks.sendRouterDrop,
    sendServerMsg: callbacks.sendServerMsg,
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
    | 'onEvent'
    | 'onEnded'
    | 'hopBudget'
    | 'onPendingRetry'
    | 'onMutation'
    | 'onPendingMutation'
    | 'sendNotification'
    | 'sendRouterDrop'
    | 'sendServerMsg'
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
        sendNotification: callbacks.sendNotification,
        sendRouterDrop: callbacks.sendRouterDrop,
        sendServerMsg: callbacks.sendServerMsg,
      })
    ) {
      live = getLiveSession(sessionId);
    }
  }
  if (!live) {
    // Phase 4 (BE-11): chain reconstruction deferred — surface as a typed
    // event + warn toast BEFORE the operator gets the generic 'reattach
    // failed' reply. Mirror of the auto-resume path above.
    if (row.mode === 'chain') {
      announceChainNotReconstructed(sessionId, callbacks);
    }
    return { ok: false, reason: 'reattach-failed' };
  }

  const prevStatus = row.status as MultiAgentStatus;
  reactivateMultiAgentSession(sessionId);
  try {
    live.rebind({
      onEvent: callbacks.onEvent,
      onEnded: callbacks.onEnded,
      onPendingRetry: callbacks.onPendingRetry,
      onMutation: callbacks.onMutation,
      onPendingMutation: callbacks.onPendingMutation,
      sendNotification: callbacks.sendNotification,
      sendRouterDrop: callbacks.sendRouterDrop,
      sendServerMsg: callbacks.sendServerMsg,
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

/**
 * Cluster A Phase 4 (D3): mark an older `running` row crashed AND announce
 * it to the operator as `session_superseded`. Inverts the silent sweep
 * `markCrashedSilent` used to do at the same site. The typed wire event +
 * warn-tier toast carry the SUPERSEDING session's id/ts so the dock CTA can
 * disambiguate "reopen this one" from "reopen any prior crash". Failure to
 * persist the crash state still logs (matches `markCrashedSilent`); the
 * notification is best-effort.
 */
function markCrashedAndAnnounceSuperseded(
  orphanSessionId: string,
  supersedingSessionId: string,
  supersedingTs: number,
  callbacks: ResumeCallbacks,
): void {
  // Step 1: state change (unchanged from `markCrashedSilent`). If this
  // fails we still try to ship the notification so the operator at least
  // sees that something supplanted the orphan row — but log loudly so the
  // db error doesn't get masked by the toast.
  try {
    endMultiAgentSession(orphanSessionId, 'crashed');
  } catch (err) {
    console.error(`[resume] failed to mark ${orphanSessionId} crashed (supersede)`, err);
  }

  // Step 2: typed ServerMsg for downstream consumers (Cluster D iterations
  // panel + future inspector). Optional callback — pre-Phase-4 callers
  // (tests, smokes) may not wire it.
  callbacks.sendServerMsg?.({
    type: 'session_superseded',
    sessionId: orphanSessionId,
    supersedingSessionId,
    supersedingTs,
  });

  // Step 3: operator-facing toast via the dispatcher. Operational warn
  // tier, dedupeKey scoped to the orphan id so a duplicate emit (rare —
  // would require another `attemptResumeMultiAgent` to find the same
  // orphan still in activeRows, which it wouldn't after the crash mark)
  // collapses. Sticky=true so a reload still shows it from the inbox
  // replay (the dispatcher persists sticky operational per BE-4).
  //
  // Cluster D Phase 5: the action is `archive` (one-click acknowledge
  // that removes the row from the iterations list) rather than the
  // spec's eventual `reopen` (workspace-diff modal, BE-D19/BE-D21).
  // Reopen requires the confirmation modal + typed "reopen" gate that
  // Phase 5b adds; until then a `reopen` button on this toast would be
  // a dead-end. Archive is the strictly-safer default per the spec's
  // risk-graded ordering (`Archive primary` in §6.5), so making it the
  // toast's single-action choice is a clean partial implementation
  // rather than a regression.
  if (callbacks.sendServerMsg) {
    const result = emitNotification(
      {
        class: 'operational',
        severity: 'warn',
        dedupeKey: `session_superseded:${orphanSessionId}`,
        title: 'A prior session was superseded',
        message: `Session ${orphanSessionId.slice(0, 8)} was marked crashed because a newer iteration started.`,
        sessionId: orphanSessionId,
        action: { kind: 'archive', sessionId: orphanSessionId },
        sticky: true,
        // Cluster A Phase 6: §7 floor sub-code label so the inbox panel's
        // SessionRecoveredReasonCode filter chip can group this row with
        // `reconstructed` / `reconstruction_failed`. Same semantic as the
        // spec's `swept_competing` — the older row was crashed because a
        // newer iteration took over the single-active slot.
        reasonCode: 'swept_competing',
      },
      callbacks.sendServerMsg,
    );
    if (!result.ok) {
      console.error('[resume] session_superseded dispatcher.emit failed', result.error);
    }
  }
}

/**
 * Cluster A Phase 4 (D2 precursor, BE-11): emit `chain_not_reconstructed`
 * BEFORE the operator receives the `multi_agent_ended { reason: 'crashed' }`
 * for a chain-mode session that couldn't be brought back across a server
 * restart. Chain R-B is intentionally deferred — Cluster D's wider
 * session-recovery surface will replace this with a proper recovery flow;
 * Phase 4 just stops the silence.
 *
 * Cluster D Phase 7: attach an `archive` action to the toast so the
 * operator has a one-click path out of the dead chain iteration.
 * Mirrors the swept-session toast pattern (Phase 5) — same
 * NotificationAction discriminant, same App.tsx routing through
 * `wsRef.send({type:'archive_session', ...})`. Without this, the
 * operator's only recourse was to dismiss the toast and let the orphan
 * chain row clutter the Iterations list.
 *
 * Why not a Reopen action: Phase 5c's ReopenSessionModal flow returns
 * `chain_reconstruction_unsupported` for chain mode (surfaced as a
 * tailored failed-state in the modal). Offering Reopen here too would
 * just route to the same failure path with extra clicks. Archive is
 * the only honest action today; the forensics record (recovery_log
 * row) lands when the operator clicks it, with `failureClass:
 * 'chain_crash'` so spec §8.5's aggregateByClass tallies chain crashes
 * separately from sweep-driven archives. See the mode-aware switch
 * in `executeArchiveSession` (server/src/ws/server.ts).
 */
function announceChainNotReconstructed(
  sessionId: string,
  callbacks: ResumeCallbacks | Pick<ResumeCallbacks, 'sendServerMsg' | 'sendNotification'>,
): void {
  // Typed wire event for the iterations panel / inspector. Skipped if the
  // caller didn't supply the generic sender (legacy unit tests).
  callbacks.sendServerMsg?.({
    type: 'chain_not_reconstructed',
    sessionId,
    reason: 'chain mode reconstruction is not implemented (R-B covers orchestrator only)',
  });

  if (callbacks.sendServerMsg) {
    const result = emitNotification(
      {
        class: 'operational',
        severity: 'warn',
        dedupeKey: `chain_not_reconstructed:${sessionId}`,
        title: 'Chain session could not be resumed',
        message: `Session ${sessionId.slice(0, 8)} ran in chain mode; chain reconstruction is not yet supported across server restarts. Archive to clear it from the Iterations list.`,
        sessionId,
        sticky: true,
        action: { kind: 'archive', sessionId },
      },
      callbacks.sendServerMsg,
    );
    if (!result.ok) {
      console.error('[resume] chain_not_reconstructed dispatcher.emit failed', result.error);
    }
  }
}

export { getMultiAgentSession, getActiveMultiAgentSession };
