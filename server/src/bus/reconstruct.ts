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
 * agent runs again.
 *
 * `Cebab-2t9.1`: chain mode is now reconstructed too, via
 * `reconstructChainSession` + the extracted `wireChainSession`. It reuses the
 * SAME shared guard (`checkReconstructable`) and the same read-only contract;
 * the only chain-specific differences are that there is no orchestrator
 * workspace and no per-agent mute/kick/pause reseed (chain exposes none of
 * those operator controls). The prerequisite — each participant's `--resume`
 * checkpoint — became durable in PR #261 (`chain.ts`'s `onSessionId`). Continue
 * for a reconstructed chain is a follow-up: a chain handle has no
 * `sendUserPrompt`, so the pipeline cannot yet be resumed past the read-only
 * re-attach.
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
import {
  listActivePauseEntries,
  listKickedAgentNames,
  listMutedAgentNames,
} from '../repo/per_agent_control.js';
import { findLatestControlReason } from '../repo/safety_audit_lookup.js';
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
import { wireChainSession } from './chain.js';
import { getLiveSession, hasLiveSession, type BusSink } from './session_registry.js';
import { emit as emitNotification } from '../notifications/dispatcher.js';
import { executeExpireParticipant } from '../ws/control_verbs.js';
import { getPauseExpiryRegistry } from '../ws/pause_expiry.js';

/**
 * `Cebab-v85`: how many hops has this session already taken, as the ROUTER
 * counts them?
 *
 * WHAT WAS WRONG. Both reconstruct paths seeded the router's enforcement
 * counter with `allEvents.length`, and that is a different quantity from the
 * one the router enforces. Five row classes are persisted directly, bypassing
 * `forwardCebabEvent`, and so never bump `hopsCount` — `onWorkerFailed`'s
 * error row, `checkBudgetExhausted`'s `cebab → _sink` error, chain's terminal
 * explanatory row, the stranded-run note, and the operator's
 * `multi_agent_ask_user_answer` reply. Every one of them is in
 * `multi_agent_events`. So a session that had taken N hops and accumulated C
 * Cebab-authored rows came back from a restart seeded at N+C: the brake
 * adopted, at exactly the moment it was reconstructed, the inflated count the
 * activity bar had been showing all along. A run stopped earlier than its
 * configured budget, and nothing anywhere said why.
 *
 * `hops_used` is now written as the run advances (`recordSessionHops`), so
 * the honest answer is on the row. Prefer it.
 *
 * THE FALLBACK IS DELIBERATELY THE OLD, WRONG NUMBER. Rows that were live
 * before this shipped have `hops_used = NULL` — the column was teardown-only
 * — and there is no way to recover the router's count for them, because the
 * bypassing rows are indistinguishable from counted ones after the fact
 * (`source = 'cebab'` is true of counted rows too; `forwardCebabEvent` writes
 * them). Between two wrong answers for those rows, take the LARGER: it
 * under-grants budget, which stops a run early, rather than over-granting and
 * letting a restart extend a run past the cap the operator set. Fail toward
 * the smaller blast radius.
 */
export function resolveInitialHopsCount(
  persistedHopsUsed: number | null | undefined,
  eventRowCount: number,
): number {
  return typeof persistedHopsUsed === 'number' && Number.isFinite(persistedHopsUsed)
    ? persistedHopsUsed
    : eventRowCount;
}

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
  | 'unknown-mode' // a mode neither reconstruct path handles (defensive)
  | 'no-session-folder' // pre-007 row, no folder anchor
  | 'folder-missing' // temp-cleaned or operator-deleted
  | 'no-iteration' // pre-006 row, no iteration id
  | 'no-agent-sessions' // pre-009 row, no persisted --resume map
  | 'no-participants' // every participant project was deleted
  | 'participant-unresolved'; // a participant row lost its bus_agent_name

export type ReconstructGuard = { ok: true } | { ok: false; reason: NotReconstructable };

/**
 * Cheap, synchronous CHECK: can this row be brought back by R-B, and if not,
 * why? Used as the early bail in `reconstructOrchestratorSession` and by the
 * Iterations UI to decide whether to show a Resume affordance.
 *
 * Register N01: this was named with an `is` prefix and documented as a
 * "predicate" while returning a `ReconstructGuard`. That combination is a trap
 * the compiler cannot spring — `if (<the old name>(row))` is legal TypeScript
 * and is ALWAYS TRUE, because the failure case is a truthy object. Every call
 * site happened to read `.ok`, so nothing was broken; the name was one
 * distracted edit away from a silent bug.
 *
 * `check` prefix, not `is`, because the return type is the reason — see
 * `canReconstruct` below for the boolean, which already existed. Of the 33
 * exported `is*`/`has*`/`can*`/`should*` functions in this repo, this was the
 * only one that did not return a boolean or a type predicate;
 * `scripts/predicateReturns.test.mjs` now keeps it that way.
 */
