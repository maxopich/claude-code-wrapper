/**
 * Canonical orchestrator workspace generator.
 *
 * The orchestrator is Cebab's own bus agent — used in orchestrator-routed
 * mode to receive user prompts, route them to participant workers, and
 * reply back to the user. Its bus name is always `orchestrator`.
 *
 * Unlike worker projects (operator-owned), the orchestrator workspace is
 * Cebab-owned end-to-end: we ship a static CLAUDE.md template, generate
 * comm.md and `.claude/settings.json` from code, and overwrite them on
 * every call so a Cebab upgrade can roll out new behaviour without manual
 * intervention by the operator.
 *
 * Layout produced by `ensureOrchestratorWorkspace()`:
 *
 *   <workspaceDir>/
 *     CLAUDE.md              # static template + path substitution
 *     .cebab/comm.md         # rendered protocol doc (imported via @.cebab/comm.md)
 *     .claude/
 *       settings.json        # BUS_AGENT_NAME, bus-script perms, Stop hook
 *
 * The legacy global `~/.cebab/orchestrator/` path is the default `targetDir`
 * for callers that don't pass one (pre-007 backwards compat + unit tests).
 * Post-007 sessions pass `<sessionFolder>/orchestrator/` so each session has
 * its own orchestrator workspace.
 *
 * The function does NOT spawn claude or otherwise launch the orchestrator
 * — PR 5 wires that. PR 4's contract is "the workspace is ready to be
 * launched". Idempotent: a no-op call returns all-`unchanged` results.
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
  getMultiAgentSession,
  listResolvedParticipants,
  type EventKind,
  type MultiAgentLifecycle,
} from '../repo/multi_agent.js';
import {
  busBinDir,
  computeSessionPaths,
  legacyGlobalSessionPaths,
  orchestratorWorkspaceDir,
  PROJECT_COMM_MD_REL,
  projectCebabDir,
  projectCommMdPath,
  sessionPathsFromFolder,
  type SessionPaths,
} from './paths.js';
import { renderCommMd } from './comm.js';
import { ensureBusBootstrap, uninstallBusForProject } from './install.js';
import { tailBusLog, type BusLogEvent, type BusLogTailerHandle } from './log_tailer.js';
import {
  BUS_CLAUDE_COMMAND,
  CEBAB_SOURCE,
  nextIterationId,
  prepareIterationDir,
  renderRosterPrompt,
  resolveAgent,
  SINK_RECIPIENT,
  USER_RECIPIENT,
  writeInboxMessage,
  type MultiAgentEndedReason,
  type ResolvedAgent,
} from './runtime.js';
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

/** Bus agent name for the orchestrator. Reserved; no project may use it. */
export const ORCHESTRATOR_AGENT_NAME = 'orchestrator';

/**
 * Soft cap on `prompt` → `reply` hops per user prompt. Surfaced here so
 * PR 5's intro message and any future UI display can pull from one source.
 */
export const DEFAULT_HOP_BUDGET = 8;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCRIPT_FILES = ['bus-send-msg.sh', 'bus-check-inbox.sh', 'bus-status.sh'] as const;

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
  settingsJson: 'created' | 'updated' | 'unchanged';
};

/**
 * Generate (or refresh) the orchestrator workspace. Idempotent; compares
 * rendered content against the existing file and only writes on
 * difference, so a stable call leaves mtimes alone. Always overwrites
 * stale content — Cebab owns this workspace, so an upgrade that changes
 * the template wins.
 *
 * Two call modes:
 *   - `ensureOrchestratorWorkspace()` (no arg): writes to the legacy
 *     global `~/.cebab/orchestrator/`. Used by pre-007 callers and unit
 *     tests that don't care about per-session folders.
 *   - `ensureOrchestratorWorkspace(targetDir)`: writes to the explicit
 *     directory (typically `paths.orchestratorWorkspace` for a per-
 *     session folder). Post-007 sessions use this so each session has
 *     its own orchestrator workspace inside its session folder.
 *
 * Both modes write comm.md INSIDE the workspace (`<wsDir>/.cebab/comm.md`)
 * so the `@import` line in CLAUDE.md is workspace-relative — external
 * imports trigger claude-code's startup trust modal, which silently
 * eats the first wake keystroke when there's no human to dismiss it.
 * See `paths.ts` header for the full story.
 */
