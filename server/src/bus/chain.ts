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
  addParticipant,
  createMultiAgentSession,
  endMultiAgentSession,
  type EventKind,
  type MultiAgentLifecycle,
} from '../repo/multi_agent.js';
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
};

export type ResumeChainOpts = {
  sessionId: string;
  onEvent: StartChainOpts['onEvent'];
  onEnded: StartChainOpts['onEnded'];
};

export type ChainSessionHandle = {
  sessionId: string;
  iterationId: string;
  participantAgentNames: string[];
  lifecycle: MultiAgentLifecycle;
  sessionFolder: string;
  /** Stop the session and tear it down. Idempotent. */
  stop: (reason: MultiAgentEndedReason) => Promise<void>;
  /** Detach the WS sink without tearing down — agents keep running
   *  in-process; a reconnect re-attaches via the session registry. */
  detach: () => void;
};

type ChainRouter = {
  teardown: (reason: MultiAgentEndedReason) => Promise<void>;
  handleEvent: (ev: BusEvent) => void;
  forwardCebabEvent: (ev: BusEvent) => void;
  detach: () => void;
  rebind: (sink: BusSink) => void;
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
  /** Wake the destination agent with `text` as its next turn. */
  deliver?: (agentName: string, text: string) => void;
}): ChainRouter {
  const { sessionId, iterationId, agentNames, paths, onTeardown, deliver } = params;
  const participantSet = new Set(agentNames);
  const lastPromptForAgent = new Map<string, string>();

  // Mutable WS sink: swapped on reconnect (`rebind`), silenced on `detach`.
  // Persistence + routing keep running regardless so a detached session's
  // events still reach the DB for replay on reconnect.
  let sink: BusSink = { onEvent: params.onEvent, onEnded: params.onEnded };
  let ended = false;

  const teardown = async (reason: MultiAgentEndedReason) => {
    if (ended) return;
    ended = true;
    try {
      endMultiAgentSession(sessionId, reason === 'completed' ? 'completed' : reason);
    } catch (err) {
      console.error('[chain] endMultiAgentSession failed', err);
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

  const handleEvent = (ev: BusEvent) => {
    if (ended) return;
    // F3: source=cebab is Cebab's own traffic, routed in-process via
    //     forwardCebabEvent — never legitimately arriving through an agent.
    if (ev.source === CEBAB_SOURCE) {
      console.warn(`[chain] drop forged source=cebab dest=${ev.destination} kind=${ev.kind}`);
      return;
    }
    // F2: chain terminates at `_sink`, never at `user`. dest=user is a spoof.
    if (ev.destination === USER_RECIPIENT) {
      console.warn(`[chain] drop dest=user from ${ev.source}`);
      return;
    }
    // F2: source must be a known participant. (Defense-in-depth — the
    //     in-process tool already pins an unspoofable source.)
    if (!participantSet.has(ev.source)) {
      console.warn(`[chain] drop event from non-participant source=${ev.source}`);
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
      console.error('[chain] persist event failed', err);
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
    // Fire-and-forget: must NOT block the sending agent's in-flight turn
    // (this runs inside its bus_send tool call). Mirrors the old
    // `sendKeys(...).catch(...)`.
    deliver?.(ev.destination, ev.text);
  };

  // Cebab-originated events (briefings, initial prompt): persist + forward so
  // the operator's scrollback + DB transcript include them. No routing — the
  // briefing/prompt is delivered as the agent's actual turn separately.
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

  return { teardown, handleEvent, forwardCebabEvent, detach, rebind };
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

  const paths = computeSessionPaths(sessionId, opts.workspaceRoot);
  fs.mkdirSync(paths.folder, { recursive: true });

  const iterationId = nextIterationId(paths);

  createMultiAgentSession(sessionId, 'chain', iterationId, paths.folder, lifecycle);
  opts.participants.forEach((p, i) => addParticipant(sessionId, p.projectId, 'worker', i));
  prepareIterationDir(iterationId, agentNames, paths);

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
  // project's own root CLAUDE.md is read here too (the SDK can't auto-load
  // it for bus agents — settingSources lacks 'project') and injected on the
  // same first turn; null when the project has none.
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

  // Forward-declared: router ↔ deliver ↔ runner form a construction cycle
  // (router needs `deliver`; deliver needs `runner`; runner.onEvent needs
  // `router`). Reassigned exactly once, just below.
  // eslint-disable-next-line prefer-const
  let router: ChainRouter;

  const runner = new AgentRunner({
    onEvent: (ev) => router.handleEvent(ev),
    onMessage: (agent, msg) => writeTranscript(paths, iterationId, agent, msg),
    abortController,
    runnerFactory: opts.runnerFactory,
  });
  for (const p of opts.participants) {
    runner.register({ name: p.agentName, cwd: p.cwd, settingSources: ['user'] });
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
    void runner.deliverTurn(agentName, prompt).catch((err) => {
      console.error(`[chain] deliverTurn(${agentName}) failed`, err);
      void router.teardown('crashed');
    });
  };

  router = createChainRouter({
    sessionId,
    iterationId,
    agentNames,
    paths,
    onEvent: opts.onEvent,
    onEnded: opts.onEnded,
    onTeardown,
    deliver,
  });

  const handle: ChainSessionHandle = {
    sessionId,
    iterationId,
    participantAgentNames: agentNames,
    lifecycle,
    sessionFolder: paths.folder,
    async stop(reason) {
      runner.stop();
      await router.teardown(reason);
    },
    detach() {
      router.detach();
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
  live.rebind({ onEvent: opts.onEvent, onEnded: opts.onEnded });
  return live.handle as ChainSessionHandle;
}

/** Build the resolved-agent list from project ids. Throws on the first
 *  unresolvable id so the caller can surface a typed error. Unchanged. */
export function resolveChainParticipants(projectIds: number[]): ResolvedAgent[] {
  return projectIds.map((id) => resolveAgent(id));
}
