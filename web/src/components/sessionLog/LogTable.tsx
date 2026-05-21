/**
 * Phase H: scrollable log row list with inline drawer.
 *
 * Not virtualized in v1 — the server chunk cap keeps the worst-case row
 * count to a few thousand, which React handles fine with simple `.map()`.
 * If we ever start streaming live tails (no future cap), this is the
 * obvious place to swap in react-window or a hand-rolled windowing hook.
 *
 * Each row is keyboard-operable: Tab focuses, Enter/Space toggles the
 * inline detail drawer. Sticky-left timestamp gutter is plain CSS
 * (`.logs-row-ts { position: sticky; left: 0; }`).
 */
import { useState } from 'react';
import type { LogRow } from '@cebab/shared/protocol';
import { LogRowDetail } from './LogRowDetail';

export function LogTable(props: {
  rows: readonly LogRow[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const { rows } = props;
  const [expanded, setExpanded] = useState<string | null>(null);

  if (props.loading && rows.length === 0) {
    return (
      <div className="logs-table-empty" role="status">
        <p>Loading log…</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="logs-table-empty">
        <p>No log entries match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="logs-table-wrap">
      <ul className="logs-table" role="log" aria-live="off">
        {rows.map((row) => {
          const isOpen = expanded === row.id;
          return (
            <li
              key={row.id}
              id={`logs-row-${cssId(row.id)}`}
              className={`logs-row logs-row-${row.kind}`}
            >
              <button
                type="button"
                className="logs-row-summary"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : row.id)}
              >
                <span className="logs-row-ts" title={new Date(row.ts).toISOString()}>
                  {formatTime(row.ts)}
                </span>
                <span className={`logs-row-kind logs-row-kind-${row.kind}`}>{row.kind}</span>
                <span className="logs-row-agent" title={`agent: ${row.agent}`}>
                  {row.agent}
                </span>
                <span className="logs-row-summary-text" title={row.summary}>
                  {row.summary}
                </span>
                <span className="logs-row-badges">
                  {row.severity === 'dangerous' && (
                    <span
                      className="mutation-badge mutation-badge-dangerous"
                      aria-label="dangerous mutation"
                      title="This row writes to a path the artifact classifier flagged as dangerous (e.g. .env, secrets)."
                    >
                      ⚠ DANGEROUS
                    </span>
                  )}
                  {row.redactedFields && row.redactedFields.length > 0 && (
                    <span
                      className="logs-row-redacted-badge"
                      title={`${row.redactedFields.length} field(s) masked: ${row.redactedFields.join(', ')}`}
                    >
                      redacted
                    </span>
                  )}
                </span>
              </button>
              {isOpen && <LogRowDetail row={row} />}
            </li>
          );
        })}
      </ul>
      {props.hasMore && (
        <div className="logs-table-load-more">
          <button
            type="button"
            className="ghost-btn"
            disabled={props.loading}
            onClick={props.onLoadMore}
          >
            {props.loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Mirror of `LogsModal.cssId` — kept local so this component is self-
 *  contained for tests. */
function cssId(rowId: string): string {
  return rowId.replace(/[^a-zA-Z0-9_-]/g, '_');
}
