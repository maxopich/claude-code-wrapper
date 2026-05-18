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
}) {
  const { onChange, onSubmit, minRows = 3, maxHeightPx = 320, submitOnEnter = true } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  // Operator-dragged height. null = pure auto-grow. When set, the box stays
  // at least this tall but still grows past it once the text needs more.
  const [manualHeight, setManualHeight] = useState<number | null>(null);

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

  return (
    <div className="grow-textarea-wrap">
      <div
        className="grow-textarea-handle"
        onPointerDown={startDrag}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize input"
        title="Drag to resize"
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
      />
    </div>
  );
}
