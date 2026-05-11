import { useEffect, useReducer, useRef, useState } from 'react';
import type { SessionPermissionMode } from '@cebab/shared/protocol';
import { connectWs, type WsHandle } from './ws';
import { activeSession, initialState, isSessionPending, reduce } from './store';
import { ProjectList } from './components/ProjectList';
import { ChatView } from './components/ChatView';
import { InputBox } from './components/InputBox';
import { ModeToggle } from './components/ModeToggle';
import { SettingsModal } from './components/SettingsModal';

const SERVER_PORT = import.meta.env.VITE_SERVER_PORT ?? '4319';
const WS_URL = `ws://${window.location.hostname}:${SERVER_PORT}`;

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const wsRef = useRef<WsHandle | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const ws = connectWs({
      url: WS_URL,
      onOpen: () => {
        dispatch({ type: 'ws_open' });
        ws.send({ type: 'get_settings' });
        ws.send({ type: 'list_projects' });
      },
      onClose: () => dispatch({ type: 'ws_close' }),
      onMessage: (msg) => dispatch({ type: 'server', msg }),
    });
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  // First-run UX: open the settings modal automatically when we learn the
  // workspace path is unset / invalid.
  useEffect(() => {
    if (state.settings && !state.settings.workspaceRootValid) {
      setSettingsOpen(true);
    }
  }, [state.settings?.workspaceRootValid]);

  function selectProject(projectId: number) {
    dispatch({ type: 'select_project', projectId });
    wsRef.current?.send({ type: 'open_project', projectId });
  }

  function selectSession(projectId: number, sessionId: string) {
    const alreadyHydrated = !!state.sessionsByProject[projectId]?.[sessionId];
    dispatch({ type: 'select_session', projectId, sessionId });
    if (!alreadyHydrated) {
      wsRef.current?.send({ type: 'load_session', projectId, sessionId });
    }
  }

  function newSession(projectId: number) {
    dispatch({ type: 'new_session', projectId });
  }

  function toggleTrust(projectId: number, trusted: boolean) {
    wsRef.current?.send({ type: 'set_trusted', projectId, trusted });
  }

  function renameSession(sessionId: string, title: string | null) {
    const projectId = state.sessionToProject[sessionId];
    if (projectId === undefined) return;
    // Optimistic: dispatch the would-be ServerMsg locally so the sidebar flips
    // immediately. The reducer is idempotent — when the server echo arrives
    // with the normalized title (trimmed, capped at 80) it produces the same
    // state. Mismatches (e.g. server rejected the rename) are rare on this
    // single-user app; the server echo would correct them either way.
    dispatch({
      type: 'server',
      msg: { type: 'session_renamed', sessionId, projectId, title },
    });
    wsRef.current?.send({ type: 'rename_session', sessionId, title });
  }

  const session = activeSession(state);
  const resumeSessionId = session && !isSessionPending(session.id) ? session.id : undefined;
  const permissionMode: SessionPermissionMode = session
    ? (state.permissionModeBySession[session.id] ?? 'default')
    : 'default';
  const sessionIsLive = session ? state.liveSessions[session.id] === true : false;

  function sendMessage(text: string) {
    if (!state.activeProjectId) return;
    dispatch({ type: 'user_send', text });
    wsRef.current?.send({
      type: 'send_message',
      projectId: state.activeProjectId,
      sessionId: resumeSessionId,
      text,
    });
  }

  function decidePermission(requestId: string, decision: 'allow' | 'deny') {
    if (!session) return;
    // Optimistic local update so the buttons flip to "decided: …" immediately.
    // The server echoes a permission_decided ServerMsg back; the reducer is
    // idempotent so the second arrival is a no-op.
    dispatch({
      type: 'server',
      msg: {
        type: 'permission_decided',
        sessionId: session.id,
        requestId,
        decision,
      },
    });
    wsRef.current?.send({
      type: 'permission_decision',
      sessionId: session.id,
      requestId,
      decision,
    });
  }

  function setPermissionMode(mode: SessionPermissionMode) {
    if (!session || isSessionPending(session.id)) return;
    wsRef.current?.send({
      type: 'set_permission_mode',
      sessionId: session.id,
      mode,
    });
  }

  function saveWorkspaceRoot(path: string) {
    wsRef.current?.send({ type: 'set_workspace_root', path });
    setSettingsOpen(false);
  }

  const running = session?.status === 'running';
  const workspaceReady = state.settings?.workspaceRootValid ?? false;
  const inputDisabled = !state.activeProjectId || running || !workspaceReady;

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>cebab</h1>
          <span
            className={state.connected ? 'dot on' : 'dot off'}
            title={state.connected ? 'connected' : 'disconnected'}
          />
        </header>
        <ProjectList
          projects={state.projects}
          activeProjectId={state.activeProjectId}
          activeSessionByProject={state.activeSessionByProject}
          knownSessions={state.knownSessions}
          liveSessions={state.liveSessions}
          onSelectProject={selectProject}
          onSelectSession={selectSession}
          onNewSession={newSession}
          onToggleTrust={toggleTrust}
          onRenameSession={renameSession}
        />
        <footer className="sidebar-footer">
          <button
            className={`workspace-btn ${
              state.settings && !state.settings.workspaceRootValid ? 'warn' : ''
            }`}
            title={
              state.settings?.workspaceRoot
                ? `${state.settings.workspaceRoot}\nClick to change workspace`
                : 'Pick a workspace folder'
            }
            onClick={() => setSettingsOpen(true)}
          >
            <span className="workspace-btn-icon" aria-hidden="true">
              ⚙
            </span>
            <span className="workspace-btn-label">
              {workspaceLabel(state.settings?.workspaceRoot ?? null)}
            </span>
          </button>
        </footer>
      </aside>
      <main className="main">
        {!workspaceReady ? (
          <div className="chat empty">
            <div>
              <p>No workspace folder set yet.</p>
              <button className="primary-btn" onClick={() => setSettingsOpen(true)}>
                Choose a folder
              </button>
            </div>
          </div>
        ) : (
          <>
            {session && !isSessionPending(session.id) && (
              <ModeToggle
                mode={permissionMode}
                disabled={!sessionIsLive}
                onChange={setPermissionMode}
              />
            )}
            <ChatView session={session} onPermissionDecide={decidePermission} />
            <InputBox disabled={inputDisabled} onSend={sendMessage} />
          </>
        )}
      </main>
      {settingsOpen && state.settings && (
        <SettingsModal
          settings={state.settings}
          onClose={() => setSettingsOpen(false)}
          onSave={saveWorkspaceRoot}
        />
      )}
    </div>
  );
}

/**
 * Label for the sidebar footer's workspace button: the trailing folder name of
 * the workspace path (e.g. `/Users/foo/agents` → `agents`). The server resolves
 * `~`-paths and relative paths server-side, so by the time we see them here
 * they're absolute POSIX paths — split-pop is enough.
 */
function workspaceLabel(workspaceRoot: string | null): string {
  if (!workspaceRoot) return 'Set workspace';
  const trimmed = workspaceRoot.replace(/\/+$/, '');
  const base = trimmed.split('/').pop();
  return base && base.length > 0 ? base : trimmed;
}
