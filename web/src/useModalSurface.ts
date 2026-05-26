import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { useModalKeys } from './useModalKeys';

/**
 * Cross-cutting modal niceties, composed on top of `useModalKeys`:
 *   - Body scroll lock on mount, restored on unmount.
 *   - Focus trap via the `inert` attribute on every sibling of the
 *     overlay (walking up to `document.body`). `inert` blocks keyboard
 *     focus AND pointer events without `aria-hidden`'s "still
 *     tab-able" pitfall. Originally lived inline inside
 *     `TemplatePreviewModal`; lifted here so every dialog gets it.
 *   - Save / restore `document.activeElement` so closing returns
 *     focus to the originating control.
 *   - A `onBackdropMouseDown` helper that calls `onClose` only when
 *     the mousedown target IS the overlay (not a descendant).
 *
 * Pair the returned `overlayRef` with a `.modal-surface` class on the
 * inner surface element for full-bleed behavior below the sm
 * breakpoint.
 */
export function useModalSurface(opts: {
  onClose: () => void;
  onConfirm?: () => void;
  canConfirm?: boolean;
}): {
  overlayRef: RefObject<HTMLDivElement>;
  onBackdropMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => void;
} {
  useModalKeys(opts);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Mirror latest opts so the stable backdrop handler always calls
  // the freshest onClose. Same pattern useModalKeys uses internally.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      try {
        prev?.focus();
      } catch {
        /* originating element may have been removed */
      }
    };
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const inerted: HTMLElement[] = [];
    // Starts at `overlay` (just guarded above) and only ever gets
    // reassigned to `parent` after the !parent break — the loop only
    // needs the body-stop check, not a redundant truthiness test.
    let node: HTMLElement = overlay;
    while (node !== document.body) {
      const parent = node.parentElement;
      if (!parent) break;
      for (const sib of Array.from(parent.children)) {
        if (sib === node) continue;
        if (!(sib instanceof HTMLElement)) continue;
        if (sib.hasAttribute('inert')) continue;
        sib.setAttribute('inert', '');
        inerted.push(sib);
      }
      node = parent;
    }
    return () => {
      for (const el of inerted) el.removeAttribute('inert');
    };
  }, []);

  const onBackdropMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) optsRef.current.onClose();
  }, []);

  return { overlayRef, onBackdropMouseDown };
}
