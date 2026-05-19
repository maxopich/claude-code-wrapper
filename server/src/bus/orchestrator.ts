/**
 * Canonical orchestrator workspace directory.
 *
 * The orchestrator is Cebab's own bus agent — used in orchestrator-routed
 * mode to receive user prompts, route them to participant workers, and
 * reply back to the user. Its bus name is always `orchestrator`.
 *
 * Unlike worker projects (operator-owned), the orchestrator workspace is
 * Cebab-owned — but it is just an (empty) directory used as the orchestrator
 * SDK `query()`'s `cwd`. Cebab writes NO files into it: the orchestrator runs
 * with `settingSources: ['user']`, so a workspace `CLAUDE.md` / `comm.md` /
 * `settings.json` would never be loaded by the SDK. The orchestrator learns
 * the bus protocol entirely from the per-turn roster prompt
 * (`renderRosterPrompt` in runtime.ts) — the only prompt it actually sees.
 * (A static CLAUDE.md template + generated comm.md used to live here; both
 * were dead under `settingSources: ['user']` and have been removed.)
 *
 * The legacy global `~/.cebab/orchestrator/` path is the default `targetDir`
 * for callers that don't pass one (pre-007 backwards compat + unit tests).
 * Post-007 sessions pass `<sessionFolder>/orchestrator/` so each session has
 * its own orchestrator workspace directory.
 *
 * The runtime half (below the generator) is the pure-SDK orchestrator: each
 * participant — and the orchestrator itself — is an in-process SDK `query()`
 * driven by the shared `AgentRunner`. No tmux, no TUI, no Stop hook, no file
 * IPC. The routing brain (`createOrchestratorRouter`) keeps its F2/F3 source-
 * allowlist filters verbatim; only its I/O boundary changed (in-process
 * `bus_send` in, `deliver()` out — see chain.ts for the symmetric story).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendMultiAgentEvent,
  addParticipant,
  createMultiAgentSession,
  endMultiAgentSession,
  getProjectBusState,
  setMultiAgentSessionLifecycle,
  upsertAgentSession,
  type EventKind,
  type MultiAgentLifecycle,
} from '../repo/multi_agent.js';
import { computeSessionPaths, orchestratorWorkspaceDir, type SessionPaths } from './paths.js';
import { installBusForProject, uninstallBusForProject } from './install.js';
import {
  CEBAB_SOURCE,
  nextIterationId,
  prepareIterationDir,
  readProjectClaudeMd,
  renderRosterPrompt,
  renderRosterUpdate,
  renderWorkerBriefing,
  resolveAgent,
  SINK_RECIPIENT,
  USER_RECIPIENT,
  type MultiAgentEndedReason,
  type ProjectRules,
  type ResolvedAgent,
} from './runtime.js';
import { AgentRunner, type AgentRunnerDeps, type BusEvent } from './runner.js';
import { createAgentActivityObserver, type ActivitySnapshot } from './activity.js';
import {
  getLiveSession,
  NOOP_SINK,
  registerLiveSession,
  unregisterLiveSession,
  type BusSink,
} from './session_registry.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Bus agent name for the orchestrator. Reserved; no project may use it. */
export const ORCHESTRATOR_AGENT_NAME = 'orchestrator';

/**
 * Soft cap on `prompt` → `reply` hops per user prompt. Surfaced here so
 * PR 5's intro message and any future UI display can pull from one source.
 */
export const DEFAULT_HOP_BUDGET = 8;

/**
 * Ensure the orchestrator workspace directory exists.
 *
 * It is only a `cwd` for the orchestrator's SDK `query()` — Cebab writes
 * nothing into it. The orchestrator runs with `settingSources: ['user']`,
 * so a workspace `CLAUDE.md` / `comm.md` / `settings.json` would never be
 * loaded; the bus protocol reaches it solely via the per-turn roster prompt
 * (`renderRosterPrompt`). Idempotent (`recursive: true`).
 *
 * `targetDir` is the per-session `<sessionFolder>/orchestrator/`; callers
 * that omit it (pre-007 / unit tests) get the legacy global path.
 */
