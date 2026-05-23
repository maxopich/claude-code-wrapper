import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { WebSocket, WebSocketServer } from 'ws';
import {
  classifyToolCall,
  isSessionPermissionMode,
  type ClientMsg,
  type ServerMsg,
  type SessionPermissionMode,
} from '@cebab/shared';
import { config } from '../config.js';
import { getProject, setProjectTrusted, touchProject } from '../repo/projects.js';
import {
  createSession,
  getSession,
  getSessionPermissionMode,
  listSessionsForProject,
  setSessionPermissionMode,
  setSessionTitle,
} from '../repo/sessions.js';
import { listEvents } from '../repo/events.js';
import { persistMessage } from '../runner/orchestrator.js';
import { closeLogger } from '../runner/logger.js';
import { pickRunner, type Runner } from '../runner/index.js';
import { registerQuery } from '../runner/lifecycle.js';
import { getSetting, setSetting } from '../repo/settings.js';
import { listTemplates, saveTemplate, deleteTemplate } from '../repo/templates.js';
import {
  resolveWorkspaceRoot,
  rowToProject,
  setWorkspaceRoot,
  syncWorkspaceProjects,
  workspaceRootValid,
} from '../workspace.js';
import type { MultiAgentLifecycle } from '@cebab/shared/protocol';
import { translate } from './translate.js';
import { classifyError } from './errors.js';
import { shouldAutoAllow } from './permission.js';
import { buildSessionLogChunk } from './session_log.js';
import { InstallError, installBusForProject, uninstallBusForProject } from '../bus/install.js';
import {
  resolveChainParticipants,
  startChainSession,
  type ChainSessionHandle,
} from '../bus/chain.js';
import {
  DEFAULT_HOP_BUDGET,
  resolveOrchestratorWorkers,
  startOrchestratorSession,
  type OrchestratorSessionHandle,
} from '../bus/orchestrator.js';
import type { ActivitySnapshot } from '../bus/activity.js';
import { ResolveAgentError, readProjectClaudeMdHead } from '../bus/runtime.js';
import {
  attemptResumeMultiAgent,
  resumeMultiAgentTarget,
  type ResumedSession,
  type ResumeCallbacks,
} from '../bus/resume.js';
import {
  clearFinishedMultiAgentSessions,
  computeRecoveryContext,
  getLastRunForTemplate,
  getMultiAgentSession,
  getPendingMutation,
  getPendingRetry,
  listMultiAgentEvents,
  listMultiAgentMutations,
  listMultiAgentSessionsWithIteration,
  listResolvedParticipants,
  setAwaitingContinue,
  type MutationRecord,
} from '../repo/multi_agent.js';
import { canReconstruct } from '../bus/reconstruct.js';
import { busIterationDir, sessionPathsFromFolder } from '../bus/paths.js';
import { hasLiveSession } from '../bus/session_registry.js';
import { ORCHESTRATOR_AGENT_NAME } from '../bus/orchestrator.js';
import type {
  IterationSummary,
  MultiAgentMutationView,
  PendingRetryDescriptor,
} from '@cebab/shared/protocol';
import { type MultiAgentEventKind, isMultiAgentEventKind } from '@cebab/shared/protocol';
import { buildAllowedOrigins, isAllowedHost } from '../origin.js';
import { verifyToken } from '../auth.js';

export type PendingPermission = {
  sessionId: string;
  resolve: (
    decision:
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string },
  ) => void;
  toolInput: Record<string, unknown>;
};

/**
 * F12: drain pending permission Promises for a given session before
 *      abort/interrupt. Otherwise their entries leak in the map until WS
 *      close — functionally benign (the SDK's canUseTool callback is
 *      cancelled by abort) but unbounded under a burst of interrupts.
 *      Filter by sessionId so other concurrent sessions on the same WS
 *      connection aren't affected. Same pattern is used on WS close,
 *      with no sessionId filter (close drains everything).
 */
export function cleanupPendingPermissionsForSession(
  pending: Map<string, PendingPermission>,
  sessionId: string,
): void {
  for (const [requestId, p] of pending) {
    if (p.sessionId !== sessionId) continue;
    p.resolve({ behavior: 'deny', message: 'interrupted' });
    pending.delete(requestId);
  }
}

type InFlight = {
  ac: AbortController;
  projectId: number;
  runner: Runner;
  permissionMode: SessionPermissionMode;
};

/** Item #5: shape-equivalent translation from the DB row to the wire view.
 *  Migration 012 adds filePath / cwd / confirmedAt / promoted; `toolUseId`
 *  is server-internal (correlation key only) and is intentionally NOT
 *  surfaced on the wire. */
function mutationRecordToView(m: MutationRecord): MultiAgentMutationView {
  return {
    id: m.id,
    sessionId: m.sessionId,
    ts: m.ts,
    agentName: m.agentName,
    toolName: m.toolName,
    category: m.category,
    summary: m.summary,
    filePath: m.filePath,
    cwd: m.cwd,
    confirmedAt: m.confirmedAt,
    promoted: m.promoted,
  };
}

type Conn = {
  ws: WebSocket;
  pendingPermissions: Map<string, PendingPermission>;
  inFlight: Map<string, InFlight>;
  /** At most one active multi-agent session per connection in v1 (per the
   *  plan's "one active session at a time"). Cleared on completion, stop,
   *  crash, or WS close. Orchestrator sessions carry an extra
   *  `sendUserPrompt` method; the WS handler narrows via `'sendUserPrompt'
   *  in active` rather than carrying a separate mode discriminator here. */
  multiAgent: ChainSessionHandle | OrchestratorSessionHandle | null;
};

