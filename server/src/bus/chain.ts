/**
 * Fixed-chain (Pattern B) orchestrator — pure-SDK runtime.
 *
 * A chain is N participants in a fixed pipeline. Each participant is an
 * in-process SDK `query()` driven by the shared `AgentRunner` (no tmux, no
 * TUI, no bash scripts, no Stop hook, no file IPC). The routing brain
 * (`createChainRouter`) is unchanged in spirit from the tmux version — same
 * persist → forward → archive → terminate logic, same F2/F3 drop filters —
 * but its I/O boundary changed:
 *
 *   - input  : `handleEvent(BusEvent)` is called in-process by the agent's
 *               `bus_send` tool (was: a bus.log tailer line).
 *   - "wake" : `deliver(dest, text)` runs the destination's next turn via the
 *               AgentRunner (was: `tmux send-keys`). Each participant's FIRST
 *               turn is prefixed once with its briefing (the tmux model put
 *               the briefing in the inbox; here it rides the first prompt).
 *
 * Lifecycle of one chain run:
 *   1. Validate participants (≥2) + workspace root.
 *   2. Create the DB session + participant rows; allocate iterations/NNN/.
 *   3. Build the router + AgentRunner; register the live session so a
 *      browser reconnect can re-attach (the in-process analogue of the old
 *      tmux-survives-restart property — see session_registry.ts).
 *   4. Forward each briefing + the initial prompt as `source=cebab` events
 *      (UI scrollback + DB parity), then deliver the initial prompt to
 *      participant[0] (briefing-prefixed).
 *   5. On each `bus_send`: persist → forward → archive the source's hop →
 *      wake the destination. `_sink` ends the chain (write final.md,
 *      teardown 'completed'). `dest=user` is never legitimate in chain mode.
 *
 * Resume: a still-live session is re-attached from the in-process registry
 * on browser reconnect. After a Cebab *server* restart the registry is empty
 * → `resumeChainSession` returns null and the WS layer marks the row
 * crashed. Chain-mode reconstruction is intentionally out of scope, so a
 * chain run still does NOT survive a server restart (the old R-A behavior);
 * orchestrated runs do (R-B, see `reconstruct.ts`). Single-agent resume is
 * unaffected; that is a different path.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  appendMultiAgentEvent,
  appendMultiAgentMutation,
  addParticipant,
  confirmMutationByToolUseId,
  createMultiAgentSession,
  endMultiAgentSession,
  getMultiAgentSession,
  getPendingMutation,
  getPendingRetry,
  recordSessionTeardown,
  setAwaitingContinue,
  setMutationsAcknowledged,
  setMutationPromoted,
  setPauseOnMutation,
  setPendingMutation,
  setPendingRetry,
  type EventKind,
  type MultiAgentLifecycle,
  type MutationRecord,
} from '../repo/multi_agent.js';
import { classifyArtifact } from '@cebab/shared';
import type {
  NotificationEnvelope,
  PendingRetryDescriptor,
  RouterDropReasonCode,
} from '@cebab/shared/protocol';
import { emit as emitNotification } from '../notifications/dispatcher.js';
import { appendRecoveryLog } from '../repo/recovery_log.js';
import { PausedForMutationError, isPausedForMutation } from './errors.js';
import {
  archiveAgentHop,
  CEBAB_SOURCE,
  nextIterationId,
  prepareIterationDir,
  readProjectClaudeMd,
  renderChainBriefing,
  resolveAgent,
  SINK_RECIPIENT,
  USER_RECIPIENT,
  type MultiAgentEndedReason,
  type ProjectRules,
  type ResolvedAgent,
} from './runtime.js';
import { AgentRunner, type AgentRunnerDeps, type BusEvent } from './runner.js';
import { createAgentActivityObserver, type ActivitySnapshot } from './activity.js';
import { DEFAULT_HOP_BUDGET } from './orchestrator.js';
import { uninstallBusForProject } from './install.js';
import { computeSessionPaths, type SessionPaths } from './paths.js';
import {
  getLiveSession,
  NOOP_SINK,
  registerLiveSession,
  unregisterLiveSession,
  type BusSink,
} from './session_registry.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type StartChainOpts = {
  participants: ResolvedAgent[];
  initialPrompt: string;
  workspaceRoot: string;
  lifecycle?: MultiAgentLifecycle;
  /** Per-event callback → `multi_agent_event` ServerMsg. `sessionId` is
   *  passed explicitly so callbacks firing during the awaited start (the
   *  first turn) still address the right session. */
  onEvent: (sessionId: string, ev: BusEvent, dbEventId: number) => void;
  onEnded: (sessionId: string, reason: MultiAgentEndedReason, iterationId: string | null) => void;
  /** Injectable for tests; threaded into the AgentRunner. Defaults to the
   *  real (mock-aware) `pickRunner` when omitted. */
  runnerFactory?: AgentRunnerDeps['runnerFactory'];
  /** Ephemeral per-turn liveness tick → `agent_activity` ServerMsg.
   *  `sessionId` is explicit (same convention as `onEvent`) so ticks
   *  emitted during the awaited first turn still address the right
   *  session. Optional: unit tests omit it. */
  onActivity?: (sessionId: string, snap: ActivitySnapshot) => void;
  /** Hard cap on total persisted hops (cumulative `multi_agent_events`
   *  rows) for this session. When reached, the router persists a synthetic
   *  `cebab → _sink kind=error` event explaining the stop and tears down
   *  with `reason='stopped'`. Caller resolves precedence (DB setting >
   *  `CEBAB_HOP_BUDGET` env > `DEFAULT_HOP_BUDGET`); omit to use the
   *  default. */
  hopBudget?: number;
  /** Per-session pending-retry slot change → `multi_agent_pending_retry`
   *  ServerMsg. `pending: null` clears (after a successful retry or an
   *  abandon); a descriptor sets/replaces. Optional so tests can skip it;
   *  the router null-checks before invoking. */
  onPendingRetry?: (sessionId: string, pending: PendingRetryDescriptor | null) => void;
  /** Item #5: opt-in pause-on-first-mutation (see orchestrator.ts for the
   *  full docstring; same semantics in chain mode). Default false. */
  pauseOnMutation?: boolean;
  /** Item #5: per-mutation hook → `multi_agent_mutation` ServerMsg. */
  onMutation?: (sessionId: string, mutation: MutationRecord) => void;
  /** Item #5: per-session pending-mutation slot change → `multi_agent_pending_mutation`. */
  onPendingMutation?: (sessionId: string, pending: MutationRecord | null) => void;
  /** Cluster A Phase 3 (D4): dispatcher notification fan-out. */
  sendNotification?: BusSink['sendNotification'];
  /** Cluster A Phase 3 (D4): typed router_drop fan-out. */
  sendRouterDrop?: BusSink['sendRouterDrop'];
  /** Cluster A Phase 4: generic ServerMsg sender (dangerous-mutation safety
   *  toast + dispatcher.emit fan-out for chain runs). */
  sendServerMsg?: BusSink['sendServerMsg'];
  /** PR-7: the saved-template id this run was started from, if any. Stamped
   *  onto the row so the templates UI's "Last run" rail can SELECT by
   *  template later. Absent for ad-hoc runs. */
  templateId?: string;
};

