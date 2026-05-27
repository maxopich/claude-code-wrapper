import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
  ClientMsg,
  MultiAgentLifecycle,
  MultiAgentTemplate,
  NotificationEnvelope,
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
import {
  InboxProvider,
  NotificationBell,
  NotificationsProvider,
  NotificationStack,
  notifyFromServerMsg,
  useNotificationsActions,
} from './components/notifications';
import { GateModalsProvider } from './components/authority/GateModalsContext';
import { AuthorityProvider } from './components/authority/AuthorityContext';
import { AuthorityPanel } from './components/authority/AuthorityPanel';
import { BannerStack, buildRateLimitBannerItem, type BannerStackItem } from './components/banners';
import { HELD_MESSAGES_CAP } from './store';

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

/**
 * Mint a client-side notification envelope id. Used for connect/disconnect
 * toasts that the client originates (no server roundtrip). Server-dispatched
 * envelopes carry their own UUID (BE-5 dedupe key); this is for the few
 * cases where the client itself shapes an envelope.
 */
function mintNotificationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Cluster A Phase 2: top-level wrapper that mounts the notifications
 * provider before `AppShell` so `AppShell` can call `useNotificationsActions`
 * via the in-provider `NotificationsBridge`. `onAck` lives here because the
 * provider needs a stable callback at mount; `AppShell` owns the actual
 * WS ref and populates it post-mount via the bridge.
 */
export function App() {
  const wsRef = useRef<WsHandle | null>(null);
  const notifPushRef = useRef<((n: NotificationEnvelope) => void) | null>(null);
  const notifDismissRef = useRef<((id: string) => void) | null>(null);
  // Cluster A Phase 5: bridge for the inbox provider. Same pattern as
  // notifPushRef/notifDismissRef from Phase 2 — App.tsx's onMessage
  // pipes `inbox_snapshot` ServerMsgs through this ref into the
  // provider's reducer.
  const inboxHandlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
  // Cluster B Phase 6a: bridge for the gate-modals provider. Same shape
  // as inboxHandlerRef — App.tsx's onMessage routes
  // `mcp_auto_install_pending` + `session_start_gated` envelopes through
  // this ref into the GateModalsProvider's queue. The provider then
  // surfaces a modal whose Submit ships the matching ClientMsg.
  const gateHandlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
  // Cluster B Phase 6e: bridge for the AuthorityProvider. Same shape as the
  // inbox / gate handlers — App.tsx's onMessage routes `project_authority`
  // ServerMsgs through this ref into the provider's per-project cache. Every
  // mounted `<AuthorityPanel>` reads from that cache via `useAuthoritySlot`.
  const authorityHandlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
  const handleAck = useCallback((id: string, ackReason?: string) => {
    wsRef.current?.send({ type: 'ack_notification', id, ackReason });
  }, []);
  // Cluster A Phase 5: ClientMsg sink for the InboxProvider. Reads the
  // current wsRef on every call so transient connection drops route
  // through the most recent socket; equivalent to handleAck's pattern.
  const inboxSend = useCallback((msg: ClientMsg) => {
    wsRef.current?.send(msg);
  }, []);
  // Cluster B Phase 6a: ClientMsg sink for the GateModalsProvider. Same
  // wsRef indirection as inboxSend — keeps the provider WS-agnostic.
  const gateSend = useCallback((msg: ClientMsg) => {
    wsRef.current?.send(msg);
  }, []);
  // Cluster B Phase 6e: ClientMsg sink for the AuthorityProvider — pipes
  // `get_project_authority` requests onto the active WS.
  const authoritySend = useCallback((msg: ClientMsg) => {
    wsRef.current?.send(msg);
  }, []);

  return (
    <NotificationsProvider onAck={handleAck}>
      <NotificationsBridge pushRef={notifPushRef} dismissRef={notifDismissRef} />
      <InboxProvider send={inboxSend} handlerRef={inboxHandlerRef}>
        <GateModalsProvider send={gateSend} handlerRef={gateHandlerRef}>
          <AuthorityProvider send={authoritySend} handlerRef={authorityHandlerRef}>
            <AppShell
              wsRef={wsRef}
              notifPushRef={notifPushRef}
              notifDismissRef={notifDismissRef}
              inboxHandlerRef={inboxHandlerRef}
              gateHandlerRef={gateHandlerRef}
              authorityHandlerRef={authorityHandlerRef}
              onAck={handleAck}
            />
            <NotificationStack />
          </AuthorityProvider>
        </GateModalsProvider>
      </InboxProvider>
    </NotificationsProvider>
  );
}

/**
 * Inside the provider, exposes the actions back to App-scoped refs so the
 * existing WS lifecycle effect (which lives outside the provider context
 * boundary in terms of hook calls — it's a useEffect inside AppShell) can
 * push and dismiss without prop-drilling.
 */
