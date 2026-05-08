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
import { translate } from './translate.js';
import { classifyError } from './errors.js';
import { shouldAutoAllow } from './permission.js';

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
};

/** Origins permitted to upgrade to a WS. Built once, lazily. */
function buildAllowedOrigins(): Set<string> {
  const base = new Set<string>([
    `http://127.0.0.1:5173`,
    `http://localhost:5173`,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ]);
  for (const o of config.allowedOrigins) base.add(o);
  return base;
}

function isAllowedHost(host: string): boolean {
  return host === `127.0.0.1:${config.port}` || host === `localhost:${config.port}`;
}

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
      // Origin can't be a Cross-Site WebSocket Hijack — and the server is
      // bound to 127.0.0.1 anyway, so the threat surface is local-only.
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
  const conn: Conn = { ws, pendingPermissions: new Map(), inFlight: new Map() };

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
  });
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
    case 'interrupt': {
      const f = conn.inFlight.get(msg.sessionId);
      if (!f) return;
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