export function startWsServer(server: HttpServer): WebSocketServer {
  const allowedOrigins = buildAllowedOrigins();
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, cb) => {
      const req = info.req as IncomingMessage;
      const origin = String(req.headers.origin ?? '');
      const host = String(req.headers.host ?? '');
      // Empty Origin is allowed only for non-browser clients (smoke tests,
      // curl). Browsers ALWAYS set Origin on WS upgrades, so an absent
      // Origin can't be a Cross-Site WebSocket Hijack. The per-launch
      // auth token below is the real gate that closes worker→WS hijack —
      // Origin/Host are kept as a cheap label and early reject.
      if (origin && !allowedOrigins.has(origin)) {
        console.warn(`[ws] reject: bad origin ${JSON.stringify(origin)}`);
        cb(false, 403, 'forbidden origin');
        return;
      }
      if (!isAllowedHost(host)) {
        console.warn(`[ws] reject: bad host ${JSON.stringify(host)}`);
        cb(false, 403, 'forbidden host');
        return;
      }
      // F4: per-launch auth token. Workers under bypassPermissions can
      //     spoof Origin/Host from a Node WS client trivially, so the
      //     only real defense against a worker→WS hijack is requiring a
      //     secret they can't read (mode 0600 on ~/.cebab/auth-token).
      const u = new URL(req.url ?? '/', 'http://x');
      if (!verifyToken(u.searchParams.get('token'))) {
        console.warn('[ws] reject: bad token');
        cb(false, 401, 'unauthorized');
        return;
      }
      cb(true);
    },
  });
  wss.on('connection', (ws) => onConnection(ws));
  return wss;
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onConnection(ws: WebSocket): void {
  console.log('[ws] client connected');
  const conn: Conn = {
    ws,
    pendingPermissions: new Map(),
    inFlight: new Map(),
    multiAgent: null,
  };

  ws.on('message', (raw) => {
    let parsed: ClientMsg;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      console.warn('[ws] bad client json');
      return;
    }
    handleClientMsg(conn, parsed).catch((err) => {
      console.error('[ws] handler error', err);
      send(ws, {
        type: 'wrapper_error',
        kind: 'process_crashed',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  ws.on('close', () => {
    console.log('[ws] client disconnected');
    for (const pending of conn.pendingPermissions.values()) {
      pending.resolve({ behavior: 'deny', message: 'client disconnected' });
    }
    conn.pendingPermissions.clear();
    for (const f of conn.inFlight.values()) f.ac.abort();
    conn.inFlight.clear();
    // Multi-agent: detach but DON'T tear down. The bus session keeps
    // running in-process (AgentRunner + router live in the session
    // registry); the DB row stays 'running'. A future WS connect (browser
    // refresh, second window) calls `attemptResumeMultiAgent` to re-attach
    // by swapping the WS sink. The Stop button is the only way an operator
    // intentionally tears a session down. (A Cebab server restart empties
    // the registry; an orchestrated run is then rebuilt from persisted
    // state and re-attached READ-ONLY — R-B — pending an operator Continue.)
    if (conn.multiAgent) {
      conn.multiAgent.detach();
      conn.multiAgent = null;
    }
  });

  // Attempt to re-attach to any pre-existing multi-agent session. Runs in
  // the background; we don't block the WS open. If a resume succeeds, the
  // browser receives a `multi_agent_started` + the persisted event replay
  // and its reducer transitions into the active-run view.
  void resumeOnConnect(conn);
}

/**
 * The onEvent/onEnded pair both the auto-resume sweep (`resumeOnConnect`)
 * and the manual `resume_multi_agent` handler feed into the bus runtime:
 * stream events to this WS and drop the active handle when it ends.
 */
function resumeCallbacks(
  conn: Conn,
): Pick<
  ResumeCallbacks,
  'onEvent' | 'onEnded' | 'onPendingRetry' | 'onMutation' | 'onPendingMutation'
> {
  return {
    onEvent: (sessionId, ev, dbEventId) => {
      const kind: MultiAgentEventKind = isMultiAgentEventKind(ev.kind) ? ev.kind : 'reply';
      send(conn.ws, {
        type: 'multi_agent_event',
        sessionId,
        eventId: dbEventId,
        ts: ev.ts,
        source: ev.source,
        destination: ev.destination,
        kind,
        text: ev.text,
      });
    },
    onEnded: (sessionId, reason, iterationId) => {
      send(conn.ws, { type: 'multi_agent_ended', sessionId, reason, iterationId });
      if (conn.multiAgent?.sessionId === sessionId) {
        conn.multiAgent = null;
      }
    },
    onPendingRetry: (sessionId, pending) => {
      send(conn.ws, { type: 'multi_agent_pending_retry', sessionId, pending });
    },
    onMutation: (sessionId, mutation) => {
      send(conn.ws, {
        type: 'multi_agent_mutation',
        sessionId,
        mutation: mutationRecordToView(mutation),
      });
    },
    onPendingMutation: (sessionId, pending) => {
      send(conn.ws, {
        type: 'multi_agent_pending_mutation',
        sessionId,
        pending: pending ? mutationRecordToView(pending) : null,
      });
    },
  };
}

/**
 * Adopt a freshly re-attached session into this Conn and bring the browser
 * up to date: emit `multi_agent_started` (the reducer clears the event list
 * to []), then replay persisted events in DB-id order so the scrollback
 * rebuilds before any live event from the re-attached tailer arrives.
 */
function emitResumedSession(conn: Conn, resumed: ResumedSession): void {
  conn.multiAgent = resumed.handle;
  // Fresh read: R-B reconstruction sets `awaiting_continue` AFTER the
  // resume sweep snapshots its `candidate` row, so `resumed.row` can be
  // stale. The DB is authoritative.
  const awaitingContinue = getMultiAgentSession(resumed.handle.sessionId)?.awaiting_continue === 1;
  // Item #4: hydrate the pending-retry banner descriptor from the persisted
  // columns. Survives both R-A (live re-attach — slot was set by an
  // onWorkerFailed in this process and lives in the DB) and R-B
  // (server restart — slot persisted in the prior process). Translate from
  // the DB `prompt` field to the wire `lastPrompt` field; both carry the
  // same bytes, just different names. The router's onPendingRetry callback
  // handles AFTER-attach transitions (a Continue+turn that re-fails, etc.).
  const pendingRow = getPendingRetry(resumed.handle.sessionId);
  const pendingRetry: PendingRetryDescriptor | undefined = pendingRow
    ? {
        agentName: pendingRow.agentName,
        reason: pendingRow.reason,
        lastPrompt: pendingRow.prompt,
        ts: pendingRow.ts,
        errorEventId: pendingRow.errorEventId,
      }
    : undefined;
  // Item #5: hydrate the pause-on-mutation overlay from the DB so the banner
  // restores after R-A re-attach (live registry still wired) and R-B
  // reconstruct (rebuilt session). All three reads (row, mutations list,
  // pending slot) are fast indexed reads — same posture as the awaiting /
  // pending-retry hydration above.
  const sessionRow = getMultiAgentSession(resumed.handle.sessionId);
  const pauseOnMutation = sessionRow?.pause_on_mutation === 1;
  const mutationsAcknowledged = sessionRow?.mutations_acknowledged === 1;
  const mutationsList = listMultiAgentMutations(resumed.handle.sessionId);
  const pendingMutationRow = getPendingMutation(resumed.handle.sessionId);
  const mutations: MultiAgentMutationView[] = mutationsList.map(mutationRecordToView);
  const pendingMutationView = pendingMutationRow
    ? mutationRecordToView(pendingMutationRow)
    : undefined;
  // Item #7: surface the per-agent recovery snapshot ONLY when the session
  // is in awaiting_continue state (R-B reconstruct or a pause-on-mutation
  // banner that survived a Cebab restart). When awaiting_continue is false
  // the recovery context is irrelevant — the banner isn't shown.
  const recoveryContext = awaitingContinue
    ? computeRecoveryContext(resumed.handle.sessionId)
    : null;
  send(conn.ws, {
    type: 'multi_agent_started',
    sessionId: resumed.handle.sessionId,
    mode: resumed.mode,
    // Original `participants` (project ids) only ride the start request,
    // not the DB row; the reducer doesn't use this field post-start.
    participants: [],
    participantAgentNames: resumed.handle.participantAgentNames,
    lifecycle: resumed.handle.lifecycle,
    sessionFolder: resumed.handle.sessionFolder,
    // R-A: re-attaches a live handle → use the original session's budget.
    // R-B: the resume path re-resolved the budget at reconstruct time and
    // the rebuilt handle carries it; both paths land here on the same field.
    hopBudget: resumed.handle.hopBudget,
    awaitingContinue,
    ...(pendingRetry ? { pendingRetry } : {}),
    pauseOnMutation,
    mutationsAcknowledged,
    mutations,
    ...(pendingMutationView ? { pendingMutation: pendingMutationView } : {}),
    ...(recoveryContext ? { recoveryContext } : {}),
  });
  for (const ev of resumed.replayEvents) {
    const kind: MultiAgentEventKind = isMultiAgentEventKind(ev.kind) ? ev.kind : 'reply';
    send(conn.ws, {
      type: 'multi_agent_event',
      sessionId: resumed.handle.sessionId,
      eventId: ev.dbEventId,
      ts: ev.ts,
      source: ev.source,
      destination: ev.destination,
      kind,
      text: ev.text,
    });
  }
}

/**
 * Async helper that runs after a WS connect: look up any active multi-agent
 * session in the DB, check the in-process registry, and re-attach if still
 * live. Catches its own errors so a failed resume doesn't leak into the WS
 * error handler.
 */
async function resumeOnConnect(conn: Conn): Promise<void> {
  try {
    const resumed = await attemptResumeMultiAgent({
      ...resumeCallbacks(conn),
      hopBudget: resolveHopBudget(),
      onResumeFailed: (sessionId) => {
        // Surface auto-resume failures as a wrapper_error toast so the
        // operator notices instead of "Cebab silently lost my session".
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId,
          kind: 'process_crashed',
          message: resumeFailureMessage(sessionId),
        });
      },
    });
    if (!resumed) return;
    emitResumedSession(conn, resumed);
  } catch (err) {
    console.error('[ws] resumeOnConnect failed', err);
  }
}

/**
 * Resolved hop budget for a new multi-agent session start (and for R-B
 * reconstruction). Precedence:
 *
 *   1. DB setting `hop_budget` (a positive integer) — what the operator set
 *      via the Settings modal.
 *   2. `CEBAB_HOP_BUDGET` env var — the operator's per-launch override.
 *   3. `DEFAULT_HOP_BUDGET` from `bus/orchestrator.ts` — the built-in floor.
 *
 * Always returns a finite integer ≥ 1. Re-read on every start/resume so a
 * Settings-modal change between runs takes effect immediately.
 */
function resolveHopBudget(): number {
  const stored = getSetting<number>('hop_budget');
  if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 1) {
    return Math.floor(stored);
  }
  const env = parseInt(process.env.CEBAB_HOP_BUDGET ?? '', 10);
  if (Number.isFinite(env) && env >= 1) return env;
  return DEFAULT_HOP_BUDGET;
}

function emitSettings(conn: Conn): void {
  // Return the *raw* setting so the client can distinguish "user hasn't set
  // anything yet" (null) from "set, but pointing at a missing folder" (string
  // + workspaceRootValid=false). resolveWorkspaceRoot would mask the unset
  // case behind the env-var fallback.
  const stored = getSetting<string>('workspace_root');
  send(conn.ws, {
    type: 'settings',
    workspaceRoot: typeof stored === 'string' && stored.length > 0 ? stored : null,
    workspaceRootValid: workspaceRootValid(),
    defaultWorkspaceRoot: config.workspaceRootDefault,
    defaultHopBudget: resolveHopBudget(),
  });
}

/**
 * The user-facing message that ships in the `wrapper_error.message` field
 * when an auto-resume fails. Kept close to the WS layer so the wording (which
 * the operator sees in a toast) doesn't drift away from the symptom. With
 * R-B, an orchestrated run is reconstructed after a server restart; this
 * fires only when reconstruction is impossible — chain mode, or a guard
 * failed (no persisted session map for a pre-009 row, a deleted participant,
 * a missing session folder, …). The session id slice helps disambiguate
 * when the operator has run multiple multi-agent sessions in a row.
 */
function resumeFailureMessage(sessionId: string): string {
  const slug = sessionId.slice(0, 8);
  return `Couldn't resume multi-agent session ${slug}: the Cebab server was restarted and this run couldn't be reconstructed (chain-mode runs, or runs missing their persisted resume state, can't come back). Marked crashed. Single-agent chats are unaffected.`;
}

/**
 * Build the orchestrator "continue after restart" nudge for R-B. The
 * orchestrator is resumed with its full prior reasoning transcript intact
 * (its CLI session was seeded), so it only needs the bus activity that
 * landed after its last action — not the whole log. Excludes the
 * cebab→user recovery banner (operator-facing, not orchestrator input).
 */
function buildContinueNudge(sessionId: string): string {
  const events = listMultiAgentEvents(sessionId);
  let lastOrchIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.source === ORCHESTRATOR_AGENT_NAME) {
      lastOrchIdx = i;
      break;
    }
  }
  const since = events
    .slice(lastOrchIdx + 1)
    .filter((e) => !(e.source === 'cebab' && e.destination === 'user'));
  const log =
    since.length > 0
      ? since.map((e) => `- ${e.source} → ${e.destination} [${e.kind}]: ${e.text}`).join('\n')
      : '(no bus messages were recorded since your last action)';
  return [
    'The Cebab server was restarted while this session was running, so your',
    'turn was interrupted. You have been resumed with your full prior context',
    'intact. Bus activity since your last action:',
    '',
    log,
    '',
    'Continue the task from where you left off. If you had already dispatched',
    'work to a participant, wait for or re-request their reply as appropriate.',
    'Anything you wrote in the interrupted turn was not delivered — re-send it',
    'via bus_send. When you have the complete answer, bus_send(recipient="user",',
    'kind="final", ...).',
  ].join('\n');
}