export function ensureOrchestratorWorkspace(targetDir?: string): void {
  const wsDir = targetDir ?? orchestratorWorkspaceDir();
  fs.mkdirSync(wsDir, { recursive: true });
}

// ============================================================================
// Orchestrator-routed session runtime (Pattern A) — pure-SDK.
// ============================================================================
//
// The orchestrator is itself an AgentRunner participant (cwd = its Cebab-
// generated workspace). Workers are participants too. Routing:
//   - dest=user         → forwarded to the operator's chat (sink.onEvent);
//                          only the orchestrator may address the user.
//   - dest=orchestrator → deliver a turn to the orchestrator.
//   - dest=worker       → deliver a turn to that worker.
//   - dest=_sink        → not used in orchestrator mode (warn).
// The initial roster prompt + user prompt are delivered as the
// orchestrator's first turn (was: written to its inbox; the Stop hook is
// gone). Mid-run user prompts and added-worker roster updates take the same
// path via `sendUserPrompt` / `addWorker`.

export type StartOrchestratorOpts = {
  workers: ResolvedAgent[];
  initialPrompt: string;
  workspaceRoot: string;
  lifecycle?: MultiAgentLifecycle;
  onEvent: (sessionId: string, ev: BusEvent, dbEventId: number) => void;
  onEnded: (sessionId: string, reason: MultiAgentEndedReason, iterationId: string | null) => void;
  /** Ephemeral per-turn liveness tick → `agent_activity` ServerMsg.
   *  `sessionId` explicit (same convention as `onEvent`). Optional: the
   *  resume/reconstruct paths don't pass it (heartbeat resumes on the next
   *  fresh start; see the `agent_activity` protocol JSDoc). */
  onActivity?: (sessionId: string, snap: ActivitySnapshot) => void;
};

export type ResumeOrchestratorOpts = {
  sessionId: string;
  onEvent: StartOrchestratorOpts['onEvent'];
  onEnded: StartOrchestratorOpts['onEnded'];
};

export type AddWorkerResult = {
  agentName: string;
  busWasAlreadyInstalled: boolean;
};

export type OrchestratorSessionHandle = {
  sessionId: string;
  iterationId: string;
  participantAgentNames: string[];
  lifecycle: MultiAgentLifecycle;
  sessionFolder: string;
  stop: (reason: MultiAgentEndedReason) => Promise<void>;
  sendUserPrompt: (text: string) => Promise<void>;
  detach: () => void;
  addWorker: (projectId: number) => Promise<AddWorkerResult>;
  setLifecycle: (lifecycle: MultiAgentLifecycle) => Promise<void>;
  getCurrentWorkerNames: () => readonly string[];
  getCurrentLifecycle: () => MultiAgentLifecycle;
};

type OrchestratorRouter = {
  teardown: (reason: MultiAgentEndedReason) => Promise<void>;
  handleEvent: (ev: BusEvent) => void;
  forwardCebabEvent: (ev: BusEvent) => void;
  sendUserPrompt: (text: string) => Promise<void>;
  detach: () => void;
  rebind: (sink: BusSink) => void;
  registerWorker: (agentName: string) => void;
  getWorkerNames: () => readonly string[];
  setLifecycle: (lifecycle: MultiAgentLifecycle) => void;
  getLifecycle: () => MultiAgentLifecycle;
};

/**
 * Build the orchestrator event router. Pure routing/persistence — does NOT
 * own the AgentRunner (security tests construct it standalone). `deliver` is
 * the injected AgentRunner-backed wake; omitted in unit tests, which only
 * drive the F2/F3 drop + allowlist paths.
 */