export function ensureOrchestratorWorkspace(targetDir?: string): EnsureOrchestratorResult {
  // Bus root + scripts (stable global state). Safe to call repeatedly.
  ensureBusBootstrap();

  const wsDir = targetDir ?? orchestratorWorkspaceDir();
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(path.join(wsDir, '.claude'), { recursive: true });
  // .cebab/ dir for the comm.md — sibling to .claude/. Hidden dot-prefix
  // matches the per-project convention used by worker installs.
  fs.mkdirSync(projectCebabDir(wsDir), { recursive: true });

  // 1. CLAUDE.md — static prose with one path placeholder that
  //    substitutes to the workspace-relative comm.md path.
  const templateDir = templateSourceDir();
  const rawTemplate = fs.readFileSync(path.join(templateDir, 'CLAUDE.md'), 'utf8');
  const claudeMdContent = renderClaudeMd(rawTemplate);
  const claudeMd = writeIfChanged(path.join(wsDir, 'CLAUDE.md'), claudeMdContent);

  // 2. comm.md — fully derived from the agent name. Written inside the
  //    workspace's `.cebab/` so the @import line stays internal.
  const commMd = writeIfChanged(projectCommMdPath(wsDir), renderCommMd(ORCHESTRATOR_AGENT_NAME));

  // 3. .claude/settings.json — fresh write, no operator content to merge.
  const settingsJson = writeIfChanged(
    path.join(wsDir, '.claude', 'settings.json'),
    renderOrchestratorSettingsJson(),
  );

  return {
    workspaceDir: wsDir,
    claudeMd,
    commMd,
    settingsJson,
  };
}

/**
 * Substitute the `{{BUS_COMM_PATH}}` placeholder with the workspace-
 * relative path to comm.md (`.cebab/comm.md`). Project-relative — keeps
 * the import internal so claude-code doesn't show its external-import
 * trust modal at TUI startup.
 */
function renderClaudeMd(template: string): string {
  return template.split(COMM_PATH_PLACEHOLDER).join(PROJECT_COMM_MD_REL);
}

/**
 * Render the orchestrator's `.claude/settings.json` from scratch. Mirrors
 * the shape `mergeSettings` would produce for a worker named `orchestrator`,
 * but without the merge dance — Cebab owns this file.
 */