/** Display-label cap. Long enough for "Refactor the WS upgrade handler", short
 * enough not to wreck the sidebar layout. */
const MAX_SESSION_TITLE_LEN = 80;

/**
 * Normalize a user-supplied title. Returns null when the input is empty after
 * trimming (the UI then falls back to the session id slice). Collapses CR/LF
 * to spaces so a pasted multi-line value can't break the row.
 */
function normalizeSessionTitle(raw: string | null): string | null {
  if (raw == null) return null;
  const collapsed = raw.replace(/[\r\n]+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_SESSION_TITLE_LEN);
}

/** Pick the permission mode for a (possibly resuming) turn. */
function seedPermissionMode(
  resumeSessionId: string | undefined,
  trusted: boolean,
): SessionPermissionMode {
  if (resumeSessionId) {
    const stored = getSessionPermissionMode(resumeSessionId);
    if (stored) return stored;
  }
  return trusted ? 'acceptEdits' : 'default';
}

/**
 * Build the iteration browser list from the DB. Exported for direct unit
 * testing without standing up a WS connection.
 *
 * artifactsDir resolution:
 *   - Post-007 rows (`session_folder` set) live under
 *     `<session_folder>/iterations/<id>/`.
 *   - Pre-007 rows (`session_folder` null) used the legacy global layout
 *     under `~/.cebab/bus/iterations/<id>/`.
 * Always emitting `busIterationDir(...)` collapsed both onto the legacy
 * path and broke per-session iteration browsing.
 */
