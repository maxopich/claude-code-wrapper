/**
 * R-B: reconstruct an orchestrated bus session after a Cebab SERVER restart.
 *
 * The pure-SDK bus keeps agent state IN this process (the `AgentRunner` +
 * router closures live in `session_registry`). A server restart empties
 * that registry, so historically a mid-run bus session was simply marked
 * `crashed` (decision R-A). But everything needed to bring an *orchestrated*
 * run back is already durable:
 *
 *   - the roster + folder + iteration → `multi_agent_sessions` /
 *     `listResolvedParticipants`,
 *   - each agent's `--resume` checkpoint → `multi_agent_agent_sessions`
 *     (migration 009),
 *   - the full comm log → `multi_agent_events`.
 *
 * So instead of crashing, we rebuild the runner + router (via the SAME
 * `wireOrchestratorSession` the live path uses — F2/F3 filters preserved by
 * construction), seed each agent's CLI session so its next turn `--resume`s
 * its real transcript, and re-register in the live registry.
 *
 * CONSERVATIVE by design: reconstruction re-attaches the session
 * **read-only**. It sets `awaiting_continue` and delivers NOTHING — an
 * interrupted turn's side effects (files written, commands run) are not
 * rolled back, so the operator must explicitly continue (Phase 3) before any
 * agent runs again. Chain mode is intentionally NOT reconstructed yet
 * (deferred); chain rows still fall back to `crashed`.
 */
import fs from 'node:fs';
import {
  appendMultiAgentEvent,
  listAgentSessions,
  listMultiAgentEvents,
  listResolvedParticipants,
  setAwaitingContinue,
  type MultiAgentLifecycle,
  type MultiAgentSessionRow,
} from '../repo/multi_agent.js';
import { sessionPathsFromFolder } from './paths.js';
import {
  ensureOrchestratorWorkspace,
  ORCHESTRATOR_AGENT_NAME,
  wireOrchestratorSession,
} from './orchestrator.js';
import {
  CEBAB_SOURCE,
  prepareIterationDir,
  USER_RECIPIENT,
  type ResolvedAgent,
} from './runtime.js';
import { hasLiveSession, type BusSink } from './session_registry.js';
import { emit as emitNotification } from '../notifications/dispatcher.js';

/**
 * Persisted, operator-facing notice prepended to the replayed scrollback
 * when a session is recovered. Spells out the conservative contract +
 * the one real hazard (an interrupted turn's side effects are not undone).
 */
export const RECOVERY_BANNER = [
  'Recovered this multi-agent session after a Cebab server restart.',
  '',
  'It is re-attached READ-ONLY: nothing runs until you explicitly continue.',
  'The agent that was mid-turn when the server stopped will pick up from its',
  'last completed step — any file writes or commands from that interrupted',
  'step are NOT rolled back. Review the transcript above before continuing.',
].join('\n');

/** Why a row cannot be reconstructed. All reasons fall back to `crashed`. */
export type NotReconstructable =
  | 'not-orchestrator' // chain mode is deferred (Phase 1 scope)
  | 'no-session-folder' // pre-007 row, no folder anchor
  | 'folder-missing' // temp-cleaned or operator-deleted
  | 'no-iteration' // pre-006 row, no iteration id
  | 'no-agent-sessions' // pre-009 row, no persisted --resume map
  | 'no-participants' // every participant project was deleted
  | 'participant-unresolved'; // a participant row lost its bus_agent_name

export type ReconstructGuard = { ok: true } | { ok: false; reason: NotReconstructable };

/**
 * Cheap, synchronous predicate: can this row be brought back by R-B?
 * Used both as the early bail in `reconstructOrchestratorSession` and by
 * the Iterations UI to decide whether to show a Resume affordance.
 */
export function isReconstructable(row: MultiAgentSessionRow): ReconstructGuard {
  if (row.mode !== 'orchestrator') return { ok: false, reason: 'not-orchestrator' };
  if (!row.session_folder) return { ok: false, reason: 'no-session-folder' };
  if (!fs.existsSync(row.session_folder)) return { ok: false, reason: 'folder-missing' };
  if (!row.iteration_id) return { ok: false, reason: 'no-iteration' };
  if (listAgentSessions(row.id).length === 0) return { ok: false, reason: 'no-agent-sessions' };
  const workers = listResolvedParticipants(row.id).filter((r) => r.role === 'worker');
  if (workers.length === 0) return { ok: false, reason: 'no-participants' };
  if (workers.some((w) => !w.bus_agent_name)) {
    return { ok: false, reason: 'participant-unresolved' };
  }
  return { ok: true };
}