export function createOrchestratorRouter(params: {
  sessionId: string;
  iterationId: string;
  workerNames: string[];
  paths: SessionPaths;
  lifecycle: MultiAgentLifecycle;
  onEvent: StartOrchestratorOpts['onEvent'];
  onEnded: StartOrchestratorOpts['onEnded'];
  onTeardown?: (reason: MultiAgentEndedReason) => Promise<void>;
  /** Always-run finalizer (stop/crash/completion), independent of
   *  `onTeardown`'s temp/crashed gating and of sink detach/rebind. Disposes
   *  the liveness observer. */
  onFinalize?: () => void;
  deliver?: (agentName: string, text: string) => void;
}): OrchestratorRouter {
  const { sessionId, iterationId, workerNames, onTeardown, onFinalize, deliver } = params;
  const workerNamesMut: string[] = [...workerNames];
  const workerSet = new Set(workerNamesMut);
  let lifecycleRef: MultiAgentLifecycle = params.lifecycle;

  let sink: BusSink = { onEvent: params.onEvent, onEnded: params.onEnded };
  let ended = false;

  const teardown = async (reason: MultiAgentEndedReason) => {
    if (ended) return;
    ended = true;
    // First: kill any pending liveness timer so it can't fire a spurious
    // `stalled` mid-teardown. Always runs, exactly once (ended-guarded).
    try {
      onFinalize?.();
    } catch (err) {
      console.error('[orchestrator] onFinalize failed', err);
    }
    try {
      endMultiAgentSession(sessionId, reason === 'completed' ? 'completed' : reason);
    } catch (err) {
      console.error('[orchestrator] endMultiAgentSession failed', err);
    }
    if (onTeardown && reason !== 'crashed' && lifecycleRef === 'temp') {
      try {
        await onTeardown(reason);
      } catch (err) {
        console.error('[orchestrator] onTeardown failed', err);
      }
    }
    unregisterLiveSession(sessionId);
    sink.onEnded(sessionId, reason, iterationId);
  };

  const handleEvent = (ev: BusEvent) => {
    if (ended) return;
    // F3: source=cebab arriving through an agent is a forgery (Cebab routes
    //     its own traffic in-process via forwardCebabEvent).
    if (ev.source === CEBAB_SOURCE) {
      console.warn(
        `[orchestrator] drop forged source=cebab dest=${ev.destination} kind=${ev.kind}`,
      );
      return;
    }
    // F2: only the orchestrator may address the user.
    if (ev.destination === USER_RECIPIENT && ev.source !== ORCHESTRATOR_AGENT_NAME) {
      console.warn(`[orchestrator] drop dest=user from non-orchestrator source=${ev.source}`);
      return;
    }
    // F2: workers must reply via the orchestrator — no worker→worker.
    if (workerSet.has(ev.source) && workerSet.has(ev.destination)) {
      console.warn(`[orchestrator] drop worker→worker ${ev.source}→${ev.destination}`);
      return;
    }
    // F2 round-2: source must be the orchestrator or a known worker.
    if (ev.source !== ORCHESTRATOR_AGENT_NAME && !workerSet.has(ev.source)) {
      console.warn(`[orchestrator] drop event from non-participant source=${ev.source}`);
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
    } catch (err) {
      console.error('[orchestrator] persist event failed', err);
    }
    try {
      sink.onEvent(sessionId, ev, dbId);
    } catch (err) {
      console.error('[orchestrator] onEvent callback threw', err);
    }

    if (ev.destination === USER_RECIPIENT) {
      return; // forwarded to the operator via sink.onEvent already
    }
    if (ev.destination === SINK_RECIPIENT) {
      console.warn(`[orchestrator] unexpected destination=_sink from ${ev.source}`);
      return;
    }
    if (ev.destination === ORCHESTRATOR_AGENT_NAME) {
      deliver?.(ORCHESTRATOR_AGENT_NAME, ev.text);
      return;
    }
    if (workerSet.has(ev.destination)) {
      deliver?.(ev.destination, ev.text);
      return;
    }
    console.warn(`[orchestrator] event for unknown destination: ${ev.destination}`);
  };

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
    } catch (err) {
      console.error('[orchestrator] persist cebab event failed', err);
    }
    try {
      sink.onEvent(sessionId, ev, dbId);
    } catch (err) {
      console.error('[orchestrator] cebab onEvent threw', err);
    }
  };

  const sendUserPrompt = async (text: string) => {
    if (ended) return;
    forwardCebabEvent({
      ts: Date.now(),
      source: CEBAB_SOURCE,
      destination: ORCHESTRATOR_AGENT_NAME,
      kind: 'prompt',
      text,
    });
    deliver?.(ORCHESTRATOR_AGENT_NAME, text);
  };

  const detach = () => {
    sink = NOOP_SINK;
  };
  const rebind = (next: BusSink) => {
    sink = next;
  };
  const registerWorker = (agentName: string) => {
    if (workerSet.has(agentName)) return;
    workerSet.add(agentName);
    workerNamesMut.push(agentName);
  };
  const getWorkerNames = (): readonly string[] => workerNamesMut;
  const setLifecycle = (next: MultiAgentLifecycle) => {
    lifecycleRef = next;
  };
  const getLifecycle = (): MultiAgentLifecycle => lifecycleRef;

  return {
    teardown,
    handleEvent,
    forwardCebabEvent,
    sendUserPrompt,
    detach,
    rebind,
    registerWorker,
    getWorkerNames,
    setLifecycle,
    getLifecycle,
  };
}

