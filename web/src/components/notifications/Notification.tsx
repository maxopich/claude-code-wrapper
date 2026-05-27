import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type {
  NotificationAction,
  NotificationEnvelope,
  NotificationSeverity,
} from '@cebab/shared/protocol';
import type { DisplayNotification } from './notificationsReducer';
import { isMuteAllowed } from './muteStore';

/**
 * Cluster A Phase 2: a single dock toast.
 *
 * Responsibilities:
 *   - Visual: tier-colored left border, glyph + tier label + title + message.
 *     UI-7 demands BOTH glyph and tier text — never color-only encoding.
 *   - Lifecycle: auto-dismiss timer keyed off severity (info 5s/8s, success
 *     5s, warn 6s; error & danger never auto-dismiss). Sticky envelopes
 *     override the timer regardless of severity.
 *   - Pause: timer pauses while the toast is hovered or focused (UX-3 / UX-7).
 *   - Keyboard: Esc dismisses (UI-12). The toast host is in tab order ONLY
 *     when it has actions (UI-11); without actions it is purely informational
 *     and tabbing past it would noise up the keyboard journey.
 *   - Focus restore: after the user clicks an action, the previously focused
 *     element is restored (UI-13) — same pattern as `useModalSurface`.
 *   - `count > 1`: the same `dedupeKey` arrived while visible — show ×N
 *     badge per UI-9.
 *
 * Action invocation: Phase 2 only renders the actions; consumers wire the
 * action handler at the host level (the dispatch is mounted via context).
 * Some actions (open_session, etc.) need App.tsx-level routing — Phase 2
 * ships dismiss-on-activate so the toast doesn't pile up; Phase 3+ wires the
 * real navigation as sources land.
 */

const DEFAULT_TIMEOUT_MS: Record<NotificationSeverity, number | null> = {
  info: 5000,
  success: 5000,
  warn: 6000,
  error: null,
  danger: null,
};

const INFO_WITH_ACTION_TIMEOUT_MS = 8000;

const TIER_LABEL: Record<NotificationSeverity, string> = {
  info: 'Info',
  success: 'Success',
  warn: 'Warning',
  error: 'Error',
  danger: 'Danger',
};

/**
 * Resolve auto-dismiss time. `null` means never. Sticky envelopes always
 * return null (spec — sticky is the application-level pin signal that
 * overrides severity defaults). Info with an action gets the 8s extension.
 */
function resolveTimeout(n: NotificationEnvelope): number | null {
  if (n.sticky) return null;
  const base = DEFAULT_TIMEOUT_MS[n.severity];
  if (base === null) return null;
  if (n.severity === 'info' && n.action) return INFO_WITH_ACTION_TIMEOUT_MS;
  return base;
}

function actionLabel(action: NotificationAction): string {
  switch (action.kind) {
    case 'open_session':
      return 'Open session';
    case 'open_logs':
      return 'Open in logs';
    case 'open_settings':
      return 'Open settings';
    case 'reauth':
      return 'Re-authenticate';
    case 'resume':
      return 'Resume';
    case 'archive':
      return 'Archive';
    case 'reopen':
      return 'Reopen';
    case 'restart_agent':
      return action.agentName ? `Restart ${action.agentName}` : 'Restart agent';
  }
}

export type NotificationProps = {
  notification: DisplayNotification;
  onDismiss: (id: string) => void;
  /**
   * Invoked when an action button is clicked. The host owns routing —
   * Phase 2 wires this to a no-op or a simple console log; later phases
   * route open_session / open_logs / reauth into App.tsx's existing
   * navigation handlers.
   */
  onAction?: (action: NotificationAction, notification: DisplayNotification) => void;
  /**
   * Cluster A Phase 5: optional mute handler. When provided, mute-
   * eligible toasts (info/success/warn — NOT error/danger) render a
   * "Mute" button. Click invokes this with the envelope; the host
   * writes the localStorage mute entry and dismisses the toast. The
   * spec disallows muting error/danger (operator MUST attend); the
   * button is hidden for those tiers via `isMuteAllowed`.
   */
  onMute?: (notification: DisplayNotification) => void;
};