export type ResumeChainOpts = {
  sessionId: string;
  onEvent: StartChainOpts['onEvent'];
  onEnded: StartChainOpts['onEnded'];
  /** Cluster A Phase 3: rebind sink callbacks on reconnect. */
  sendNotification?: BusSink['sendNotification'];
  sendRouterDrop?: BusSink['sendRouterDrop'];
  /** Cluster A Phase 4: generic ServerMsg sender for the rebound chain sink. */
  sendServerMsg?: BusSink['sendServerMsg'];
};

export type ChainSessionHandle = {
  sessionId: string;
  iterationId: string;
  participantAgentNames: string[];
  lifecycle: MultiAgentLifecycle;
  sessionFolder: string;
  /** Resolved hop budget for this session (caller-provided or default).
   *  Surfaced on the handle so the WS layer can put it on the wire in
   *  `multi_agent_started`; the UI reads `events.length / hopBudget` for
   *  the activity-bar chip. */
  hopBudget: number;
  /** Item #5: resolved pause-on-first-mutation flag for this session. */
  pauseOnMutation: boolean;
  /** Stop the session and tear it down. Idempotent. */
  stop: (reason: MultiAgentEndedReason) => Promise<void>;
  /** Detach the WS sink without tearing down — agents keep running
   *  in-process; a reconnect re-attaches via the session registry. */
  detach: () => void;
  /** Re-deliver the captured prompt of the worker named in this session's
   *  pending-retry slot. No-op when the slot is empty (idempotent). The
   *  slot is cleared BEFORE re-delivery so a racing second click sees the
   *  cleared slot. A re-fail re-asserts the slot with a fresh reason. */
  retry: () => Promise<void>;
  /** Item #5: operator clicked Continue on the pause-on-first-mutation
   *  banner. Clears the slot, sets `mutations_acknowledged=1`, re-delivers
   *  the paused worker's last captured prompt. No-op when no pause active. */
  continueThroughMutation: () => Promise<void>;
};

type ChainRouter = {
  teardown: (reason: MultiAgentEndedReason) => Promise<void>;
  handleEvent: (ev: BusEvent) => void;
  forwardCebabEvent: (ev: BusEvent) => void;
  detach: () => void;
  rebind: (sink: BusSink) => void;
  /** Called from the `deliver` .catch handler when a worker's `deliverTurn`
   *  rejects (iterator throw OR non-success `result.subtype` — the runner
   *  unifies both into a thrown error). Persists a synthetic
   *  `cebab → user kind=error` event, writes the pending-retry slot, and
   *  emits `onPendingRetry`. Does NOT teardown — the session stays
   *  `running` waiting for the operator's Retry or Abandon click. */
  onWorkerFailed: (agentName: string, prompt: string, err: unknown) => void;
};

/**
 * Build the chain event router. Pure routing/persistence logic — does NOT
 * own the AgentRunner, so the security tests can construct it standalone
 * and exercise the drop filters without spawning anything. `deliver` is the
 * injected "wake" primitive (AgentRunner-backed at runtime; omitted in unit
 * tests, which only drive drop paths).
 */
