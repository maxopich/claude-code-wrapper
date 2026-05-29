import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
  ClientMsg,
  ControlReasonCode,
  KickMode,
  MultiAgentLifecycle,
  MultiAgentTemplate,
  NotificationAction,
  NotificationEnvelope,
  PauseExpiryAction,
  ServerMsg,
  SessionLogScope,
  SessionPermissionMode,
  StopReasonCode,
} from '@cebab/shared/protocol';
import { connectWs, type WsHandle } from './ws';
import { activeSession, initialState, isSessionPending, reduce } from './store';
import { ProjectList } from './components/ProjectList';
import { ChatView } from './components/ChatView';
import { InputBox } from './components/InputBox';
import { ModeToggle } from './components/ModeToggle';
import { ChatHeaderChip } from './components/ChatHeaderChip';
import { ModelChip } from './components/ModelChip';
import { MaxTurnsInput } from './components/MaxTurnsInput';
import { TurnCounterChip } from './components/TurnCounterChip';
import { SlashCommandButtons } from './components/SlashCommandButtons';
import { LogsButton } from './components/sessionLog';
import { logsHashFor } from './components/sessionLog/logsHash';
import { SettingsModal } from './components/SettingsModal';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { SHORTCUTS } from './shortcutRegistry';
import { findShortcut, useKeyboardShortcuts } from './useKeyboardShortcuts';
import { MultiAgentTab, MultiAgentActivityBar, TopRunBar } from './components/MultiAgentTab';
import { ClaudeMark } from './components/ClaudeMark';
import { MockBadge } from './components/MockBadge';
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
import {
  BannerStack,
  SessionBanner,
  buildAuthExpiredBannerItem,
  buildRateLimitBannerItem,
  type BannerStackItem,
} from './components/banners';
import { ReopenProvider, useReopenActions } from './components/reopen';
import { AuthRefreshProvider, useAuthRefreshActions } from './components/authRefresh';
import { RecoveryLogButton, RecoveryLogProvider } from './components/recoveryLog';
import { ForensicViewerProvider } from './components/agentControl/ForensicViewerContext';
import { KickForensicsModal } from './components/agentControl/KickForensicsModal';
import { RunsBadge } from './components/runs';
import {
  ConnectionLostOverlay,
  resolveFromAuthTokenResponse,
  resolveFromCloseInfo,
} from './components/connectionLost';
import { HELD_MESSAGES_CAP } from './store';
import type { ActiveRunView } from './store';
import { downloadSessionLog, isDownloadError } from './exports';

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
  // Cluster I C2 UI: the per-launch WS auth token. App fetches it once at
  // mount (the same call that gates the WS upgrade) and stashes it here so
  // the per-session `⤓` Download icon — and any other future HTTP fetch
  // against the gated endpoints — can read it without re-fetching. Set
  // inside the auth-token-fetch effect; cleared on disconnect so a stale
  // token can't be used after the server has rotated it on its next boot.
  const authTokenRef = useRef<string | null>(null);
  // Cluster A Phase 5: bridge for the inbox provider. Same pattern as
  // notifPushRef/notifDismissRef from Phase 2 — App.tsx's onMessage
  // pipes `inbox_snapshot` ServerMsgs through this ref into the
  // provider's reducer.
  const inboxHandlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
  // Cluster B Phase 6a + Cluster G Phase 4 (D6/D11): bridge for the
  // gate-modals provider. Same shape as inboxHandlerRef — App.tsx's
  // onMessage routes `mcp_auto_install_pending` / `session_start_gated`
  // / `bus_auto_install_pending` envelopes through this ref into the
  // GateModalsProvider's queue. The provider then surfaces a modal
  // whose Submit ships the matching ClientMsg.
  const gateHandlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
  // Cluster B Phase 6e: bridge for the AuthorityProvider. Same shape as the
  // inbox / gate handlers — App.tsx's onMessage routes `project_authority`
  // ServerMsgs through this ref into the provider's per-project cache. Every
  // mounted `<AuthorityPanel>` reads from that cache via `useAuthoritySlot`.
  const authorityHandlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
  // Cluster D Phase 5d: bridges for the ReopenProvider.
  //   - `reopenHandlerRef` — App.tsx routes reopen_session_confirm_required
  //     / reopen_session_failed / multi_agent_started ServerMsgs into the
  //     provider's reducer (mirror of inbox/gate handlers).
  //   - `reopenRequestRef` — `onNotificationAction`'s `kind:'reopen'` case
  //     reads this to open the modal + ship the probe ClientMsg in one
  //     call. Populated by a NotificationsBridge-style inner component.
  const reopenHandlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
  const reopenRequestRef = useRef<((sessionId: string) => void) | null>(null);
  // Cluster D Phase 6c: bridges for the AuthRefreshProvider.
  //   - `authRefreshHandlerRef` — App.tsx routes
  //     auth_refresh_{started,output,completed,failed} ServerMsgs
  //     into the provider's reducer.
  //   - `authRefreshRequestRef` — populated by AuthRefreshBridge so the
  //     AuthExpiredBanner's onReauthenticate callback can fire the
  //     start without prop-drilling the provider's action through 6
  //     layers.
  const authRefreshHandlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
  const authRefreshRequestRef = useRef<(() => void) | null>(null);
  // Cluster D Phase 8b: bridge for the RecoveryLogProvider. Same shape
  // as inbox / gate / authority handlers — App.tsx routes the
  // `recovery_log_snapshot` ServerMsg through this ref into the
  // provider's reducer. No `requestRef` companion: the RecoveryLogButton
  // owns its trigger (no notification-action plumbing required).
  const recoveryLogHandlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
  // Cluster C Phase 4g4: bridge for the ForensicViewerProvider.
  // App.tsx routes `kick_forensics_snapshot` through this ref into the
  // viewer's reducer. The ⋮ menu's "View forensics…" item ships the
  // matching `get_kick_forensics` request via the provider's open
  // action; no requestRef needed.
  const forensicViewerHandlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
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
  // Cluster D Phase 5d: ClientMsg sink for the ReopenProvider. Same wsRef
  // indirection as the others — keeps the provider WS-agnostic.
  const reopenSend = useCallback((msg: ClientMsg) => {
    wsRef.current?.send(msg);
  }, []);
  // Cluster D Phase 6c: ClientMsg sink for the AuthRefreshProvider.
  // Ships `start_auth_refresh` / `cancel_auth_refresh` onto the active
  // WS — same indirection so a reconnect doesn't strand the spawn.
  const authRefreshSend = useCallback((msg: ClientMsg) => {
    wsRef.current?.send(msg);
  }, []);
  // Cluster D Phase 8b: ClientMsg sink for the RecoveryLogProvider.
  // Ships `get_recovery_log_snapshot` onto the active WS — same
  // wsRef indirection so a reconnect doesn't strand the request.
  const recoveryLogSend = useCallback((msg: ClientMsg) => {
    wsRef.current?.send(msg);
  }, []);
  // Cluster C Phase 4g4: ClientMsg sink for the ForensicViewerProvider.
  // Ships `get_kick_forensics` onto the active WS — same indirection.
  const forensicViewerSend = useCallback((msg: ClientMsg) => {
    wsRef.current?.send(msg);
  }, []);

  // Cluster D Phase 5/5d: route NotificationStack action clicks onto the WS.
  //   - `archive` (used by `session_superseded` toasts, Phase 5) → ships
  //     `archive_session` ClientMsg directly.
  //   - `reopen` (Phase 5d) → calls `reopenRequestRef.current(sessionId)`
  //     which opens the ReopenSessionModal AND ships the `reopen_session`
  //     probe; the modal drives the rest of the flow (confirm_required,
  //     typed gate, commit). The ref is populated by `ReopenBridge`
  //     below — wsRef-style indirection so a reconnect doesn't strand it.
  //   - Other action kinds (open_session / open_logs / reauth / resume /
  //     restart_agent) are intentional no-ops; explicit cases keep the
  //     discriminated-union exhaustiveness check honest so a future kind
  //     surfaces at compile time.
  //
  // Pinned to wsRef.current / reopenRequestRef.current per call (not
  // captured at mount) so a transient reconnect doesn't strand the action
  // on a dead socket.
  const onNotificationAction = useCallback((action: NotificationAction) => {
    switch (action.kind) {
      case 'archive':
        wsRef.current?.send({ type: 'archive_session', sessionId: action.sessionId });
        return;
      case 'reopen':
        reopenRequestRef.current?.(action.sessionId);
        return;
      case 'reauth':
        // Cluster D Phase 6c: the dispatcher emits a notification with
        // action.kind='reauth' alongside every wrapper_error{kind:
        // 'auth_expired'}. Route it to the same AuthRefreshModal the
        // banner uses so the operator has a one-click path from the
        // transient toast (parallel to the durable banner).
        authRefreshRequestRef.current?.();
        return;
      case 'open_session':
      case 'open_logs':
      case 'open_settings':
      case 'resume':
      case 'restart_agent':
        return;
    }
  }, []);

  return (
    <NotificationsProvider onAck={handleAck}>
      <NotificationsBridge pushRef={notifPushRef} dismissRef={notifDismissRef} />
      <InboxProvider send={inboxSend} handlerRef={inboxHandlerRef}>
        <GateModalsProvider send={gateSend} handlerRef={gateHandlerRef}>
          <AuthorityProvider send={authoritySend} handlerRef={authorityHandlerRef}>
            <ReopenProvider send={reopenSend} handlerRef={reopenHandlerRef}>
              <ReopenBridge requestRef={reopenRequestRef} />
              <AuthRefreshProvider send={authRefreshSend} handlerRef={authRefreshHandlerRef}>
                <AuthRefreshBridge requestRef={authRefreshRequestRef} />
                <RecoveryLogProvider send={recoveryLogSend} handlerRef={recoveryLogHandlerRef}>
                  <ForensicViewerProvider
                    send={forensicViewerSend}
                    handlerRef={forensicViewerHandlerRef}
                  >
                    <AppShell
                      wsRef={wsRef}
                      notifPushRef={notifPushRef}
                      notifDismissRef={notifDismissRef}
                      authTokenRef={authTokenRef}
                      inboxHandlerRef={inboxHandlerRef}
                      gateHandlerRef={gateHandlerRef}
                      authorityHandlerRef={authorityHandlerRef}
                      reopenHandlerRef={reopenHandlerRef}
                      authRefreshHandlerRef={authRefreshHandlerRef}
                      authRefreshRequestRef={authRefreshRequestRef}
                      recoveryLogHandlerRef={recoveryLogHandlerRef}
                      forensicViewerHandlerRef={forensicViewerHandlerRef}
                      onAck={handleAck}
                    />
                    <NotificationStack onAction={onNotificationAction} />
                    <KickForensicsModal />
                  </ForensicViewerProvider>
                </RecoveryLogProvider>
              </AuthRefreshProvider>
            </ReopenProvider>
          </AuthorityProvider>
        </GateModalsProvider>
      </InboxProvider>
    </NotificationsProvider>
  );
}