export async function buildIterationsList(): Promise<IterationSummary[]> {
  const rows = listMultiAgentSessionsWithIteration();
  const out: IterationSummary[] = [];
  for (const row of rows) {
    const participants = listResolvedParticipants(row.id);
    const workerNames = participants
      .map((p) => p.bus_agent_name)
      .filter((n): n is string => n !== null);
    const participantAgentNames =
      row.mode === 'orchestrator' ? [ORCHESTRATOR_AGENT_NAME, ...workerNames] : workerNames;
    const artifactsDir =
      row.session_folder !== null
        ? sessionPathsFromFolder(row.session_folder).iterationDir(row.iteration_id!)
        : busIterationDir(row.iteration_id!);
    // Resumable if it's still live in THIS process's registry (same-process
    // re-attach) OR — for an orchestrated run — it can be reconstructed
    // from persisted state after a Cebab server restart (R-B). Chain rows
    // are only resumable while live. Re-validated on the actual resume.
    const resumable = hasLiveSession(row.id) || canReconstruct(row);
    out.push({
      iterationId: row.iteration_id!,
      sessionId: row.id,
      mode: row.mode as 'chain' | 'orchestrator',
      status: row.status as 'running' | 'completed' | 'stopped' | 'crashed',
      startedAt: row.started_at,
      endedAt: row.ended_at,
      participantAgentNames,
      // Absolute path so the browser can render it for clipboard / `cd`
      // use. The filesystem layout under iterations/NNN/ is the
      // operator's source of truth — Cebab doesn't proxy it.
      artifactsDir,
      resumable,
    });
  }
  return out;
}

