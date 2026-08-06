import { useEffect, useRef } from 'react';

/**
 * Does this element already do something meaningful with Enter?
 *
 * The listener is on `document`, so before this check ANY Enter while a modal
 * was open ran the modal's primary action — including Enter on the focused
 * **Cancel** button, which saved instead of discarding (register U13). The
 * shortcut is meant for "I've typed in the field, commit without mousing to
 * Save", not for overriding whatever control the operator actually chose.
 *
 * `<textarea>` was the only case handled before; the rest activate on Enter
 * per the HTML spec (buttons, links, `<summary>`, `<select>`) or opt in via
 * `role="button"`, which the codebase's own keyboard handlers honour.
 */
function ownsEnterKey(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.getAttribute('role') === 'button') return true;
  switch (target.tagName) {
    case 'TEXTAREA':
    case 'BUTTON':
    case 'SUMMARY':
    case 'SELECT':
      return true;
    case 'A':
      return target.hasAttribute('href');
    default:
      return false;
  }
}

/**
 * Keyboard affordances shared by every hand-rolled modal (there is no shared
 * Modal component): Escape closes, Enter confirms the primary action. Mirrors
 * the codebase's single-line convention (Enter = commit, Esc = cancel — see
 * `ProjectList.tsx` session rename) so users never have to mouse to Save.
 *
 * Enter is ignored when `canConfirm` is false (gates like the Settings
 * `canSave`) and when the focused element owns Enter itself — see
 * `ownsEnterKey`. Latest opts are mirrored into a ref so the listener binds
 * once and doesn't re-subscribe on every keystroke of a controlled input.
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
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !ownsEnterKey(e.target)) {
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
