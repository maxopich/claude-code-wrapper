import { useCopyFeedback } from '../useCopyFeedback';

/**
 * Small hover-revealed copy affordance. The icon presentation of
 * `useCopyFeedback` — callers just hand it the text. Reveal-on-hover is the
 * caller's concern via `className` (see `.msg-copy`); the button itself is
 * always rendered + focusable so keyboard users can still reach it.
 *
 * The copied-state + timed-reset pair moved into `useCopyFeedback` (U42) so
 * that a text-labelled copy button can share it. Behaviour here is unchanged —
 * this file's existing test passing untouched is the evidence.
 */
export function CopyButton(props: { text: string; className?: string; label?: string }) {
  const { copied, copy } = useCopyFeedback();
  const label = props.label ?? 'Copy';

  async function onCopy() {
    await copy(props.text);
  }

  return (
    <button
      type="button"
      className={`icon-btn copy-btn${props.className ? ` ${props.className}` : ''}`}
      onClick={onCopy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
    </button>
  );
}