export function createChainRouter(params: {
  sessionId: string;
  iterationId: string;
  agentNames: string[];
  paths: SessionPaths;
  onEvent: StartChainOpts['onEvent'];
  onEnded: StartChainOpts['onEnded'];
  onTeardown?: (reason: MultiAgentEndedReason) => Promise<void>;
  /** Always-run finalizer (every terminal path: stop, crash, completion),
   *  independent of `onTeardown`'s temp/crashed gating and of the sink's
   *  detach/rebind state. Used to dispose the liveness observer. */
  onFinalize?: () => void;
  /** Wake the destination agent with `text` as its next turn. */
  deliver?: (agentName: string, text: string) => void;
  /** Hard cap on persisted hops. Required so the router enforces the
   *  ceiling; the caller resolves precedence. */
  hopBudget: number;
  /** Optional pending-retry set/clear sink (Item #4). Threaded onto
   *  `BusSink.onPendingRetry` so rebind/detach honor the same plumbing. */
  onPendingRetry?: StartChainOpts['onPendingRetry'];
  /** Cluster A Phase 3 (D4): dispatcher notification fan-out for chain
   *  router drops. Threaded onto `BusSink.sendNotification`. */
  sendNotification?: BusSink['sendNotification'];
  /** Cluster A Phase 3 (D4): forward-compat typed `router_drop` ServerMsg
   *  for non-toast consumers. Threaded onto `BusSink.sendRouterDrop`. */
  sendRouterDrop?: BusSink['sendRouterDrop'];
  /** Cluster A Phase 4: generic ServerMsg sender. Threaded onto
   *  `BusSink.sendServerMsg` so the rebound sink keeps shipping the
   *  dangerous-mutation safety toast. */
  sendServerMsg?: BusSink['sendServerMsg'];
}): ChainRouter {
  const { sessionId, iterationId, agentNames, paths, onTeardown, onFinalize, deliver, hopBudget } =
    params;
  const participantSet = new Set(agentNames);
  const lastPromptForAgent = new Map<string, string>();

  // Mutable WS sink: swapped on reconnect (`rebind`), silenced on `detach`.
  // Persistence + routing keep running regardless so a detached session's
  // events still reach the DB for replay on reconnect.
  let sink: BusSink = {
    onEvent: params.onEvent,
    onEnded: params.onEnded,
    onPendingRetry: params.onPendingRetry,
    sendNotification: params.sendNotification,
    sendRouterDrop: params.sendRouterDrop,
    sendServerMsg: params.sendServerMsg,
  };
  let ended = false;
  // Cumulative count of persisted `multi_agent_events` rows for this session.
  // Incremented on every successful append (handleEvent + forwardCebabEvent)
  // so it stays in lockstep with what the UI sees as `run.events.length`.
  // The synthetic budget-exhausted event is persisted directly inline below
  // and intentionally does NOT bump this counter (it lives in DB/wire as
  // event N+1 but the displayed ratio matches the cap when it fires).
  let hopsCount = 0;
  // PR-7: first error captured during this chain session for the rail.
  // Sources mirror orchestrator: synthetic budget-exhaust text + any kind=
  // 'error' bus event observed in handleEvent + worker-failed reason.
  let firstError: string | null = null;
  const captureError = (text: string) => {
    if (firstError !== null) return;
    firstError = text.slice(0, 200);
  };

  const teardown = async (reason: MultiAgentEndedReason) => {
    if (ended) return;
    ended = true;
    // First: kill any pending liveness timer so it can't fire a spurious
    // `stalled` mid-teardown. Always runs, exactly once (ended-guarded).
    try {
      onFinalize?.();
    } catch (err) {
      console.error('[chain] onFinalize failed', err);
    }
    try {
      endMultiAgentSession(sessionId, reason === 'completed' ? 'completed' : reason);
    } catch (err) {
      console.error('[chain] endMultiAgentSession failed', err);
    }
    // PR-7: record final hops_used + first_error symmetrically with the
    // orchestrator path; the rail's SELECT-by-template doesn't care which
    // mode produced the row.
    try {
      recordSessionTeardown(sessionId, { hopsUsed: hopsCount, firstError });
    } catch (err) {
      console.error('[chain] recordSessionTeardown failed', err);
    }
    if (onTeardown && reason !== 'crashed') {
      try {
        await onTeardown(reason);
      } catch (err) {
        console.error('[chain] onTeardown failed', err);
      }
    }
    unregisterLiveSession(sessionId);
    sink.onEnded(sessionId, reason, reason === 'completed' ? iterationId : null);
  };

  /**
   * Cluster A Phase 3 (D4): chain-mode mirror of the orchestrator's
   * dispatchRouterDrop. Same BE-1/BE-2 invariants — safety_audit row first,
   * never coalesced at the recording layer, console.warn kept as a developer
   * breadcrumb.
   */
  const dispatchRouterDrop = (params: {
    reasonCode: RouterDropReasonCode;
    source: string;
    destination: string;
    kind: string;
    title: string;
    message: string;
  }) => {
    const result = emitNotification(
      {
        class: 'safety',
        severity: 'danger',
        dedupeKey: `router_drop:${params.reasonCode}:${sessionId}`,
        title: params.title,
        message: params.message,
        sessionId,
        reasonCode: params.reasonCode,
        auditKind: 'router.drop',
        auditPayload: {
          source: params.source,
          destination: params.destination,
          kind: params.kind,
        },
      },
      (msg) => {
        if (msg.type === 'notification') {
          sink.sendNotification?.(msg as NotificationEnvelope & { type: 'notification' });
        }
      },
    );
    if (result.ok) {
      sink.sendRouterDrop?.({
        sessionId,
        reasonCode: params.reasonCode,
        source: params.source,
        destination: params.destination,
        kind: params.kind,
        auditRowId: result.id,
      });
    } else {
      console.error('[chain] router_drop dispatcher.emit failed', result.error);
    }
  };

  const handleEvent = (ev: BusEvent) => {
    if (ended) return;
    // F3: source=cebab is Cebab's own traffic, routed in-process via
    //     forwardCebabEvent — never legitimately arriving through an agent.
    if (ev.source === CEBAB_SOURCE) {
      console.warn(`[chain] drop forged source=cebab dest=${ev.destination} kind=${ev.kind}`);
      dispatchRouterDrop({
        reasonCode: 'forged_source',
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        title: 'Forged source=cebab dropped',
        message: `dest=${ev.destination} kind=${ev.kind}`,
      });
      return;
    }
    // F2: chain terminates at `_sink`, never at `user`. dest=user is a spoof.
    if (ev.destination === USER_RECIPIENT) {
      console.warn(`[chain] drop dest=user from ${ev.source}`);
      dispatchRouterDrop({
        reasonCode: 'worker_to_user',
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        title: 'Agent tried to address user directly',
        message: `from=${ev.source}`,
      });
      return;
    }
    // F2: source must be a known participant. (Defense-in-depth — the
    //     in-process tool already pins an unspoofable source.)
    if (!participantSet.has(ev.source)) {
      console.warn(`[chain] drop event from non-participant source=${ev.source}`);
      dispatchRouterDrop({
        reasonCode: 'unknown_source',
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        title: 'Unknown source on bus',
        message: `source=${ev.source}`,
      });
      return;
    }

    let dbId = 0;
    try {
      const row = appendMultiAgentEvent(
        sessionId,
        ev.source,
        ev.destination,
        ev.kind as EventKind,
        ev.text,
      );
      dbId = row.id;
      hopsCount += 1;
    } catch (err) {
      console.error('[chain] persist event failed', err);
    }
    // PR-7: capture kind='error' events as the run's first_error for the rail.
    if (ev.kind === 'error') {
      captureError(ev.text);
    }
    try {
      sink.onEvent(sessionId, ev, dbId);
    } catch (err) {
      console.error('[chain] onEvent callback threw', err);
    }

    if (participantSet.has(ev.source)) {
      const theirPrompt = lastPromptForAgent.get(ev.source) ?? '';
      try {
        archiveAgentHop({
          iterationId,
          agentName: ev.source,
          prompt: theirPrompt,
          reply: ev.text,
          paths,
        });
      } catch (err) {
        console.error('[chain] archiveAgentHop failed', err);
      }
    }
    lastPromptForAgent.set(ev.destination, ev.text);

    if (ev.destination === SINK_RECIPIENT) {
      try {
        const idir = paths.iterationDir(iterationId);
        fs.mkdirSync(idir, { recursive: true });
        fs.writeFileSync(path.join(idir, 'final.md'), ev.text);
      } catch (err) {
        console.error('[chain] write final.md failed', err);
      }
      void teardown('completed');
      return;
    }
    if (!participantSet.has(ev.destination)) {
      console.warn(`[chain] event for non-participant: ${ev.destination}`);
      return;
    }
    // Hop-budget enforcement: the hop we just persisted is in the trail; if
    // it pushed us to the cap, refuse to wake the next agent and surface a
    // synthetic `cebab → _sink kind=error` event so the trail explains the
    // stop. Persist+wire directly (NOT via `forwardCebabEvent`) so the count
    // does not also bump for the error itself — the displayed ratio reads
    // exactly `hopBudget/hopBudget` at the moment of refusal. F3 normally
    // drops `source=cebab` in `handleEvent`; bypassing here mirrors the same
    // pattern `forwardCebabEvent` uses for legitimate Cebab traffic.
    if (hopsCount >= hopBudget) {
      const reasonText = `Hop budget exhausted (${hopsCount}/${hopBudget}). The session was stopped to prevent a runaway loop. Raise the limit in Settings or via the CEBAB_HOP_BUDGET env var to extend.`;
      // PR-7: this synthetic error is THIS run's first_error if none earlier.
      captureError(reasonText);
      try {
        const row = appendMultiAgentEvent(
          sessionId,
          CEBAB_SOURCE,
          SINK_RECIPIENT,
          'error',
          reasonText,
        );
        sink.onEvent(
          sessionId,
          {
            ts: Date.now(),
            source: CEBAB_SOURCE,
            destination: SINK_RECIPIENT,
            kind: 'error',
            text: reasonText,
          },
          row.id,
        );
      } catch (err) {
        console.error('[chain] persist budget-exhausted event failed', err);
      }
      void teardown('stopped');
      return;
    }
    // Fire-and-forget: must NOT block the sending agent's in-flight turn
    // (this runs inside its bus_send tool call). Mirrors the old
    // `sendKeys(...).catch(...)`.
    deliver?.(ev.destination, ev.text);
  };

  // Cebab-originated events (briefings, initial prompt): persist + forward so
  // the operator's scrollback + DB transcript include them. No routing — the
  // briefing/prompt is delivered as the agent's actual turn separately.
  // Bumps `hopsCount` on a successful persist so the counter stays in
  // lockstep with `run.events.length` as the UI sees it.
  const forwardCebabEvent = (ev: BusEvent) => {
    if (ended) return;
    let dbId = 0;
    try {
      const row = appendMultiAgentEvent(
        sessionId,
        ev.source,
        ev.destination,
        ev.kind as EventKind,
        ev.text,
      );
      dbId = row.id;
      hopsCount += 1;
    } catch (err) {
      console.error('[chain] persist cebab event failed', err);
    }
    try {
      sink.onEvent(sessionId, ev, dbId);
    } catch (err) {
      console.error('[chain] cebab onEvent threw', err);
    }
  };

  const detach = () => {
    // Keep persisting/routing; just stop forwarding to the (now dead) WS.
    sink = NOOP_SINK;
  };
  const rebind = (next: BusSink) => {
    sink = next;
  };

  // Worker failure handler — same shape in both routers (Item #4). The
  // deliver() .catch in startChainSession calls this when a worker's
  // deliverTurn rejects (iterator throw OR non-success result.subtype).
  // We emit a synthetic `cebab → user kind=error` event so the trail
  // explains the stop, persist the pending-retry slot so the operator
  // (and a post-restart R-B reconstruction) can resume from it, and stay
  // live. Critical: this bypasses `forwardCebabEvent` so the error event
  // does NOT bump hopsCount (consistent with the budget-exhaust pattern).
  // If no last prompt is known (the agent failed before `deliver` was
  // ever called, e.g. an unknown-agent error), we fall back to crashed
  // teardown — there's nothing to retry.
  const onWorkerFailed = (agentName: string, prompt: string, err: unknown) => {
    if (ended) return;
    const errMessage =
      err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
    const reasonText = `\`${agentName}\`'s last turn failed: ${errMessage}`;
    // PR-7: a worker failure is a strong "first error" signal. Capture
    // unconditionally so the rail's red chip + excerpt show even if the
    // persist below trips.
    captureError(reasonText);
    let errorEventId = 0;
    try {
      const row = appendMultiAgentEvent(
        sessionId,
        CEBAB_SOURCE,
        USER_RECIPIENT,
        'error',
        reasonText,
      );
      errorEventId = row.id;
      try {
        sink.onEvent(
          sessionId,
          {
            ts: Date.now(),
            source: CEBAB_SOURCE,
            destination: USER_RECIPIENT,
            kind: 'error',
            text: reasonText,
          },
          row.id,
        );
      } catch (sinkErr) {
        console.error('[chain] worker-failed onEvent threw', sinkErr);
      }
    } catch (persistErr) {
      console.error('[chain] persist worker-failed event failed', persistErr);
    }
    if (!prompt) {
      // No bytes to retry — collapse to the legacy crashed teardown so the
      // session ends with a legible status pill rather than dangling live.
      console.warn(`[chain] worker ${agentName} failed pre-deliver; ending crashed`);
      void teardown('crashed');
      return;
    }
    const descriptor: PendingRetryDescriptor = {
      agentName,
      reason: reasonText,
      lastPrompt: prompt,
      ts: Date.now(),
      errorEventId,
    };
    try {
      setPendingRetry(sessionId, {
        agentName,
        prompt,
        reason: reasonText,
        ts: descriptor.ts,
        errorEventId,
      });
    } catch (dbErr) {
      console.error('[chain] persist pending-retry failed', dbErr);
    }
    try {
      sink.onPendingRetry?.(sessionId, descriptor);
    } catch (sinkErr) {
      console.error('[chain] onPendingRetry callback threw', sinkErr);
    }
  };

  return { teardown, handleEvent, forwardCebabEvent, detach, rebind, onWorkerFailed };
}

