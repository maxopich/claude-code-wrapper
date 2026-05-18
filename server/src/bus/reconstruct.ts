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
  callbacks: { onEvent: BusSink['onEvent']; onEnded: BusSink['onEnded'] },
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
  const workerNameSet = new Set(workers.map((w) => w.agentName));
  const briefedAgents = [
    ...new Set(
      listMultiAgentEvents(row.id)
        .map((e) => e.source)
        .filter((s) => workerNameSet.has(s)),
    ),
  ];

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
      seededSessions,
      briefedAgents,
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

  return true;
}