/**
 * Cluster D Phase 5d: bridge component that captures the ReopenProvider's
 * `requestReopen` action into a ref so the outer `onNotificationAction`
 * callback can fire it for `kind:'reopen'` clicks. Same pattern as
 * NotificationsBridge — keeps the cross-boundary wiring honest about
 * the provider/consumer split.
 */
function ReopenBridge({
  requestRef,
}: {
  requestRef: React.MutableRefObject<((sessionId: string) => void) | null>;
}) {
  const { requestReopen } = useReopenActions();
  useEffect(() => {
    requestRef.current = requestReopen;
    return () => {
      requestRef.current = null;
    };
  }, [requestReopen, requestRef]);
  return null;
}

/**
 * Cluster D Phase 6c: bridge component that captures the
 * AuthRefreshProvider's `requestStart` action into a ref so the
 * AuthExpiredBanner's `onReauthenticate` callback can fire it without
 * prop-drilling. Same pattern as ReopenBridge / NotificationsBridge.
 */
function AuthRefreshBridge({
  requestRef,
}: {
  requestRef: React.MutableRefObject<(() => void) | null>;
}) {
  const { requestStart } = useAuthRefreshActions();
  useEffect(() => {
    requestRef.current = requestStart;
    return () => {
      requestRef.current = null;
    };
  }, [requestStart, requestRef]);
  return null;
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
   * Cluster I C2 UI: the per-launch WS auth token, populated by the
   * auth-token fetch inside AppShell's WS connect effect. Read by the
   * per-session `⤓` Download handler to gate `GET /session-log/:sid`.
   * Null whenever the WS isn't open (no token = no download attempt;
   * the icon-btn is itself gated on a session existing AND a live WS).
   */
  authTokenRef: React.MutableRefObject<string | null>;
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
  /**
   * Cluster D Phase 5d: bridge ref the ReopenProvider populates. Routes
   * `reopen_session_confirm_required` / `reopen_session_failed` /
   * `multi_agent_started` envelopes into the provider's reducer so the
   * modal can transition through probe → confirm → commit → close (or
   * surface error states).
   */
  reopenHandlerRef: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
  /**
   * Cluster D Phase 6c: bridge ref the AuthRefreshProvider populates.
   * Routes auth_refresh_{started,output,completed,failed} envelopes
   * into the provider's reducer so the AuthRefreshModal can transition
   * through spawning → running → completed/failed.
   */
  authRefreshHandlerRef: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
  /**
   * Cluster D Phase 6c: ref the AuthRefreshBridge populates with the
   * provider's `requestStart` action. AppShell wires this into the
   * AuthExpiredBanner's `onReauthenticate` callback so clicking the
   * banner button opens the modal + ships start_auth_refresh in one
   * call. Pinned ref (not captured at mount) so a reconnect doesn't
   * strand the action — same pattern as reopenRequestRef.
   */
  authRefreshRequestRef: React.MutableRefObject<(() => void) | null>;
  /**
   * Cluster D Phase 8b: bridge ref the RecoveryLogProvider populates.
   * Routes `recovery_log_snapshot` envelopes into the provider's
   * reducer so the RecoveryLogInspector renders fresh aggregates +
   * recent rows on open.
   */
  recoveryLogHandlerRef: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
  /**
   * Cluster C Phase 4g4: bridge ref the ForensicViewerProvider populates.
   * onMessage routes typed `kick_forensics_snapshot` through this into
   * the viewer reducer so the KickForensicsModal renders the snapshot
   * fresh on each open.
   */
  forensicViewerHandlerRef: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
  /** Cluster A Phase 5: ack handler shared between the dock and the inbox. */
  onAck: (id: string, ackReason?: string) => void;
};

