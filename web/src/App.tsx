import { useEffect, useReducer, useRef, useState } from 'react';
import type { MultiAgentLifecycle, SessionPermissionMode } from '@cebab/shared/protocol';
import { connectWs, type WsHandle } from './ws';
import { activeSession, initialState, isSessionPending, reduce } from './store';
import { ProjectList } from './components/ProjectList';
import { ChatView } from './components/ChatView';
import { InputBox } from './components/InputBox';
import { ModeToggle } from './components/ModeToggle';
import { SettingsModal } from './components/SettingsModal';
import { MultiAgentTab } from './components/MultiAgentTab';

const SERVER_PORT = import.meta.env.VITE_SERVER_PORT ?? '4319';
const HTTP_BASE = `http://${window.location.hostname}:${SERVER_PORT}`;
const WS_URL = `ws://${window.location.hostname}:${SERVER_PORT}`;

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const wsRef = useRef<WsHandle | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let ws: WsHandle | null = null;
    // F4: fetch the per-launch auth token before opening the WS. The
    //     /auth-token endpoint is Origin+Host gated server-side; a
    //     cross-origin tab can't read it. We then append `?token=` to
    //     the WS URL so the server's verifyClient gate accepts the
    //     upgrade. See server/src/auth.ts.
    (async () => {
      let token: string;
      try {
        const r = await fetch(`${HTTP_BASE}/auth-token`);
        if (!r.ok) throw new Error(`status ${r.status}`);
        token = (await r.text()).trim();
      } catch (err) {
        console.error('[ws] failed to fetch auth token', err);
        return;
      }
      if (cancelled) return;
      ws = connectWs({
        url: `${WS_URL}/?token=${encodeURIComponent(token)}`,
        onOpen: () => {
          dispatch({ type: 'ws_open' });
          ws?.send({ type: 'get_settings' });
          ws?.send({ type: 'list_projects' });
        },
        onClose: () => dispatch({ type: 'ws_close' }),
        onMessage: (msg) => dispatch({ type: 'server', msg }),
      });
      wsRef.current = ws;
    })();
    return () => {
      cancelled = true;
      ws?.close();
    };
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

  function setMultiAgentMode(mode: 'chain' | 'orchestrator') {
    dispatch({ type: 'ma_set_mode', mode });
  }
  function setMultiAgentLifecycle(lifecycle: MultiAgentLifecycle) {
    dispatch({ type: 'ma_set_lifecycle', lifecycle });
  }
  function addParticipant(projectId: number) {
    dispatch({ type: 'ma_add_participant', projectId });
  }
  function removeParticipant(projectId: number) {
    dispatch({ type: 'ma_remove_participant', projectId });
  }
  function reorderParticipant(projectId: number, direction: 'up' | 'down') {
    dispatch({ type: 'ma_reorder_participant', projectId, direction });
  }
  function installBus(projectId: number) {
    wsRef.current?.send({ type: 'install_bus_integration', projectId });
  }
  function uninstallBus(projectId: number) {
    wsRef.current?.send({ type: 'uninstall_bus_integration', projectId });
  }
  function setDraftPrompt(text: string) {
    dispatch({ type: 'ma_set_draft_prompt', text });
  }
  function startChain() {
    const { mode, draftParticipants, draftPrompt, draftLifecycle } = state.multiAgent;
    if (mode !== 'chain') return;
    if (draftPrompt.trim().length === 0) return;
    if (draftParticipants.length < 2) return;
    wsRef.current?.send({
      type: 'start_multi_agent',
      mode: 'chain',
      participants: draftParticipants,
      initialPrompt: draftPrompt,
      lifecycle: draftLifecycle,
    });
  }
  function startOrchestrator() {
    const { mode, draftParticipants, draftPrompt, draftLifecycle } = state.multiAgent;
    if (mode !== 'orchestrator') return;
    if (draftPrompt.trim().length === 0) return;
    // Orchestrator mode is hub-and-spoke; even one worker is functional
    // (degenerate, but useful for smoke testing the routing path).
    if (draftParticipants.length < 1) return;
    wsRef.current?.send({
      type: 'start_multi_agent',
      mode: 'orchestrator',
      participants: draftParticipants,
      initialPrompt: draftPrompt,
      lifecycle: draftLifecycle,
    });
  }
  function stopMultiAgent(sessionId: string) {
    wsRef.current?.send({ type: 'stop_multi_agent', sessionId });
  }
  function sendMultiAgentUserPrompt(sessionId: string, text: string) {
    // Caller (the active-run input) already trims; nothing else to validate
    // here. The reducer doesn't track an optimistic local copy — the prompt
    // round-trips through bus.log as a `multi_agent_event` with
    // source=cebab, so it shows up in the scrollback like any other event.
    wsRef.current?.send({ type: 'multi_agent_user_prompt', sessionId, text });
  }
  function setActiveLifecycle(sessionId: string, lifecycle: MultiAgentLifecycle) {
    // Server validates: orchestrator-mode only, sessionId must match the
    // active session. On success, server echoes `multi_agent_lifecycle_changed`
    // which the reducer applies to `state.multiAgent.active.lifecycle`.
    // No optimistic update — wait for the echo so the UI never drifts
    // from server truth.
    wsRef.current?.send({ type: 'set_multi_agent_lifecycle', sessionId, lifecycle });
  }
  function dismissActiveRun() {
    dispatch({ type: 'ma_dismiss_active' });
  }
  function refreshIterations() {
    wsRef.current?.send({ type: 'list_iterations' });
  }
  function clearIterations() {
    // Server-side: deletes every multi_agent_sessions row whose status is
    // not 'running', along with its events and participants, then re-sends
    // the (now empty / running-only) iterations list. No client-side
    // optimistic update — we wait for the server reply so the cache stays
    // consistent with the DB even if the WS round-trip fails.
    wsRef.current?.send({ type: 'clear_iterations' });
  }

  // Lazy-load iterations on first switch into the Multi-Agent tab. Also
  // refresh after each `multi_agent_ended` so a just-finished run appears
  // without an explicit user action.
  const maView = state.multiAgent.view;
  const iterationsLoaded = state.multiAgent.iterations !== null;
  const activeStatus = state.multiAgent.active?.status;
  useEffect(() => {
    if (maView === 'multi-agent' && !iterationsLoaded) {
      refreshIterations();
    }
  }, [maView, iterationsLoaded]);
  useEffect(() => {
    // status flips from 'running' → terminal exactly once per session.
    // Refresh so the iteration browser picks up the just-ended row.
    if (activeStatus && activeStatus !== 'running') {
      refreshIterations();
    }
  }, [activeStatus]);

  const running = session?.status === 'running';
  const workspaceReady = state.settings?.workspaceRootValid ?? false;
  const inputDisabled = !state.activeProjectId || running || !workspaceReady;
  const view = state.multiAgent.view;

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
          onUninstallBus={uninstallBus}
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
            <nav className="main-tabs" aria-label="Main view">
              <button
                className={`main-tab ${view === 'chat' ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'ma_set_view', view: 'chat' })}
                aria-pressed={view === 'chat'}
              >
                Chat
              </button>
              <button
                className={`main-tab ${view === 'multi-agent' ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'ma_set_view', view: 'multi-agent' })}
                aria-pressed={view === 'multi-agent'}
              >
                Multi-agent
              </button>
            </nav>
            {view === 'chat' ? (
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
            ) : (
              <MultiAgentTab
                projects={state.projects}
                multiAgent={state.multiAgent}
                onSetMode={setMultiAgentMode}
                onSetLifecycle={setMultiAgentLifecycle}
                onAddParticipant={addParticipant}
                onRemoveParticipant={removeParticipant}
                onReorderParticipant={reorderParticipant}
                onInstallBus={installBus}
                onUninstallBus={uninstallBus}
                onSetDraftPrompt={setDraftPrompt}
                onStartChain={startChain}
                onStartOrchestrator={startOrchestrator}
                onStopMultiAgent={stopMultiAgent}
                onSendUserPrompt={sendMultiAgentUserPrompt}
                onSetActiveLifecycle={setActiveLifecycle}
                onDismissActive={dismissActiveRun}
                onRefreshIterations={refreshIterations}
                onClearIterations={clearIterations}
              />
            )}
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