function NotificationsBridge({
  pushRef,
  dismissRef,
}: {
  pushRef: React.MutableRefObject<((n: NotificationEnvelope) => void) | null>;
  dismissRef: React.MutableRefObject<((id: string) => void) | null>;
}) {
  const { push, dismiss } = useNotificationsActions();
  useEffect(() => {
    pushRef.current = push;
    dismissRef.current = dismiss;
    return () => {
      pushRef.current = null;
      dismissRef.current = null;
    };
  }, [push, dismiss, pushRef, dismissRef]);
  return null;
}

type AppShellProps = {
  wsRef: React.MutableRefObject<WsHandle | null>;
  notifPushRef: React.MutableRefObject<((n: NotificationEnvelope) => void) | null>;
  notifDismissRef: React.MutableRefObject<((id: string) => void) | null>;
  /**
   * Cluster A Phase 5: bridge ref the InboxProvider populates with its
   * own ServerMsg handler. AppShell's onMessage calls this AFTER the
   * main reducer dispatch so the inbox state and the store stay in
   * sync without coupling the two.
   */
  inboxHandlerRef: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
  /**
   * Cluster B Phase 6a: bridge ref the GateModalsProvider populates.
   * Same routing posture as inboxHandlerRef — called AFTER the reducer
   * dispatch so the modal queue and store stay independent.
   */
  gateHandlerRef: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
  /**
   * Cluster B Phase 6e: bridge ref the AuthorityProvider populates. Same
   * pattern — onMessage routes `project_authority` envelopes here after the
   * reducer; the provider caches per project for every mounted AuthorityPanel.
   */
  authorityHandlerRef: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
  /** Cluster A Phase 5: ack handler shared between the dock and the inbox. */
  onAck: (id: string, ackReason?: string) => void;
};