function AppShell({
  wsRef,
  notifPushRef,
  notifDismissRef,
  authTokenRef,
  inboxHandlerRef,
  gateHandlerRef,
  authorityHandlerRef,
  reopenHandlerRef,
  authRefreshHandlerRef,
  authRefreshRequestRef,
  recoveryLogHandlerRef,
  forensicViewerHandlerRef,
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
  // Cluster E Phase 4 (H1): keyboard shortcuts cheatsheet. `?` opens
  // from outside an input; Cmd/Ctrl+/ opens from anywhere (including
  // inside a composer/input). Esc closes.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Cluster F Phase A1b (UI-A1): per-turn MAX_TURNS override for the
  // single-agent composer. Lives at App level (not in the InputBox)
  // because (a) `sendMessage` reads it inline when shipping the
  // ClientMsg, (b) the chat-header MaxTurnsInput renders next to the
  // model/trust chips (not inside InputBox), and (c) we want to clear
  // it after each successful send so it doesn't carry into the next
  // turn unexpectedly. `null` = no override; resolver falls through
  // to DB setting / env / built-in.
  const [draftMaxTurns, setDraftMaxTurns] = useState<number | null>(null);
  // Cluster F Phase A1b (UI-A1): per-session counter of how many times
  // the operator has clicked Extend on a max-turns result card. Drives
  // the MaxTurnsResultCard's soft-cap warning copy. Keyed by sessionId;
  // reset on each fresh user_send for that session (a new prompt is a
  // fresh exploration, not a continuation of an extension chain).
  const [extensionsUsedBySession, setExtensionsUsedBySession] = useState<Record<string, number>>(
    {},
  );

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

  // WS lifecycle bookkeeping for the reconnect toast (UX-11):
  //   - `hasOpenedRef`: skip the success toast on the FIRST open (initial
  //     connection — there was nothing to reconnect from).
  //
  // The sticky "Disconnected" warn toast that used to live here was
  // superseded by `ConnectionLostOverlay` in Cluster G E3 UI — the
  // overlay carries the same severity AND adds a Retry affordance, so
  // dual surfacing would just be noise.
  const hasOpenedRef = useRef(false);

  // Cluster G Phase 2a (UI-A3): one-shot boot toast when the operator
  // connects to a Cebab process running under MOCK=1. The persistent
  // MockBadge in the sidebar header is the ongoing visual signal; the
  // toast is the at-first-glance announcement so the operator doesn't
  // start typing into what they think is a live session.
  //
  // Fired exactly once per page load, gated by `mockBootToastFiredRef`.
  // Reconnects (the WS open effect re-fires) don't re-trigger because
  // the ref persists across renders. A genuine in-page mode flip
  // (impossible per R-G2 — config.mock is fixed at server boot) would
  // ALSO not re-trigger, which is the correct behavior — the operator
  // can't lose information by missing a re-fire.
  //
  // We check `notifPushRef.current` inside the effect rather than as a
  // dependency because refs don't trigger re-renders; by the time
  // `state.settings.mockMode` flips from undefined → true (post-WS
  // settings landing), the NotificationsBridge has already mounted and
  // populated the push handler.
  const mockBootToastFiredRef = useRef(false);
  useEffect(() => {
    if (mockBootToastFiredRef.current) return;
    if (state.settings?.mockMode !== true) return;
    const push = notifPushRef.current;
    if (!push) return; // bridge hasn't mounted yet — wait for the next render
    push({
      id: mintNotificationId(),
      ts: Date.now(),
      severity: 'info',
      class: 'operational',
      dedupeKey: 'mock_mode:boot',
      title: 'Mock mode is on',
      message:
        'No live model calls are being made. Responses come from replay fixtures. ' +
        'The MOCK badge in the sidebar header stays visible while this process runs.',
      sticky: false,
    });
    mockBootToastFiredRef.current = true;
  }, [state.settings?.mockMode, notifPushRef]);

  // Cluster G E3 UI: a monotonic counter the operator (or the
  // ConnectionLostOverlay's auto-retry) bumps to force the WS effect
  // to re-run. The effect can't see state.connectionLost dismissals
  // directly (they don't repopulate the WS handle); the counter is
  // the cleanest "trigger this side-effect again" signal.
  const [wsRetryNonce, setWsRetryNonce] = useState(0);

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
        if (!r.ok) {
          // Cluster G E3 UI: surface a structured overlay instead of a
          // silent return. The server's `X-Cebab-Reject-Reason` header
          // (PR #175) disambiguates origin/host rejections; non-403
          // statuses route to server_unreachable.
          const reason = resolveFromAuthTokenResponse(r);
          dispatch({
            type: 'connection_lost',
            view: {
              reason,
              diagnostic: {
                ts: Date.now(),
                url: `${HTTP_BASE}/auth-token`,
                rejectReason: r.headers.get('X-Cebab-Reject-Reason') ?? undefined,
              },
            },
          });
          throw new Error(`status ${r.status}`);
        }
        token = (await r.text()).trim();
        // Cluster I C2 UI: stash the token so the `⤓` Download icon
        // in ProjectList can gate its `GET /session-log/:sid` fetch.
        // The WS connect path also embeds it in the upgrade URL below;
        // both reads land off the same `r.text()` value, so they can't
        // disagree mid-flight.
        authTokenRef.current = token;
      } catch (err) {
        console.error('[ws] failed to fetch auth token', err);
        // `fetch` itself threw (network error) — no response object to
        // inspect, so the resolver yields server_unreachable. We avoid
        // double-dispatching for the !r.ok case above by checking the
        // existing slice; the most-recent failure still wins.
        if (!stateRef.current.connectionLost) {
          dispatch({
            type: 'connection_lost',
            view: {
              reason: resolveFromAuthTokenResponse(null),
              diagnostic: {
                ts: Date.now(),
                url: `${HTTP_BASE}/auth-token`,
              },
            },
          });
        }
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
        onClose: (info) => {
          dispatch({ type: 'ws_close' });
          // Cluster I C2 UI: drop the cached auth token on close. The
          // server rotates tokens on every boot, so reusing a stale
          // value after a reconnect would 403 against the new token's
          // launch. The reopened WS-connect path re-fetches.
          authTokenRef.current = null;
          // Cluster G E3 UI: route the close info into the
          // ConnectionLostOverlay. The reason resolver maps close
          // codes (4001/4002 → structured; 1006 → server_unreachable;
          // 1000/1001/1011 → unknown). The previous "Reload the page
          // to reconnect" sticky toast is superseded by the overlay's
          // explicit Retry affordance.
          //
          // We skip the overlay for code 1000 *only when* the operator
          // explicitly initiated it (page unload). Today there's no
          // reliable signal for that in the browser — `beforeunload`
          // doesn't fire before WS close in all cases — so we let
          // 1000 surface as `unknown`; the operator can Dismiss.
          const reason = resolveFromCloseInfo(info);
          dispatch({
            type: 'connection_lost',
            view: {
              reason,
              diagnostic: {
                ts: Date.now(),
                url: `${WS_URL}/`,
                closeCode: info.code,
                wasClean: info.wasClean,
              },
            },
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
          // Cluster B Phase 6a + Cluster G Phase 4 (D6/D11): hand to
          // the GateModalsProvider bridge so `mcp_auto_install_pending`
          // / `session_start_gated` / `bus_auto_install_pending`
          // surface their modals. Same narrow-filter posture as the
          // inbox handler — non-gate messages are silently dropped by
          // the provider's internal type filter.
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
          // Cluster D Phase 5d: hand to the ReopenProvider bridge so
          // `reopen_session_confirm_required` / `reopen_session_failed` /
          // `multi_agent_started` envelopes drive the modal's state
          // machine. Same narrow-filter posture — non-reopen messages
          // (including multi_agent_started outside an in-flight reopen)
          // are silently ignored by the reducer's sessionId match.
          try {
            reopenHandlerRef.current?.(msg);
          } catch (err) {
            console.error('[reopen] handler threw', err);
          }
          // Cluster D Phase 6c: hand to the AuthRefreshProvider bridge
          // so auth_refresh_{started,output,completed,failed} envelopes
          // drive the modal's state machine. Narrow filter — the
          // reducer drops anything that doesn't match its kind/runId
          // guards.
          try {
            authRefreshHandlerRef.current?.(msg);
          } catch (err) {
            console.error('[auth_refresh] handler threw', err);
          }
          // Cluster D Phase 8b: hand to the RecoveryLogProvider bridge
          // so `recovery_log_snapshot` envelopes update the inspector
          // panel state. Narrow filter — non-snapshot messages are
          // silently dropped. Same posture as inboxHandlerRef.
          try {
            recoveryLogHandlerRef.current?.(msg);
          } catch (err) {
            console.error('[recovery_log] handler threw', err);
          }
          // Cluster C Phase 4g4: hand to the ForensicViewerProvider
          // bridge so `kick_forensics_snapshot` envelopes resolve the
          // KickForensicsModal's loading state. Same posture as above —
          // provider filters by msg.type internally.
          try {
            forensicViewerHandlerRef.current?.(msg);
          } catch (err) {
            console.error('[forensic_viewer] handler threw', err);
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
    // Cluster G E3 UI: `wsRetryNonce` participates so a Retry click
    // (which bumps the counter) re-runs this effect cleanly. Putting
    // the nonce in the deps array also makes the auto-retry timer's
    // `onRetry` callback trigger a real reconnect path rather than
    // closing over a stale effect closure.
  }, [wsRef, notifPushRef, notifDismissRef, wsRetryNonce]);

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

  /**
   * Cluster G Phase 3b (G1 UI / G1-3): RunsBadge dropdown row click. The
   * "jump" intent is twofold per spec §5: select the session AND switch
   * the main tab so the operator lands ON the run rather than next to
   * it. Concretely:
   *
   * - `kind === 'single'` + projectId known + project still present:
   *   call `selectSession` (which loads the session if needed) and flip
   *   the multi-agent slice's view to `'chat'`. The chat tab then
   *   renders the just-selected session.
   *
   * - Any bus kind (`'bus-worker'` / `'orchestrator'`): we can't tell
   *   chain from orchestrator from the wire alone (the lifecycle meta
   *   doesn't carry the topology) — both share the same active-slot
   *   reducer slice. Switching the tab to `'multi-agent'` (the default
   *   multi-agent tab) is a best-effort jump; the operator may need to
   *   pick the iteration manually if multiple bus sessions are in
   *   flight. Phase 4+ may refine this once `orchestrator` kind is
   *   actually emitted distinctly.
   *
   * - Defensive: if the project the descriptor references is gone (rare;
   *   only between a deletion and the next snapshot), drop the session
   *   selection but still switch tabs so the click isn't a silent no-op.
   */
  function onJumpToRun(run: ActiveRunView) {
    if (run.kind === 'single') {
      const knownProject =
        run.projectId !== undefined && state.projects.some((p) => p.id === run.projectId);
      if (knownProject && run.projectId !== undefined) {
        selectSession(run.projectId, run.sessionId);
      }
      dispatch({ type: 'ma_set_view', view: 'chat' });
      return;
    }
    // bus-worker / orchestrator → multi-agent tab. Phase 4 may split
    // chain vs orchestrator into distinct views once the lifecycle meta
    // carries the topology.
    dispatch({ type: 'ma_set_view', view: 'multi-agent' });
  }

  function newSession(projectId: number) {
    dispatch({ type: 'new_session', projectId });
  }

  function toggleTrust(projectId: number, trusted: boolean) {
    wsRef.current?.send({ type: 'set_trusted', projectId, trusted });
  }

  /**
   * Cluster I C2 UI: invoke the per-session JSONL export endpoint and
   * push a success/error toast. Called by ProjectList's `⤓` icon-btn
   * (this slice) and, in a later slice, by the SessionSettingsPanel
   * "Data" entry. Wraps the shared `exports.ts` helper.
   *
   * v1 ships the redacted form only — no surface yet collects the
   * typed-acknowledgment that flips the X-Cebab-Acknowledge-Raw header.
   * The Reveal-in-Finder action that the spec mentions (§5) is also
   * deferred — it needs a server-side path-open endpoint that doesn't
   * exist yet. Both are tracked as follow-ups.
   */
  async function downloadSession(sessionId: string): Promise<void> {
    const push = notifPushRef.current;
    const token = authTokenRef.current;
    if (!token) {
      push?.({
        id: mintNotificationId(),
        ts: Date.now(),
        severity: 'error',
        class: 'operational',
        dedupeKey: `session_log_export:no_token:${sessionId}`,
        title: 'Download failed',
        message: 'Not connected — reconnect and try again.',
        sticky: false,
      });
      return;
    }
    try {
      const result = await downloadSessionLog({
        baseUrl: HTTP_BASE,
        sessionId,
        token,
        format: 'redacted',
      });
      push?.({
        id: mintNotificationId(),
        ts: Date.now(),
        severity: 'success',
        class: 'operational',
        dedupeKey: `session_log_export:ok:${sessionId}`,
        title: 'Session log downloaded',
        message: result.filename,
        sticky: false,
      });
    } catch (err) {
      const message = isDownloadError(err)
        ? err.kind === 'http' && err.status === 404
          ? 'No log file on disk for this session.'
          : err.kind === 'http' && err.status === 403
            ? 'Server rejected the request — check that the auth token is current.'
            : err.message
        : 'Unexpected error during download.';
      push?.({
        id: mintNotificationId(),
        ts: Date.now(),
        severity: 'error',
        class: 'operational',
        dedupeKey: `session_log_export:err:${sessionId}`,
        title: 'Download failed',
        message,
        sticky: false,
      });
    }
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

  // Cluster C Phase 1 (spec §4.4): ship `interrupt` ClientMsg to the
  // single-agent runner. Server handler cleans pending permissions,
  // calls `runner.interrupt()`, and emits the new `session_interrupted`
  // envelope once cancellation resolves. Idempotent on the server
  // (BE-3), so double-clicks are harmless.
  function interruptSession() {
    const sessionId = session?.id;
    if (!sessionId) return;
    wsRef.current?.send({ type: 'interrupt', sessionId });
  }

  // Cluster E Phase 4 (H1): global keyboard bindings driven by the
  // central shortcut registry. Per-component bindings (modal Esc,
  // composer Enter, slash-palette `/` trigger) stay where they are;
  // this is the additive layer for cross-cutting shortcuts.
  //
  // The cheatsheet bindings work whether or not a session is active —
  // they're help, not actions. The Cmd/Ctrl+. Stop alternative
  // dispatches `interrupt` unconditionally; the server is idempotent
  // (BE-3, same as InputBox's Esc handler) and `interruptSession`
  // short-circuits when there's no active session id.
  useKeyboardShortcuts([
    [findShortcut(SHORTCUTS, 'help.openCheatsheet.questionMark'), () => setShortcutsOpen(true)],
    [findShortcut(SHORTCUTS, 'help.openCheatsheet.slash'), () => setShortcutsOpen((cur) => !cur)],
    [
      findShortcut(SHORTCUTS, 'session.stop.cmdPeriod'),
      // Same payload as the composer-scoped Esc-to-stop: fire
      // `interrupt` for the active session if any. interruptSession
      // is a no-op when session?.id is undefined, so this is safe
      // when no session is active.
      () => interruptSession(),
    ],
    [
      findShortcut(SHORTCUTS, 'session.logs.cmdShiftL'),
      // Cluster H C3 UI: push the `#/session/:id/logs` hash for the
      // active single-agent session. The single-agent LogsButton's
      // hashchange subscriber promotes the matching hash to an open
      // modal, restoring focus on Esc. No-op when no single-agent
      // session is active (multi-agent runs have their own LogsButton
      // mounted in TopRunBar; we don't double-dispatch here).
      () => {
        const target = session && !isSessionPending(session.id) ? session.id : null;
        if (target === null) return;
        const hash = logsHashFor(target);
        // Both operands are URL fragments — not credentials, not session
        // secrets. The security/detect-possible-timing-attacks rule fires
        // on every string `!==` and would force an indexOf-style workaround
        // that is strictly less readable here.
        // eslint-disable-next-line security/detect-possible-timing-attacks
        if (window.location.hash !== hash) {
          window.history.pushState(null, '', hash);
          // Browsers fire hashchange only on actual URL changes, but
          // not when we push the same hash twice. The early-return
          // above guards against that path so we never silently miss.
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
      },
    ],
  ]);

  // Cluster C Phase 2: ship the operator's reason-for-stop. Server
  // validates the interruptAckId binds to the most recent Stop and
  // drops mismatched messages — we still locally flip
  // reasonSubmitted so the prompt unmounts immediately (the operator
  // already made their choice; refreshing would be noise). The
  // server's silent drop on stale id is the right behavior: a late
  // reason for a stale Stop becomes a no-op on both sides.
  const submitStopReason = useCallback(
    (
      sessionId: string,
      interruptAckId: string,
      reasonCode: StopReasonCode,
      reasonText?: string,
    ) => {
      wsRef.current?.send({
        type: 'stop_reason',
        sessionId,
        interruptAckId,
        reasonCode,
        reasonText,
      });
      dispatch({ type: 'stop_reason_dismissed', sessionId });
    },
    [],
  );

  const skipStopReason = useCallback((sessionId: string) => {
    // Skip ships nothing — the absence of a stop_reason event is
    // the spec's "reason=unspecified" outcome. Just dismiss the
    // prompt locally so it doesn't keep nagging.
    dispatch({ type: 'stop_reason_dismissed', sessionId });
  }, []);

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
    // Cluster F Phase A1b (UI-A1): include the per-turn maxTurns override
    // only when explicitly set. The server's resolver omits gracefully
    // for `undefined` (falls through DB → env → built-in). Snapshot the
    // value before the WS send so clearing the input state below doesn't
    // race the post.
    const maxTurnsOverride = draftMaxTurns ?? undefined;
    wsRef.current?.send({
      type: 'send_message',
      projectId: state.activeProjectId,
      sessionId: resumeSessionId,
      text,
      ...(maxTurnsOverride !== undefined ? { maxTurns: maxTurnsOverride } : {}),
    });
    // Per-turn override is single-use by design — the operator typed it
    // for this turn. Clear so the next message uses the default again.
    if (draftMaxTurns !== null) setDraftMaxTurns(null);
    // Cluster F Phase A1b (UI-A1): a fresh user prompt resets the
    // extensions counter for the session — extensions are tied to
    // continuing a turn that hit the cap, not to operator-initiated
    // new exploration. Use resumeSessionId since the freshly-created
    // pending session id is what's actually being sent to the server.
    if (resumeSessionId && extensionsUsedBySession[resumeSessionId]) {
      setExtensionsUsedBySession((prev) => {
        const next = { ...prev };
        delete next[resumeSessionId];
        return next;
      });
    }
  }

  // Cluster F Phase A1b (UI-A1): "Extend +N" click handler for the
  // MaxTurnsResultCard. The SDK has no mid-conversation cap-raise verb
  // — we re-issue `send_message` against the same session with a
  // continuation prompt and a bumped `maxTurns`. `Continue.` is the
  // minimal nudge: the model resumes via `--resume <sessionId>` and
  // picks up where it left off. We do NOT route through `sendMessage`
  // because it would clear `draftMaxTurns` (which is unrelated here)
  // and reset the extension counter (which would break the soft cap).
  function extendMaxTurns(sessionId: string, bumpBy: number) {
    if (!state.activeProjectId) return;
    const sess = state.sessionsByProject[state.activeProjectId]?.[sessionId];
    if (!sess) return;
    // Find the most recent result message and read its effectiveMaxTurns
    // so the bump starts from the actual cap that tripped, not the
    // current settings (which may have changed mid-session).
    let lastEffective: number | undefined;
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      const m = sess.messages[i];
      if (m && m.kind === 'result' && m.effectiveMaxTurns !== undefined) {
        lastEffective = m.effectiveMaxTurns;
        break;
      }
    }
    const base = lastEffective ?? state.settings?.defaultMaxTurns ?? 50;
    const newCap = base + bumpBy;
    dispatch({ type: 'user_send', text: 'Continue.' });
    wsRef.current?.send({
      type: 'send_message',
      projectId: state.activeProjectId,
      sessionId,
      text: 'Continue.',
      maxTurns: newCap,
    });
    setExtensionsUsedBySession((prev) => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? 0) + 1,
    }));
  }

  // Cluster F Phase A1b (UI-A1): "End session" click handler for the
  // MaxTurnsResultCard. The session is already done (SDK already wrote
  // result.error_max_turns); this is purely a UI dismiss + counter
  // reset. We don't strip the card from the message log — keeping it
  // visible is useful forensics ("yes, you hit the cap, you chose to
  // end"). A future refinement could add a `cardDismissed` flag and
  // hide the buttons.
  function endMaxTurnsSession(sessionId: string) {
    if (extensionsUsedBySession[sessionId]) {
      setExtensionsUsedBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    }
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

  function saveSettings(payload: {
    workspaceRoot: string;
    defaultHopBudget: number;
    /**
     * Cluster F Phase A1b (UI-A1): the modal always supplies a value;
     * we only fire `set_default_max_turns` when it actually changed
     * (consistent with the workspace-root + hop-budget treatment above).
     */
    defaultMaxTurns: number;
  }) {
    // Fire only the messages whose field actually changed so unrelated
    // settings stay untouched (e.g. saving a hop-budget tweak doesn't
    // re-trigger the workspace-root sync which re-scans the filesystem).
    if (state.settings && payload.workspaceRoot !== state.settings.workspaceRoot) {
      wsRef.current?.send({ type: 'set_workspace_root', path: payload.workspaceRoot });
    }
    if (state.settings && payload.defaultHopBudget !== state.settings.defaultHopBudget) {
      wsRef.current?.send({ type: 'set_default_hop_budget', value: payload.defaultHopBudget });
    }
    if (state.settings && payload.defaultMaxTurns !== state.settings.defaultMaxTurns) {
      wsRef.current?.send({ type: 'set_default_max_turns', value: payload.defaultMaxTurns });
    }
    setSettingsOpen(false);
  }

  function setMultiAgentLifecycle(lifecycle: MultiAgentLifecycle) {
    dispatch({ type: 'ma_set_lifecycle', lifecycle });
  }
  function addParticipant(projectId: number) {
    dispatch({ type: 'ma_add_participant', projectId });
  }
  // Cluster C Phase 4g2: per-participant control-verb senders. Each is a
  // thin wrapper around the typed ClientMsg shapes in shared/src/protocol.ts;
  // the server's executors live in server/src/ws/control_verbs.ts and
  // dual-write a per_agent_control row + safety_audit row before echoing.
  // C4g5: each sender now forwards `reasonText` (collected by MuteReason/
  // PauseReasonModal) — the optional `reasonText?` field on each ClientMsg
  // shape. Undefined means the operator left the notes blank; we elide
  // the field entirely so the on-wire shape stays clean.
  function muteParticipant(
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) {
    wsRef.current?.send({
      type: 'mute_participant',
      sessionId,
      projectId,
      reasonCode,
      ...(reasonText !== undefined ? { reasonText } : {}),
    });
  }
  function unmuteParticipant(
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) {
    wsRef.current?.send({
      type: 'unmute_participant',
      sessionId,
      projectId,
      reasonCode,
      ...(reasonText !== undefined ? { reasonText } : {}),
    });
  }
  function pauseParticipant(
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    timeoutMs: number,
    expiryAction: PauseExpiryAction,
  ) {
    wsRef.current?.send({
      type: 'pause_participant',
      sessionId,
      projectId,
      reasonCode,
      ...(reasonText !== undefined ? { reasonText } : {}),
      timeoutMs,
      expiryAction,
    });
  }
  function resumeParticipant(
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) {
    wsRef.current?.send({
      type: 'resume_participant',
      sessionId,
      projectId,
      reasonCode,
      ...(reasonText !== undefined ? { reasonText } : {}),
    });
  }
  // Cluster C Phase 4g3: kick sender. Mode is currently always 'drain'
  // (server rejects 'hard' with `hard_kill_unsupported_v1`); KickModal
  // doesn't surface the toggle until the AbortController refactor.
  function kickParticipant(
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    mode: KickMode,
  ) {
    wsRef.current?.send({
      type: 'kick_participant',
      sessionId,
      projectId,
      reasonCode,
      ...(reasonText !== undefined ? { reasonText } : {}),
      mode,
    });
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
  function archiveSession(sessionId: string) {
    // Cluster D Phase 5e (UI-D17): in-session SweptSessionBanner's
    // Archive button. Identical ClientMsg to the toast notification's
    // Archive action — the reducer's `iteration_archived` handler
    // removes the row from the iterations list. The active view stays
    // on this iteration until the operator navigates away (no auto-
    // redirect; the scrollback is still useful after archiving for
    // post-mortem). Idempotent server-side (Phase 5).
    wsRef.current?.send({ type: 'archive_session', sessionId });
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
  function setDraftHopBudget(value: number | null) {
    // Cluster F Phase D9 (UI-D9): operator-typed hop-budget override.
    // The action flips draftHopBudgetSource to 'user' so the DraftView's
    // "(from template)" annotation hides — the value is no longer the
    // template's even if the operator typed a number that matches.
    dispatch({ type: 'ma_set_draft_hop_budget', value });
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
    scope?: SessionLogScope,
  ) {
    // Phase H: pure WS round-trip. The matching `session_log_chunk` reply
    // is consumed by the LogsModal via its `subscribeServerMsg` subscriber
    // (the reducer no-ops on the chunk because the rows live outside Redux).
    //
    // Cluster H C3 UI: `scope` is optional and forwarded verbatim. Older
    // callers (multi-agent TopRunBar / participants list mount) omit it;
    // the server defaults to `'multi_agent'` so the existing projection
    // still answers. The single-agent LogsButton mount passes `'single'`.
    wsRef.current?.send({
      type: 'load_session_log',
      sessionId,
      offset,
      limit,
      revealSensitive,
      ...(scope !== undefined ? { scope } : {}),
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
  // Cluster C Phase 1: `running` no longer hard-disables the composer —
  // the InputBox now flips its button to Stop + leaves the textarea
  // usable (UI-6 lets the operator draft the next message while the
  // current turn is in flight). `disabled` is reserved for true
  // structural blocks (no project, workspace bad). SlashCommandButtons
  // keep the old "off while running" semantics since their actions
  // are themselves new prompts.
  const composerStructurallyDisabled = !state.activeProjectId || !workspaceReady;
  const inputDisabled = composerStructurallyDisabled || running;
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
          {/*
            Cluster G Phase 2a (UI-A3): MOCK runtime badge. Mount immediately
            right of the brand (per ux-agent §5: "immediately right of Cebab
            logo") so it reads as the FIRST status signal the operator sees,
            before they look at the connection dot or notification bell.
            Non-dismissible by design — the whole point of the badge is that
            MOCK persists for the lifetime of the process. Strict equality
            on mockMode === true: an undefined value (pre-G1 server, or
            settings haven't arrived yet) renders nothing rather than
            falsely advertising "not mock".
          */}
          {state.settings?.mockMode === true && <MockBadge />}
          <div className="sidebar-header-controls">
            {/*
              Cluster G Phase 3b (G1 UI): "▶ N active" pill. Mount predicate
              is `state.activeRuns.length > 0` (hidden silently when
              nothing is running); the spec (§5 G1) places it between
              brand and connection dot so it reads left-to-right as
              "what's running here? → is the link up? → events". Each
              chip in the controls strip stands alone and unmounts when
              irrelevant — matches MockBadge / NotificationBell.

              `onJumpToRun` is defined just below `selectSession` so it
              can reuse the same project-bucket reconciliation path; if
              the descriptor is single-agent and the project is known,
              it both selects the session and flips to the chat tab. For
              bus/orchestrator descriptors it can't disambiguate
              orchestrator-vs-chain from the wire alone, so it lands the
              operator on the multi-agent tab (the live run will be
              visible there iff it's the active session — chain & orch
              currently share the same active-slot reducer slice).
            */}
            <RunsBadge runs={state.activeRuns} onJump={onJumpToRun} />
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
            {/*
              Cluster D Phase 8b: recovery_log inspector trigger. Same
              chrome placement as the bell (XCT-3 fallback — no app-
              shell header yet). The button surfaces an opaque history
              of every recovery action; unlike the bell it has no
              badge because the log isn't unread/acked.
            */}
            <RecoveryLogButton />
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
          onDownloadSession={downloadSession}
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
        {/* Cluster D Phase 6 (UI-D22): app-wide auth-expired banner.
         *  Mounted as the first child of <main> so it sits above
         *  whichever view (chat / chained / multi-agent) is currently
         *  rendering and is visible regardless of session state — the
         *  subscription is process-level, not per-session. The reducer
         *  populates `state.authExpired` on wrapper_error{kind:'auth_expired'}
         *  and clears it on the next session_started (positive signal).
         *  Dismissal is a soft hide that re-surfaces on the next
         *  observation, so the operator can't permanently silence a
         *  real expiry. Mounted as a direct <SessionBanner /> rather
         *  than via <BannerStack> since it's the sole top-level banner
         *  today (the rate-limit / swept banners live in per-session
         *  containers below). When more app-wide banners ship, this
         *  becomes a BannerStack of its own. */}
        {state.authExpired && !state.authExpired.dismissed && (
          <SessionBanner
            {...buildAuthExpiredBannerItem({
              state: state.authExpired,
              callbacks: {
                onDismiss: () => dispatch({ type: 'auth_expired_dismissed' }),
                // Cluster D Phase 6c: clicking Re-authenticate opens
                // the AuthRefreshModal + spawns `claude login` server-
                // side. The pin-via-ref pattern keeps AppShell out of
                // the AuthRefreshProvider context (the provider wraps
                // AppShell from outside in App.tsx's JSX) — same
                // posture as reopenRequestRef for the reopen flow.
                onReauthenticate: () => authRefreshRequestRef.current?.(),
              },
            })}
          />
        )}
        {!workspaceReady ? (
          <div className="chat empty">
            <div>
              <p>No workspace folder set yet.</p>
              {/* Cluster E Phase 3 (A4): the fallback path resolves
               * client-side from the settings ServerMsg. When the
               * stored workspace is null but the default resolves to
               * a valid directory, runs would land in
               * `defaultWorkspaceRoot` until the operator sets one.
               * Surface that landing location explicitly so "Choose a
               * folder" isn't the only signal of what happens if they
               * skip it. */}
              {state.settings?.defaultWorkspaceRoot && (
                <p className="hint">
                  Until you set one, runs and logs would land in{' '}
                  <code>{state.settings.defaultWorkspaceRoot}</code>
                  {state.settings.defaultWorkspaceRootSource === 'env'
                    ? ' (from your WORKSPACE_ROOT env var).'
                    : state.settings.defaultWorkspaceRootSource === 'builtin'
                      ? " (Cebab's built-in default)."
                      : '.'}
                </p>
              )}
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
            {view !== 'chat' && (
              <MultiAgentActivityBar run={state.multiAgent.active} projects={state.projects} />
            )}
            {view === 'chat' ? (
              <>
                {session && !isSessionPending(session.id) && (
                  <div className="chat-header">
                    {/* Cluster E Phase 2 (B4-1): ModelChip is the first
                     *  chip in the header — operator can tell which
                     *  model is producing the responses at a glance.
                     *  Reads from `session.model` which the reducer
                     *  captures on every `session_started`. */}
                    <ModelChip model={session.model} />
                    {/* Cluster G Phase 2b (UI-A3): per-session MOCK
                     *  badge, mounted immediately after ModelChip when
                     *  the session was created under MOCK runtime mode.
                     *  Reads `session.mock` (server projects from
                     *  `sessions.mock`), NOT `settings.mockMode` — so a
                     *  historical mock session opened after a live
                     *  restart still shows the badge. Strict equality
                     *  on === true so undefined/false renders nothing. */}
                    {session.mock === true && <MockBadge variant="inline" />}
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
                    {/* Cluster F Phase A1b (UI-A1): per-turn max-turns
                     *  override. Empty = use default (settings.defaultMaxTurns
                     *  > MAX_TURNS env > 50). Cleared after each send. */}
                    <MaxTurnsInput
                      value={draftMaxTurns}
                      defaultValue={state.settings?.defaultMaxTurns}
                      onChange={setDraftMaxTurns}
                      disabled={inputDisabled}
                    />
                    {/* Cluster F Phase A1b (UI-A1): post-hoc turn-counter.
                     *  Shows "Turns N/M" from the last result; warns at
                     *  ≥80% so the operator can raise the cap before the
                     *  next turn runs out. Renders nothing when no
                     *  result has landed yet (or older server payloads
                     *  lacking numTurns/effectiveMaxTurns). */}
                    <TurnCounterChip messages={session.messages} />
                    <SlashCommandButtons disabled={inputDisabled} onSend={sendMessage} />
                    {/* Cluster H C3 UI: raw-event inspector for the
                     *  single-agent session. Reuses the same `LogsButton`
                     *  the multi-agent TopRunBar already mounts; the
                     *  `scope='single'` prop tells the LogsModal to ask
                     *  the server's single-agent projector for `events`-
                     *  table rows and to hide the Agent multi-select.
                     *  Cmd/Ctrl+Shift+L below routes the same way via
                     *  the hash-route LogsButton listens for. */}
                    <LogsButton
                      sessionId={session.id}
                      scope="single"
                      onLoadSessionLog={loadSessionLog}
                      subscribeServerMsg={subscribeServerMsg}
                    />
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
                  onSubmitStopReason={submitStopReason}
                  onSkipStopReason={skipStopReason}
                  /* Cluster F Phase A1b (UI-A1): max-turns result card
                   * affordances — extend the cap or end the session. The
                   * extensionsUsed counter drives the soft-cap warning
                   * tooltip when >= EXTENSION_SOFT_CAP (3). */
                  extensionsUsed={session ? (extensionsUsedBySession[session.id] ?? 0) : 0}
                  onExtendMaxTurns={extendMaxTurns}
                  onEndMaxTurnsSession={endMaxTurnsSession}
                />
                <InputBox
                  /* Cluster C Phase 1: structural disable only (no
                   * project, workspace bad). `running` no longer hard-
                   * disables the composer — InputBox owns the running-
                   * state UI now (Send→Stop swap, textarea stays usable
                   * for the next prompt). */
                  disabled={
                    composerStructurallyDisabled ||
                    (session?.rateLimit && session.heldMessages.length >= HELD_MESSAGES_CAP
                      ? true
                      : false)
                  }
                  isRunning={running}
                  onSend={sendMessage}
                  onStop={interruptSession}
                  /* Cluster E Phase 1: SDK-discovered slash commands for
                   * the palette's "Discovered from session" group. The
                   * reducer captures this from session_started; undefined
                   * before the first init lands or for older payloads. */
                  sdkSlashCommands={session?.slashCommands}
                />
              </>
            ) : (
              <MultiAgentTab
                mode={view === 'chained-chat' ? 'chain' : 'orchestrator'}
                projects={state.projects}
                lastBusInstallAt={state.lastBusInstallAt}
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
                onArchiveSession={archiveSession}
                onContinueThroughMutation={continueThroughMutation}
                onClearAutoRetry={clearAutoRetry}
                onSetDraftPauseOnMutation={setDraftPauseOnMutation}
                onSetDraftHopBudget={setDraftHopBudget}
                defaultHopBudget={state.settings?.defaultHopBudget ?? null}
                onSetActiveLifecycle={setActiveLifecycle}
                onAddActiveParticipant={addActiveParticipant}
                onMuteParticipant={muteParticipant}
                onUnmuteParticipant={unmuteParticipant}
                onPauseParticipant={pauseParticipant}
                onResumeParticipant={resumeParticipant}
                onKickParticipant={kickParticipant}
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
      {shortcutsOpen && <KeyboardShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {/*
        Cluster G E3 UI: connection-lost overlay. Mounts iff the slice
        is populated (a recent WS close or initial fetch failure that
        the operator hasn't acknowledged). Mounts as a sibling of the
        main shell so its absolute positioning can cover the main pane
        without affecting layout flow. The sidebar stays visible per
        spec — the overlay's CSS leaves space at the left edge for it.
      */}
      <ConnectionLostOverlay
        view={state.connectionLost}
        onDismiss={() => dispatch({ type: 'connection_lost_dismissed' })}
        onRetry={() => setWsRetryNonce((n) => n + 1)}
      />
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
