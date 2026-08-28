import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { useAssistant } from './AssistantContext';
import { AssistantPanel } from './AssistantPanel';

/**
 * Cebab-8x8.3.2: the floating assistant trigger + its popover.
 *
 * Renders NOTHING until the server reports an `assistantProjectId` (a build
 * without an assistant project must show no dock at all).
 *
 * Open/close follows the {@link NotificationBell} recipe — local open state,
 * outside-pointerdown + Esc to close, focus restored to the trigger on close.
 * It is a POPOVER, not a modal: no `useModalSurface`, so no focus trap, no
 * `inert` on siblings, no body scroll lock. The app stays interactive behind
 * it.
 */
export function AssistantDock() {
  const { assistantProjectId } = useAssistant();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const closePanel = useCallback(() => {
    setOpen(false);
    // Restore focus to the trigger so keyboard users don't lose their place.
    buttonRef.current?.focus();
  }, []);

  // Outside-pointerdown + Esc to close, bound only while open so the dock
  // doesn't swallow Esc when closed.
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

  // Renders nothing when the assistant project is absent.
  if (assistantProjectId === undefined) return null;

  return (
    <div className="assistant-dock">
      <button
        ref={buttonRef}
        type="button"
        className="assistant-dock-trigger icon-btn"
        title="Cebab assistant"
        aria-label="Cebab assistant"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? closePanel() : setOpen(true))}
      >
        <Icon name="chat" />
      </button>
      {open && (
        <div ref={popoverRef} className="assistant-dock-popover">
          <AssistantPanel onClose={closePanel} />
        </div>
      )}
    </div>
  );
}
