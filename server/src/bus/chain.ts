/**
 * Fixed-chain (Pattern B) orchestrator.
 *
 * Lifecycle of one chain run:
 *   1. Validate participants resolve to bus-installed agents.
 *   2. Create the DB session + participant rows.
 *   3. Allocate `iterations/NNN/` and per-agent subdirs on disk.
 *   4. Build the event router and start the bus log tailer (positioned at
 *      EOF so we don't replay events from prior runs).
 *   5. Spawn a detached tmux session, one window per participant, each
 *      running `claude` in the participant's cwd.
 *   6. Wait briefly for the TUIs to initialize.
 *   7. Write a per-step "briefing" message to each participant's inbox
 *      (who they are, who they forward to).
 *   8. Write the initial task input to participant[0]'s inbox.
 *   9. Wake participant[0] via `tmux send-keys "Check inbox" Enter`. Their
 *      Stop hook drains the inbox (briefing + input concatenated) and
 *      feeds it as the next prompt.
 *  10. On each observed bus event:
 *        - persist to `multi_agent_events`
 *        - hand to the caller's onEvent (becomes a `multi_agent_event` WS
 *          message)
 *        - archive the source agent's hop (`prompt.md` / `reply.md`)
 *        - wake the destination agent if it's another participant; if it's
 *          the `_sink` sentinel, the chain is complete — tear down and
 *          fire `onEnded('completed', iterationId)`.
 *
 * After a Cebab restart, `resumeChainSession` re-attaches to a still-living
 * tmux session by reading the DB row + participants and reusing the same
 * router factory — see the comment on `createChainRouter` for why both the
 * start and resume paths share that piece.
 *
 * Failure modes the caller might see (via `onEnded('crashed', null)` or
 * a throw from `startChainSession`):
 *   - tmux not installed → throw before any state is committed
 *   - any participant lacks bus integration → throw before tmux
 *   - in-flight crash (e.g. tmux session vanished) → onEnded('crashed', ...)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendMultiAgentEvent,
  addParticipant,
  createMultiAgentSession,
  endMultiAgentSession,
  getMultiAgentSession,
  listResolvedParticipants,
  type EventKind,
  type MultiAgentLifecycle,
} from '../repo/multi_agent.js';
import {
  archiveAgentHop,
  BUS_CLAUDE_COMMAND,
  CEBAB_SOURCE,
  nextIterationId,
  prepareIterationDir,
  renderChainBriefing,
  resolveAgent,
  SINK_RECIPIENT,
  USER_RECIPIENT,
  writeInboxMessage,
  type MultiAgentEndedReason,
  type ResolvedAgent,
} from './runtime.js';
import { tailBusLog, type BusLogEvent, type BusLogTailerHandle } from './log_tailer.js';
import { ensureBusBootstrap, uninstallBusForProject } from './install.js';
import {
  dismissBypassPermissionsModal,
  hasSession,
  killSession,
  newSession,
  newWindow,
  pipePane,
  sendKeys,
  tmuxAvailable,
  TmuxNotInstalled,
} from './tmux.js';
import {
  computeSessionPaths,
  legacyGlobalSessionPaths,
  sessionPathsFromFolder,
  type SessionPaths,
} from './paths.js';

/** Milliseconds to wait after tmux window creation before sending the first
 *  wakeup. Picked empirically — claude TUI is usually interactive within
 *  ~2-3s on a warm cache. Conservative to avoid lost keystrokes. */
const TUI_WARMUP_MS = 5000;

/** What we type into the recipient's TUI to nudge a turn. Anything that
 *  triggers Claude to respond is fine — the actual inbox drain happens in
 *  the Stop hook after that response. Keep it short to minimize tokens. */
const WAKE_TEXT = 'Check inbox.';

export type StartChainOpts = {
  participants: ResolvedAgent[];
  initialPrompt: string;
  /**
   * Absolute path to the operator's workspace root. The per-session
   * folder (`<workspaceRoot>/.cebab-session-<id>/`) holds the live bus
   * traffic + iteration artifacts for this run. Caller should validate
   * that this resolves to an existing directory before calling.
   */
  workspaceRoot: string;
  /**
   * Lifecycle for this session. 'persistent' (default) leaves the
   * session folder + DB row alone on End. 'temp' triggers folder rm-rf
   * + bus uninstall per participant when the session ends with reason
   * 'completed' or 'stopped' (NOT 'crashed' — that preserves evidence).
   */
  lifecycle?: MultiAgentLifecycle;
  /**
   * Per-event callback. `sessionId` is passed explicitly (not closed over by
   * the caller) so callbacks that fire DURING the `await startChainSession`
   * — i.e. while the caller's `const handle = ...` is still in TDZ — can
   * still address the right session without ReferenceError. The early
   * writes (briefings, initial input) plus the 5-second TUI warmup means
   * this window is wide; the tailer reliably fires inside it.
   */
  onEvent: (sessionId: string, ev: BusLogEvent, dbEventId: number) => void;
  onEnded: (sessionId: string, reason: MultiAgentEndedReason, iterationId: string | null) => void;
};