async function handleClientMsg(conn: Conn, msg: ClientMsg): Promise<void> {
  switch (msg.type) {
    case 'list_projects': {
      const rows = await syncWorkspaceProjects();
      send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      return;
    }
    case 'get_settings': {
      emitSettings(conn);
      return;
    }
    case 'set_workspace_root': {
      try {
        setWorkspaceRoot(msg.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
        emitSettings(conn);
        return;
      }
      // Reading the resolved root is harmless; mostly here so console logs are useful.
      void resolveWorkspaceRoot();
      const rows = await syncWorkspaceProjects();
      emitSettings(conn);
      send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      return;
    }
    case 'set_default_hop_budget': {
      // Silently clamp invalid/non-finite/below-1 values to a no-op; the
      // client's number input is the validation surface for typo recovery.
      // Mirrors `set_workspace_root`'s "emit settings even on rejection so
      // the UI re-syncs" contract.
      if (Number.isFinite(msg.value) && msg.value >= 1) {
        setSetting('hop_budget', Math.floor(msg.value));
      }
      emitSettings(conn);
      return;
    }
    case 'open_project': {
      const project = getProject(msg.projectId);
      if (!project) return;
      const sessions = listSessionsForProject(project.id).map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.created_at,
        lastEventAt: s.last_event_at,
        totalCostUsd: s.total_cost_usd,
      }));
      const runningSessionIds = [...conn.inFlight.entries()]
        .filter(([, f]) => f.projectId === project.id)
        .map(([sid]) => sid);
      send(conn.ws, {
        type: 'project_opened',
        projectId: project.id,
        sessions,
        runningSessionIds,
      });
      return;
    }
    case 'load_session': {
      await replaySession(conn, msg.projectId, msg.sessionId);
      return;
    }
    case 'set_trusted': {
      setProjectTrusted(msg.projectId, msg.trusted);
      const rows = await syncWorkspaceProjects();
      send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      return;
    }
    case 'permission_decision': {
      const pending = conn.pendingPermissions.get(msg.requestId);
      if (!pending) return;
      // Lie-detection: a decision must reference the same session that
      // produced the pending request. Otherwise something is confused.
      if (pending.sessionId !== msg.sessionId) {
        console.warn(
          `[ws] permission_decision sessionId mismatch: pending=${pending.sessionId} got=${msg.sessionId}`,
        );
        return;
      }
      conn.pendingPermissions.delete(msg.requestId);
      if (msg.decision === 'allow') {
        const updated = msg.updatedInput ?? pending.toolInput;
        pending.resolve({ behavior: 'allow', updatedInput: updated });
      } else {
        pending.resolve({
          behavior: 'deny',
          message: msg.message ?? 'User denied this action',
        });
      }
      // Echo a permission_decided so the UI flips Allow/Deny → "decided" and
      // any other connection on the same session sees the outcome too.
      send(conn.ws, {
        type: 'permission_decided',
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        decision: msg.decision,
      });
      // Persist so replay shows the resolution next to the request card.
      await persistMessage(msg.sessionId, {
        type: 'wrapper',
        subtype: 'permission_decided',
        session_id: msg.sessionId,
        uuid: randomUUID(),
        requestId: msg.requestId,
        decision: msg.decision,
      } as never);
      return;
    }
    case 'set_permission_mode': {
      // Runtime validation: protocol type narrows to default|acceptEdits, but
      // a non-browser local client could try to send anything.
      if (!isSessionPermissionMode(msg.mode)) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `invalid permission mode: ${JSON.stringify(msg.mode)}`,
        });
        return;
      }
      const f = conn.inFlight.get(msg.sessionId);
      if (!f) return;
      try {
        await f.runner.setPermissionMode?.(msg.mode);
        f.permissionMode = msg.mode;
        // Persist so the next turn (and replay) seed from this preference.
        setSessionPermissionMode(msg.sessionId, msg.mode);
        send(conn.ws, {
          type: 'permission_mode_changed',
          sessionId: msg.sessionId,
          mode: msg.mode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message,
        });
      }
      return;
    }
    case 'rename_session': {
      const row = getSession(msg.sessionId);
      if (!row) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `unknown session ${msg.sessionId}`,
        });
        return;
      }
      const normalized = normalizeSessionTitle(msg.title);
      setSessionTitle(msg.sessionId, normalized);
      send(conn.ws, {
        type: 'session_renamed',
        sessionId: msg.sessionId,
        projectId: row.project_id,
        title: normalized,
      });
      return;
    }
    case 'interrupt': {
      const f = conn.inFlight.get(msg.sessionId);
      if (!f) return;
      // F12 cleanup. Pure-function helper defined above for testability.
      cleanupPendingPermissionsForSession(conn.pendingPermissions, msg.sessionId);
      // Don't await — `runner.interrupt()` can take a second or two and we
      // shouldn't back up the WS message queue. The for-await loop in
      // runOneTurn will exit and clean up via finally.
      if (f.runner.interrupt) {
        f.runner.interrupt().catch((err) => {
          console.warn('[ws] runner.interrupt failed; falling back to abort', err);
          f.ac.abort();
        });
      } else {
        f.ac.abort();
      }
      return;
    }
    case 'install_bus_integration': {
      try {
        const result = await installBusForProject(msg.projectId);
        send(conn.ws, {
          type: 'bus_integration_changed',
          projectId: msg.projectId,
          installed: true,
          agentName: result.agentName,
        });
        // Refresh the whole project list so any client tab that renders the
        // `busInstalled` flag picks up the change in one place. Cheap on this
        // single-user app; the project list is bounded by workspace size.
        const rows = await syncWorkspaceProjects();
        send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      } catch (err) {
        const message =
          err instanceof InstallError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
      }
      return;
    }
    case 'uninstall_bus_integration': {
      try {
        await uninstallBusForProject(msg.projectId);
        send(conn.ws, {
          type: 'bus_integration_changed',
          projectId: msg.projectId,
          installed: false,
          agentName: null,
        });
        const rows = await syncWorkspaceProjects();
        send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      } catch (err) {
        const message =
          err instanceof InstallError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
      }
      return;
    }
    case 'start_multi_agent': {
      if (conn.multiAgent) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: `another multi-agent session is already running (${conn.multiAgent.sessionId}); stop it first.`,
        });
        return;
      }
      if (!Array.isArray(msg.participants) || msg.participants.length === 0) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: 'a multi-agent session needs at least one participant.',
        });
        return;
      }
      // Mode-specific minimum participant counts. Chain mode is a pipeline
      // (≥2 hops to be useful); orchestrator mode is hub-and-spoke (one
      // worker is degenerate but allowed for smoke testing).
      if (msg.mode === 'chain' && msg.participants.length < 2) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: 'chain mode requires at least two participants.',
        });
        return;
      }
      // Event forwarders shared between modes — translate BusLogEvent →
      // `multi_agent_event` ServerMsg. `sessionId` is passed by the runtime
      // as the callback's first arg (NOT closed over from a `const handle =
      // await ...` value), so callbacks firing DURING the await — which
      // happens routinely while the tailer picks up the briefings / roster
      // / initial-prompt writes during the 5s TUI warmup — don't hit TDZ.
      const onEvent = (
        sessionId: string,
        ev: { ts: number; source: string; destination: string; kind: string; text: string },
        dbEventId: number,
      ) => {
        const kind: MultiAgentEventKind = isMultiAgentEventKind(ev.kind) ? ev.kind : 'reply';
        send(conn.ws, {
          type: 'multi_agent_event',
          sessionId,
          eventId: dbEventId,
          ts: ev.ts,
          source: ev.source,
          destination: ev.destination,
          kind,
          text: ev.text,
        });
      };
      const onEnded = (
        sessionId: string,
        reason: 'completed' | 'stopped' | 'crashed',
        iterationId: string | null,
      ) => {
        send(conn.ws, {
          type: 'multi_agent_ended',
          sessionId,
          reason,
          iterationId,
        });
        if (conn.multiAgent?.sessionId === sessionId) {
          conn.multiAgent = null;
        }
      };
      // Ephemeral liveness pulse for the active run's in-flight turn. Not
      // persisted and not replayed: it is only meaningful to the connection
      // that started the run (see the `agent_activity` protocol JSDoc — a
      // live re-attach intentionally won't receive it; the spine re-syncs on
      // the next real hop).
      const onActivity = (sessionId: string, snap: ActivitySnapshot) => {
        send(conn.ws, {
          type: 'agent_activity',
          sessionId,
          agentName: snap.agentName,
          phase: snap.phase,
          currentTool: snap.currentTool,
          lastActivityTs: snap.lastActivityTs,
          turnStartedAt: snap.turnStartedAt,
        });
      };
      // Item #4: pending-retry set/clear → wire. Fresh starts never carry a
      // pending-retry slot on `multi_agent_started`; this callback is the
      // delta for transitions that happen later (a worker fails, the
      // operator retries, etc.).
      const onPendingRetry = (sessionId: string, pending: PendingRetryDescriptor | null) => {
        send(conn.ws, { type: 'multi_agent_pending_retry', sessionId, pending });
      };
      // Item #5: per-mutation live forwarding → `multi_agent_mutation`. Fires
      // for every classified non-'read' tool call observed during this
      // session. The initial batch on attach ships on `multi_agent_started`.
      const onMutation = (sessionId: string, mutation: MutationRecord) => {
        send(conn.ws, {
          type: 'multi_agent_mutation',
          sessionId,
          mutation: mutationRecordToView(mutation),
        });
      };
      // Item #5: pause-on-mutation slot set/clear → wire. Fresh starts never
      // carry a pending slot on `multi_agent_started`; this is the delta.
      const onPendingMutation = (sessionId: string, pending: MutationRecord | null) => {
        send(conn.ws, {
          type: 'multi_agent_pending_mutation',
          sessionId,
          pending: pending ? mutationRecordToView(pending) : null,
        });
      };

      // Per-session folders live under the workspace root, so it must be
      // a valid existing directory. The Settings modal validates on save,
      // but a workspace that was deleted between then and now would slip
      // through — bail with a useful error.
      if (!workspaceRootValid()) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message:
            'workspace root is not set or no longer exists; pick a workspace folder in Settings first.',
        });
        return;
      }
      const workspaceRoot = resolveWorkspaceRoot();
      // Lifecycle is optional on the wire; default 'persistent' here so
      // pre-007 clients (or any that forget to send it) get the safer
      // resumable behavior.
      const lifecycle: MultiAgentLifecycle = msg.lifecycle ?? 'persistent';

      // Resolve once per start so the wire's `hopBudget` matches what the
      // router was constructed with (Settings-modal saves between fetch and
      // start would otherwise risk a brief mismatch).
      //
      // PR-7 precedence: per-run override on the message > global default.
      // Per-template hopBudget is mirrored onto `msg.hopBudget` client-side
      // when the operator clicks Apply, so the server doesn't need to look
      // up the template here. Clamped to >= 1 defensively.
      const requestedHopBudget =
        typeof msg.hopBudget === 'number' && Number.isFinite(msg.hopBudget) && msg.hopBudget >= 1
          ? Math.floor(msg.hopBudget)
          : null;
      const hopBudget = requestedHopBudget ?? resolveHopBudget();

      if (msg.mode === 'orchestrator') {
        let workers;
        try {
          workers = resolveOrchestratorWorkers(msg.participants);
        } catch (err) {
          const message =
            err instanceof ResolveAgentError
              ? `${err.code}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err);
          send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
          return;
        }
        try {
          const handle = await startOrchestratorSession({
            workers,
            initialPrompt: msg.initialPrompt,
            workspaceRoot,
            lifecycle,
            onEvent,
            onEnded,
            onActivity,
            onPendingRetry,
            onMutation,
            onPendingMutation,
            hopBudget,
            pauseOnMutation: msg.pauseOnMutation === true,
            // PR-7: stamp template provenance onto the row so the rail can
            // SELECT by template post-teardown. Absent on ad-hoc runs.
            templateId: typeof msg.templateId === 'string' ? msg.templateId : undefined,
          });
          conn.multiAgent = handle;
          send(conn.ws, {
            type: 'multi_agent_started',
            sessionId: handle.sessionId,
            mode: 'orchestrator',
            participants: msg.participants,
            participantAgentNames: handle.participantAgentNames,
            lifecycle: handle.lifecycle,
            sessionFolder: handle.sessionFolder,
            hopBudget: handle.hopBudget,
            // Item #5: fresh start — no mutations recorded yet, no pending,
            // ack flag false. `pauseOnMutation` echoes the operator's choice
            // so the UI mirrors its own setup checkbox.
            pauseOnMutation: handle.pauseOnMutation,
            mutationsAcknowledged: false,
            mutations: [],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
        }
        return;
      }

      // Chain mode.
      let participants;
      try {
        participants = resolveChainParticipants(msg.participants);
      } catch (err) {
        const message =
          err instanceof ResolveAgentError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
        return;
      }
      try {
        const handle = await startChainSession({
          participants,
          initialPrompt: msg.initialPrompt,
          workspaceRoot,
          lifecycle,
          onEvent,
          onEnded,
          onActivity,
          onPendingRetry,
          onMutation,
          onPendingMutation,
          hopBudget,
          pauseOnMutation: msg.pauseOnMutation === true,
          // PR-7: stamp template provenance onto the row.
          templateId: typeof msg.templateId === 'string' ? msg.templateId : undefined,
        });
        conn.multiAgent = handle;
        send(conn.ws, {
          type: 'multi_agent_started',
          sessionId: handle.sessionId,
          mode: 'chain',
          participants: msg.participants,
          participantAgentNames: handle.participantAgentNames,
          lifecycle: handle.lifecycle,
          sessionFolder: handle.sessionFolder,
          hopBudget: handle.hopBudget,
          pauseOnMutation: handle.pauseOnMutation,
          mutationsAcknowledged: false,
          mutations: [],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
      }
      return;
    }
    case 'multi_agent_user_prompt': {
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        // Either no active session or a different one. Drop silently — the
        // client may have raced a `multi_agent_ended` event.
        return;
      }
      if (!('sendUserPrompt' in active)) {
        // Chain mode doesn't accept mid-flight user prompts; it's fire-
        // and-forget after the initial input rides participant[0]'s first
        // turn. Surface as a wrapper_error so the operator gets feedback.
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: 'chain-mode sessions do not accept mid-flight user prompts.',
        });
        return;
      }
      try {
        await active.sendUserPrompt(msg.text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
      }
      return;
    }
    case 'stop_multi_agent': {
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        // Either no active session or one with a different id. Idempotent
        // no-op — the caller may have raced a `multi_agent_ended` event.
        return;
      }
      try {
        await active.stop('stopped');
      } catch (err) {
        console.error('[ws] stop_multi_agent failed', err);
        // onEnded won't fire if stop threw; emit a synthetic ended so the
        // client doesn't get stuck in 'running' state.
        send(conn.ws, {
          type: 'multi_agent_ended',
          sessionId: active.sessionId,
          reason: 'crashed',
          iterationId: null,
        });
        conn.multiAgent = null;
      }
      return;
    }
    case 'resume_multi_agent': {
      // Single-active invariant — same posture as start_multi_agent.
      if (conn.multiAgent) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'Another multi-agent session is already running; stop it first.',
        });
        return;
      }
      try {
        const result = await resumeMultiAgentTarget(msg.sessionId, {
          ...resumeCallbacks(conn),
          hopBudget: resolveHopBudget(),
        });
        if (!result.ok) {
          const message =
            result.reason === 'not-found'
              ? 'That session no longer exists.'
              : result.reason === 'already-running'
                ? 'That session is already running.'
                : 'Failed to re-attach: the server restarted and this run could not be reconstructed (chain-mode, or missing persisted resume state).';
          send(conn.ws, {
            type: 'wrapper_error',
            sessionId: msg.sessionId,
            kind: 'process_crashed',
            message,
          });
          return;
        }
        emitResumedSession(conn, result.resumed);
      } catch (err) {
        console.error('[ws] resume_multi_agent failed', err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'Failed to resume this session.',
        });
      }
      return;
    }
    case 'continue_multi_agent': {
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        // Not the active session — drop (raced an ended, or never
        // re-attached). The browser only shows Continue on the active run.
        return;
      }
      if (!('sendUserPrompt' in active)) {
        // Chain handles have no sendUserPrompt — chain reconstruction is
        // out of scope, so this should be unreachable, but fail loud.
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'Only orchestrator sessions can be continued.',
        });
        return;
      }
      const row = getMultiAgentSession(msg.sessionId);
      if (!row || row.awaiting_continue !== 1) {
        // Already continued (or never a recovered session). Idempotent
        // no-op so a double-click can't double-deliver the nudge.
        return;
      }
      try {
        // Clear the flag BEFORE delivering so a racing second click sees
        // awaiting_continue=0 and the guard above no-ops it.
        setAwaitingContinue(msg.sessionId, false);
        await active.sendUserPrompt(buildContinueNudge(msg.sessionId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
      }
      return;
    }
    case 'retry_worker': {
      // Item #4: re-deliver the captured prompt of the worker named in the
      // session's persisted pending-retry slot. Stateless — the server reads
      // the agent name + bytes from the DB, never from the client. The
      // router clears the slot BEFORE re-delivery so a racing second click
      // sees the empty slot and no-ops.
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        // Not the active session — drop. Idempotent.
        return;
      }
      const pending = getPendingRetry(msg.sessionId);
      if (!pending) {
        // No slot to retry; either never set or a racing second click won.
        return;
      }
      // If this session is also awaiting Continue (R-B reconstruct + a
      // failure that survived the restart), retrying implies acknowledging
      // the recovery context — clear awaiting_continue too so the banner
      // doesn't linger after the retried turn lands.
      try {
        const row = getMultiAgentSession(msg.sessionId);
        if (row?.awaiting_continue === 1) {
          setAwaitingContinue(msg.sessionId, false);
        }
      } catch (err) {
        console.error('[ws] clear awaiting_continue on retry failed', err);
      }
      try {
        await active.retry();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message,
        });
      }
      return;
    }
    case 'abandon_session': {
      // Item #4: give up on the pending-retry slot and end the session as
      // `'stopped'`. Same teardown as `stop_multi_agent`, distinct verb so
      // we can later differentiate post-hoc (analytics, iteration browser
      // labels) "operator stopped a healthy run" from "abandoned after a
      // failure". Handle.stop already clears pending-retry as part of its
      // teardown.
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        return;
      }
      try {
        await active.stop('stopped');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message,
        });
      }
      return;
    }
    case 'continue_through_mutation': {
      // Item #5: operator clicked Continue on the pause-on-first-mutation
      // banner. Idempotent — the handle reads its own pending slot and no-ops
      // if cleared. Clearing `awaiting_continue` happens inside the handle's
      // `continueThroughMutation` (it set it on pause; clears it on resume).
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        return;
      }
      try {
        await active.continueThroughMutation();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message,
        });
      }
      return;
    }
    case 'set_multi_agent_lifecycle': {
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        // No active session or a different one — drop silently. The
        // client may have raced a `multi_agent_ended`.
        return;
      }
      if (!('setLifecycle' in active)) {
        // Chain handle doesn't expose setLifecycle in v1. Surface as
        // wrapper_error so the operator gets feedback rather than a
        // silent no-op.
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'chain-mode sessions do not support lifecycle changes mid-run.',
        });
        return;
      }
      try {
        await active.setLifecycle(msg.lifecycle);
        send(conn.ws, {
          type: 'multi_agent_lifecycle_changed',
          sessionId: msg.sessionId,
          lifecycle: msg.lifecycle,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `set_multi_agent_lifecycle failed: ${message}`,
        });
      }
      return;
    }
    case 'add_multi_agent_participant': {
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        return;
      }
      if (!('addWorker' in active)) {
        // Chain-mode handle has no addWorker — chain_order is baked in
        // at start. Surface as wrapper_error.
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'chain-mode sessions do not support adding participants mid-run.',
        });
        return;
      }
      try {
        const result = await active.addWorker(msg.projectId);
        send(conn.ws, {
          type: 'multi_agent_participant_added',
          sessionId: msg.sessionId,
          projectId: msg.projectId,
          agentName: result.agentName,
          busWasAlreadyInstalled: result.busWasAlreadyInstalled,
        });
        // Project bus state may have changed via auto-install — notify
        // the sidebar so its bus-installed indicator updates. Matches
        // the `install_bus_integration` handler's two-message echo:
        // `bus_integration_changed` for the single project, plus a
        // refreshed `projects` list for any UI surface that reads the
        // wider state.
        if (!result.busWasAlreadyInstalled) {
          send(conn.ws, {
            type: 'bus_integration_changed',
            projectId: msg.projectId,
            installed: true,
            agentName: result.agentName,
          });
          const rows = await syncWorkspaceProjects();
          send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `add_multi_agent_participant failed: ${message}`,
        });
      }
      return;
    }
    case 'list_iterations': {
      send(conn.ws, { type: 'iterations', items: await buildIterationsList() });
      return;
    }
    case 'clear_iterations': {
      // Delete finished DB rows + their events + their participants. Disk
      // artifacts under the per-session folder are left in place — useful
      // for post-mortem; the operator can `rm -rf` by hand. The pure-SDK
      // runtime has no out-of-process sessions to reap: a still-live run
      // is in the in-process registry with a `running` row (never cleared
      // here), and a server restart already ended every prior run.
      clearFinishedMultiAgentSessions();
      send(conn.ws, { type: 'iterations', items: await buildIterationsList() });
      return;
    }
    case 'list_templates': {
      send(conn.ws, { type: 'templates', items: listTemplates() });
      return;
    }
    case 'save_template': {
      const items = saveTemplate({
        name: msg.name,
        mode: msg.mode,
        lifecycle: msg.lifecycle,
        participants: msg.participants,
        roles: msg.roles,
        // PR-6: passthrough only — repo persists as-is, future editor
        // validates via shared/topology.ts before sending.
        layout: msg.layout,
        // PR-7: optional per-template hop budget. The repo clamps + drops
        // non-finite/sub-1 input; passing `undefined` keeps the template
        // on the global default (no override).
        hopBudget: msg.hopBudget,
      });
      send(conn.ws, { type: 'templates', items });
      return;
    }
    case 'delete_template': {
      send(conn.ws, { type: 'templates', items: deleteTemplate(msg.id) });
      return;
    }
    case 'load_session_log': {
      // Phase H: paginated merged log for a multi-agent session. Pure read
      // — no DB mutation, no side effects, no permission check beyond
      // session existence. `revealSensitive=true` requires the operator's
      // explicit confirm client-side (the WS message is enough server-side
      // because the connection is already bound to 127.0.0.1).
      const meta = getMultiAgentSession(msg.sessionId);
      if (!meta) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `load_session_log: no such multi-agent session ${msg.sessionId}`,
        });
        return;
      }
      const offset = Number.isFinite(msg.offset) ? Math.max(0, Math.floor(msg.offset)) : 0;
      const limit = Number.isFinite(msg.limit) ? Math.max(1, Math.floor(msg.limit)) : 200;
      const chunk = buildSessionLogChunk({
        sessionId: msg.sessionId,
        offset,
        limit,
        revealSensitive: msg.revealSensitive === true,
      });
      send(conn.ws, {
        type: 'session_log_chunk',
        sessionId: msg.sessionId,
        offset,
        rows: chunk.rows,
        total: chunk.total,
        hasMore: chunk.hasMore,
        revealedSensitive: chunk.revealedSensitive,
      });
      return;
    }
    case 'send_message': {
      await runOneTurn(conn, msg);
      return;
    }
    case 'get_last_run_for_template': {
      // PR-7: read the most-recent persisted row for this template id, map
      // to the wire shape, and reply. Always emits — `lastRun: null` when
      // no row matches (template never used, or only used by pre-013 runs
      // whose `template_id` was never recorded). Pure read; safe to call
      // outside an active session.
      if (typeof msg.templateId !== 'string' || msg.templateId.length === 0) {
        send(conn.ws, {
          type: 'last_run_for_template',
          templateId: typeof msg.templateId === 'string' ? msg.templateId : '',
          lastRun: null,
        });
        return;
      }
      const row = getLastRunForTemplate(msg.templateId);
      if (!row) {
        send(conn.ws, { type: 'last_run_for_template', templateId: msg.templateId, lastRun: null });
        return;
      }
      // Resolve artifactsDir from the iteration id + session_folder, mirroring
      // the pattern used by the iterations browser handler above. NULL on
      // pre-006 rows with no iteration_id, omitted entirely on the wire then.
      const artifactsDir = row.iteration_id
        ? row.session_folder
          ? sessionPathsFromFolder(row.session_folder).iterationDir(row.iteration_id)
          : busIterationDir(row.iteration_id)
        : undefined;
      send(conn.ws, {
        type: 'last_run_for_template',
        templateId: msg.templateId,
        lastRun: {
          sessionId: row.id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          // SQLite has no enum — same `as` narrowing the iterations browser
          // uses above. Invalid stored statuses are impossible in practice
          // (the only writers are this server's typed code paths).
          status: row.status as 'running' | 'completed' | 'stopped' | 'crashed',
          hopsUsed: row.hops_used,
          hopBudget: row.hop_budget,
          ...(row.first_error ? { firstError: row.first_error } : {}),
          ...(artifactsDir ? { artifactsDir } : {}),
        },
      });
      return;
    }
    case 'read_project_facts': {
      // PR-6: pure-read RPC for the per-participant facts disclosure in the
      // template-preview modal. Always replies (even when the project row is
      // missing or there's no CLAUDE.md) so the client can resolve its
      // pending request and render whatever data IS available.
      const project = getProject(msg.projectId);
      if (!project) {
        // No matching project — emit a minimal stub so the disclosure shows
        // "(project unavailable)" rather than spinning forever. A wrapper_error
        // would be loud for what is, from the operator's POV, just stale
        // template data (a deleted project still referenced by a saved template).
        send(conn.ws, {
          type: 'project_facts',
          projectId: msg.projectId,
          facts: { name: `(deleted #${msg.projectId})`, path: '' },
        });
        return;
      }
      const head = readProjectClaudeMdHead(project.path);
      send(conn.ws, {
        type: 'project_facts',
        projectId: project.id,
        facts: {
          name: project.name,
          path: project.path,
          ...(head ? { claudeMdHead: head.head, claudeMdSizeLabel: head.sizeLabel } : {}),
        },
      });
      return;
    }
  }
}

