import { useCallback, useEffect, useRef, useState } from 'react';
import { useInboxActions, useInboxState } from './InboxContext';
import { NotificationInbox } from './NotificationInbox';

/**
 * Cluster A Phase 5: header bell + unread badge.
 *
 * Lives in the sidebar header (DEC-1 fallback per the validation report:
 * the app has no app-shell header today, so the bell sits alongside the
 * connection dot in `sidebar-header-controls`; a future PR can promote
 * it to an app-shell header if/when one lands).
 *
 * Badge count = `unackedGlobal` from the latest `inbox_snapshot`. The
 * server pushes a snapshot on every WS attach so the badge populates
 * without operator interaction; opening the panel triggers a fresh
 * snapshot so a long-running tab doesn't drift.
 *
 * Open/close is local state — the panel is purely presentational; the
 * inbox data and actions live in `InboxContext`. The panel renders as
 * an overlay anchored to the bell; outside-click + Esc close it.
 */

const MAX_BADGE_DISPLAY = 99;

function badgeLabel(count: number): string {
  if (count <= 0) return '';
  if (count > MAX_BADGE_DISPLAY) return `${MAX_BADGE_DISPLAY}+`;
  return String(count);
}

export type NotificationBellProps = {
  /**
   * Per-row ack handler — App.tsx already wires this for the dock's
   * sticky-dismiss path; the inbox's "Mark read" button reuses it.
   * Optional in tests.
   */
  onAck?: (id: string) => void;
};

export function NotificationBell({ onAck }: NotificationBellProps = {}) {
  const { unackedGlobal } = useInboxState();
  const { requestSnapshot } = useInboxActions();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const openPanel = useCallback(() => {
    setOpen(true);
    // Fresh snapshot every open — a long-running tab may have missed
    // pushes if it briefly disconnected, and including acked rows lets
    // the panel show recent activity instead of "no notifications".
    requestSnapshot({ includeAcked: true });
  }, [requestSnapshot]);

  const closePanel = useCallback(() => {
    setOpen(false);
    // Restore focus to the bell so keyboard users don't lose their
    // place after closing. The popover itself manages internal focus.
    buttonRef.current?.focus();
  }, []);

  // Outside-click + Esc to close. Esc handler bound while open only so
  // the popover doesn't swallow Esc when closed.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (buttonRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const label = badgeLabel(unackedGlobal);
  const ariaLabel =
    unackedGlobal > 0 ? `Notifications inbox, ${unackedGlobal} unread` : 'Notifications inbox';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn notif-bell"
        title={ariaLabel}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? closePanel() : openPanel())}
        data-has-unread={unackedGlobal > 0 ? 'true' : 'false'}
      >
        <BellGlyph />
        {label && (
          <span className="notif-bell-badge" aria-hidden="true">
            {label}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="notif-inbox-popover"
          role="dialog"
          aria-label="Notifications"
        >
          <NotificationInbox onClose={closePanel} onAck={onAck} />
        </div>
      )}
    </>
  );
}

function BellGlyph() {
  // 16x16 viewBox; sized via .notif-bell svg. Outline + clapper, no fill.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <path
        d="M8 2c-2.2 0-4 1.8-4 4v2.5l-1.2 2c-.2.4.1.9.6.9h9.2c.5 0 .8-.5.6-.9L12 8.5V6c0-2.2-1.8-4-4-4z"
        strokeLinejoin="round"
      />
      <path d="M6.5 12c.3.7 1 1.1 1.5 1.1s1.2-.4 1.5-1.1" strokeLinecap="round" />
    </svg>
  );
}
