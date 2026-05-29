/**
 * Phase H: top-bar "Logs" affordance for the active multi-agent run.
 *
 * Click opens the LogsModal at `#/session/:id/logs` (hash route — no router
 * dependency; just `location.hash`). The Esc key + browser back-button both
 * dismiss the modal, restoring focus to this button. ARIA: the button is
 * `aria-haspopup="dialog"` + carries the warning tooltip about raw inputs.
 *
 * No "new entries" badge in v1 — the bus runtime doesn't push live log rows
 * (the modal pulls on-demand). Future polish can hook into a future
 * `log_row_appended` ServerMsg here.
 */
import { useEffect, useRef, useState } from 'react';
import type { ServerMsg, SessionLogScope } from '@cebab/shared/protocol';
import { LogsModal } from './LogsModal';
import { hashIsLogsFor, logsHashFor } from './logsHash';

export function LogsButton(props: {
  sessionId: string;
  /** Count of confirmed dangerous mutations on the current run. When > 0
   *  the button label becomes `Logs · ⚠ N` and the tooltip carries the
   *  review-before-granting prompt. */
  dangerousCount?: number;
  /**
   * Cluster H C3 UI: scope discriminator forwarded verbatim into the
   * `LogsModal`. Optional — omit for the historical multi-agent button
   * (mounted by MultiAgentTab.tsx / TopRunBar); pass `'single'` from the
   * single-agent ChatHeader mount in App.tsx so the modal pulls
   * events-table rows and the toolbar hides the Agent multi-select.
   */
  scope?: SessionLogScope;
  onLoadSessionLog: (
    sessionId: string,
    offset: number,
    limit: number,
    revealSensitive: boolean,
    scope?: SessionLogScope,
  ) => void;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
}) {
  const { sessionId, dangerousCount = 0 } = props;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // Hash-route sync: open the modal whenever the URL matches
  // `#/session/:id/logs` (deep-link / back-button restore). The hash may
  // also carry a `?row=<rowId>` anchor for bidirectional deep-links
  // (lane row / artifact → "Open in Logs at this event"); we forward that
  // verbatim to the modal via the live `location.hash` read, no extra prop.
  useEffect(() => {
    function syncFromHash() {
      setOpen(hashIsLogsFor(window.location.hash, sessionId));
    }
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, [sessionId]);

  function openModal() {
    const target = logsHashFor(sessionId);
    if (window.location.hash !== target) {
      // pushState (not replaceState) so back-button dismisses without
      // navigating away from the page entirely.
      window.history.pushState(null, '', target);
    }
    setOpen(true);
  }

  function closeModal() {
    if (window.location.hash.endsWith('/logs')) {
      // Pop the synthetic logs entry; if there's no prior history we just
      // clear the hash so the URL doesn't lie.
      if (window.history.state !== null && window.history.length > 1) {
        window.history.back();
      } else {
        window.history.replaceState(null, '', window.location.pathname);
      }
    }
    setOpen(false);
    // Restore focus to the button per WAI-ARIA modal pattern.
    requestAnimationFrame(() => buttonRef.current?.focus());
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`ghost-btn logs-button${dangerousCount > 0 ? ' has-dangerous' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          dangerousCount > 0
            ? `Open session logs. ${dangerousCount} dangerous mutation${dangerousCount === 1 ? '' : 's'} recorded.`
            : undefined
        }
        onClick={openModal}
        title={
          dangerousCount > 0
            ? `${dangerousCount} dangerous mutation${dangerousCount === 1 ? '' : 's'} recorded — review before granting further permissions.`
            : 'Open the raw session log. Contains raw tool inputs and outputs (sensitive fields redacted by default).'
        }
      >
        Logs
        {dangerousCount > 0 && (
          <span className="logs-button-dangerous-chip" aria-hidden="true">
            <span className="logs-button-dangerous-sep">·</span>
            <span className="logs-button-dangerous-glyph">⚠</span>
            <span className="logs-button-dangerous-count">{dangerousCount}</span>
          </span>
        )}
      </button>
      {open && (
        <LogsModal
          sessionId={sessionId}
          scope={props.scope}
          onClose={closeModal}
          onLoadSessionLog={props.onLoadSessionLog}
          subscribeServerMsg={props.subscribeServerMsg}
        />
      )}
    </>
  );
}
