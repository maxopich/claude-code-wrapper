import { useEffect, useReducer, useRef, useState } from 'react';
import type {
  MultiAgentLifecycle,
  MultiAgentTemplate,
  ServerMsg,
  SessionPermissionMode,
} from '@cebab/shared/protocol';
import { connectWs, type WsHandle } from './ws';
import { activeSession, initialState, isSessionPending, reduce } from './store';
import { ProjectList } from './components/ProjectList';
import { ChatView } from './components/ChatView';
import { InputBox } from './components/InputBox';
import { ModeToggle } from './components/ModeToggle';
import { ChatHeaderChip } from './components/ChatHeaderChip';
import { SlashCommandButtons } from './components/SlashCommandButtons';
import { SettingsModal } from './components/SettingsModal';
import { MultiAgentTab, MultiAgentActivityBar, TopRunBar } from './components/MultiAgentTab';
import { ClaudeMark } from './components/ClaudeMark';
import { Icon } from './components/Icon';
import { mqBelow } from './breakpoints';

const SERVER_PORT = import.meta.env.VITE_SERVER_PORT ?? '4319';
const HTTP_BASE = `http://${window.location.hostname}:${SERVER_PORT}`;
const WS_URL = `ws://${window.location.hostname}:${SERVER_PORT}`;

// Sidebar layout prefs. First localStorage usage in the app — kept to two
// plain keys, no abstraction. Reads/writes are try/catch'd so private mode
// or a full quota can't break the app over a non-critical preference.
const SIDEBAR_MIN = 170;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 220;
const SIDEBAR_KEY_STEP = 16;

