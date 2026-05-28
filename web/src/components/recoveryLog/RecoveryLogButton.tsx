import { useCallback, useEffect, useRef, useState } from 'react';
import { useRecoveryLogActions } from './RecoveryLogContext';
import { RecoveryLogInspector } from './RecoveryLogInspector';

/**
 * Cluster D Phase 8b: trigger button for the RecoveryLogInspector.
 *
 * Lives in the sidebar header next to NotificationBell — same chrome
 * placement as the bell (per DEC-1 fallback: no app-shell header
 * exists today, so forensic surfaces sit in `sidebar-header-controls`).
 *
 * Unlike the bell, this button does NOT carry a badge — `recovery_log`
 * is an append-only forensic record, not an unread inbox. The button
 * is always "neutral" until clicked.
 *
 * Mechanics mirror NotificationBell: toggle on click, outside-click +
 * Esc close, focus returns to the button on close.
 */

export type RecoveryLogButtonProps = {
  /** Optional className extra for layout tweaks. */
  className?: string;
};

export function RecoveryLogButton({ className }: RecoveryLogButtonProps = {}) {
  const { requestSnapshot } = useRecoveryLogActions();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const openPanel = useCallback(() => {
    setOpen(true);
    // The inspector also requests on mount; we re-request here so the
    // initial open hits the server even if React batches the mount
    // effect — same defensive call as NotificationBell.
    requestSnapshot();
  }, [requestSnapshot]);

  const closePanel = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  // Outside-click + Esc to close. Esc only bound while open so the
  // button doesn't swallow Esc when there's nothing to dismiss.
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

  const ariaLabel = 'Recovery activity';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`icon-btn recovery-log-btn${className ? ` ${className}` : ''}`}
        title={ariaLabel}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? closePanel() : openPanel())}
      >
        <ClockGlyph />
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="recovery-log-popover"
          role="dialog"
          aria-label="Recovery activity"
        >
          <RecoveryLogInspector onClose={closePanel} />
        </div>
      )}
    </>
  );
}

function ClockGlyph() {
  // 16x16 viewBox; outline-only — visually distinct from the bell.
  // A clock-face glyph reads as "history / time-series" without
  // suggesting "alerts" (the bell already owns that).
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