async function runOneTurn(
  conn: Conn,
  msg: Extract<ClientMsg, { type: 'send_message' }>,
): Promise<void> {
  const project = getProject(msg.projectId);
  if (!project) {
    send(conn.ws, {
      type: 'wrapper_error',
      kind: 'process_crashed',
      message: `unknown project ${msg.projectId}`,
    });
    return;
  }

  // F5: when the caller supplies an existing sessionId, verify it belongs
  //     to the supplied projectId. Without this check a client could
  //     resume project B's session with cwd=project A, mixing transcripts
  //     across projects. Pattern mirrors `replaySession` below.
  if (msg.sessionId) {
    const existing = getSession(msg.sessionId);
    if (!existing || existing.project_id !== project.id) {
      send(conn.ws, {
        type: 'wrapper_error',
        sessionId: msg.sessionId,
        kind: 'process_crashed',
        message: `unknown session ${msg.sessionId} for project ${project.id}`,
      });
      return;
    }
  }

  const sessionId = msg.sessionId ?? randomUUID();
  if (!msg.sessionId) createSession(sessionId, project.id);
  touchProject(project.id);

  const ac = new AbortController();

  const trusted = project.trusted === 1;
  // Initial mode preserves the user's last in-session preference (persisted on
  // `sessions.permission_mode`) across turns. Falls back to the trust-derived
  // default for fresh sessions. Trust still drives `settingSources` either way.
  const permissionMode = seedPermissionMode(msg.sessionId, trusted);
  const settingSources = trusted ? (['user', 'project', 'local'] as const) : (['user'] as const);

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > => {
    // Read the live mode from `inFlight` (mutated by `set_permission_mode`).
    // The closure-captured `permissionMode` is the bootstrap fallback for the
    // narrow window before `inFlight.set(...)` runs below — in practice the SDK
    // doesn't emit tool calls before that, but be defensive.
    const liveMode = conn.inFlight.get(sessionId)?.permissionMode ?? permissionMode;
    if (shouldAutoAllow(trusted, liveMode, toolName)) {
      // Persist a silent record so replays can show "tool was auto-allowed"
      // without a card. We don't emit a ServerMsg — the tool_use block itself
      // is the user-visible signal that the tool ran.
      await persistMessage(sessionId, {
        type: 'wrapper',
        subtype: 'permission_auto_allowed',
        session_id: sessionId,
        uuid: randomUUID(),
        toolName,
        input,
        mode: liveMode,
      } as never);
      return { behavior: 'allow', updatedInput: input };
    }
    const requestId = randomUUID();
    // Item #5: classify server-side so the React card can pick the right
    // subcomponent (Bash / Edit / Write / …) + badge color without
    // re-running the classifier client-side. `category` / `summary` / `cwd`
    // / `projectName` are optional on the wire so pre-Item-5 replays still
    // render via the JSON-fallback subcomponent.
    const classification = classifyToolCall(toolName, input);
    send(conn.ws, {
      type: 'permission_request',
      requestId,
      sessionId,
      toolName,
      input,
      category: classification.category,
      summary: classification.summary,
      cwd: project.path,
      projectName: project.name,
    });
    await persistMessage(sessionId, {
      type: 'wrapper',
      subtype: 'permission_request',
      session_id: sessionId,
      uuid: requestId,
      requestId,
      toolName,
      input,
      category: classification.category,
      summary: classification.summary,
      cwd: project.path,
      projectName: project.name,
    } as never);
    return new Promise((resolve) => {
      conn.pendingPermissions.set(requestId, { sessionId, resolve, toolInput: input });
    });
  };

  const runner = pickRunner({
    cwd: project.path,
    prompt: msg.text,
    sessionId: msg.sessionId ? undefined : sessionId,
    resume: msg.sessionId,
    includePartialMessages: true,
    permissionMode,
    settingSources: [...settingSources],
    canUseTool,
    abortController: ac,
    maxTurns: config.maxTurns,
  });
  const unregister = registerQuery(runner);

  conn.inFlight.set(sessionId, { ac, projectId: project.id, runner, permissionMode });
  // Persist the seed so subsequent runOneTurn calls (this same session) and
  // replay see it. This also covers brand-new sessions where the row was just
  // INSERTed with permission_mode = NULL.
  setSessionPermissionMode(sessionId, permissionMode);
  send(conn.ws, {
    type: 'session_running',
    projectId: project.id,
    sessionId,
    running: true,
  });
  send(conn.ws, {
    type: 'permission_mode_changed',
    sessionId,
    mode: permissionMode,
  });

  try {
    for await (const sdkMsg of runner) {
      await persistMessage(sessionId, sdkMsg);
      const out = translate(sdkMsg, project.id);
      if (out) send(conn.ws, out);
    }
  } catch (err) {
    const wrap = classifyError(err);
    send(conn.ws, { type: 'wrapper_error', sessionId, kind: wrap.kind, message: wrap.message });
    await persistMessage(sessionId, {
      type: 'wrapper',
      subtype: wrap.kind,
      session_id: sessionId,
      uuid: randomUUID(),
      message: wrap.message,
    } as never);
  } finally {
    try {
      runner.close?.();
    } catch (err) {
      console.error('[ws] runner.close failed', err);
    }
    unregister();
    conn.inFlight.delete(sessionId);
    closeLogger(sessionId);
    send(conn.ws, {
      type: 'session_running',
      projectId: project.id,
      sessionId,
      running: false,
    });
  }
}

