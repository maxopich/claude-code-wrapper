import { useEffect, useRef } from 'react';

/**
 * Keyboard affordances shared by every hand-rolled modal (there is no shared
 * Modal component): Escape closes, Enter confirms the primary action. Mirrors
 * the codebase's single-line convention (Enter = commit, Esc = cancel — see
 * `ProjectList.tsx` session rename) so users never have to mouse to Save.
 *
 * Enter is ignored when a <textarea> is focused (multi-line fields own their
 * own Enter/Shift+Enter) and when `canConfirm` is false (gates like the
 * Settings `canSave`). Latest opts are mirrored into a ref so the listener
 * binds once and doesn't re-subscribe on every keystroke of a controlled
 * input.
 */
export function useModalKeys(opts: {
  onClose: () => void;
  onConfirm?: () => void;
  canConfirm?: boolean;
}): void {
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const o = ref.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        o.onClose();
      } else if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        (e.target as HTMLElement | null)?.tagName !== 'TEXTAREA'
      ) {
        if (o.onConfirm && o.canConfirm) {
          e.preventDefault();
          o.onConfirm();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