function writeTranscript(paths: SessionPaths, iterationId: string, agent: string, msg: SDKMessage) {
  try {
    const dir = paths.iterationDir(iterationId, agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'transcript.log'), JSON.stringify(msg) + '\n');
  } catch (err) {
    console.error('[chain] transcript write failed', err);
  }
}

export async function startChainSession(opts: StartChainOpts): Promise<ChainSessionHandle> {
  if (opts.participants.length < 2) {
    throw new Error('chain mode requires at least two participants');
  }
  if (!fs.existsSync(opts.workspaceRoot)) {
    throw new Error(`workspaceRoot does not exist: ${opts.workspaceRoot}`);
  }

  const sessionId = crypto.randomUUID();
  const lifecycle: MultiAgentLifecycle = opts.lifecycle ?? 'persistent';
  const agentNames = opts.participants.map((p) => p.agentName);
  const projectIds = opts.participants.map((p) => p.projectId);
  // Precedence is resolved by the caller (WS layer reads settings + env);
  // this fallback only applies when the caller didn't specify.
  const hopBudget = opts.hopBudget ?? DEFAULT_HOP_BUDGET;

  const paths = computeSessionPaths(sessionId, opts.workspaceRoot);
  fs.mkdirSync(paths.folder, { recursive: true });

  const iterationId = nextIterationId(paths);

  createMultiAgentSession(sessionId, 'chain', iterationId, paths.folder, lifecycle, {
    // PR-7: template provenance + effective hop budget at session start
    // are stamped onto the row so the "Last run" rail can attribute this
    // session and render hops_used/hop_budget post-teardown.
    templateId: opts.templateId ?? null,
    hopBudget,
  });
  opts.participants.forEach((p, i) => addParticipant(sessionId, p.projectId, 'worker', i));
  prepareIterationDir(iterationId, agentNames, paths);

  // Item #5: persist the opt-in pause-on-mutation flag at session start so
  // the bus runner's mutation tap can read it from DB on every gate check.
  if (opts.pauseOnMutation) {
    try {
      setPauseOnMutation(sessionId, true);
    } catch (err) {
      console.error('[chain] persist pause_on_mutation failed', err);
    }
  }

  const onTeardown: ((reason: MultiAgentEndedReason) => Promise<void>) | undefined =
    lifecycle === 'temp'
      ? async () => {
          for (const projectId of projectIds) {
            try {
              await uninstallBusForProject(projectId);
            } catch (err) {
              console.warn(`[chain] temp-cleanup uninstall failed for ${projectId}`, err);
            }
          }
          try {
            fs.rmSync(paths.folder, { recursive: true, force: true });
          } catch (err) {
            console.warn('[chain] temp-cleanup rmSync failed', err);
          }
        }
      : undefined;

  // Per-participant briefing, prepended once to that agent's first turn (it
  // rides the first prompt rather than living in a project file). The
  // project's own root CLAUDE.md is read here too and injected as framed
  // text on the same first turn (null when the project has none). The SDK
  // now also auto-loads project CLAUDE.md because chain participants run
  // with `settingSources: ['user', 'project', 'local']`; we keep the
  // explicit injection so the bytes are visible in the on-disk transcript
  // and the operator's chat (the SDK's auto-load is system-context and
  // doesn't surface). The duplication is a small token cost, intentional.
  const briefings = new Map<string, string>();
  const projectRules = new Map<string, ProjectRules | null>();
  opts.participants.forEach((p, i) => {
    const nextHop =
      i === opts.participants.length - 1 ? SINK_RECIPIENT : opts.participants[i + 1]!.agentName;
    briefings.set(
      p.agentName,
      renderChainBriefing({
        iterationId,
        position: i + 1,
        totalSteps: opts.participants.length,
        selfAgent: p.agentName,
        participantNames: agentNames,
        nextHop,
      }),
    );
    projectRules.set(p.agentName, readProjectClaudeMd(p.cwd));
  });

  const abortController = new AbortController();
  const briefed = new Set<string>();

  // Passive liveness tap on the existing per-turn SDKMessage stream. Pure
  // Cebab-side; no agent/prompt/DB change. `sessionId` is closed over so the
  // WS layer's `onActivity` addresses the right session even mid-first-turn.
  const activity = createAgentActivityObserver((snap) => opts.onActivity?.(sessionId, snap));

  // Item #5: per-agent last delivered prompt — captured by `deliver` AFTER
  // briefing/rules prefix, used by `continueThroughMutation` to replay the
  // exact wire bytes (no double briefing). Mirrors orchestrator.ts.
  const lastPromptOut = new Map<string, string>();

  // Forward-declared: router ↔ deliver ↔ runner form a construction cycle
  // (router needs `deliver`; deliver needs `runner`; runner.onEvent needs
  // `router`). Reassigned exactly once, just below.
  // eslint-disable-next-line prefer-const
  let router: ChainRouter;

  // Item #5: mutation tap closure (mirrors orchestrator.ts's `onMutationHook`).
  const onMutationHook: AgentRunnerDeps['onMutation'] = async (agentName, toolName, cwd, cls) => {
    let row: MutationRecord;
    try {
      row = appendMultiAgentMutation(sessionId, agentName, toolName, cls.category, cls.summary, {
        filePath: cls.filePath ?? null,
        cwd,
        toolUseId: cls.toolUseId ?? null,
      });
    } catch (err) {
      console.error('[chain] persist mutation failed', err);
      return;
    }
    try {
      opts.onMutation?.(sessionId, row);
    } catch (err) {
      console.error('[chain] onMutation sink threw', err);
    }
    const session = getMultiAgentSession(sessionId);
    if (
      session?.pause_on_mutation === 1 &&
      session.mutations_acknowledged === 0 &&
      session.pending_mutation_id === null
    ) {
      try {
        setPendingMutation(sessionId, row.id);
        setAwaitingContinue(sessionId, true);
      } catch (err) {
        console.error('[chain] persist pending-mutation failed', err);
      }
      try {
        opts.onPendingMutation?.(sessionId, row);
      } catch (err) {
        console.error('[chain] onPendingMutation sink threw', err);
      }
      throw new PausedForMutationError(`paused before ${cls.summary}`);
    }
  };

  // Migration 012 + Phase E: tool-result tap (mirrors orchestrator.ts's
  // `onToolResultHook`). Flips `confirmed_at`, runs the artifact classifier,
  // and re-emits `multi_agent_mutation` (the wire reducer dedupes by id).
  const onToolResultHook: AgentRunnerDeps['onToolResult'] = (_agentName, toolUseId) => {
    let confirmed: MutationRecord | null;
    try {
      confirmed = confirmMutationByToolUseId(sessionId, toolUseId);
    } catch (err) {
      console.error('[chain] confirm mutation failed', err);
      return;
    }
    if (!confirmed) return;

    let finalRow = confirmed;
    if (confirmed.filePath) {
      try {
        const kind = classifyArtifact(confirmed.filePath, confirmed.cwd);
        if (kind === 'promoted' && !confirmed.promoted) {
          const promoted = setMutationPromoted(confirmed.id, true);
          if (promoted) finalRow = promoted;
        }
      } catch (err) {
        console.error('[chain] classify/promote mutation failed', err);
      }
    }

    try {
      opts.onMutation?.(sessionId, finalRow);
    } catch (err) {
      console.error('[chain] onMutation sink (confirm re-emit) threw', err);
    }
  };

  const runner = new AgentRunner({
    onEvent: (ev) => router.handleEvent(ev),
    onMessage: (agent, msg) => {
      writeTranscript(paths, iterationId, agent, msg);
      activity.onMessage(agent, msg);
    },
    onMutation: onMutationHook,
    onToolResult: onToolResultHook,
    abortController,
    runnerFactory: opts.runnerFactory,
    // Cluster D Phase 4a (BE-D5 / BE-D8 / spec §4.2): every transient-
    // overload retry fans out an `auto_retry` ServerMsg AND writes a
    // `recovery_log` row. The row is the durable record the
    // regression-gate queries (spec §8.5) read; the ServerMsg is the
    // live signal the RateLimitBanner (Phase 4c) drives its countdown
    // from. Failures here are isolated — a sink/DB error can't break
    // the SDK retry loop itself; we just lose the observability for
    // that attempt.
    onAutoRetry: (info) => {
      try {
        opts.sendServerMsg?.({
          type: 'auto_retry',
          sessionId,
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          backoffMs: info.backoffMs,
          reason: info.reason,
          retryAt: info.retryAt,
          agentName: info.agentName,
        });
      } catch (err) {
        console.error('[chain] sendServerMsg auto_retry threw', err);
      }
      try {
        appendRecoveryLog({
          sessionId,
          failureClass: 'other',
          operatorAction: 'auto_retry',
          // Time-to-recovery is the backoff itself; the retry HAS NOT
          // succeeded yet, so the outcome stays null (backfilled later
          // by the resolution path — Phase 4b/c).
          timeToRecoveryMs: info.backoffMs,
        });
      } catch (err) {
        console.error('[chain] appendRecoveryLog auto_retry threw', err);
      }
    },
  });
  for (const p of opts.participants) {
    runner.register({
      name: p.agentName,
      cwd: p.cwd,
      settingSources: ['user', 'project', 'local'],
    });
  }

  const deliver = (agentName: string, text: string) => {
    const briefing = briefings.get(agentName);
    let prompt = text;
    if (briefing && !briefed.has(agentName)) {
      briefed.add(agentName);
      // Order: bus protocol → project rules → task. Rules sit after the
      // protocol so the "bus protocol wins" framing holds; the task still
      // visibly follows the fenced block.
      const pr = projectRules.get(agentName);
      prompt = pr ? `${briefing}\n\n${pr.framed}\n\n${text}` : `${briefing}\n\n${text}`;
    }
    // Capture the post-briefing-and-rules bytes so the .catch can hand them
    // to onWorkerFailed for the pending-retry slot, AND so
    // `continueThroughMutation` can replay the same exact wire bytes after a
    // pause. (The briefed Set is already populated above, so a retry that
    // re-uses these exact bytes won't double-brief.)
    const deliveredPrompt = prompt;
    lastPromptOut.set(agentName, deliveredPrompt);
    void runner
      .deliverTurn(agentName, prompt)
      .catch((err) => {
        if (isPausedForMutation(err)) return; // controlled pause, not a failure
        console.error(`[chain] deliverTurn(${agentName}) failed`, err);
        router.onWorkerFailed(agentName, deliveredPrompt, err);
      })
      .finally(() => activity.onTurnEnd(agentName));
  };

  router = createChainRouter({
    sessionId,
    iterationId,
    agentNames,
    paths,
    onEvent: opts.onEvent,
    onEnded: opts.onEnded,
    onTeardown,
    onFinalize: () => activity.dispose(),
    deliver,
    hopBudget,
    onPendingRetry: opts.onPendingRetry,
    sendNotification: opts.sendNotification,
    sendRouterDrop: opts.sendRouterDrop,
    sendServerMsg: opts.sendServerMsg,
  });

  const handle: ChainSessionHandle = {
    sessionId,
    iterationId,
    participantAgentNames: agentNames,
    lifecycle,
    sessionFolder: paths.folder,
    hopBudget,
    pauseOnMutation: opts.pauseOnMutation ?? false,
    async stop(reason) {
      // Clear any pending-retry / pause-on-mutation slot first so the
      // teardown leaves a clean row — otherwise a crashed-but-with-non-null-
      // pending row would be dead data that R-B reconstruction can't
      // usefully act on.
      try {
        setPendingRetry(sessionId, null);
      } catch (err) {
        console.error('[chain] clear pending-retry on stop failed', err);
      }
      try {
        setPendingMutation(sessionId, null);
      } catch (err) {
        console.error('[chain] clear pending-mutation on stop failed', err);
      }
      runner.stop();
      await router.teardown(reason);
    },
    detach() {
      router.detach();
    },
    async retry() {
      const pending = getPendingRetry(sessionId);
      if (!pending) return;
      // Clear the slot BEFORE re-delivery so a racing second click sees
      // the empty slot and no-ops. If the retried turn fails again, the
      // onWorkerFailed callback re-asserts the slot with a fresh reason
      // and re-emits the pending-retry ServerMsg.
      try {
        setPendingRetry(sessionId, null);
      } catch (err) {
        console.error('[chain] clear pending-retry on retry failed', err);
      }
      try {
        opts.onPendingRetry?.(sessionId, null);
      } catch (err) {
        console.error('[chain] retry onPendingRetry-null callback threw', err);
      }
      // Re-call `deliver` so the activity observer / liveness ticks see
      // the new turn. The agent's `briefed` Set is already populated by
      // the failed delivery, so re-feeding `pending.prompt` (which IS the
      // post-briefing bytes captured in the previous turn) does not
      // double-prepend the briefing.
      deliver(pending.agentName, pending.prompt);
    },
    async continueThroughMutation() {
      const pending = getPendingMutation(sessionId);
      if (!pending) return;
      try {
        setPendingMutation(sessionId, null);
        setMutationsAcknowledged(sessionId, true);
        setAwaitingContinue(sessionId, false);
      } catch (err) {
        console.error('[chain] persist continue-through-mutation failed', err);
      }
      try {
        opts.onPendingMutation?.(sessionId, null);
      } catch (err) {
        console.error('[chain] continue onPendingMutation-null callback threw', err);
      }
      const replayPrompt = lastPromptOut.get(pending.agentName);
      if (!replayPrompt) {
        console.warn(
          `[chain] continue-through-mutation: no captured prompt for ${pending.agentName}`,
        );
        return;
      }
      deliver(pending.agentName, replayPrompt);
    },
  };

  registerLiveSession({
    sessionId,
    mode: 'chain',
    handle,
    rebind: (s) => router.rebind(s),
  });

  // Briefings + initial prompt → UI scrollback + DB parity (source=cebab).
  // The CLAUDE.md the agent actually receives is NOT echoed here (it would
  // flood the operator's chat and is already in the on-disk iteration
  // transcript); scrollback gets a one-line marker instead.
  for (const p of opts.participants) {
    router.forwardCebabEvent({
      ts: Date.now(),
      source: CEBAB_SOURCE,
      destination: p.agentName,
      kind: 'intro',
      text: briefings.get(p.agentName)!,
    });
    const pr = projectRules.get(p.agentName);
    if (pr) {
      router.forwardCebabEvent({
        ts: Date.now(),
        source: CEBAB_SOURCE,
        destination: p.agentName,
        kind: 'intro',
        text: `Cebab injected ${p.projectName}/CLAUDE.md (${pr.sizeLabel}) into ${p.agentName}'s first turn`,
      });
    }
  }
  router.forwardCebabEvent({
    ts: Date.now(),
    source: CEBAB_SOURCE,
    destination: opts.participants[0]!.agentName,
    kind: 'prompt',
    text: opts.initialPrompt,
  });

  // Kick the pipeline: participant[0]'s first turn (briefing-prefixed).
  deliver(opts.participants[0]!.agentName, opts.initialPrompt);

  return handle;
}