export function Notification({ notification, onDismiss, onAction, onMute }: NotificationProps) {
  const { id, severity, title, message, action, count, sticky } = notification;
  const timeoutMs = resolveTimeout(notification);
  const [paused, setPaused] = useState(false);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  /**
   * Snapshot the active element when the toast mounts so we can restore
   * focus when an action is invoked and the toast is dismissed (UI-13).
   * Same approach as `useModalSurface`.
   */
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
  }, []);

  useEffect(() => {
    if (timeoutMs === null) return;
    if (paused) return;
    const handle = window.setTimeout(() => onDismiss(id), timeoutMs);
    return () => window.clearTimeout(handle);
  }, [timeoutMs, paused, id, onDismiss]);

  const restoreFocus = useCallback(() => {
    const target = previouslyFocused.current;
    if (target && typeof target.focus === 'function') {
      try {
        target.focus();
      } catch {
        /* originator may have been removed from the DOM */
      }
    }
  }, []);

  const handleDismiss = useCallback(() => {
    restoreFocus();
    onDismiss(id);
  }, [id, onDismiss, restoreFocus]);

  const handleActionClick = useCallback(() => {
    if (action && onAction) onAction(action, notification);
    handleDismiss();
  }, [action, onAction, notification, handleDismiss]);

  const muteAvailable = onMute && isMuteAllowed(severity);
  const handleMuteClick = useCallback(() => {
    if (onMute) onMute(notification);
    // Don't restoreFocus — the mute action is a "make this go away"
    // gesture; restoring focus to the previously focused element is
    // the appropriate behavior, matching dismiss.
    restoreFocus();
    onDismiss(id);
  }, [onMute, notification, restoreFocus, onDismiss, id]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleDismiss();
      }
    },
    [handleDismiss],
  );

  /**
   * UI-11: toast host is tabbable only when it has actions. Otherwise the
   * notification is purely informational and shouldn't interrupt keyboard
   * navigation. Esc still works once tab focus lands here naturally
   * (which only happens with actions today). Mute counts as an action
   * for tab-order purposes — operators need keyboard access to silence
   * a noisy source.
   */
  const tabIndex = action || muteAvailable ? 0 : -1;

  /**
   * UX-7: danger uses alertdialog so AT treats it as modal-blocking.
   * Other tiers stay role=alert (assertive ones — error/danger) or
   * role=status (everything else). The host's outer aria-live regions
   * already announce text; here the role is for the visible toast
   * semantics, NOT for AT replay (avoid double-announcement).
   */
  const role = severity === 'danger' ? 'alertdialog' : severity === 'error' ? 'alert' : 'status';

  return (
    <div
      className="notif"
      data-severity={severity}
      data-sticky={sticky ? 'true' : 'false'}
      role={role}
      tabIndex={tabIndex}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      aria-labelledby={`notif-title-${id}`}
    >
      <span className="notif-glyph" aria-hidden="true">
        <SeverityGlyph severity={severity} />
      </span>
      <div className="notif-body">
        <div className="notif-head">
          <span className="notif-tier-label">{TIER_LABEL[severity]}</span>
          {count > 1 && (
            <span className="notif-count" aria-label={`${count} occurrences`}>
              ×{count}
            </span>
          )}
        </div>
        <div id={`notif-title-${id}`} className="notif-title">
          {title}
        </div>
        {message && <div className="notif-message">{message}</div>}
        {(action || muteAvailable) && (
          <div className="notif-actions">
            {action && (
              <button type="button" className="notif-action-btn" onClick={handleActionClick}>
                {actionLabel(action)}
              </button>
            )}
            {muteAvailable && (
              <button
                type="button"
                className="notif-mute-btn"
                onClick={handleMuteClick}
                aria-label="Mute this notification type for 1 hour"
                title="Mute this notification type for 1 hour"
              >
                Mute
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="notif-close"
        aria-label="Dismiss notification"
        onClick={handleDismiss}
      >
        ×
      </button>
    </div>
  );
}

function SeverityGlyph({ severity }: { severity: NotificationSeverity }) {
  // Decorative SVGs — semantic load is carried by the tier label text.
  // 16×16 viewBox; sized by `.notif-glyph svg` rules.
  switch (severity) {
    case 'info':
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <circle cx="8" cy="8" r="6.5" />
          <line x1="8" y1="7" x2="8" y2="11" strokeLinecap="round" />
          <circle cx="8" cy="5" r="0.7" fill="currentColor" />
        </svg>
      );
    case 'success':
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <circle cx="8" cy="8" r="6.5" />
          <path d="M5 8.5l2 2 4-4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'warn':
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <path d="M8 2l6.5 11.5h-13z" strokeLinejoin="round" />
          <line x1="8" y1="6.5" x2="8" y2="10" strokeLinecap="round" />
          <circle cx="8" cy="12" r="0.7" fill="currentColor" />
        </svg>
      );
    case 'error':
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <circle cx="8" cy="8" r="6.5" />
          <line x1="5.5" y1="5.5" x2="10.5" y2="10.5" strokeLinecap="round" />
          <line x1="10.5" y1="5.5" x2="5.5" y2="10.5" strokeLinecap="round" />
        </svg>
      );
    case 'danger':
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <path d="M8 1.5l5.5 2.5v4.5c0 3-2.5 5-5.5 6-3-1-5.5-3-5.5-6V4z" strokeLinejoin="round" />
          <line x1="8" y1="6" x2="8" y2="9" strokeLinecap="round" />
          <circle cx="8" cy="11" r="0.7" fill="currentColor" />
        </svg>
      );
  }
}