async function replaySession(conn: Conn, projectId: number, sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session || session.project_id !== projectId) {
    send(conn.ws, {
      type: 'wrapper_error',
      sessionId,
      kind: 'process_crashed',
      message: `unknown session ${sessionId} for project ${projectId}`,
    });
    return;
  }
  send(conn.ws, { type: 'session_history_start', projectId, sessionId });
  for (const row of listEvents(sessionId)) {
    let parsed: SDKMessage;
    try {
      parsed = JSON.parse(row.raw) as SDKMessage;
    } catch {
      continue;
    }
    const out = translate(parsed, projectId);
    if (out) send(conn.ws, out);
  }
  send(conn.ws, { type: 'session_history_end', projectId, sessionId });

  // Replay the persisted permission mode for past sessions too, so the toggle
  // UI doesn't lie about what was active. Live sessions overwrite this with
  // the in-memory mode below.
  const stored = getSessionPermissionMode(sessionId);
  if (stored) {
    send(conn.ws, { type: 'permission_mode_changed', sessionId, mode: stored });
  }

  const live = conn.inFlight.get(sessionId);
  if (live) {
    send(conn.ws, { type: 'session_running', projectId, sessionId, running: true });
    send(conn.ws, {
      type: 'permission_mode_changed',
      sessionId,
      mode: live.permissionMode,
    });
  }
}

export type { Conn };
