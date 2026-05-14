import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { WebSocket, WebSocketServer } from 'ws';
import {
  isSessionPermissionMode,
  type ClientMsg,
  type ServerMsg,
  type SessionPermissionMode,
} from '@cebab/shared/protocol';
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
import { getSetting } from '../repo/settings.js';
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
import { InstallError, installBusForProject, uninstallBusForProject } from '../bus/install.js';
import {
  resolveChainParticipants,
  startChainSession,
  type ChainSessionHandle,
} from '../bus/chain.js';
import {
  resolveOrchestratorWorkers,
  startOrchestratorSession,
  type OrchestratorSessionHandle,
} from '../bus/orchestrator.js';
import { ResolveAgentError } from '../bus/runtime.js';
import { attemptResumeMultiAgent, type ResumeFailureReason } from '../bus/resume.js';
import {
  clearFinishedMultiAgentSessions,
  listMultiAgentSessionsWithIteration,
  listResolvedParticipants,
  listRunningTmuxSessionNames,
} from '../repo/multi_agent.js';
import { busIterationDir, sessionPathsFromFolder } from '../bus/paths.js';
import { killSession, listSessions as listTmuxSessions } from '../bus/tmux.js';
import { ORCHESTRATOR_AGENT_NAME } from '../bus/orchestrator.js';
import type { IterationSummary } from '@cebab/shared/protocol';
import { type MultiAgentEventKind, isMultiAgentEventKind } from '@cebab/shared/protocol';
import { buildAllowedOrigins, isAllowedHost } from '../origin.js';
import { verifyToken } from '../auth.js';

type PendingPermission = {
  sessionId: string;
  resolve: (
    decision:
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string },
  ) => void;
  toolInput: Record<string, unknown>;
};

type InFlight = {
  ac: AbortController;
  projectId: number;
  runner: Runner;
  permissionMode: SessionPermissionMode;
};

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
    // Multi-agent: detach but DON'T kill. The bus session keeps running in
    // tmux; the DB row stays 'running'. A future WS connect (browser
    // refresh, Cebab restart, second window) calls `attemptResumeMultiAgent`
    // to re-attach. The Stop button is the only way an operator
    // intentionally tears a session down.
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
 * Async helper that runs after a WS connect: look up any active multi-agent
 * session in the DB, validate against tmux, and re-attach if alive. Catches
 * its own errors so a failed resume doesn't leak into the WS error handler.
 */
async function resumeOnConnect(conn: Conn): Promise<void> {
  try {
    const resumed = await attemptResumeMultiAgent({
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
        send(conn.ws, {
          type: 'multi_agent_ended',
          sessionId,
          reason,
          iterationId,
        });
        if (conn.multiAgent?.sessionId === sessionId) {
          conn.multiAgent = null;
        }
      },
      onResumeFailed: (sessionId, reason) => {
        // Surface auto-resume failures as a wrapper_error toast so the
        // operator notices instead of "Cebab silently lost my session".
        // The row is already crash-marked at this point — the toast
        // just makes that state observable without opening the
        // Iterations browser.
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId,
          kind: 'process_crashed',
          message: resumeFailureMessage(sessionId, reason),
        });
      },
    });
    if (!resumed) return;

    conn.multiAgent = resumed.handle;
    // Tell the browser this session is active. The reducer's
    // `multi_agent_started` case CLEARS the event list to [], so the
    // replay below populates it fresh in DB order.
    send(conn.ws, {
      type: 'multi_agent_started',
      sessionId: resumed.handle.sessionId,
      mode: resumed.mode,
      // We don't know the original `participants` (project ids) because
      // they're only carried on the start request, not the DB row. The
      // reducer doesn't use this field beyond the started message; pass
      // an empty list. (PR 6 could DB-persist the original project ids if
      // we ever need them client-side — out of scope here.)
      participants: [],
      participantAgentNames: resumed.handle.participantAgentNames,
      tmuxSession: resumed.handle.tmuxSession,
      lifecycle: resumed.handle.lifecycle,
      sessionFolder: resumed.handle.sessionFolder,
    });
    // Replay persisted events in DB-id order. The tailer is already
    // attached (at EOF); live events from the resumed session will arrive
    // after this loop completes since the JS event loop is busy
    // synchronously sending these.
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
  } catch (err) {
    console.error('[ws] resumeOnConnect failed', err);
  }
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
  });
}

/**
 * Map a `ResumeFailureReason` to the user-facing message that ships in the
 * `wrapper_error.message` field. Kept close to the WS layer so the wording
 * (which the operator sees in a toast) doesn't drift away from the
 * symptoms it describes. The session id slice helps disambiguate when the
 * operator has run multiple multi-agent sessions in a row.
 */