function clampSidebarWidth(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(n)));
}
function readStored<T>(key: string, fallback: T, parse: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-critical preference — ignore */
  }
}

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const wsRef = useRef<WsHandle | null>(null);
  /**
   * Phase H side channel: ServerMsg subscribers for surfaces whose state
   * doesn't belong in Redux. The Logs modal subscribes here for
   * `session_log_chunk` deliveries — keeping the chunk rows out of AppState
   * (they're transient and big) while still funneling through the single WS
   * connection. The reducer dispatch fires FIRST, then subscribers; mutual
   * dependencies (Redux update + side effect) flow in a predictable order.
   */
  const msgSubscribersRef = useRef<Set<(msg: ServerMsg) => void>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readStored('cebab.sidebarCollapsed', false, (r) => r === 'true'),
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStored('cebab.sidebarWidth', SIDEBAR_DEFAULT, (r) => clampSidebarWidth(Number(r))),
  );
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarResizingRef = useRef(false);

  useEffect(() => {
    writeStored('cebab.sidebarCollapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  useEffect(() => {
    writeStored('cebab.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  // At ≤md the sidebar isn't user-resizable; unmount the resizer to
  // keep it out of the tab order and out of pointer-event reach. At
  // ≤sm the sidebar auto-collapses to an icon rail (PR-3), so the
  // resizer is also gone there. Both states are derived from
  // matchMedia and re-subscribed on resize.
  const [resizerSuppressed, setResizerSuppressed] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(mqBelow('md')).matches,
  );
  const [isBelowSm, setIsBelowSm] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(mqBelow('sm')).matches,
  );
  useEffect(() => {
    const mqMd = window.matchMedia(mqBelow('md'));
    const mqSm = window.matchMedia(mqBelow('sm'));
    const onMd = (e: MediaQueryListEvent) => setResizerSuppressed(e.matches);
    const onSm = (e: MediaQueryListEvent) => setIsBelowSm(e.matches);
    mqMd.addEventListener('change', onMd);
    mqSm.addEventListener('change', onSm);
    return () => {
      mqMd.removeEventListener('change', onMd);
      mqSm.removeEventListener('change', onSm);
    };
  }, []);

  // Tri-state sidebar mode. `rail` forces an icon-only column at ≤sm
  // regardless of the stored `cebab.sidebarCollapsed` preference (which
  // we deliberately do NOT mutate — the stored value is restored when
  // the viewport widens past sm again).
  const sidebarMode: 'rail' | 'collapsed' | 'open' = isBelowSm
    ? 'rail'
    : sidebarCollapsed
      ? 'collapsed'
      : 'open';

  function onResizerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const target = e.currentTarget;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* not all environments support pointer capture */
    }
    sidebarResizingRef.current = true;
    setSidebarResizing(true);
    // Sidebar's left edge is viewport x=0, so pointer x is the new width.
    const onMove = (ev: PointerEvent) => {
      if (sidebarResizingRef.current) setSidebarWidth(clampSidebarWidth(ev.clientX));
    };
    const onUp = (ev: PointerEvent) => {
      sidebarResizingRef.current = false;
      setSidebarResizing(false);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      try {
        target.releasePointerCapture(ev.pointerId);
      } catch {
        /* idempotent on most browsers */
      }
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  function onResizerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        setSidebarWidth((w) => clampSidebarWidth(w - SIDEBAR_KEY_STEP));
        return;
      case 'ArrowRight':
        e.preventDefault();
        setSidebarWidth((w) => clampSidebarWidth(w + SIDEBAR_KEY_STEP));
        return;
      case 'Home':
        e.preventDefault();
        setSidebarWidth(SIDEBAR_MIN);
        return;
      case 'End':
        e.preventDefault();
        setSidebarWidth(SIDEBAR_MAX);
        return;
    }
  }

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
        onMessage: (msg) => {
          dispatch({ type: 'server', msg });
          // Phase H side channel: after the reducer settles, fan out to any
          // out-of-Redux subscribers (e.g. the Logs modal). Wrapped in a
          // try/catch per-subscriber so a broken listener can't stop the
          // WS connection from processing further messages.
          for (const fn of msgSubscribersRef.current) {
            try {
              fn(msg);
            } catch (err) {
              console.error('[ws] subscriber threw', err);
            }
          }
        },
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
  // Item #6: trust chip joins live `project.trusted` with `permissionMode`. The
  // active project is the project whose session is currently rendering — pulled
  // from `state.projects` because the SessionView only carries `projectId`.
  const activeProject = session
    ? (state.projects.find((p) => p.id === session.projectId) ?? null)
    : null;

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

  function saveSettings(payload: { workspaceRoot: string; defaultHopBudget: number }) {
    // Fire only the messages whose field actually changed so unrelated
    // settings stay untouched (e.g. saving a hop-budget tweak doesn't
    // re-trigger the workspace-root sync which re-scans the filesystem).
    if (state.settings && payload.workspaceRoot !== state.settings.workspaceRoot) {
      wsRef.current?.send({ type: 'set_workspace_root', path: payload.workspaceRoot });
    }
    if (state.settings && payload.defaultHopBudget !== state.settings.defaultHopBudget) {
      wsRef.current?.send({ type: 'set_default_hop_budget', value: payload.defaultHopBudget });
    }
    setSettingsOpen(false);
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
    // Mode is enforced by the mounted tab (Chained Chat) — no mode guard.
    const {
      draftParticipants,
      draftPrompt,
      draftLifecycle,
      draftPauseOnMutation,
      // PR-7: template provenance + per-template hop budget. Both are null
      // for ad-hoc runs; the server stamps them onto the row only if set.
      draftTemplateId,
      draftHopBudget,
    } = state.multiAgent;
    if (draftPrompt.trim().length === 0) return;
    if (draftParticipants.length < 2) return;
    wsRef.current?.send({
      type: 'start_multi_agent',
      mode: 'chain',
      participants: draftParticipants,
      initialPrompt: draftPrompt,
      lifecycle: draftLifecycle,
      pauseOnMutation: draftPauseOnMutation,
      ...(draftTemplateId ? { templateId: draftTemplateId } : {}),
      ...(draftHopBudget !== null ? { hopBudget: draftHopBudget } : {}),
    });
  }
  function startOrchestrator() {
    // Mode is enforced by the mounted tab (Multi-Agent) — no mode guard.
    const {
      draftParticipants,
      draftPrompt,
      draftLifecycle,
      draftPauseOnMutation,
      draftTemplateId,
      draftHopBudget,
    } = state.multiAgent;
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
      pauseOnMutation: draftPauseOnMutation,
      ...(draftTemplateId ? { templateId: draftTemplateId } : {}),
      ...(draftHopBudget !== null ? { hopBudget: draftHopBudget } : {}),
    });
  }
  function stopMultiAgent(sessionId: string) {
    wsRef.current?.send({ type: 'stop_multi_agent', sessionId });
  }
  function resumeSession(sessionId: string) {
    // Pure WS round-trip; success arrives as `multi_agent_started` (the
    // reducer flips to the active-run view), failure as `wrapper_error`.
    wsRef.current?.send({ type: 'resume_multi_agent', sessionId });
  }
  function sendMultiAgentUserPrompt(sessionId: string, text: string) {
    // Caller (the active-run input) already trims; nothing else to validate
    // here. The reducer doesn't track an optimistic local copy — the prompt
    // round-trips through the in-process router as a `multi_agent_event`
    // with source=cebab, so it shows up in the scrollback like any other
    // event.
    wsRef.current?.send({ type: 'multi_agent_user_prompt', sessionId, text });
  }
  function continueMultiAgent(sessionId: string) {
    // R-B: the operator reviewed a restart-recovered (read-only) run and
    // chose to continue. Optimistically drop the read-only gate; the server
    // delivers the "continue where you left off" nudge to the orchestrator
    // and the resumed turn streams back as normal events.
    dispatch({ type: 'ma_clear_awaiting' });
    wsRef.current?.send({ type: 'continue_multi_agent', sessionId });
  }
  function retryWorker(sessionId: string) {
    // Item #4: re-deliver the captured prompt of the worker named in this
    // session's pending-retry slot. Optimistically drop the banner so the
    // UI doesn't double-render between click and server echo. The server
    // clears the DB slot and replays; if the retried turn fails again,
    // the next `multi_agent_pending_retry` ServerMsg re-asserts a new
    // descriptor and the banner re-appears.
    dispatch({ type: 'ma_clear_pending_retry' });
    wsRef.current?.send({ type: 'retry_worker', sessionId });
  }
  function abandonSession(sessionId: string) {
    // Item #4: give up on the pending-retry slot and end the session as
    // 'stopped'. No optimistic update — the banner stays visible until
    // `multi_agent_ended` arrives (which the reducer uses to flip status
    // and also clears `pendingRetry` so the banner disappears).
    wsRef.current?.send({ type: 'abandon_session', sessionId });
  }
  function continueThroughMutation(sessionId: string) {
    // Item #5: operator clicked Continue on the pause-on-first-mutation
    // banner. Optimistically clear the slot + flip ack so the UI doesn't
    // double-render or re-pause mid-flight; server echoes
    // `multi_agent_pending_mutation { pending: null }` and re-delivers the
    // captured prompt. A re-fail mid-replay would re-pause via the runner's
    // mutation tap (gated on `mutations_acknowledged=0`, which is now 1 —
    // subsequent mutations auto-allow, per the original review's intent).
    dispatch({ type: 'ma_clear_pending_mutation' });
    wsRef.current?.send({ type: 'continue_through_mutation', sessionId });
  }
  function setDraftPauseOnMutation(value: boolean) {
    // Item #5: setup-screen toggle. Persists only in client state until
    // `start_multi_agent` sends it as `pauseOnMutation`.
    dispatch({ type: 'ma_set_draft_pause_on_mutation', value });
  }
  function setActiveLifecycle(sessionId: string, lifecycle: MultiAgentLifecycle) {
    // Server validates: orchestrator-mode only, sessionId must match the
    // active session. On success, server echoes `multi_agent_lifecycle_changed`
    // which the reducer applies to `state.multiAgent.active.lifecycle`.
    // No optimistic update — wait for the echo so the UI never drifts
    // from server truth.
    wsRef.current?.send({ type: 'set_multi_agent_lifecycle', sessionId, lifecycle });
  }
  function addActiveParticipant(sessionId: string, projectId: number) {
    // Server resolves the project, auto-installs bus if missing (DB
    // metadata), registers a new in-process agent, persists the
    // participant row, and delivers an updated roster prompt to the
    // orchestrator. On success the reducer
    // gets `multi_agent_participant_added` (appends to
    // participantAgentNames) and possibly `bus_integration_changed` +
    // `projects` (if auto-install ran).
    wsRef.current?.send({ type: 'add_multi_agent_participant', sessionId, projectId });
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
  function refreshTemplates() {
    wsRef.current?.send({ type: 'list_templates' });
  }
  function saveTemplate(name: string, mode: 'chain' | 'orchestrator') {
    const { draftLifecycle, draftParticipants } = state.multiAgent;
    // Mode comes from the active tab (passed down), not draft state. Per-agent
    // roles are authored later in the expanded card, not at save time. No
    // optimistic update — the server replies with the full refreshed
    // `templates` list (settings is the source of truth).
    wsRef.current?.send({
      type: 'save_template',
      name,
      mode,
      lifecycle: draftLifecycle,
      participants: draftParticipants,
    });
  }
  function updateTemplateRoles(t: MultiAgentTemplate, roles: Record<string, string>) {
    // Edit per-agent roles WITHOUT clobbering the template: save_template
    // upserts by name and replaces mode/lifecycle/participants wholesale, so
    // resend the template's OWN fields with just the roles map changed.
    //
    // PR-7: preserve `hopBudget` so editing roles doesn't reset a per-template
    // budget back to "no override". Same goes for `layout` (PR-6) — both
    // are passthroughs.
    wsRef.current?.send({
      type: 'save_template',
      name: t.name,
      mode: t.mode,
      lifecycle: t.lifecycle,
      participants: t.participants,
      roles,
      layout: t.layout,
      hopBudget: t.hopBudget,
    });
  }
  function deleteTemplate(id: string) {
    wsRef.current?.send({ type: 'delete_template', id });
  }
  function applyTemplate(t: MultiAgentTemplate) {
    // Pure local reducer fill — no WS. The Start flow is unchanged; the
    // operator types a fresh prompt and presses the existing Start button.
    dispatch({ type: 'ma_apply_template', template: t });
  }
  function loadSessionLog(
    sessionId: string,
    offset: number,
    limit: number,
    revealSensitive: boolean,
  ) {
    // Phase H: pure WS round-trip. The matching `session_log_chunk` reply
    // is consumed by the LogsModal via its `subscribeServerMsg` subscriber
    // (the reducer no-ops on the chunk because the rows live outside Redux).
    wsRef.current?.send({
      type: 'load_session_log',
      sessionId,
      offset,
      limit,
      revealSensitive,
    });
  }
  function subscribeServerMsg(cb: (msg: ServerMsg) => void): () => void {
    // Phase H side-channel subscription. Returns the unsubscribe fn so
    // useEffect cleanups can remove their listener on unmount.
    msgSubscribersRef.current.add(cb);
    return () => {
      msgSubscribersRef.current.delete(cb);
    };
  }
  function readProjectFacts(projectId: number) {
    // PR-6: WS round-trip for the per-participant facts disclosure inside
    // the template-preview modal. The matching `project_facts` reply lives
    // outside Redux — consumers subscribe via `subscribeServerMsg` and own
    // the per-modal-open cache (so closed-then-reopened modal sees fresh
    // on-disk state).
    wsRef.current?.send({ type: 'read_project_facts', projectId });
  }
  function readLastRunForTemplate(templateId: string) {
    // PR-7: WS round-trip for the templates UI's "Last run" rail. The reply
    // (`last_run_for_template`) lives outside Redux; the templates panel
    // owns a per-template cache keyed on templateId and refreshes on
    // `multi_agent_ended` for a matching templateId (same side-channel
    // pattern as project_facts above).
    wsRef.current?.send({ type: 'get_last_run_for_template', templateId });
  }

  // Lazy-load iterations on first switch into the Multi-Agent tab. Also
  // refresh after each `multi_agent_ended` so a just-finished run appears
  // without an explicit user action.
  const maView = state.multiAgent.view;
  const iterationsLoaded = state.multiAgent.iterations !== null;
  const templatesLoaded = state.multiAgent.templates !== null;
  const activeStatus = state.multiAgent.active?.status;
  useEffect(() => {
    const onMultiTab = maView === 'multi-agent' || maView === 'chained-chat';
    if (onMultiTab && !iterationsLoaded) {
      refreshIterations();
    }
    if (onMultiTab && !templatesLoaded) {
      refreshTemplates();
    }
  }, [maView, iterationsLoaded, templatesLoaded]);
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
    <div
      className="app"
      data-sidebar-mode={sidebarMode}
      style={{
        gridTemplateColumns:
          sidebarMode === 'rail'
            ? '48px 1fr'
            : sidebarMode === 'collapsed'
              ? '0 1fr'
              : `${sidebarWidth}px 1fr`,
      }}
    >
      <aside className="sidebar" id="app-sidebar">
        <header>
          <ClaudeMark className="brand-mark" />
          <h1>cebab</h1>
          <div className="sidebar-header-controls">
            <span
              className={state.connected ? 'dot on' : 'dot off'}
              title={state.connected ? 'connected' : 'disconnected'}
            />
            <button
              className="icon-btn sidebar-collapse-btn"
              title="Hide sidebar"
              aria-label="Hide sidebar"
              onClick={() => setSidebarCollapsed(true)}
            >
              «
            </button>
          </div>
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
        {!sidebarCollapsed && !resizerSuppressed && (
          <div
            className={`sidebar-resizer ${sidebarResizing ? 'dragging' : ''}`}
            onPointerDown={onResizerPointerDown}
            onKeyDown={onResizerKeyDown}
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            aria-valuenow={sidebarWidth}
            aria-controls="app-sidebar"
            aria-label="Resize sidebar"
            tabIndex={0}
            title="Drag or use arrow keys to resize sidebar"
          />
        )}
      </aside>
      {sidebarMode === 'collapsed' && (
        <button
          className="sidebar-reopen-btn"
          title="Show sidebar"
          aria-label="Show sidebar"
          onClick={() => setSidebarCollapsed(false)}
        >
          »
        </button>
      )}
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
            <div className="main-top-bar">
              <nav className="main-tabs" aria-label="Main view">
                <button
                  className={`main-tab ${view === 'chat' ? 'active' : ''}`}
                  onClick={() => dispatch({ type: 'ma_set_view', view: 'chat' })}
                  aria-pressed={view === 'chat'}
                >
                  <Icon name="chat" />
                  Chat
                </button>
                <button
                  className={`main-tab ${view === 'multi-agent' ? 'active' : ''}`}
                  onClick={() => dispatch({ type: 'ma_set_view', view: 'multi-agent' })}
                  aria-pressed={view === 'multi-agent'}
                >
                  <Icon name="agents" />
                  Multi-Agent
                </button>
                <button
                  className={`main-tab ${view === 'chained-chat' ? 'active' : ''}`}
                  onClick={() => dispatch({ type: 'ma_set_view', view: 'chained-chat' })}
                  aria-pressed={view === 'chained-chat'}
                >
                  <Icon name="chain" />
                  Chained Chat
                </button>
              </nav>
              {view !== 'chat' && state.multiAgent.active && (
                <TopRunBar
                  run={state.multiAgent.active}
                  onStop={stopMultiAgent}
                  onDismiss={dismissActiveRun}
                  onLoadSessionLog={loadSessionLog}
                  subscribeServerMsg={subscribeServerMsg}
                />
              )}
            </div>
            {view !== 'chat' && <MultiAgentActivityBar run={state.multiAgent.active} />}
            {view === 'chat' ? (
              <>
                {session && !isSessionPending(session.id) && (
                  <div className="chat-header">
                    {activeProject && (
                      <ChatHeaderChip trusted={activeProject.trusted} mode={permissionMode} />
                    )}
                    <ModeToggle
                      mode={permissionMode}
                      disabled={!sessionIsLive}
                      onChange={setPermissionMode}
                    />
                    <SlashCommandButtons disabled={inputDisabled} onSend={sendMessage} />
                  </div>
                )}
                <ChatView
                  session={session}
                  isLive={sessionIsLive}
                  onPermissionDecide={decidePermission}
                />
                <InputBox disabled={inputDisabled} onSend={sendMessage} />
              </>
            ) : (
              <MultiAgentTab
                mode={view === 'chained-chat' ? 'chain' : 'orchestrator'}
                projects={state.projects}
                multiAgent={state.multiAgent}
                onSetLifecycle={setMultiAgentLifecycle}
                onAddParticipant={addParticipant}
                onRemoveParticipant={removeParticipant}
                onReorderParticipant={reorderParticipant}
                onInstallBus={installBus}
                onUninstallBus={uninstallBus}
                onSetDraftPrompt={setDraftPrompt}
                onStart={view === 'chained-chat' ? startChain : startOrchestrator}
                onStopMultiAgent={stopMultiAgent}
                onResumeSession={resumeSession}
                wrapperErrorSeq={state.wrapperErrorSeq}
                onSendUserPrompt={sendMultiAgentUserPrompt}
                onContinueMultiAgent={continueMultiAgent}
                onRetryWorker={retryWorker}
                onAbandonSession={abandonSession}
                onContinueThroughMutation={continueThroughMutation}
                onSetDraftPauseOnMutation={setDraftPauseOnMutation}
                onSetActiveLifecycle={setActiveLifecycle}
                onAddActiveParticipant={addActiveParticipant}
                onDismissActive={dismissActiveRun}
                onRefreshIterations={refreshIterations}
                onClearIterations={clearIterations}
                onRefreshTemplates={refreshTemplates}
                onSaveTemplate={saveTemplate}
                onUpdateTemplateRoles={updateTemplateRoles}
                onDeleteTemplate={deleteTemplate}
                onApplyTemplate={applyTemplate}
                onLoadSessionLog={loadSessionLog}
                subscribeServerMsg={subscribeServerMsg}
                onReadProjectFacts={readProjectFacts}
                onReadLastRunForTemplate={readLastRunForTemplate}
              />
            )}
          </>
        )}
      </main>
      {settingsOpen && state.settings && (
        <SettingsModal
          settings={state.settings}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
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