function renderOrchestratorSettingsJson(): string {
  const bin = busBinDir();
  const settings = {
    env: {
      BUS_AGENT_NAME: ORCHESTRATOR_AGENT_NAME,
    },
    permissions: {
      allow: SCRIPT_FILES.map((s) => `Bash(${path.join(bin, s)}:*)`),
    },
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `${path.join(bin, 'bus-check-inbox.sh')} ${ORCHESTRATOR_AGENT_NAME}`,
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(settings, null, 2) + '\n';
}

function writeIfChanged(filePath: string, content: string): 'created' | 'updated' | 'unchanged' {
  // Try-read instead of existsSync+read: collapses the check and the
  // operation into a single fs call, so there's no TOCTOU window where
  // an attacker could swap the path between an existence check and the
  // subsequent write. (In our context the workspace is operator-owned
  // and there's no realistic attacker, but the simpler control flow is
  // also genuinely nicer to read.)
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // Most commonly ENOENT — the file doesn't exist yet. Any other
    // error (EACCES, EISDIR, …) is surfaced by the writeFileSync
    // below, which is what we want.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  if (existing === content) return 'unchanged';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return existing === null ? 'created' : 'updated';
}

// ============================================================================
// Orchestrator-routed session runtime (Pattern A from the spec).
// ============================================================================
//
// Lifecycle of an orchestrator session:
//
//   1. Pre-flight: tmux installed, ≥1 worker resolved, orchestrator workspace
//      generated (idempotent — see `ensureOrchestratorWorkspace` above).
//   2. Create the DB session + worker rows (orchestrator itself is implicit;
//      it's not a project, so it never lands in `multi_agent_participants`).
//   3. Allocate `iterations/NNN/` and per-agent subdirs (including the
//      orchestrator's, so its transcript.log has a home).
//   4. Start the bus log tailer at EOF before any writes — events from this
//      session should be observed, but stale ones from prior runs ignored.
//   5. Spawn the detached tmux session:
//        - window 0: `orchestrator` in `~/.cebab/orchestrator/`
//        - windows 1..N: one per worker, in the worker's cwd
//      Each window runs `claude` with `BUS_AGENT_NAME` injected as an env var.
//      Each gets a `pipe-pane` to its transcript.log under iterations/NNN/.
//   6. Wait `TUI_WARMUP_MS` for the orchestrator TUI to become interactive.
//   7. Write the session roster prompt (`source=cebab`, `kind=prompt`) to the
//      orchestrator's inbox, immediately followed by the initial user prompt
//      (also `kind=prompt`). The Stop hook drains both in one turn — see
//      the orchestrator's CLAUDE.md for how it handles this.
//   8. Send-keys "Check inbox." + Enter to the orchestrator window to nudge
//      a turn if it's still idle.
//   9. On each bus event, route per these rules:
//        - dest=`user`        → already forwarded to the WS via onEvent;
//                               no tmux action.
//        - dest=`_sink`       → log warning (sentinel for chain mode).
//        - dest=`orchestrator`→ worker (or cebab) → orchestrator; wake it.
//        - dest=worker        → orchestrator → worker; wake them.
//        - other              → log warning.
//
// User prompts arriving mid-session via the WS `multi_agent_user_prompt`
// ClientMsg take the same path as the initial prompt: `sendUserPrompt` writes
// to the orchestrator's inbox + send-keys to minimize latency.
//
// Stop: SIGINT to the orchestrator window first (gives it a chance to abort
// an in-flight turn cleanly), then `kill-session` after a short grace.

/** Milliseconds to wait after tmux window creation before sending the first
 *  wakeup. Picked empirically — claude TUI is usually interactive within
 *  ~2-3s on a warm cache. Conservative to avoid lost keystrokes. */
const TUI_WARMUP_MS = 5000;

/** What we type into the orchestrator's TUI to nudge a turn. Anything that
 *  triggers Claude to respond is fine — the actual inbox drain happens in
 *  the Stop hook after that response. */
const WAKE_TEXT = 'Check inbox.';

/** Grace period between SIGINT-to-orchestrator and tmux kill-session on
 *  operator-initiated stop. Lets the in-flight turn (if any) abort. */
const STOP_GRACE_MS = 500;

export type StartOrchestratorOpts = {
  workers: ResolvedAgent[];
  initialPrompt: string;
  /**
   * Absolute path to the operator's workspace root. The per-session
   * folder (`<workspaceRoot>/.cebab-session-<id>/`) holds the
   * orchestrator workspace + live bus traffic + iteration artifacts.
   */
  workspaceRoot: string;
  /**
   * 'persistent' (default) or 'temp'. Temp triggers folder rm-rf + bus
   * uninstall per worker when the session ends with reason 'completed'
   * or 'stopped' (NOT 'crashed' — preserves evidence).
   */
  lifecycle?: MultiAgentLifecycle;
  /**
   * Per-event callback. `sessionId` is passed explicitly (rather than left
   * for the caller to close over its `const handle = await ...` value) so
   * callbacks firing DURING the await — common, because the tailer is
   * attached before writes and the warmup is 5s long — don't hit TDZ on
   * `handle`. See the `StartChainOpts` comment for the longer story.
   */
  onEvent: (sessionId: string, ev: BusLogEvent, dbEventId: number) => void;
  onEnded: (sessionId: string, reason: MultiAgentEndedReason, iterationId: string | null) => void;
};

export type ResumeOrchestratorOpts = {
  sessionId: string;
  onEvent: StartOrchestratorOpts['onEvent'];
  onEnded: StartOrchestratorOpts['onEnded'];
};

export type OrchestratorSessionHandle = {
  sessionId: string;
  iterationId: string;
  tmuxSession: string;
  /** [`orchestrator`, ...workerSlugs] — the orchestrator is first so the
   *  UI can identify it as the hub. */
  participantAgentNames: string[];
  /** Lifecycle this session was started with — same field shape as
   *  `ChainSessionHandle.lifecycle`. */
  lifecycle: MultiAgentLifecycle;
  /** Absolute path to this session's on-disk folder. */
  sessionFolder: string;
  /** Tear down the session: SIGINT orchestrator, kill tmux, update DB. */
  stop: (reason: MultiAgentEndedReason) => Promise<void>;
  /** Write a user prompt to the orchestrator's inbox + wake its TUI. Use
   *  this for prompts after the initial one (which is delivered as part
   *  of start). No-op once the session has ended. */
  sendUserPrompt: (text: string) => Promise<void>;
  /**
   * Detach Cebab from the session without killing tmux. See the
   * `ChainSessionHandle.detach` doc for the full rationale — same shape,
   * lets browser-close survive without tearing the orchestrator down so a
   * future WS connect can resume.
   */
  detach: () => void;
};

/**
 * Build the event router + teardown + sendUserPrompt closures for an
 * orchestrator session. Factored out of `startOrchestratorSession` so the
 * resume path can re-create exactly the same routing semantics on a
 * re-attached tmux session.
 */
function createOrchestratorRouter(params: {
  sessionId: string;
  iterationId: string;
  workerNames: string[];
  tmuxSessionName: string;
  paths: SessionPaths;
  onEvent: StartOrchestratorOpts['onEvent'];
  onEnded: StartOrchestratorOpts['onEnded'];
  /** Optional cleanup hook — same contract as the chain router's. */
  onTeardown?: (reason: MultiAgentEndedReason) => Promise<void>;
}): {
  teardown: (reason: MultiAgentEndedReason) => Promise<void>;
  handleEvent: (ev: BusLogEvent) => void;
  attachTailer: () => BusLogTailerHandle;
  detach: () => void;
  sendUserPrompt: (text: string) => Promise<void>;
} {
  const {
    sessionId,
    iterationId,
    workerNames,
    tmuxSessionName,
    paths,
    onEvent,
    onEnded,
    onTeardown,
  } = params;
  const workerSet = new Set(workerNames);
  const tmuxTarget = (agent: string) => `${tmuxSessionName}:${agent}`;

  let ended = false;
  let tailer: BusLogTailerHandle | null = null;

  const teardown = async (reason: MultiAgentEndedReason) => {
    if (ended) return;
    ended = true;
    tailer?.stop();
    // On operator-initiated stop, give the orchestrator a chance to abort
    // its in-flight turn cleanly before we kill the whole session.
    if (reason === 'stopped') {
      try {
        if (await hasSession(tmuxSessionName)) {
          await sendKeys(tmuxTarget(ORCHESTRATOR_AGENT_NAME), ['C-c']);
          await new Promise((r) => setTimeout(r, STOP_GRACE_MS));
        }
      } catch (err) {
        console.warn('[orchestrator] interrupt before kill failed', err);
      }
    }
    try {
      await killSession(tmuxSessionName);
    } catch (err) {
      console.warn(`[orchestrator] killSession(${tmuxSessionName}) failed`, err);
    }
    try {
      endMultiAgentSession(sessionId, reason === 'completed' ? 'completed' : reason);
    } catch (err) {
      console.error('[orchestrator] endMultiAgentSession failed', err);
    }
    // Caller-supplied cleanup (temp-mode rm-rf + uninstall). Skip on
    // 'crashed' so the operator can inspect.
    if (onTeardown && reason !== 'crashed') {
      try {
        await onTeardown(reason);
      } catch (err) {
        console.error('[orchestrator] onTeardown failed', err);
      }
    }
    // Orchestrator sessions don't have a discrete "completed" transition (the
    // operator stops them), but transcripts and events ARE archived under the
    // iteration dir — pass it through regardless so the UI link works.
    onEnded(sessionId, reason, iterationId);
  };

  const handleEvent = (ev: BusLogEvent) => {
    if (ended) return;
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
      console.error('[orchestrator] persist event failed', err);
    }
    // 2. Forward to WS (UI scrollback). User-bound finals already render
    //    through this path; no separate intercept needed.
    try {
      onEvent(sessionId, ev, dbId);
    } catch (err) {
      console.error('[orchestrator] onEvent callback threw', err);
    }

    // 3. Route to wake the destination TUI.
    if (ev.destination === USER_RECIPIENT) {
      return;
    }
    if (ev.destination === SINK_RECIPIENT) {
      console.warn(`[orchestrator] unexpected destination=_sink from ${ev.source}`);
      return;
    }
    if (ev.destination === ORCHESTRATOR_AGENT_NAME) {
      sendKeys(tmuxTarget(ORCHESTRATOR_AGENT_NAME), [WAKE_TEXT, 'Enter']).catch((err) => {
        console.warn('[orchestrator] sendKeys to orchestrator failed', err);
      });
      return;
    }
    if (workerSet.has(ev.destination)) {
      sendKeys(tmuxTarget(ev.destination), [WAKE_TEXT, 'Enter']).catch((err) => {
        console.warn(`[orchestrator] sendKeys to ${ev.destination} failed`, err);
      });
      return;
    }
    console.warn(`[orchestrator] event for unknown destination: ${ev.destination}`);
  };

  const attachTailer = (): BusLogTailerHandle => {
    // Per-session bus.log — tailer fires only for events in THIS session.
    tailer = tailBusLog({ onEvent: handleEvent, path: paths.busLog });
    return tailer;
  };

  const detach = (): void => {
    if (ended) return;
    ended = true;
    tailer?.stop();
  };

  const sendUserPrompt = async (text: string): Promise<void> => {
    if (ended) return;
    writeInboxMessage({
      recipient: ORCHESTRATOR_AGENT_NAME,
      source: CEBAB_SOURCE,
      text,
      kind: 'prompt',
      paths,
    });
    try {
      if (await hasSession(tmuxSessionName)) {
        await sendKeys(tmuxTarget(ORCHESTRATOR_AGENT_NAME), [WAKE_TEXT, 'Enter']);
      }
    } catch (err) {
      console.warn('[orchestrator] sendUserPrompt wake failed', err);
    }
  };

  return { teardown, handleEvent, attachTailer, detach, sendUserPrompt };
}

