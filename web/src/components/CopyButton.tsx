import { useState } from 'react';
import { copyToClipboard } from '../clipboard';

/**
 * Small hover-revealed copy affordance. Encapsulates the copied-state +
 * timed-reset pattern already used across the app (multi-agent event copy,
 * MCP-path copy) so callers just hand it the text. Reveal-on-hover is the
 * caller's concern via `className` (see `.msg-copy`); the button itself is
 * always rendered + focusable so keyboard users can still reach it.
 */
export function CopyButton(props: { text: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const label = props.label ?? 'Copy';

  async function onCopy() {
    const ok = await copyToClipboard(props.text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
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
