/**
 * Phase H: the route-backed Logs modal.
 *
 * Layout: header (title + close) → toolbar (search + filters + actions) →
 * table (rows + optional row-detail drawer). The whole thing is a modal
 * dialog (`role="dialog" aria-modal="true"`) with a focus trap and Esc
 * dismissal — `useModalKeys` already handles the Esc + Enter contract for
 * every modal in the app, so reuse that. The button that opened us restores
 * focus on close (in `LogsButton`).
 *
 * Data ownership: `useLogStream` owns the chunk rows + pagination state.
 * `useLogFilters` overlays an AND-composition filter; both hooks are pure
 * client state, no Redux.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogRow, ServerMsg } from '@cebab/shared/protocol';
import { useModalKeys } from '../../useModalKeys';
import { useLogStream } from './useLogStream';
import { applyLogFilters, useLogFilters } from './useLogFilters';
import { LogToolbar } from './LogToolbar';
import { LogTable } from './LogTable';
import { parseLogsRowAnchor } from './logsHash';

export function LogsModal(props: {
  sessionId: string;
  onClose: () => void;
  onLoadSessionLog: (
    sessionId: string,
    offset: number,
    limit: number,
    revealSensitive: boolean,
  ) => void;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
}) {
  useModalKeys({ onClose: props.onClose });

  const stream = useLogStream({
    sessionId: props.sessionId,
    onLoadSessionLog: props.onLoadSessionLog,
    subscribeServerMsg: props.subscribeServerMsg,
  });
  const filters = useLogFilters();

  const filtered = useMemo(() => applyLogFilters(stream.rows, filters), [stream.rows, filters]);
  const agents = useMemo(() => uniqueAgents(stream.rows), [stream.rows]);

  // Focus the close button on mount so screen readers announce the modal.
  // Tab key cycles through interactive elements naturally; the modal-keys
  // hook traps Esc → onClose.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Bidirectional link: the lane row / artifact row pushes a hash like
  // `#/session/:id/logs?row=event:42`. Read it once the rows have loaded,
  // then scrollIntoView + highlight the matching DOM element. Stale anchor
  // (row not in the loaded chunk yet) → no-op; the operator can scroll or
  // click Load more.
  const [anchorRowId, setAnchorRowId] = useState<string | null>(() =>
    parseLogsRowAnchor(window.location.hash),
  );
  useEffect(() => {
    function syncAnchor() {
      setAnchorRowId(parseLogsRowAnchor(window.location.hash));
    }
    window.addEventListener('hashchange', syncAnchor);
    return () => window.removeEventListener('hashchange', syncAnchor);
  }, []);
  useEffect(() => {
    if (!anchorRowId) return;
    if (stream.loading) return;
    // Defer one frame so the table has rendered the row's DOM.
    requestAnimationFrame(() => {
      const el = document.getElementById(`logs-row-${cssId(anchorRowId)}`);
      if (!el) return;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      el.classList.add('is-anchor-highlight');
      window.setTimeout(() => el.classList.remove('is-anchor-highlight'), 1800);
    });
  }, [anchorRowId, stream.loading, stream.rows.length]);

  return (
    <div
      className="logs-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Session log for ${props.sessionId.slice(0, 8)}`}
    >
      <div className="logs-modal">
        <header className="logs-modal-header">
          <div>
            <h3 className="logs-modal-title">Session log</h3>
            <p className="logs-modal-subtitle">
              <code>{props.sessionId.slice(0, 8)}</code>
              {' · '}
              <span className="logs-modal-count">
                {filtered.length === stream.total
                  ? `${stream.total} ${stream.total === 1 ? 'entry' : 'entries'}`
                  : `${filtered.length} of ${stream.total} entries`}
              </span>
              {stream.hasMore && <span className="logs-modal-more"> · more available</span>}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="ghost-btn"
            onClick={props.onClose}
            aria-label="Close logs"
          >
            Close
          </button>
        </header>

        <LogToolbar
          filters={filters}
          agents={agents}
          revealedSensitive={stream.revealedSensitive}
          loading={stream.loading}
          onRevealSensitive={() => requestReveal(stream, filtered)}
          onRefresh={stream.refresh}
          onDownload={() => downloadNdjson(props.sessionId, filtered)}
        />

        {stream.error && (
          <p className="logs-modal-error" role="alert">
            {stream.error}
          </p>
        )}

        <LogTable
          rows={filtered}
          loading={stream.loading}
          hasMore={stream.hasMore}
          onLoadMore={stream.loadMore}
        />
      </div>
    </div>
  );
}

function uniqueAgents(rows: readonly LogRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) set.add(r.agent);
  return [...set].sort();
}

/** Make a LogRow.id (e.g. `event:42`) safe for use as a DOM id. */
function cssId(rowId: string): string {
  return rowId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Reveal-sensitive flow: explicit operator confirm before un-masking. The
 * confirm string lists the redacted field names from the currently-filtered
 * set so the operator knows what they're un-masking. Server-side, the flag
 * round-trips with the next chunk request; until that chunk arrives the UI
 * still shows redacted data.
 */
function requestReveal(
  stream: ReturnType<typeof useLogStream>,
  filteredRows: readonly LogRow[],
): void {
  if (stream.revealedSensitive) {
    // Already revealed — operator is asking to RE-MASK.
    stream.setRevealSensitive(false);
    return;
  }
  const sample = new Set<string>();
  for (const r of filteredRows) {
    for (const f of r.redactedFields ?? []) {
      sample.add(f);
      if (sample.size >= 8) break;
    }
    if (sample.size >= 8) break;
  }
  const sampleStr = sample.size > 0 ? [...sample].sort().join(', ') : 'no redacted fields detected';
  const ok = window.confirm(
    `Reveal sensitive fields?\n\nThe server has masked fields matching credential/path patterns. ` +
      `Examples in the current view: ${sampleStr}.\n\n` +
      `Click OK to re-fetch the log with redaction disabled. Refresh the page to re-mask.`,
  );
  if (ok) stream.setRevealSensitive(true);
}

/**
 * Operator-triggered NDJSON export of the currently-filtered rows.
 * Triggered by clicking Download in the toolbar; pure client-side blob.
 * The .ndjson format is one JSON-encoded LogRow per line — easy to grep
 * and re-import into a viewer.
 */
function downloadNdjson(sessionId: string, rows: readonly LogRow[]): void {
  const lines = rows.map((r) => JSON.stringify(r)).join('\n');
  const blob = new Blob([lines], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cebab-session-${sessionId.slice(0, 8)}.ndjson`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke to next tick so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