export async function startOrchestratorSession(
  opts: StartOrchestratorOpts,
): Promise<OrchestratorSessionHandle> {
  if (!(await tmuxAvailable())) throw new TmuxNotInstalled();
  if (opts.workers.length < 1) {
    throw new Error('orchestrator mode requires at least one worker participant');
  }
  if (!fs.existsSync(opts.workspaceRoot)) {
    throw new Error(`workspaceRoot does not exist: ${opts.workspaceRoot}`);
  }

  const sessionId = crypto.randomUUID();
  const tmuxSessionName = `cebab-bus-${sessionId.slice(0, 8)}`;
  const lifecycle: MultiAgentLifecycle = opts.lifecycle ?? 'persistent';
  const workerNames = opts.workers.map((w) => w.agentName);
  const participantAgentNames = [ORCHESTRATOR_AGENT_NAME, ...workerNames];
  const workerProjectIds = opts.workers.map((w) => w.projectId);

  // Per-session folder under the workspace root. Created up front so
  // subsequent mkdirs and the orchestrator workspace generation land in
  // the right place.
  const paths = computeSessionPaths(sessionId, opts.workspaceRoot);
  fs.mkdirSync(paths.folder, { recursive: true });

  // Generate (or refresh) the orchestrator workspace inside this
  // session's folder. comm.md and the bus scripts stay at the stable
  // global location; only the orchestrator's CLAUDE.md + settings.json
  // live per-session here.
  ensureOrchestratorWorkspace(paths.orchestratorWorkspace);

  // Per-session iteration id (always '001' for a fresh folder). See
  // chain.ts for why we accept the global-uniqueness drop.
  const iterationId = nextIterationId(paths);

  createMultiAgentSession(
    sessionId,
    'orchestrator',
    tmuxSessionName,
    iterationId,
    paths.folder,
    lifecycle,
  );
  // Orchestrator is NOT a project — it's Cebab's own agent — so it doesn't
  // get a `multi_agent_participants` row (the table has a NOT-NULL FK to
  // projects). Only workers are persisted. UI knows the orchestrator is
  // present because `mode='orchestrator'`.
  opts.workers.forEach((w) => addParticipant(sessionId, w.projectId, 'worker', null));

  prepareIterationDir(iterationId, participantAgentNames, paths);

  const onTeardown: ((reason: MultiAgentEndedReason) => Promise<void>) | undefined =
    lifecycle === 'temp'
      ? async () => {
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
        }
      : undefined;

  const router = createOrchestratorRouter({
    sessionId,
    iterationId,
    workerNames,
    tmuxSessionName,
    paths,
    onEvent: opts.onEvent,
    onEnded: opts.onEnded,
    onTeardown,
  });

  // Attach the tailer BEFORE any writes so no event is missed.
  router.attachTailer();

  const orchTarget = `${tmuxSessionName}:${ORCHESTRATOR_AGENT_NAME}`;

  // Spawn tmux: orchestrator window first (cwd = per-session
  // orchestrator workspace), then one per worker. BUS_SESSION_ROOT
  // routes the bus scripts at the per-session inbox/archive/log paths.
  try {
    await newSession({
      name: tmuxSessionName,
      windowName: ORCHESTRATOR_AGENT_NAME,
      cwd: paths.orchestratorWorkspace,
      // Orchestrator runs with `--permission-mode bypassPermissions`
      // just like workers. The narrow allow-list it used to have only
      // matched flat `bus-send-msg.sh foo bar` calls; the moment the
      // LLM reached for `cat <<EOF | bus-send-msg.sh …` to send a
      // long message, the bash AST became a pipeline and the
      // permission prompt blocked the orchestrator forever. Trust
      // justification: its workspace is entirely Cebab-generated
      // (CLAUDE.md, comm.md, settings.json). See BUS_CLAUDE_COMMAND
      // doc in runtime.ts for the full rationale.
      command: BUS_CLAUDE_COMMAND,
      env: { BUS_AGENT_NAME: ORCHESTRATOR_AGENT_NAME, BUS_SESSION_ROOT: paths.folder },
    });
    await pipePane(
      orchTarget,
      path.join(paths.iterationDir(iterationId, ORCHESTRATOR_AGENT_NAME), 'transcript.log'),
    );
    for (const w of opts.workers) {
      await newWindow({
        sessionName: tmuxSessionName,
        windowName: w.agentName,
        cwd: w.cwd,
        // Workers use the same BUS_CLAUDE_COMMAND — see chain.ts and
        // runtime.ts for the trust rationale.
        command: BUS_CLAUDE_COMMAND,
        env: { BUS_AGENT_NAME: w.agentName, BUS_SESSION_ROOT: paths.folder },
      });
      await pipePane(
        `${tmuxSessionName}:${w.agentName}`,
        path.join(paths.iterationDir(iterationId, w.agentName), 'transcript.log'),
      );
    }

    // Dismiss claude-code's "Bypass Permissions mode" warning in every
    // pane — orchestrator AND workers (all bus panes use
    // BUS_CLAUDE_COMMAND now). Parallel so total delay is bounded by
    // one modal-render time. See `dismissBypassPermissionsModal` for
    // the full rationale.
    await Promise.all([
      dismissBypassPermissionsModal(orchTarget),
      ...opts.workers.map((w) =>
        dismissBypassPermissionsModal(`${tmuxSessionName}:${w.agentName}`),
      ),
    ]);
  } catch (err) {
    // Half-spawned: tear down what we made and bail.
    console.error('[orchestrator] tmux spawn failed', err);
    await router.teardown('crashed');
    throw err;
  }

  // Roster + initial user prompt land in the orchestrator's inbox. The Stop
  // hook will concatenate both into the first turn's input — see the
  // orchestrator's CLAUDE.md for how it's expected to handle "roster + first
  // user message at once" (it sends intros first, then routes the prompt).
  writeInboxMessage({
    recipient: ORCHESTRATOR_AGENT_NAME,
    source: CEBAB_SOURCE,
    text: renderRosterPrompt({
      workers: opts.workers.map((w) => ({ agentName: w.agentName, projectName: w.projectName })),
      hopBudget: DEFAULT_HOP_BUDGET,
    }),
    kind: 'prompt',
    paths,
  });
  writeInboxMessage({
    recipient: ORCHESTRATOR_AGENT_NAME,
    source: CEBAB_SOURCE,
    text: opts.initialPrompt,
    kind: 'prompt',
    paths,
  });

  // Wait for the orchestrator TUI to come up, then nudge a turn. Same
  // fixed-delay pattern as chain.ts.
  await new Promise((r) => setTimeout(r, TUI_WARMUP_MS));
  try {
    if (await hasSession(tmuxSessionName)) {
      await sendKeys(orchTarget, [WAKE_TEXT, 'Enter']);
    } else {
      await router.teardown('crashed');
    }
  } catch (err) {
    console.error('[orchestrator] initial wake failed', err);
    await router.teardown('crashed');
  }

  return {
    sessionId,
    iterationId,
    tmuxSession: tmuxSessionName,
    participantAgentNames,
    lifecycle,
    sessionFolder: paths.folder,
    async stop(reason) {
      await router.teardown(reason);
    },
    sendUserPrompt: router.sendUserPrompt,
    detach: router.detach,
  };
}