/** Boolean convenience for call sites that don't need the reason. */
export function canReconstruct(row: MultiAgentSessionRow): boolean {
  return isReconstructable(row).ok;
}

/**
 * Rebuild an orchestrated session in-process and register it live, READ-ONLY
 * (sets `awaiting_continue`, delivers nothing). Returns true iff the session
 * is now in the registry (caller re-fetches via `getLiveSession` and
 * re-attaches the WS sink exactly like the browser-refresh path). Returns
 * false on any guard failure or rebuild error → caller falls back to
 * `markCrashedSilent`, i.e. behavior is never worse than R-A.
 */
export function reconstructOrchestratorSession(
  row: MultiAgentSessionRow,
  callbacks: {
    onEvent: BusSink['onEvent'];
    onEnded: BusSink['onEnded'];
    /** Re-resolved hop budget for this session (the WS layer reads from
     *  current settings + env on every reconstruct so a budget change
     *  between runs takes effect on Continue). */
    hopBudget: number;
    /** Item #4: forwarded into the rebuilt router so a failure that
     *  happens AFTER the reconstruct (e.g. on the operator's Continue or
     *  on a subsequent retry) emits the pending-retry ServerMsg to the
     *  re-attached browser. The persisted row's `pending_retry_*` columns
     *  already survived the restart and are hydrated by the WS layer on
     *  `multi_agent_started`, so the initial banner restore does not need
     *  this callback. */
    onPendingRetry?: BusSink['onPendingRetry'];
    /** Item #5: mutation + pending-mutation callbacks forwarded into the
     *  rebuilt router so a mutation observed AFTER the reconstruct (e.g.
     *  the operator's first Continue) emits to the re-attached browser.
     *  Initial state (existing mutations, an already-set pending slot)
     *  hydrates from the DB via the WS layer's `multi_agent_started`
     *  payload. */
    onMutation?: BusSink['onMutation'];
    onPendingMutation?: BusSink['onPendingMutation'];
    /** Cluster A Phase 3 (D4): dispatcher notification fan-out for the
     *  rebuilt router so a router_drop in a reconstructed session reaches
     *  the operator. */
    sendNotification?: BusSink['sendNotification'];
    sendRouterDrop?: BusSink['sendRouterDrop'];
    /** Cluster A Phase 4: generic ServerMsg sender used for the new typed
     *  events + as the dispatcher.emit `send` callback. The
     *  chain-not-reconstructed signal (BE-11) is emitted by the resume
     *  caller before this function would return false; this callback is
     *  threaded through for router-attached dangerous-mutation safety
     *  toasts originating from the rebuilt router. */
    sendServerMsg?: BusSink['sendServerMsg'];
  },
): boolean {
  if (!isReconstructable(row).ok) return false;

  // Idempotent / single-flight: a prior reconnect in this same post-restart
  // process may already have rebuilt it — a second browser is a plain
  // re-attach, not a second rebuild.
  if (hasLiveSession(row.id)) return true;

  const folder = row.session_folder as string;
  const iterationId = row.iteration_id as string;
  const paths = sessionPathsFromFolder(folder);

  try {
    // Idempotent regen so the orchestrator's cwd (CLAUDE.md + comm.md) is
    // valid before its first resumed turn.
    ensureOrchestratorWorkspace(paths.orchestratorWorkspace);
  } catch (err) {
    console.error(`[reconstruct] ensureOrchestratorWorkspace failed for ${row.id}`, err);
    return false;
  }

  const workers: ResolvedAgent[] = listResolvedParticipants(row.id)
    .filter((r) => r.role === 'worker' && r.bus_agent_name)
    .map((r) => ({
      projectId: r.project_id,
      agentName: r.bus_agent_name as string,
      cwd: r.project_path,
      projectName: r.project_name,
    }));

  const seededSessions = listAgentSessions(row.id).map((r) => ({
    agentName: r.agent_name,
    cliSessionId: r.cli_session_id,
  }));

  // A worker is "already briefed" iff it has produced at least one event:
  // to have spoken it must have completed its briefed first turn, so its
  // resumed transcript already contains the briefing. The orchestrator is
  // never briefed (it learns the protocol from its workspace CLAUDE.md).
  const allEvents = listMultiAgentEvents(row.id);
  const workerNameSet = new Set(workers.map((w) => w.agentName));
  const briefedAgents = [
    ...new Set(allEvents.map((e) => e.source).filter((s) => workerNameSet.has(s))),
  ];
  // Seed the router's hop counter from the persisted event count so
  // budget enforcement carries across the restart. Without this, a
  // session that was at 29/30 hops pre-restart would silently re-open
  // the gate to 30 more hops.
  const initialHopsCount = allEvents.length;

  const participantAgentNames = [ORCHESTRATOR_AGENT_NAME, ...workers.map((w) => w.agentName)];
  try {
    prepareIterationDir(iterationId, participantAgentNames, paths);
  } catch (err) {
    console.warn(`[reconstruct] prepareIterationDir failed for ${row.id}`, err);
  }

  try {
    wireOrchestratorSession({
      sessionId: row.id,
      iterationId,
      lifecycle: row.lifecycle as MultiAgentLifecycle,
      paths,
      workers,
      onEvent: callbacks.onEvent,
      onEnded: callbacks.onEnded,
      onPendingRetry: callbacks.onPendingRetry,
      onMutation: callbacks.onMutation,
      onPendingMutation: callbacks.onPendingMutation,
      sendNotification: callbacks.sendNotification,
      sendRouterDrop: callbacks.sendRouterDrop,
      sendServerMsg: callbacks.sendServerMsg,
      seededSessions,
      briefedAgents,
      hopBudget: callbacks.hopBudget,
      initialHopsCount,
      // Item #5: surface the persisted opt-in onto the rebuilt handle so the
      // UI re-attaches with the correct toggle state. The runtime read is
      // always DB-fresh inside `onMutationHook`; this is purely the handle's
      // self-report.
      pauseOnMutation: row.pause_on_mutation === 1,
    });
  } catch (err) {
    console.error(`[reconstruct] wireOrchestratorSession failed for ${row.id}`, err);
    return false;
  }

  // Conservative: paused for operator review. No turn delivered here.
  try {
    setAwaitingContinue(row.id, true);
  } catch (err) {
    console.error(`[reconstruct] setAwaitingContinue failed for ${row.id}`, err);
  }

  // Persist the banner so it replays in scrollback and survives further
  // reconnects (same persistence path as every other bus event).
  try {
    appendMultiAgentEvent(row.id, CEBAB_SOURCE, USER_RECIPIENT, 'intro', RECOVERY_BANNER);
  } catch (err) {
    console.error(`[reconstruct] banner append failed for ${row.id}`, err);
  }

  // Cluster A Phase 6 (D2): typed `session_reconstructed` ServerMsg + a
  // success-info toast. The persisted banner above lands in scrollback for
  // anyone viewing the recovered session; this dock toast reaches the
  // operator wherever they are (different tab, sidebar collapsed). Sticky
  // so a reload still shows it from the inbox replay — operators
  // re-attaching after the restart should see the recovery happened.
  //
  // Best-effort: pre-Phase-6 callers (legacy unit tests) may not wire
  // `sendServerMsg`; in that case the typed event + toast are skipped and
  // the existing scrollback banner is still the source of truth.
  if (callbacks.sendServerMsg) {
    callbacks.sendServerMsg({
      type: 'session_reconstructed',
      sessionId: row.id,
      reasonCode: 'reconstructed',
    });
    const result = emitNotification(
      {
        class: 'operational',
        severity: 'success',
        dedupeKey: `session_reconstructed:${row.id}`,
        title: 'Session recovered',
        message: `Session ${row.id.slice(0, 8)} was rebuilt after a Cebab restart — paused for review.`,
        sessionId: row.id,
        action: { kind: 'resume', sessionId: row.id },
        sticky: true,
        reasonCode: 'reconstructed',
      },
      callbacks.sendServerMsg,
    );
    if (!result.ok) {
      console.error('[reconstruct] session_reconstructed dispatcher.emit failed', result.error);
    }
  }

  return true;
}
