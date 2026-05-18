/**
 * Canonical orchestrator workspace generator.
 *
 * The orchestrator is Cebab's own bus agent — used in orchestrator-routed
 * mode to receive user prompts, route them to participant workers, and
 * reply back to the user. Its bus name is always `orchestrator`.
 *
 * Unlike worker projects (operator-owned), the orchestrator workspace is
 * Cebab-owned end-to-end: we ship a static CLAUDE.md template and generate
 * comm.md from code, overwriting them on every call so a Cebab upgrade can
 * roll out new behaviour without manual intervention by the operator. No
 * settings.json is written — the orchestrator runs with
 * `settingSources: ['user']`, so a workspace settings.json would never be
 * read (its old Stop hook / bus-script perms are dead under pure-SDK).
 *
 * Layout produced by `ensureOrchestratorWorkspace()`:
 *
 *   <workspaceDir>/
 *     CLAUDE.md              # static template + path substitution
 *     .cebab/comm.md         # rendered protocol doc (imported via @.cebab/comm.md)
 *
 * The legacy global `~/.cebab/orchestrator/` path is the default `targetDir`
 * for callers that don't pass one (pre-007 backwards compat + unit tests).
 * Post-007 sessions pass `<sessionFolder>/orchestrator/` so each session has
 * its own orchestrator workspace.
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
import { fileURLToPath } from 'node:url';
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
import {
  computeSessionPaths,
  orchestratorWorkspaceDir,
  PROJECT_COMM_MD_REL,
  projectCebabDir,
  projectCommMdPath,
  type SessionPaths,
} from './paths.js';
import { renderCommMd } from './comm.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMM_PATH_PLACEHOLDER = '{{BUS_COMM_PATH}}';

/**
 * Find the orchestrator template directory. Mirrors `scriptsSourceDir` in
 * install.ts: `tsx` runs from src/, so `__dirname/orchestrator-template`
 * works; for a built dist/ runtime the fallback path points back at the
 * source tree (we don't currently copy data files into dist/).
 */
function templateSourceDir(): string {
  const candidates = [
    path.join(__dirname, 'orchestrator-template'),
    path.join(__dirname, '..', '..', 'src', 'bus', 'orchestrator-template'),
  ];
  for (const d of candidates) {
    if (fs.existsSync(path.join(d, 'CLAUDE.md'))) return d;
  }
  throw new Error(`orchestrator template dir not found; tried: ${candidates.join(', ')}`);
}

export type EnsureOrchestratorResult = {
  workspaceDir: string;
  claudeMd: 'created' | 'updated' | 'unchanged';
  commMd: 'created' | 'updated' | 'unchanged';
};

/**
 * Generate (or refresh) the orchestrator workspace. Idempotent; compares
 * rendered content against the existing file and only writes on
 * difference, so a stable call leaves mtimes alone. Always overwrites
 * stale content — Cebab owns this workspace, so an upgrade that changes
 * the template wins.
 *
 * Both modes write comm.md INSIDE the workspace (`<wsDir>/.cebab/comm.md`)
 * so the `@import` line in CLAUDE.md is workspace-relative.
 */
export function ensureOrchestratorWorkspace(targetDir?: string): EnsureOrchestratorResult {
  const wsDir = targetDir ?? orchestratorWorkspaceDir();
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(projectCebabDir(wsDir), { recursive: true });

  const templateDir = templateSourceDir();
  const rawTemplate = fs.readFileSync(path.join(templateDir, 'CLAUDE.md'), 'utf8');
  const claudeMdContent = renderClaudeMd(rawTemplate);
  const claudeMd = writeIfChanged(path.join(wsDir, 'CLAUDE.md'), claudeMdContent);

  const commMd = writeIfChanged(projectCommMdPath(wsDir), renderCommMd(ORCHESTRATOR_AGENT_NAME));

  return { workspaceDir: wsDir, claudeMd, commMd };
}

/**
 * Substitute the `{{BUS_COMM_PATH}}` placeholder with the workspace-
 * relative path to comm.md (`.cebab/comm.md`).
 */
function renderClaudeMd(template: string): string {
  return template.split(COMM_PATH_PLACEHOLDER).join(PROJECT_COMM_MD_REL);
}

function writeIfChanged(filePath: string, content: string): 'created' | 'updated' | 'unchanged' {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  if (existing === content) return 'unchanged';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return existing === null ? 'created' : 'updated';
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
  deliver?: (agentName: string, text: string) => void;
}): OrchestratorRouter {
  const { sessionId, iterationId, workerNames, onTeardown, deliver } = params;
  const workerNamesMut: string[] = [...workerNames];
  const workerSet = new Set(workerNamesMut);
  let lifecycleRef: MultiAgentLifecycle = params.lifecycle;

  let sink: BusSink = { onEvent: params.onEvent, onEnded: params.onEnded };
  let ended = false;

  const teardown = async (reason: MultiAgentEndedReason) => {
    if (ended) return;
    ended = true;
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

  // Forward-declared: router ↔ deliver ↔ runner construction cycle (same
  // shape as chain.ts). Reassigned exactly once below.
  // eslint-disable-next-line prefer-const
  let router: OrchestratorRouter;

  const runner = new AgentRunner({
    onEvent: (ev) => router.handleEvent(ev),
    onMessage: (agent, msg) => writeTranscript(paths, iterationId, agent, msg),
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
  // from its Cebab-generated workspace CLAUDE.md + the roster prompt. Without
  // this, orchestrator-mode workers have the bus_send tool but no
  // instruction to use it, so their replies are emitted as plain turn text
  // and lost (the install collapse removed the per-project comm.md that
  // used to carry this).
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
    void runner.deliverTurn(agentName, prompt).catch((err) => {
      console.error(`[orchestrator] deliverTurn(${agentName}) failed`, err);
      void router.teardown('crashed');
    });
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
