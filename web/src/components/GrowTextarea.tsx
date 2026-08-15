import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * A controlled textarea that (a) auto-grows with its content and (b) has a
 * custom drag handle on its TOP edge. Both composers are pinned to the bottom
 * of the viewport, so the native `resize: vertical` grabber (bottom-right)
 * could only ever shrink the box. Growing height from a bottom-pinned flex
 * child visually expands UPWARD for free — no extra layout code needed.
 *
 * Enter submits (matches the old InputBox); Shift+Enter inserts a newline.
 */
export function GrowTextarea(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Floor in text rows (also the empty-state height). Default 3. */
  minRows?: number;
  /** Hard ceiling in px; past this the textarea scrolls internally. Default 320. */
  maxHeightPx?: number;
  /** Enter submits (default). Set false for free-text fields like notes,
   *  where Enter must insert a newline and saving is explicit. */
  submitOnEnter?: boolean;
  ariaLabel?: string;
  /** Id of an element describing the field's current state — used by the
   *  composer to point at its disabled-reason line (U33). Note that a
   *  `disabled` textarea is not focusable, so an AT reading in focus order
   *  never reaches the description; this association is for browse-mode
   *  readers, and the visible line is what does the real work. */
  ariaDescribedBy?: string;
}) {
  const { onChange, onSubmit, minRows = 3, maxHeightPx = 320, submitOnEnter = true } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  // Operator-dragged height. null = pure auto-grow. When set, the box stays
  // at least this tall but still grows past it once the text needs more.
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  // The height actually painted, mirrored into state so the separator can
  // report a truthful `aria-valuenow` and so a keyboard resize has a current
  // value to step from before any drag has ever happened.
  const [renderedHeight, setRenderedHeight] = useState(0);

  // Resize after every value/manual change and on mount. Reset to 'auto'
  // first so scrollHeight reflects the true content height (lets it shrink).
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const auto = ta.scrollHeight;
    const target = manualHeight != null ? Math.max(auto, manualHeight) : auto;
    const capped = Math.min(target, maxHeightPx);
    ta.style.height = `${capped}px`;
    ta.style.overflowY = target > maxHeightPx ? 'auto' : 'hidden';
    setRenderedHeight(capped);
  }, [props.value, manualHeight, maxHeightPx]);

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (submitOnEnter && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const ta = ref.current;
      if (!ta) return;
      const startY = e.clientY;
      const startHeight = ta.offsetHeight;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ns-resize';
      const onMove = (ev: PointerEvent) => {
        const node = ref.current;
        if (!node) return;
        // Drag up (clientY decreases) → taller. Floor = the content's
        // natural height (can't drag shorter than the text); ceiling = max.
        node.style.height = 'auto';
        const floor = Math.min(node.scrollHeight, maxHeightPx);
        const desired = startHeight + (startY - ev.clientY);
        setManualHeight(Math.max(floor, Math.min(desired, maxHeightPx)));
      };
      const onUp = () => {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [maxHeightPx],
  );

  /** The content's own height — the box may never be shorter than its text.
   *  Measured the same way the pointer drag measures it in `onMove`. */
  const contentFloor = useCallback(() => {
    const ta = ref.current;
    if (!ta) return 0;
    const inline = ta.style.height;
    ta.style.height = 'auto';
    const floor = Math.min(ta.scrollHeight, maxHeightPx);
    ta.style.height = inline;
    return floor;
  }, [maxHeightPx]);

  /**
   * Register U38: the handle declared `role="separator"` with a label — so a
   * screen reader announced a control — while being pointer-only, with no
   * tabIndex and no key handler. A focusable separator is a window splitter,
   * and the operator gets the keys one promises.
   *
   * ArrowUp grows and ArrowDown shrinks, matching the drag (dragging up makes
   * it taller). Home/End are defined by SIZE rather than by "separator
   * position", because the axis here is inverted and the control's label
   * promises resizing: Home is the shortest the text allows, End the tallest.
   */
  const RESIZE_STEP_PX = 24;
  const onHandleKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const floor = contentFloor();
      // Step from the height actually PAINTED, not from `manualHeight`. That
      // is the whole bound check: `renderedHeight` is already capped by the
      // layout effect, so a step from it lands at most one step outside the
      // range and the effect pulls it back. Stepping from `manualHeight`
      // instead would bank height past the ceiling — arrow up ten times too
      // many and the operator then needs ten ArrowDowns before the box moves.
      // A clamp here would be dead code; the effect owns both bounds.
      const current = Math.max(renderedHeight, floor);
      let next: number | null = null;
      if (e.key === 'ArrowUp') next = current + RESIZE_STEP_PX;
      else if (e.key === 'ArrowDown') next = current - RESIZE_STEP_PX;
      else if (e.key === 'Home') next = floor;
      else if (e.key === 'End') next = maxHeightPx;
      if (next === null) return;
      // Arrow keys would otherwise scroll the page out from under the composer.
      e.preventDefault();
      setManualHeight(next);
    },
    [contentFloor, renderedHeight, maxHeightPx],
  );

  return (
    <div className="grow-textarea-wrap">
      <div
        className="grow-textarea-handle"
        onPointerDown={startDrag}
        onKeyDown={onHandleKey}
        tabIndex={0}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize input"
        aria-valuenow={renderedHeight}
        aria-valuemin={0}
        aria-valuemax={maxHeightPx}
        title="Drag to resize, or focus and use the arrow keys"
      />
      <textarea
        ref={ref}
        value={props.value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        rows={minRows}
        placeholder={props.placeholder}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        aria-describedby={props.ariaDescribedBy}
      />
    </div>
  );
}