function AppShell({
  wsRef,
  notifPushRef,
  notifDismissRef,
  inboxHandlerRef,
  gateHandlerRef,
  authorityHandlerRef,
  onAck,
}: AppShellProps) {
  const [state, dispatch] = useReducer(reduce, initialState);
  // Cluster D Phase 4c (UI-D6): the WS onMessage callback in the connect
  // effect closes over a stale `state` snapshot. The banner ↔ toast dedup
  // predicate needs the LATEST state to answer "is the rate-limit banner
  // mounted for sessionId X right now?", so we mirror state into a ref
  // updated on every reducer dispatch. This is the same mutable-ref-into-
  // effect pattern as `notifPushRef` / `inboxHandlerRef` — kept narrow:
  // only the WS effect's `notifyFromServerMsg` call reads it.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
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

  // WS lifecycle bookkeeping for connect/disconnect toasts (UX-11):
  //   - `hasOpenedRef`: skip the success toast on the FIRST open (initial
  //     connection — there was nothing to reconnect from).
  //   - `wsDisconnectToastIdRef`: the id of the sticky "Disconnected"
  //     toast, so a reconnect can dismiss it. Cleared on dismiss.
  const hasOpenedRef = useRef(false);
  const wsDisconnectToastIdRef = useRef<string | null>(null);

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
          // UX-11: only toast "Reconnected" after the FIRST open. The first
          // open is just initial-connection — no banner needed; subsequent
          // opens follow a disconnect and are reconnect events worth
          // announcing (and clearing the prior sticky warn).
          if (hasOpenedRef.current) {
            if (wsDisconnectToastIdRef.current) {
              notifDismissRef.current?.(wsDisconnectToastIdRef.current);
              wsDisconnectToastIdRef.current = null;
            }
            notifPushRef.current?.({
              id: mintNotificationId(),
              ts: Date.now(),
              severity: 'success',
              class: 'operational',
              dedupeKey: 'ws:reconnected',
              title: 'Reconnected',
              sticky: false,
            });
          }
          hasOpenedRef.current = true;
        },
        onClose: () => {
          dispatch({ type: 'ws_close' });
          // UX-11: sticky warn while the socket is down. ws.ts doesn't
          // auto-reconnect today, so the message points to a reload — Phase
          // 5+ adds an action button once a retry path exists.
          const id = mintNotificationId();
          wsDisconnectToastIdRef.current = id;
          notifPushRef.current?.({
            id,
            ts: Date.now(),
            severity: 'warn',
            class: 'operational',
            dedupeKey: 'ws:disconnected',
            title: 'Disconnected',
            message: 'Reload the page to reconnect.',
            sticky: true,
          });
        },
        onMessage: (msg) => {
          dispatch({ type: 'server', msg });
          // Cluster A Phase 2: route the wire envelope (and any narrowly
          // typed fallbacks like sessionless wrapper_error) into the dock.
          // Wrapped in try/catch so a dispatch-table bug can't break WS
          // message processing (same defensive shape as the subscriber loop
          // below).
          try {
            const push = notifPushRef.current;
            if (push) {
              notifyFromServerMsg(msg, {
                push,
                // Cluster D Phase 4c (UI-D6): suppress the rate-limit toast
                // when the rate-limit banner is already mounted for that
                // session. The predicate reads `stateRef.current` (kept
                // fresh by the useEffect above) — using stale `state`
                // captured by the connect effect would let the dedup miss
                // a banner that just appeared.
                isBannerVisibleFor: (sessionId, kind) => {
                  if (kind !== 'rate_limit') return false;
                  const pid = stateRef.current.sessionToProject[sessionId];
                  if (pid === undefined) return false;
                  const sv = stateRef.current.sessionsByProject[pid]?.[sessionId];
                  return !!sv?.rateLimit;
                },
              });
            }
          } catch (err) {
            console.error('[notifications] dispatch threw', err);
          }
          // Cluster A Phase 5: hand the message to the InboxProvider's
          // bridge so `inbox_snapshot` updates the bell badge + panel
          // state. The handler is a narrow type-filter — other ServerMsgs
          // are silently ignored, so this is safe to invoke for every
          // message without an outer type-check.
          try {
            inboxHandlerRef.current?.(msg);
          } catch (err) {
            console.error('[inbox] handler threw', err);
          }
          // Cluster B Phase 6a: hand to the GateModalsProvider bridge
          // so `mcp_auto_install_pending` + `session_start_gated`
          // surface their modals. Same narrow-filter posture as the
          // inbox handler — non-gate messages are silently dropped.
          try {
            gateHandlerRef.current?.(msg);
          } catch (err) {
            console.error('[gate-modals] handler threw', err);
          }
          // Cluster B Phase 6e: hand to the AuthorityProvider bridge so
          // `project_authority` envelopes land in the per-project cache that
          // every mounted AuthorityPanel reads from. Same narrow-filter
          // posture — non-authority messages are dropped.
          try {
            authorityHandlerRef.current?.(msg);
          } catch (err) {
            console.error('[authority] handler threw', err);
          }
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
  }, [wsRef, notifPushRef, notifDismissRef]);

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
    // Cluster D Phase 4c (UI-D7): when this session is rate-limited, the
    // captured turn the server is holding is the original prompt — fresh
    // operator messages must NOT race straight to the SDK (they'd 429 the
    // same way). Queue them locally; the drain effect below ships each
    // one in order once the rate-limit clears and the captured turn
    // finishes. The cap is enforced both here (composer-side) and in
    // the reducer (defense-in-depth).
    if (session?.rateLimit) {
      if (session.heldMessages.length >= HELD_MESSAGES_CAP) return; // composer should disable
      dispatch({ type: 'rl_enqueue_held', sessionId: session.id, text });
      return;
    }
    dispatch({ type: 'user_send', text });
    wsRef.current?.send({
      type: 'send_message',
      projectId: state.activeProjectId,
      sessionId: resumeSessionId,
      text,
    });
  }

  // Cluster D Phase 4c: rate-limit operator callbacks. Encapsulated here
  // so the banner factory stays prop-only and the WS bridge stays in
  // one file. `triggerRetry` is shared between manual + auto fire — the
  // `auto` flag is the only difference, and it tags the recovery_log
  // row server-side (`'manual_retry'` vs `'auto_retry'`, spec §8.5).
  const triggerRateLimitRetry = useCallback((sessionId: string, auto: boolean) => {
    dispatch({ type: 'rl_retry_sent', sessionId });
    wsRef.current?.send({ type: 'retry_rate_limited', sessionId, auto });
  }, []);
  const setRateLimitPaused = useCallback((sessionId: string, paused: boolean) => {
    dispatch({ type: 'rl_set_paused', sessionId, paused });
  }, []);
  const dropHeldMessage = useCallback((sessionId: string, index: number) => {
    dispatch({ type: 'rl_drop_held', sessionId, index });
  }, []);

  // Cluster D Phase 4c: drain the held-message queue when rate-limit
  // clears + the previous turn (the captured re-fire) has fully
  // settled. We ship one message per pass; subsequent shipments wait
  // for the next idle window. The session.status === 'running' guard
  // is critical: without it, this effect would fire all 3 held
  // messages in parallel the instant rateLimit goes undefined, each
  // racing the others for the SDK's `--resume` turn (which serializes
  // anyway — but you'd see three optimistic user messages flash into
  // the chat and only one of them would actually round-trip).
  useEffect(() => {
    if (!session) return;
    if (session.rateLimit) return; // still rate-limited, wait
    if (session.heldMessages.length === 0) return; // nothing to drain
    if (state.liveSessions[session.id]) return; // server says turn still in flight
    if (session.status === 'running') return; // optimistic local-status guard

    const next = session.heldMessages[0];
    if (next === undefined) return;
    dispatch({ type: 'rl_drain_one', sessionId: session.id });
    dispatch({ type: 'user_send', text: next });
    wsRef.current?.send({
      type: 'send_message',
      projectId: session.projectId,
      sessionId: isSessionPending(session.id) ? undefined : session.id,
      text: next,
    });
    // The deps cover every signal the drain reads. Including session
    // itself would re-run on every reducer dispatch (router_drop,
    // streamingText delta, etc.); reading the narrow fields gives us
    // the right cadence — re-render on rate_limit_event clearance, on
    // queue shift, on liveSessions flip, on status flip.
  }, [
    session,
    session?.id,
    session?.projectId,
    session?.rateLimit,
    session?.heldMessages,
    session?.status,
    state.liveSessions,
  ]);

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
  // Cluster D Phase 4d: bus auto-retry banner self-clears when the
  // CountdownChip's onElapsed fires (retry just fired or is firing now).
  // No server round-trip — the bus runner owns the retry loop; this is
  // a pure client-side dispatch to unmount the banner.
  const clearAutoRetry = useCallback(() => {
    dispatch({ type: 'ma_clear_auto_retry' });
  }, []);
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
            {/*
              Cluster A Phase 5: notifications inbox bell. Per DEC-1 (XCT-3
              chrome lock), the bell ideally lives in an app-shell header
              — but Cebab has no such header today. The validation report's
              fallback is to keep notification chrome in the sidebar header
              alongside the connection dot until the app-shell header
              actually lands. Order matches XCT-3's left-to-right intent:
              ConnectionDot (state) → Bell (events).
            */}
            <NotificationBell onAck={onAck} />
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
                      <ChatHeaderChip
                        trusted={activeProject.trusted}
                        mode={permissionMode}
                        projectId={activeProject.id}
                      />
                    )}
                    <ModeToggle
                      mode={permissionMode}
                      disabled={!sessionIsLive}
                      onChange={setPermissionMode}
                    />
                    <SlashCommandButtons disabled={inputDisabled} onSend={sendMessage} />
                  </div>
                )}
                {/* Cluster B Phase 6e (UI-B7): in-session authority disclosure.
                 *  Sections inside are collapsed by default — the panel
                 *  header itself is a thin row with Refresh, so the
                 *  operator's chat scrollback isn't pushed down meaningfully
                 *  on first paint. */}
                {session && !isSessionPending(session.id) && activeProject && (
                  <AuthorityPanel projectId={activeProject.id} mode="in-session" />
                )}
                {/* Cluster D Phase 4c (B2): rate-limit banner. Mounted via
                 *  <BannerStack> so when later phases add the auth-expired
                 *  + swept-session banners they slot into the same priority-
                 *  sorted region. The factory returns null-equivalent (no
                 *  item) when the session has no rateLimit slice, so the
                 *  stack stays empty and BannerStack renders null itself
                 *  (no DOM cost). */}
                {session && session.rateLimit && (
                  <BannerStack
                    banners={(() => {
                      const items: BannerStackItem[] = [];
                      items.push(
                        buildRateLimitBannerItem({
                          sessionId: session.id,
                          state: session.rateLimit,
                          heldMessages: session.heldMessages,
                          callbacks: {
                            onManualRetry: () => triggerRateLimitRetry(session.id, false),
                            onAutoRetry: () => triggerRateLimitRetry(session.id, true),
                            onPauseToggle: (paused) => setRateLimitPaused(session.id, paused),
                            onDropHeld: (i) => dropHeldMessage(session.id, i),
                          },
                        }),
                      );
                      return items;
                    })()}
                  />
                )}
                <ChatView
                  session={session}
                  isLive={sessionIsLive}
                  onPermissionDecide={decidePermission}
                />
                <InputBox
                  disabled={inputDisabled}
                  onSend={sendMessage}
                  /* Phase 4c: when rate-limited, the composer is still
                   * enabled (so the operator can queue follow-up messages
                   * via the held-queue) — but past the cap it disables
                   * itself to avoid silent drops. The InputBox doesn't
                   * know about rate-limit; the parent enforces by
                   * passing `disabled` when the queue is full. */
                  {...(session?.rateLimit && session.heldMessages.length >= HELD_MESSAGES_CAP
                    ? { disabled: true }
                    : {})}
                />
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
                onClearAutoRetry={clearAutoRetry}
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