/**
 * Re-attach to a still-running orchestrator session after a Cebab restart.
 *
 * Returns `null` if the session can't be resumed — see `resumeChainSession`'s
 * doc for the full list of preconditions; the orchestrator-specific addition
 * is that workers must still have bus integration installed (we don't
 * support resuming a session whose participant was uninstalled mid-run).
 */
export async function resumeOrchestratorSession(
  opts: ResumeOrchestratorOpts,
): Promise<OrchestratorSessionHandle | null> {
  const row = getMultiAgentSession(opts.sessionId);
  if (!row) return null;
  if (row.mode !== 'orchestrator') return null;
  if (row.status !== 'running') return null;
  if (!row.tmux_session) return null;
  if (!row.iteration_id) return null;

  if (!(await tmuxAvailable())) return null;
  if (!(await hasSession(row.tmux_session))) return null;

  const participants = listResolvedParticipants(opts.sessionId);
  if (participants.length < 1) return null;
  const workerNames: string[] = [];
  const workerProjectIds: number[] = [];
  for (const p of participants) {
    if (!p.bus_agent_name) return null;
    workerNames.push(p.bus_agent_name);
    workerProjectIds.push(p.project_id);
  }
  const participantAgentNames = [ORCHESTRATOR_AGENT_NAME, ...workerNames];

  // Reconstruct SessionPaths from the DB. Pre-007 rows fall back to the
  // legacy global layout so old orchestrator sessions can still resume.
  const paths = row.session_folder
    ? sessionPathsFromFolder(row.session_folder)
    : legacyGlobalSessionPaths();
  const lifecycle = (row.lifecycle as MultiAgentLifecycle | undefined) ?? 'persistent';

  const onTeardown: ((reason: MultiAgentEndedReason) => Promise<void>) | undefined =
    lifecycle === 'temp' && row.session_folder
      ? async () => {
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
        }
      : undefined;

  const router = createOrchestratorRouter({
    sessionId: opts.sessionId,
    iterationId: row.iteration_id,
    workerNames,
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
    participantAgentNames,
    lifecycle,
    sessionFolder: paths.folder,
    async stop(reason) {
      await router.teardown(reason);
    },
    sendUserPrompt: router.sendUserPrompt,
    detach: router.detach,
  };
}

/**
 * Resolve a list of worker project ids. Mirrors `resolveChainParticipants` —
 * separate function so the WS handler can be intent-explicit about which
 * mode it's resolving for, even though the implementation is identical
 * (both modes pull projectId → ResolvedAgent the same way).
 */
export function resolveOrchestratorWorkers(projectIds: number[]): ResolvedAgent[] {
  return projectIds.map((id) => resolveAgent(id));
}