function writeTranscript(paths: SessionPaths, iterationId: string, agent: string, msg: SDKMessage) {
  try {
    const dir = paths.iterationDir(iterationId, agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'transcript.log'), JSON.stringify(msg) + '\n');
  } catch (err) {
    console.error('[orchestrator] transcript write failed', err);
  }
}

/**
 * Shared wiring for an orchestrator session: AgentRunner + router + handle +
 * live-registry registration. Both a fresh start and an R-B reconstruction
 * go through this ONE function so the F2/F3 routing filters and the
 * handle/closure shape can never drift between the two paths.
 *
 * It does NOT create the DB session/participant rows, allocate an iteration,
 * or deliver any prompt — those differ between start (fresh) and reconstruct
 * (read-only) and are the caller's responsibility.
 *
 * R-B hooks:
 *   - `seededSessions`: pre-load each agent's last-completed CLI session id
 *     so its next turn `--resume`s its real transcript.
 *   - `briefedAgents`: workers that already consumed their one-time briefing
 *     in the prior process (their resumed transcript still contains it) —
 *     don't re-prefix it.
 */
export function wireOrchestratorSession(p: {
  sessionId: string;
  iterationId: string;
  lifecycle: MultiAgentLifecycle;
  paths: SessionPaths;
  workers: ResolvedAgent[];
  onEvent: StartOrchestratorOpts['onEvent'];
  onEnded: StartOrchestratorOpts['onEnded'];
  onActivity?: StartOrchestratorOpts['onActivity'];
  seededSessions?: ReadonlyArray<{ agentName: string; cliSessionId: string }>;
  briefedAgents?: ReadonlyArray<string>;
  /** Injectable for tests; threaded into the AgentRunner. Defaults to the
   *  real (mock-aware) `pickRunner` when omitted. */
  runnerFactory?: AgentRunnerDeps['runnerFactory'];
}): {
  handle: OrchestratorSessionHandle;
  router: OrchestratorRouter;
  deliver: (agentName: string, text: string) => void;
} {
  const { sessionId, iterationId, lifecycle, paths } = p;
  const workerNames = p.workers.map((w) => w.agentName);
  const participantAgentNames = [ORCHESTRATOR_AGENT_NAME, ...workerNames];
  const workerProjectIds = p.workers.map((w) => w.projectId);
  const workerProjectNames = new Map<string, string>(
    p.workers.map((w) => [w.agentName, w.projectName]),
  );
  // Each worker's own root CLAUDE.md, read here because the SDK won't load
  // it for bus agents (settingSources lacks 'project'). Injected once on the
  // worker's first turn (see `deliver`). Recomputed automatically on R-B
  // resume since `reconstructOrchestratorSession` rebuilds `p.workers` with
  // each `cwd` and re-enters this function. The orchestrator itself is never
  // in this map — its cwd is the Cebab workspace, not a target project.
  const workerProjectRules = new Map<string, ProjectRules | null>(
    p.workers.map((w) => [w.agentName, readProjectClaudeMd(w.cwd)]),
  );

  const onTeardown = async () => {
    for (const projectId of workerProjectIds) {
      try {
        await uninstallBusForProject(projectId);
      } catch (err) {
        console.warn(`[orchestrator] temp-cleanup uninstall failed for ${projectId}`, err);
      }
    }
    try {
      fs.rmSync(paths.folder, { recursive: true, force: true });
    } catch (err) {
      console.warn('[orchestrator] temp-cleanup rmSync failed', err);
    }
  };

  const abortController = new AbortController();

  // Passive liveness tap on the existing per-turn SDKMessage stream (same
  // observer chain.ts uses). Pure Cebab-side; no agent/prompt/DB change.
  const activity = createAgentActivityObserver((snap) => p.onActivity?.(sessionId, snap));

  // Forward-declared: router ↔ deliver ↔ runner construction cycle (same
  // shape as chain.ts). Reassigned exactly once below.
  // eslint-disable-next-line prefer-const
  let router: OrchestratorRouter;

  const runner = new AgentRunner({
    onEvent: (ev) => router.handleEvent(ev),
    onMessage: (agent, msg) => {
      writeTranscript(paths, iterationId, agent, msg);
      activity.onMessage(agent, msg);
    },
    onSessionId: (agent, cli) => {
      // Persist each agent's `--resume` checkpoint so this session can be
      // reconstructed after a Cebab server restart (R-B). Covers the
      // orchestrator itself and every worker, including mid-run addWorker.
      try {
        upsertAgentSession(sessionId, agent, cli);
      } catch (err) {
        console.error('[orchestrator] persist agent session failed', err);
      }
    },
    abortController,
    runnerFactory: p.runnerFactory,
  });
  runner.register({
    name: ORCHESTRATOR_AGENT_NAME,
    cwd: paths.orchestratorWorkspace,
    settingSources: ['user'],
  });
  for (const w of p.workers) {
    runner.register({ name: w.agentName, cwd: w.cwd, settingSources: ['user'] });
  }

  // R-B: rehydrate each agent's `--resume` checkpoint from the persisted
  // map so its next turn continues its real CLI transcript. Rows for
  // unknown agents are ignored; an agent with no row stays fresh (correct —
  // it never completed a turn before the restart).
  for (const s of p.seededSessions ?? []) {
    if (runner.has(s.agentName)) runner.seedSession(s.agentName, s.cliSessionId);
  }

  // Worker briefing, prepended once to each worker's first turn (mirrors
  // chain.ts). The orchestrator is NEVER prefixed — it learns the protocol
  // from the roster prompt (`renderRosterPrompt`), the only prompt it sees
  // (its workspace is just an empty cwd; `settingSources: ['user']` means a
  // workspace CLAUDE.md would never load). Without this briefing,
  // orchestrator-mode workers have the bus_send tool but no instruction to
  // use it, so their replies are emitted as plain turn text and lost (the
  // install collapse removed the per-project comm.md that used to carry
  // this).
  //
  // R-B: a worker that already spoke in the prior process consumed this
  // briefing (its resumed transcript still has it), so it is pre-marked
  // here and `deliver` won't duplicate it.
  const briefed = new Set<string>(p.briefedAgents ?? []);
  const deliver = (agentName: string, text: string) => {
    let prompt = text;
    if (agentName !== ORCHESTRATOR_AGENT_NAME && !briefed.has(agentName)) {
      briefed.add(agentName);
      // Order: bus protocol → project rules → task (same as chain mode).
      const brief = renderWorkerBriefing({ selfAgent: agentName });
      const pr = workerProjectRules.get(agentName) ?? null;
      prompt = pr ? `${brief}\n\n${pr.framed}\n\n${text}` : `${brief}\n\n${text}`;
      if (pr) {
        // Compact scrollback marker only — the full CLAUDE.md is in the
        // delivered prompt + the on-disk iteration transcript, not echoed
        // into the operator's chat. `router` is always assigned before any
        // `deliver` call (same forward-decl pattern as `addWorker`).
        router.forwardCebabEvent({
          ts: Date.now(),
          source: CEBAB_SOURCE,
          destination: agentName,
          kind: 'intro',
          text: `Cebab injected ${workerProjectNames.get(agentName) ?? agentName}/CLAUDE.md (${pr.sizeLabel}) into ${agentName}'s first turn`,
        });
      }
    }
    void runner
      .deliverTurn(agentName, prompt)
      .catch((err) => {
        console.error(`[orchestrator] deliverTurn(${agentName}) failed`, err);
        void router.teardown('crashed');
      })
      .finally(() => activity.onTurnEnd(agentName));
  };

  router = createOrchestratorRouter({
    sessionId,
    iterationId,
    workerNames,
    paths,
    lifecycle,
    onEvent: p.onEvent,
    onEnded: p.onEnded,
    onTeardown,
    onFinalize: () => activity.dispose(),
    deliver,
  });

  async function addWorker(projectId: number): Promise<AddWorkerResult> {
    if (workerProjectIds.includes(projectId)) {
      throw new Error(`project ${projectId} is already a participant in this session`);
    }
    const busBefore = getProjectBusState(projectId);
    const busWasAlreadyInstalled = busBefore.installed;
    if (!busBefore.installed) {
      await installBusForProject(projectId);
    }
    const newAgent = resolveAgent(projectId);
    runner.register({ name: newAgent.agentName, cwd: newAgent.cwd, settingSources: ['user'] });
    router.registerWorker(newAgent.agentName);
    addParticipant(sessionId, projectId, 'worker', null);
    workerProjectIds.push(projectId);
    workerProjectNames.set(newAgent.agentName, newAgent.projectName);
    // Read the new participant's CLAUDE.md so its first delivered turn
    // injects + marks it via the same `deliver`/`briefed` path as a
    // start-time worker.
    workerProjectRules.set(newAgent.agentName, readProjectClaudeMd(newAgent.cwd));
    const currentWorkers = router.getWorkerNames().map((agentName) => ({
      agentName,
      projectName: workerProjectNames.get(agentName) ?? agentName,
    }));
    const rosterText = renderRosterUpdate({
      newWorker: { agentName: newAgent.agentName, projectName: newAgent.projectName },
      currentWorkers,
      hopBudget: DEFAULT_HOP_BUDGET,
    });
    router.forwardCebabEvent({
      ts: Date.now(),
      source: CEBAB_SOURCE,
      destination: ORCHESTRATOR_AGENT_NAME,
      kind: 'prompt',
      text: rosterText,
    });
    deliver(ORCHESTRATOR_AGENT_NAME, rosterText);
    return { agentName: newAgent.agentName, busWasAlreadyInstalled };
  }

  async function setLifecycleHandle(next: MultiAgentLifecycle): Promise<void> {
    setMultiAgentSessionLifecycle(sessionId, next);
    router.setLifecycle(next);
  }

  const handle: OrchestratorSessionHandle = {
    sessionId,
    iterationId,
    participantAgentNames,
    lifecycle,
    sessionFolder: paths.folder,
    async stop(reason) {
      runner.stop();
      await router.teardown(reason);
    },
    sendUserPrompt: (text) => router.sendUserPrompt(text),
    detach() {
      router.detach();
    },
    addWorker,
    setLifecycle: setLifecycleHandle,
    getCurrentWorkerNames: () => router.getWorkerNames(),
    getCurrentLifecycle: () => router.getLifecycle(),
  };

  registerLiveSession({
    sessionId,
    mode: 'orchestrator',
    handle,
    rebind: (s) => router.rebind(s),
  });

  return { handle, router, deliver };
}