export type ResumeChainOpts = {
  sessionId: string;
  onEvent: StartChainOpts['onEvent'];
  onEnded: StartChainOpts['onEnded'];
};

export type ChainSessionHandle = {
  sessionId: string;
  iterationId: string;
  tmuxSession: string;
  participantAgentNames: string[];
  /** Lifecycle this session was started with. Reused on resume — also
   *  surfaced to the WS layer for the `multi_agent_started` broadcast. */
  lifecycle: MultiAgentLifecycle;
  /** Absolute path to this session's on-disk folder. */
  sessionFolder: string;
  /** Stop the session and tear down tmux. Idempotent. */
  stop: (reason: MultiAgentEndedReason) => Promise<void>;
  /**
   * Detach Cebab from the session without killing tmux. Stops the bus log
   * tailer and marks the router inert so future bus events don't get
   * processed by this handle's closures. The tmux session itself, and the
   * DB row's `status='running'`, stay untouched — a future WS connect
   * can call `resumeChainSession` to re-attach.
   *
   * Used by the WS close handler so that browser refresh / tab close
   * doesn't tear down the chain. Idempotent.
   */
  detach: () => void;
};

/**
 * Build the event router for a chain session. Returns the per-event handler,
 * the teardown closure, and a function to attach a bus tailer.
 *
 * Factored out of `startChainSession` so the resume path can reuse exactly
 * the same routing semantics on a re-attached tmux session. The state held
 * inside the closure (`ended`, `tailer`, `lastPromptForAgent`) is rebuilt
 * empty on resume — we accept that the first post-resume hop will have an
 * empty `prompt.md` archived alongside its reply, because tracking
 * already-archived hops across restart isn't worth the bookkeeping in v1.
 */