/**
 * Re-attach to a still-live chain session (browser reconnect, same process).
 * Returns null when the session is not live in this process — e.g. after a
 * Cebab server restart — so the WS layer marks the row crashed. Chain
 * reconstruction is deferred (orchestrated runs get R-B; chain does not).
 * Pure re-attach: never respawns agents.
 */
export async function resumeChainSession(
  opts: ResumeChainOpts,
): Promise<ChainSessionHandle | null> {
  const live = getLiveSession(opts.sessionId);
  if (!live || live.mode !== 'chain') return null;
  // Re-attach: swap the WS sink on the original, still-running router. The
  // returned handle is the ORIGINAL one (authoritative stop/detach/
  // iterationId) — we only redirected its event stream to this connection.
  live.rebind({
    onEvent: opts.onEvent,
    onEnded: opts.onEnded,
    sendNotification: opts.sendNotification,
    sendRouterDrop: opts.sendRouterDrop,
    sendServerMsg: opts.sendServerMsg,
  });
  return live.handle as ChainSessionHandle;
}

/** Build the resolved-agent list from project ids. Throws on the first
 *  unresolvable id so the caller can surface a typed error. Unchanged. */
export function resolveChainParticipants(projectIds: number[]): ResolvedAgent[] {
  return projectIds.map((id) => resolveAgent(id));
}