export async function startOrchestratorSession(
  opts: StartOrchestratorOpts,
): Promise<OrchestratorSessionHandle> {
  if (opts.workers.length < 1) {
    throw new Error('orchestrator mode requires at least one worker participant');
  }
  if (!fs.existsSync(opts.workspaceRoot)) {
    throw new Error(`workspaceRoot does not exist: ${opts.workspaceRoot}`);
  }

  const sessionId = crypto.randomUUID();
  const lifecycle: MultiAgentLifecycle = opts.lifecycle ?? 'persistent';
  const participantAgentNames = [ORCHESTRATOR_AGENT_NAME, ...opts.workers.map((w) => w.agentName)];

  const paths = computeSessionPaths(sessionId, opts.workspaceRoot);
  fs.mkdirSync(paths.folder, { recursive: true });
  ensureOrchestratorWorkspace(paths.orchestratorWorkspace);

  const iterationId = nextIterationId(paths);

  createMultiAgentSession(sessionId, 'orchestrator', iterationId, paths.folder, lifecycle);
  opts.workers.forEach((w) => addParticipant(sessionId, w.projectId, 'worker', null));
  prepareIterationDir(iterationId, participantAgentNames, paths);

  const { handle, router, deliver } = wireOrchestratorSession({
    sessionId,
    iterationId,
    lifecycle,
    paths,
    workers: opts.workers,
    onEvent: opts.onEvent,
    onEnded: opts.onEnded,
    onActivity: opts.onActivity,
  });

  // Roster prompt + initial user prompt → UI/DB parity, then delivered as
  // the orchestrator's first turn (was: two inbox messages drained by the
  // Stop hook; now concatenated into one prompt).
  const rosterText = renderRosterPrompt({
    workers: opts.workers.map((w) => ({ agentName: w.agentName, projectName: w.projectName })),
    hopBudget: DEFAULT_HOP_BUDGET,
  });
  router.forwardCebabEvent({
    ts: Date.now(),
    source: CEBAB_SOURCE,
    destination: ORCHESTRATOR_AGENT_NAME,
    kind: 'prompt',
    text: rosterText,
  });
  router.forwardCebabEvent({
    ts: Date.now(),
    source: CEBAB_SOURCE,
    destination: ORCHESTRATOR_AGENT_NAME,
    kind: 'prompt',
    text: opts.initialPrompt,
  });
  deliver(ORCHESTRATOR_AGENT_NAME, `${rosterText}\n\n${opts.initialPrompt}`);

  return handle;
}

/**
 * Re-attach to a still-live orchestrator session (browser reconnect, same
 * process). Returns null when not live — e.g. after a Cebab server restart.
 * That is NOT the end of the story for orchestrated runs: the resume
 * dispatcher (`resume.ts`) then rebuilds the session from persisted state
 * via `reconstruct.ts` (R-B) and re-attaches it READ-ONLY. This function
 * itself is the pure same-process re-attach; it never respawns agents.
 */
export async function resumeOrchestratorSession(
  opts: ResumeOrchestratorOpts,
): Promise<OrchestratorSessionHandle | null> {
  const live = getLiveSession(opts.sessionId);
  if (!live || live.mode !== 'orchestrator') return null;
  live.rebind({ onEvent: opts.onEvent, onEnded: opts.onEnded });
  return live.handle as unknown as OrchestratorSessionHandle;
}

/** Resolve worker project ids to ResolvedAgents. Unchanged. */
export function resolveOrchestratorWorkers(projectIds: number[]): ResolvedAgent[] {
  return projectIds.map((id) => resolveAgent(id));
}