export function checkReconstructable(row: MultiAgentSessionRow): ReconstructGuard {
  // `Cebab-2t9.1`: the durable-state preconditions below are mode-agnostic —
  // both `orchestrator` and `chain` are reconstructable now. The mode-specific
  // wiring is chosen by the caller (`reconstructOrchestratorSession` /
  // `reconstructChainSession`), each of which asserts its own mode; this shared
  // guard only answers "is the durable state present to rebuild ANY run?".
  if (row.mode !== 'orchestrator' && row.mode !== 'chain') {
    return { ok: false, reason: 'unknown-mode' };
  }
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
  return checkReconstructable(row).ok;
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
    /** `Cebab-vie.17`: re-resolved per-hop turn cap, read fresh for the same
     *  reason `hopBudget` is — a Settings change between runs takes effect on
     *  Continue. Required here (unlike on the routers' start opts) so the
     *  compiler is the gate on every resume seam. */
    maxTurns: number;
    /** Item #4: forwarded into the rebuilt router so a failure that
     *  happens AFTER the reconstruct (e.g. on the operator's Continue or
     *  on a subsequent retry) emits the pending-retry ServerMsg to the
     *  re-attached browser. The persisted `multi_agent_pending_retries` rows
     *  already survived the restart and are hydrated (front slot) by the WS
     *  layer on `multi_agent_started`, so the initial banner restore does not
     *  need this callback. */
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
  // `Cebab-2t9.1`: the shared guard is now mode-agnostic, so this function has
  // to reject a chain row itself — wiring one through `wireOrchestratorSession`
  // would rebuild it with an orchestrator (which a chain run has no participant
  // for) and the wrong routing filters. `reconstructChainSession` is its twin.
  if (row.mode !== 'orchestrator') return false;
  if (!checkReconstructable(row).ok) return false;

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
  //
  // DELIBERATELY UNBOUNDED (`Cebab-3nt`), unlike the session-log projector
  // which now pages. A cap here would silently narrow the set of agents this
  // reconstruction believes have been briefed: an agent whose only event fell
  // outside the cap would be re-briefed after a restart, mid-task. The
  // question this asks is "has this agent EVER spoken", so it needs every row.
  const allEvents = listMultiAgentEvents(row.id);
  const workerNameSet = new Set(workers.map((w) => w.agentName));
  const briefedAgents = [
    ...new Set(allEvents.map((e) => e.source).filter((s) => workerNameSet.has(s))),
  ];
  // Seed the router's hop counter so budget enforcement carries across the
  // restart. Without this, a session that was at 29/30 hops pre-restart would
  // silently re-open the gate to 30 more hops. `Cebab-v85`: the seed is the
  // PERSISTED counter, not the event-row count — see `resolveInitialHopsCount`
  // for why those two differ and why the fallback is the larger of them.
  const initialHopsCount = resolveInitialHopsCount(row.hops_used, allEvents.length);

  const participantAgentNames = [ORCHESTRATOR_AGENT_NAME, ...workers.map((w) => w.agentName)];
  try {
    prepareIterationDir(iterationId, participantAgentNames, paths);
  } catch (err) {
    console.warn(`[reconstruct] prepareIterationDir failed for ${row.id}`, err);
  }

  // Cluster C Phase 4e: R-B reseed of per-agent control state. Mute +
  // kick are pure router-set membership — read durable rows and seed
  // the rebuilt router so the very first event after restart respects
  // the operator's standing mutes/kicks. Without this, a muted worker
  // could emit one event through the rebuilt router before the
  // operator's next interaction re-applied the mute.
  //
  // Defensive: a missing bus_agent_name for a participant is filtered
  // out at the repo layer (the slugs are the router's keys; a NULL
  // slug means the project's bus install was missing). Such
  // participants stay un-seeded; the operator's next action surfaces
  // the divergence.
  const initialMutedAgents = listMutedAgentNames(row.id);
  const initialKickedAgents = listKickedAgentNames(row.id);

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
      maxTurns: callbacks.maxTurns,
      initialHopsCount,
      // Item #5: surface the persisted opt-in onto the rebuilt handle so the
      // UI re-attaches with the correct toggle state. The runtime read is
      // always DB-fresh inside `onMutationHook`; this is purely the handle's
      // self-report.
      pauseOnDangerous: row.pause_on_dangerous === 1,
      // Re-seed execute mode from the persisted row so a worker briefed for the
      // first time after the restart gets the same execute/consultant clause
      // the session started with.
      executeMode: row.execute_mode === 1,
      // Phase 4e: forward mute + kick seeds into the rebuilt router.
      initialMutedAgents,
      initialKickedAgents,
    });
  } catch (err) {
    console.error(`[reconstruct] wireOrchestratorSession failed for ${row.id}`, err);
    return false;
  }

  // Cluster C Phase 4e: reschedule pause expiry timers for every
  // currently-paused participant. Reseed after the session is wired so
  // the timer's fire callback has a live handle to consult via
  // `getLiveSession` at fire time (the handle wasn't in the registry
  // yet at the start of this function).
  //
  // The original pause's `reasonCode` + `reasonText` weren't persisted
  // on the participant row — they live in safety_audit. Query
  // `findLatestControlReason` to recover them; if the audit row is
  // missing (corrupted DB or a participant that was paused via a
  // raw-SQL backdoor that skipped the audit dual-write), fall back to
  // `topology_repair` so the timer still fires + write a warn log so
  // the divergence is auditable.
  //
  // A non-positive remaining delay (the deadline already elapsed
  // during downtime) fires the timer synchronously on the next tick —
  // the executor's defensive re-check catches diverged states and
  // no-ops cleanly.
  const activePauses = listActivePauseEntries(row.id);
  // Register B04: reinstall the RUNNER gates, not just the timers. Mute and
  // kick are router-set membership and were reseeded via the factory params
  // above, but a pause is an `AgentRunner` turn-queue gate — in-memory, and
  // gone with the old process. Reseeding only the timers left the operator
  // looking at a paused worker with a live countdown whose next delegation
  // would be delivered normally.
  //
  // Post-wire rather than a factory param: the gate lives in the runner, not
  // the router, and reconstruct sets `awaiting_continue` and delivers no turn
  // — so unlike the mute/kick reseed there is no window to close between
  // wiring and the first event.
  const rebuilt = getLiveSession(row.id);
  const pauseGateHandle =
    rebuilt?.mode === 'orchestrator'
      ? (rebuilt.handle as unknown as { pauseAgent: (agentName: string) => boolean })
      : undefined;
  for (const pauseEntry of activePauses) {
    if (!pauseGateHandle?.pauseAgent(pauseEntry.agentName)) {
      // Loud: an un-gated worker that the UI reports as paused is exactly
      // the bug this reseed exists to prevent.
      console.warn(
        `[reconstruct] could not reinstall pause gate for ${row.id}/${pauseEntry.agentName}; it is shown paused but its turns are NOT held`,
      );
    }
    const recovered = findLatestControlReason(row.id, pauseEntry.projectId, 'agent_control.paused');
    if (!recovered) {
      console.warn(
        `[reconstruct] no audit row found for paused participant ${row.id}/${pauseEntry.projectId} (${pauseEntry.agentName}); using fallback reasonCode='topology_repair'`,
      );
    }
    const reasonCode = recovered?.reasonCode ?? 'topology_repair';
    const reasonText = recovered?.reasonText ?? null;
    const sessionIdAtSchedule = row.id;
    getPauseExpiryRegistry().schedule(
      {
        sessionId: sessionIdAtSchedule,
        projectId: pauseEntry.projectId,
        agentName: pauseEntry.agentName,
        pausedUntil: pauseEntry.pausedUntil,
        expiryAction: pauseEntry.pauseExpiryAction,
        reasonCode,
        reasonText,
      },
      (entry) => {
        // Fire-time orchestrator handle: look up the current live
        // session from the registry rather than capturing at schedule
        // time. The handle instance is created by
        // `wireOrchestratorSession` above and stays put across R-A
        // re-attaches; we use the structural typing of
        // `executeExpireParticipant`'s `orchestratorHandle` param so
        // we don't need to import the full `OrchestratorSessionHandle`
        // type here.
        const live = getLiveSession(entry.sessionId);
        const handle =
          live?.mode === 'orchestrator'
            ? (live.handle as unknown as {
                resumeAgent: (agentName: string) => boolean;
                kickAgent: (agentName: string) => boolean;
              })
            : undefined;
        const result = executeExpireParticipant({
          entry,
          orchestratorHandle: handle,
        });
        if (!result.ok) {
          console.error(
            `[reconstruct] reseeded pause-expiry executor failed for ${entry.sessionId}/${entry.projectId}`,
            result.error,
          );
        }
        // No ServerMsg emit on the reseeded path — the durable state
        // (DB + audit) is the trail. A connected operator sees the
        // updated state on their next interaction; future R-A
        // attach-time snapshot push (C4g+ when the reducer tracks
        // control state) will make this transparent.
      },
    );
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

/**
 * `Cebab-2t9.1`: rebuild a CHAIN session in-process and register it live,
 * READ-ONLY — the chain twin of `reconstructOrchestratorSession`. Returns true
 * iff the session is now in the registry (caller re-fetches via
 * `getLiveSession` and re-attaches its WS sink exactly like the orchestrator
 * path). Returns false on any guard failure or rebuild error → caller falls
 * back to `markCrashedSilent`, i.e. behavior is never worse than R-A.
 *
 * Simpler than the orchestrator path in two ways, both because chain exposes no
 * per-agent operator controls: there is no orchestrator workspace to
 * regenerate, and no mute / kick / pause-expiry reseed. The one hold chain does
 * have — a pause-on-dangerous mutation hold — is reseeded inside
 * `wireChainSession` (`listPendingMutations` → `runner.holdForMutation`), the
 * same shared path a fresh start takes.
 */
export function reconstructChainSession(
  row: MultiAgentSessionRow,
  callbacks: {
    onEvent: BusSink['onEvent'];
    onEnded: BusSink['onEnded'];
    /** Re-resolved hop budget for this session (read fresh from settings + env
     *  on every reconstruct so a budget change between runs takes effect on
     *  Continue). */
    hopBudget: number;
    /** `Cebab-vie.17`: re-resolved per-hop turn cap, read fresh for the same
     *  reason `hopBudget` is. */
    maxTurns: number;
    onPendingRetry?: BusSink['onPendingRetry'];
    onMutation?: BusSink['onMutation'];
    onPendingMutation?: BusSink['onPendingMutation'];
    sendNotification?: BusSink['sendNotification'];
    sendRouterDrop?: BusSink['sendRouterDrop'];
    sendServerMsg?: BusSink['sendServerMsg'];
  },
): boolean {
  // Twin of `reconstructOrchestratorSession`'s mode assertion: the shared guard
  // is mode-agnostic, so this function refuses anything but a chain row.
  if (row.mode !== 'chain') return false;
  if (!checkReconstructable(row).ok) return false;

  // Idempotent / single-flight: a prior reconnect in this same post-restart
  // process may already have rebuilt it — a second browser is a plain
  // re-attach, not a second rebuild.
  if (hasLiveSession(row.id)) return true;

  const folder = row.session_folder as string;
  const iterationId = row.iteration_id as string;
  const paths = sessionPathsFromFolder(folder);

  // Participants in CHAIN ORDER — `listResolvedParticipants` orders by
  // `chain_order`, which is exactly the pipeline position, so the rebuilt
  // `nextHops` / terminal-agent entitlement match the original run. A NULL
  // `bus_agent_name` was already rejected by the shared guard.
  const participants: ResolvedAgent[] = listResolvedParticipants(row.id)
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

  // A participant is "already briefed" iff it has produced at least one event:
  // to have spoken it must have completed its briefed first turn, so its
  // resumed transcript already contains the briefing. Same DELIBERATELY
  // UNBOUNDED reasoning as the orchestrator path (`Cebab-3nt`): the question is
  // "has this agent EVER spoken", so it needs every row.
  const allEvents = listMultiAgentEvents(row.id);
  const participantNameSet = new Set(participants.map((part) => part.agentName));
  const briefedAgents = [
    ...new Set(allEvents.map((e) => e.source).filter((s) => participantNameSet.has(s))),
  ];
  // Seed the router's hop counter so budget enforcement carries across the
  // restart — without this a session at 29/30 hops pre-restart would silently
  // re-open the gate to 30 more. `Cebab-v85`: the seed is the PERSISTED
  // counter, not the event-row count — see `resolveInitialHopsCount`.
  const initialHopsCount = resolveInitialHopsCount(row.hops_used, allEvents.length);

  try {
    prepareIterationDir(iterationId, [...participantNameSet], paths);
  } catch (err) {
    console.warn(`[reconstruct] prepareIterationDir failed for ${row.id}`, err);
  }

  try {
    wireChainSession({
      sessionId: row.id,
      iterationId,
      lifecycle: row.lifecycle as MultiAgentLifecycle,
      paths,
      participants,
      // NO initialPrompt → READ-ONLY: nothing is delivered until the operator
      // continues (the conservative R-B contract).
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
      maxTurns: callbacks.maxTurns,
      initialHopsCount,
      pauseOnDangerous: row.pause_on_dangerous === 1,
    });
  } catch (err) {
    console.error(`[reconstruct] wireChainSession failed for ${row.id}`, err);
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

  // Typed `session_reconstructed` ServerMsg + a success toast — identical to
  // the orchestrator path so the operator dock treats a recovered chain run
  // the same. Best-effort: legacy callers may not wire `sendServerMsg`.
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
