import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { getProject, setProjectTrusted, touchProject } from '../repo/projects.js';
import { createSession, getSession, listSessionsForProject } from '../repo/sessions.js';
import { listEvents } from '../repo/events.js';
import { persistMessage } from '../runner/orchestrator.js';
import { closeLogger } from '../runner/logger.js';
import { pickRunner } from '../runner/index.js';
import { registerQuery } from '../runner/lifecycle.js';
import { rowToProject, syncWorkspaceProjects } from '../workspace.js';
import { translate } from './translate.js';
import { classifyError } from './errors.js';

type PendingPermission = {
  resolve: (
    decision:
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string },
  ) => void;
  toolInput: Record<string, unknown>;
};

type InFlight = { ac: AbortController; projectId: number };

type Conn = {
  ws: WebSocket;
  pendingPermissions: Map<string, PendingPermission>;
  inFlight: Map<string, InFlight>;
};

export function startWsServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server });
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
    // Resolve any blocked permission requests so the SDK doesn't hang.
    for (const pending of conn.pendingPermissions.values()) {
      pending.resolve({ behavior: 'deny', message: 'client disconnected' });
    }
    conn.pendingPermissions.clear();
    // Abort any in-flight runs.
    for (const f of conn.inFlight.values()) f.ac.abort();
    conn.inFlight.clear();
  });
}

async function handleClientMsg(conn: Conn, msg: ClientMsg): Promise<void> {
  switch (msg.type) {
    case 'list_projects': {
      const rows = syncWorkspaceProjects();
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
      const rows = syncWorkspaceProjects();
      send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      return;
    }
    case 'permission_decision': {
      const pending = conn.pendingPermissions.get(msg.requestId);
      if (!pending) return;
      conn.pendingPermissions.delete(msg.requestId);
      if (msg.decision === 'allow') {
        pending.resolve({ behavior: 'allow', updatedInput: pending.toolInput });
      } else {
        pending.resolve({
          behavior: 'deny',
          message: msg.message ?? 'User denied this action',
        });
      }
      return;
    }
    case 'interrupt': {
      conn.inFlight.get(msg.sessionId)?.ac.abort();
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
  conn.inFlight.set(sessionId, { ac, projectId: project.id });
  send(conn.ws, {
    type: 'session_running',
    projectId: project.id,
    sessionId,
    running: true,
  });

  const trusted = project.trusted === 1;
  const permissionMode: 'default' | 'acceptEdits' = trusted ? 'acceptEdits' : 'default';

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > => {
    if (trusted) return { behavior: 'allow', updatedInput: input };
    const requestId = randomUUID();
    const reqMsg: ServerMsg = {
      type: 'permission_request',
      requestId,
      sessionId,
      toolName,
      input,
    };
    send(conn.ws, reqMsg);
    persistMessage(sessionId, {
      type: 'wrapper',
      subtype: 'permission_request',
      session_id: sessionId,
      uuid: requestId,
      requestId,
      toolName,
      input,
    } as never);
    return new Promise((resolve) => {
      conn.pendingPermissions.set(requestId, { resolve, toolInput: input });
    });
  };

  const runner = pickRunner({
    cwd: project.path,
    prompt: msg.text,
    sessionId: msg.sessionId ? undefined : sessionId,
    resume: msg.sessionId,
    includePartialMessages: true,
    permissionMode,
    canUseTool,
    abortController: ac,
  });
  const unregister = registerQuery(runner as { close?: () => void });

  try {
    for await (const sdkMsg of runner) {
      persistMessage(sessionId, sdkMsg);
      const out = translate(sdkMsg, project.id);
      if (out) send(conn.ws, out);
    }
  } catch (err) {
    const wrap = classifyError(err);
    send(conn.ws, { type: 'wrapper_error', sessionId, kind: wrap.kind, message: wrap.message });
    persistMessage(sessionId, {
      type: 'wrapper',
      subtype: wrap.kind,
      session_id: sessionId,
      uuid: randomUUID(),
      message: wrap.message,
    } as never);
  } finally {
    // Close the SDK Query so its spawned `claude` subprocess exits.
    try {
      (runner as { close?: () => void }).close?.();
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
  // If the session is currently in flight on this connection, the live status
  // is implicit (we already sent session_running:true when the turn began);
  // just nudge the client so it knows after a fresh load.
  if (conn.inFlight.has(sessionId)) {
    send(conn.ws, { type: 'session_running', projectId, sessionId, running: true });
  }
}

export type { Conn };