function resumeFailureMessage(sessionId: string, reason: ResumeFailureReason): string {
  const slug = sessionId.slice(0, 8);
  switch (reason) {
    case 'tmux-unavailable':
      return `Couldn't resume multi-agent session ${slug}: tmux isn't running. The session has been marked crashed.`;
    case 'tmux-missing':
      return `Couldn't resume multi-agent session ${slug}: its tmux session is gone (likely killed by reboot or manual cleanup). Marked crashed.`;
    case 'legacy-row':
      return `Couldn't resume multi-agent session ${slug}: legacy DB row missing tmux/iteration info. Marked crashed.`;
    case 'reattach-failed':
      return `Couldn't reattach to multi-agent session ${slug}: a participant likely lost its bus integration. Marked crashed.`;
  }
}

/** Display-label cap. Long enough for "Refactor the WS upgrade handler", short
 * enough not to wreck the sidebar layout. */
const MAX_SESSION_TITLE_LEN = 80;

/** Prefix every Cebab-spawned multi-agent tmux session shares. Used by the
 *  `clear_iterations` reaper to scope its kill loop to sessions we own
 *  (operator's unrelated tmux sessions are left untouched). */
const CEBAB_BUS_TMUX_PREFIX = 'cebab-bus-';

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
export function buildIterationsList(): IterationSummary[] {
  const rows = listMultiAgentSessionsWithIteration();
  return rows.map((row) => {
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
    return {
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
    };
  });
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
      // F12: drain any pending permission Promises for this session before
      //      abort/interrupt. Otherwise their entries leak in the map until
      //      WS close — functionally benign (abort cancels the SDK's
      //      canUseTool callback) but unbounded growth under a burst of
      //      interrupts. Mirrors the close-handler pattern at the top of
      //      onConnection. Filter by sessionId so other concurrent sessions
      //      on the same WS connection aren't affected.
      for (const [requestId, pending] of conn.pendingPermissions) {
        if (pending.sessionId !== msg.sessionId) continue;
        pending.resolve({ behavior: 'deny', message: 'interrupted' });
        conn.pendingPermissions.delete(requestId);
      }
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
          });
          conn.multiAgent = handle;
          send(conn.ws, {
            type: 'multi_agent_started',
            sessionId: handle.sessionId,
            mode: 'orchestrator',
            participants: msg.participants,
            participantAgentNames: handle.participantAgentNames,
            tmuxSession: handle.tmuxSession,
            lifecycle: handle.lifecycle,
            sessionFolder: handle.sessionFolder,
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
        });
        conn.multiAgent = handle;
        send(conn.ws, {
          type: 'multi_agent_started',
          sessionId: handle.sessionId,
          mode: 'chain',
          participants: msg.participants,
          participantAgentNames: handle.participantAgentNames,
          tmuxSession: handle.tmuxSession,
          lifecycle: handle.lifecycle,
          sessionFolder: handle.sessionFolder,
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
        // and-forget after the initial input lands in participant[0]'s
        // inbox. Surface as a wrapper_error so the operator gets feedback.
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
    case 'list_iterations': {
      send(conn.ws, { type: 'iterations', items: buildIterationsList() });
      return;
    }
    case 'clear_iterations': {
      // Two-step cleanup. (1) Reap any orphan tmux sessions: live
      // `cebab-bus-*` sessions whose DB row no longer says
      // `status='running'`. These accumulate when Cebab restarts mid-
      // session, when the operator manually deletes DB rows, or when a
      // session's `running` row was cleared by a previous Clear before
      // this reaper shipped. Sessions still backed by a running DB row
      // are preserved (matched by exact `tmux_session` name). (2) Delete
      // finished DB rows + their events + their participants. Disk
      // artifacts under the per-session folder are left in place —
      // useful for post-mortem; operator can `rm -rf` by hand.
      try {
        const protectedNames = new Set(listRunningTmuxSessionNames());
        const live = await listTmuxSessions();
        for (const name of live) {
          if (!name.startsWith(CEBAB_BUS_TMUX_PREFIX)) continue;
          if (protectedNames.has(name)) continue;
          try {
            await killSession(name);
          } catch (err) {
            // killSession itself is idempotent on the missing-session
            // case; any other failure is logged but not surfaced — the
            // operator's Clear request still completes for the DB side.
            console.warn(`[ws] orphan killSession(${name}) failed during clear`, err);
          }
        }
      } catch (err) {
        // tmux not installed, or list-sessions returned an unexpected
        // error. Either way, the DB clear below is independent and
        // worth completing. Logged for diagnosis.
        console.warn('[ws] tmux orphan scan during clear failed', err);
      }
      clearFinishedMultiAgentSessions();
      send(conn.ws, { type: 'iterations', items: buildIterationsList() });
      return;
    }
    case 'send_message': {
      await runOneTurn(conn, msg);
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
    send(conn.ws, {
      type: 'permission_request',
      requestId,
      sessionId,
      toolName,
      input,
    });
    await persistMessage(sessionId, {
      type: 'wrapper',
      subtype: 'permission_request',
      session_id: sessionId,
      uuid: requestId,
      requestId,
      toolName,
      input,
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