function createChainRouter(params: {
  sessionId: string;
  iterationId: string;
  agentNames: string[];
  tmuxSessionName: string;
  paths: SessionPaths;
  onEvent: StartChainOpts['onEvent'];
  onEnded: StartChainOpts['onEnded'];
  /** Optional cleanup hook invoked AFTER tmux kill + DB mark and BEFORE
   *  `onEnded`. Used for lifecycle='temp' to uninstall bus from each
   *  participant + rm-rf the session folder. Runs only on the 'completed'
   *  and 'stopped' reasons (NOT 'crashed' — preserves evidence). */
  onTeardown?: (reason: MultiAgentEndedReason) => Promise<void>;
}): {
  teardown: (reason: MultiAgentEndedReason) => Promise<void>;
  handleEvent: (ev: BusLogEvent) => void;
  attachTailer: () => BusLogTailerHandle;
  detach: () => void;
  /** Persist + WS-forward a Cebab-originated event. Mirrors orchestrator
   *  mode — see `createOrchestratorRouter` for the rationale. */
  forwardCebabEvent: (ev: BusLogEvent) => void;
} {
  const {
    sessionId,
    iterationId,
    agentNames,
    tmuxSessionName,
    paths,
    onEvent,
    onEnded,
    onTeardown,
  } = params;
  const lastPromptForAgent = new Map<string, string>();
  const participantSet = new Set(agentNames);
  const tmuxTarget = (agentName: string) => `${tmuxSessionName}:${agentName}`;

  // Tail the per-session bus.log so the tailer reads from this session's
  // stream only — historical events from other sessions live in their own
  // session folders and don't fire here.
  const busLogPath = paths.busLog;

  let ended = false;
  let tailer: BusLogTailerHandle | null = null;

  const teardown = async (reason: MultiAgentEndedReason) => {
    if (ended) return;
    ended = true;
    tailer?.stop();
    try {
      await killSession(tmuxSessionName);
    } catch (err) {
      console.warn(`[chain] killSession(${tmuxSessionName}) failed`, err);
    }
    try {
      endMultiAgentSession(sessionId, reason === 'completed' ? 'completed' : reason);
    } catch (err) {
      console.error('[chain] endMultiAgentSession failed', err);
    }
    // Run any caller-supplied cleanup (e.g. temp-mode uninstall + rm-rf).
    // Skip on 'crashed' so the operator can inspect what went wrong.
    if (onTeardown && reason !== 'crashed') {
      try {
        await onTeardown(reason);
      } catch (err) {
        console.error('[chain] onTeardown failed', err);
      }
    }
    onEnded(sessionId, reason, reason === 'completed' ? iterationId : null);
  };

  const handleEvent = (ev: BusLogEvent) => {
    if (ended) return;
    // F3: same rationale as orchestrator.handleEvent — Cebab routes its
    //     own events in-process; an on-disk source=cebab observed via
    //     the tailer is a forgery.
    if (ev.source === CEBAB_SOURCE) {
      console.warn(`[chain] drop forged source=cebab dest=${ev.destination} kind=${ev.kind}`);
      return;
    }
    // F2: chain mode legitimately has worker→next-worker traffic (that's
    //     the pipeline), but `dest=user` is never legitimate in chain
    //     mode — the chain terminates at `_sink`, never at `user`. Drop
    //     spoofed user replies hard.
    if (ev.destination === USER_RECIPIENT) {
      console.warn(`[chain] drop dest=user from ${ev.source}`);
      return;
    }
    // F2: the `source` must be a known participant. Cebab itself uses
    //     CEBAB_SOURCE for briefings (filtered above); the only other
    //     legitimate sources are the participants themselves.
    if (!participantSet.has(ev.source)) {
      console.warn(`[chain] drop event from non-participant source=${ev.source}`);
      return;
    }
    // 1. Persist.
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
    // 2. Forward to WS.
    try {
      onEvent(sessionId, ev, dbId);
    } catch (err) {
      console.error('[chain] onEvent callback threw', err);
    }

    // 3. Archive source agent's hop (their prompt + this outgoing reply).
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

    // Remember this message as the destination's incoming prompt for next-hop archival.
    lastPromptForAgent.set(ev.destination, ev.text);

    if (ev.destination === SINK_RECIPIENT) {
      // Chain complete. Write an iteration-level final.md so the operator
      // sees the end-state at the top of the iteration dir.
      try {
        const finalPath = path.join(paths.iterationDir(iterationId), 'final.md');
        fs.writeFileSync(finalPath, ev.text);
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
    sendKeys(tmuxTarget(ev.destination), [WAKE_TEXT, 'Enter']).catch((err) => {
      console.warn(`[chain] sendKeys to ${ev.destination} failed`, err);
    });
  };

  const attachTailer = (): BusLogTailerHandle => {
    // Tail the per-session bus.log specifically — each session has its
    // own append-only log inside its folder. Tailer starts at EOF (default)
    // so it doesn't replay events from past Cebab runs.
    tailer = tailBusLog({ onEvent: handleEvent, path: busLogPath });
    return tailer;
  };

  const detach = (): void => {
    if (ended) return;
    ended = true;
    tailer?.stop();
  };

  // F3 round-2: see createOrchestratorRouter.forwardCebabEvent for the
  //              shared rationale. Briefings + initial chain prompt come
  //              from Cebab; without this in-process forwarding the
  //              tailer-side `source=cebab` drop would silently swallow
  //              them and the operator's UI would only see participant
  //              traffic (no roster, no initial input).
  const forwardCebabEvent = (ev: BusLogEvent): void => {
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
      onEvent(sessionId, ev, dbId);
    } catch (err) {
      console.error('[chain] cebab onEvent threw', err);
    }
  };

  return { teardown, handleEvent, attachTailer, detach, forwardCebabEvent };
}

export async function startChainSession(opts: StartChainOpts): Promise<ChainSessionHandle> {
  if (!(await tmuxAvailable())) throw new TmuxNotInstalled();
  if (opts.participants.length < 2) {
    throw new Error('chain mode requires at least two participants');
  }
  if (!fs.existsSync(opts.workspaceRoot)) {
    throw new Error(`workspaceRoot does not exist: ${opts.workspaceRoot}`);
  }

  ensureBusBootstrap();

  const sessionId = crypto.randomUUID();
  const tmuxSessionName = `cebab-bus-${sessionId.slice(0, 8)}`;
  const lifecycle: MultiAgentLifecycle = opts.lifecycle ?? 'persistent';
  const agentNames = opts.participants.map((p) => p.agentName);
  const projectIds = opts.participants.map((p) => p.projectId);

  // Per-session folder under the workspace. Created up-front so subsequent
  // mkdirs / file writes can rely on it. The dot prefix hides it from
  // Finder and from `syncWorkspaceProjects` (which already filters
  // `.`-prefixed entries).
  const paths = computeSessionPaths(sessionId, opts.workspaceRoot);
  fs.mkdirSync(paths.folder, { recursive: true });

  // Iteration id is now per-session (lives inside paths.folder/iterations/),
  // so every fresh session starts at '001'. That's intentional — the id is
  // just a local label inside this folder, not a global counter.
  const iterationId = nextIterationId(paths);

  createMultiAgentSession(
    sessionId,
    'chain',
    tmuxSessionName,
    iterationId,
    paths.folder,
    lifecycle,
  );
  opts.participants.forEach((p, i) => {
    addParticipant(sessionId, p.projectId, 'worker', i);
  });

  prepareIterationDir(iterationId, agentNames, paths);

  // Temp-mode cleanup hook: uninstall bus from each participant + rm-rf
  // the session folder. Only fires on 'completed' / 'stopped' (the
  // router skips 'crashed' so the operator can inspect).
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

  const router = createChainRouter({
    sessionId,
    iterationId,
    agentNames,
    tmuxSessionName,
    paths,
    onEvent: opts.onEvent,
    onEnded: opts.onEnded,
    onTeardown,
  });

  // Start the tailer BEFORE we write any briefings so no event is missed.
  router.attachTailer();

  // Spawn tmux session + one window per participant. BUS_SESSION_ROOT
  // points the bus scripts at this session's per-folder inboxes/archive/
  // bus.log. BUS_AGENT_NAME tells them who's calling.
  try {
    await newSession({
      name: tmuxSessionName,
      windowName: opts.participants[0]!.agentName,
      cwd: opts.participants[0]!.cwd,
      // Bus panes (workers + orchestrator) all run with
      // `--permission-mode bypassPermissions` because they're headless
      // tmux panes — any per-tool permission prompt hangs the agent
      // indefinitely (verified in session 4946d15f, where obsidian-agent
      // stalled on a `find` prompt, and again in e82d6912 where the
      // orchestrator stalled on a bash pipeline). Trust gate: the
      // operator's per-project "Install bus integration" click; see
      // BUS_CLAUDE_COMMAND doc in runtime.ts + CLAUDE.md.
      command: BUS_CLAUDE_COMMAND,
      env: {
        BUS_AGENT_NAME: opts.participants[0]!.agentName,
        BUS_SESSION_ROOT: paths.folder,
      },
    });
    await pipePane(
      tmuxTarget(tmuxSessionName, opts.participants[0]!.agentName),
      path.join(paths.iterationDir(iterationId, opts.participants[0]!.agentName), 'transcript.log'),
    );
    for (let i = 1; i < opts.participants.length; i++) {
      const p = opts.participants[i]!;
      await newWindow({
        sessionName: tmuxSessionName,
        windowName: p.agentName,
        cwd: p.cwd,
        command: BUS_CLAUDE_COMMAND,
        env: { BUS_AGENT_NAME: p.agentName, BUS_SESSION_ROOT: paths.folder },
      });
      await pipePane(
        tmuxTarget(tmuxSessionName, p.agentName),
        path.join(paths.iterationDir(iterationId, p.agentName), 'transcript.log'),
      );
    }

    // Dismiss claude-code's "Bypass Permissions mode" startup warning
    // modal in every worker pane (all bus panes use BUS_CLAUDE_COMMAND,
    // which carries the bypass flag). The modal appears on every launch
    // and its default option is "No, exit" — skipping the dismiss step
    // would mean our first wake's `Enter` kills the worker. Parallel
    // across workers so total delay is bounded by one modal-render
    // time, not N. See `dismissBypassPermissionsModal` for the full
    // rationale.
    await Promise.all(
      opts.participants.map((p) =>
        dismissBypassPermissionsModal(tmuxTarget(tmuxSessionName, p.agentName)),
      ),
    );
  } catch (err) {
    // Half-spawned: tear down what we made and bail.
    console.error('[chain] tmux spawn failed', err);
    await router.teardown('crashed');
    throw err;
  }

  // Briefings (parallel — they're independent file writes).
  // F3 round-2: forwardCebabEvent so each briefing reaches the UI + DB.
  opts.participants.forEach((p, i) => {
    const nextHop =
      i === opts.participants.length - 1 ? SINK_RECIPIENT : opts.participants[i + 1]!.agentName;
    const briefing = renderChainBriefing({
      iterationId,
      position: i + 1,
      totalSteps: opts.participants.length,
      selfAgent: p.agentName,
      participantNames: agentNames,
      nextHop,
    });
    const briefingEv = writeInboxMessage({
      recipient: p.agentName,
      source: CEBAB_SOURCE,
      text: briefing,
      kind: 'intro',
      paths,
    });
    router.forwardCebabEvent(briefingEv);
  });

  // Initial task input goes to participant[0]'s inbox after the briefing so
  // the Stop hook concatenation order is [briefing, then input].
  const initialEv = writeInboxMessage({
    recipient: opts.participants[0]!.agentName,
    source: CEBAB_SOURCE,
    text: opts.initialPrompt,
    kind: 'prompt',
    paths,
  });
  router.forwardCebabEvent(initialEv);

  // Wait for the TUIs to be ready, then nudge participant[0]. We don't
  // poll capture-pane in v1 — a fixed delay is good enough on a fresh
  // claude cache. PR 6 can refine if it proves flaky.
  await new Promise((r) => setTimeout(r, TUI_WARMUP_MS));
  try {
    if (await hasSession(tmuxSessionName)) {
      await sendKeys(tmuxTarget(tmuxSessionName, opts.participants[0]!.agentName), [
        WAKE_TEXT,
        'Enter',
      ]);
    } else {
      await router.teardown('crashed');
    }
  } catch (err) {
    console.error('[chain] initial wake failed', err);
    await router.teardown('crashed');
  }

  return {
    sessionId,
    iterationId,
    tmuxSession: tmuxSessionName,
    participantAgentNames: agentNames,
    lifecycle,
    sessionFolder: paths.folder,
    async stop(reason) {
      await router.teardown(reason);
    },
    detach: router.detach,
  };
}

/**
 * Re-attach to a still-running chain session after a Cebab restart.
 *
 * Returns `null` if the session can't be resumed for any of these reasons:
 *   - no matching DB row, or it's not a `chain` row
 *   - DB row is not in `running` status
 *   - DB row has no `tmux_session` or `iteration_id` (pre-006 rows fall
 *     into the latter category)
 *   - tmux isn't installed, or the named session is gone
 *   - one of the participant projects no longer has bus integration
 *
 * On a `null` return the caller is expected to mark the row `crashed` —
 * the session is dead and we can't recover its routing. On a non-null
 * return, the session is fully wired again: new bus events will flow
 * through `onEvent`, and `stop()` works the same as on a freshly-started
 * session.
 */
export async function resumeChainSession(
  opts: ResumeChainOpts,
): Promise<ChainSessionHandle | null> {
  const row = getMultiAgentSession(opts.sessionId);
  if (!row) return null;
  if (row.mode !== 'chain') return null;
  if (row.status !== 'running') return null;
  if (!row.tmux_session) return null;
  if (!row.iteration_id) return null;

  if (!(await tmuxAvailable())) return null;
  if (!(await hasSession(row.tmux_session))) return null;

  const participants = listResolvedParticipants(opts.sessionId);
  if (participants.length < 2) return null;
  const agentNames: string[] = [];
  const projectIds: number[] = [];
  for (const p of participants) {
    if (!p.bus_agent_name) return null;
    agentNames.push(p.bus_agent_name);
    projectIds.push(p.project_id);
  }

  // Rebuild SessionPaths from the persisted session_folder. Pre-007 rows
  // have NULL session_folder — fall back to the legacy global layout so
  // their inboxes/archive/bus.log keep resolving to `~/.cebab/bus/`.
  const paths = row.session_folder
    ? sessionPathsFromFolder(row.session_folder)
    : legacyGlobalSessionPaths();
  const lifecycle = (row.lifecycle as MultiAgentLifecycle | undefined) ?? 'persistent';

  const onTeardown: ((reason: MultiAgentEndedReason) => Promise<void>) | undefined =
    lifecycle === 'temp' && row.session_folder
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

  const router = createChainRouter({
    sessionId: opts.sessionId,
    iterationId: row.iteration_id,
    agentNames,
    tmuxSessionName: row.tmux_session,
    paths,
    onEvent: opts.onEvent,
    onEnded: opts.onEnded,
    onTeardown,
  });
  router.attachTailer();

  return {
    sessionId: opts.sessionId,
    iterationId: row.iteration_id,
    tmuxSession: row.tmux_session,
    participantAgentNames: agentNames,
    lifecycle,
    sessionFolder: paths.folder,
    async stop(reason) {
      await router.teardown(reason);
    },
    detach: router.detach,
  };
}

/** Helper: tmux target spec (`<session>:<window>`) for a given agent. */
function tmuxTarget(tmuxSessionName: string, agentName: string): string {
  return `${tmuxSessionName}:${agentName}`;
}

/** Build the list of resolved agents from project ids. Throws on the first
 *  unresolvable id so the caller can surface a typed error before any tmux
 *  state exists. */
export function resolveChainParticipants(projectIds: number[]): ResolvedAgent[] {
  return projectIds.map((id) => resolveAgent(id));
}
