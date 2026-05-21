/**
 * Phase H: inline detail drawer for a single log row.
 *
 * Shows pretty-printed JSON of the (already server-redacted) `raw` payload,
 * the list of fields the server masked, and a Copy line / Copy raw action
 * pair. The "Reveal sensitive" action lives in the toolbar (global toggle)
 * not per-row — per-row reveal would require per-row server round-trips,
 * which is more complex than v1 needs.
 */
import type { LogRow } from '@cebab/shared/protocol';

export function LogRowDetail(props: { row: LogRow }) {
  const { row } = props;
  return (
    <div className="logs-row-detail">
      <header className="logs-row-detail-header">
        <span className="logs-row-detail-label">Detail</span>
        <div className="logs-row-detail-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => copyText(formatLine(row))}
            title="Copy this row as a single tab-separated line"
          >
            Copy line
          </button>
          {row.raw !== undefined && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => copyText(JSON.stringify(row.raw, null, 2))}
              title="Copy the pretty-printed JSON payload"
            >
              Copy raw
            </button>
          )}
        </div>
      </header>

      <dl className="logs-row-detail-meta">
        <dt>id</dt>
        <dd>
          <code>{row.id}</code>
        </dd>
        <dt>ts</dt>
        <dd>{new Date(row.ts).toISOString()}</dd>
        <dt>agent</dt>
        <dd>{row.agent}</dd>
        <dt>kind</dt>
        <dd>{row.kind}</dd>
        {row.status && (
          <>
            <dt>status</dt>
            <dd>{row.status}</dd>
          </>
        )}
        {row.durationMs !== undefined && (
          <>
            <dt>duration</dt>
            <dd>{formatDuration(row.durationMs)}</dd>
          </>
        )}
        {row.laneRowId !== undefined && (
          <>
            <dt>lane row</dt>
            <dd>
              <a href={`#lane-row-${row.laneRowId}`}>#{row.laneRowId}</a>
            </dd>
          </>
        )}
        {row.artifactId !== undefined && (
          <>
            <dt>artifact</dt>
            <dd>
              <a href={`#artifact-${row.artifactId}`}>#{row.artifactId}</a>
            </dd>
          </>
        )}
      </dl>

      {row.redactedFields && row.redactedFields.length > 0 && (
        <p className="logs-row-detail-redacted">
          <strong>Redacted fields:</strong> <code>{row.redactedFields.join(', ')}</code>
          {' — '}use the toolbar's <em>Reveal sensitive</em> button to un-mask.
        </p>
      )}

      {row.raw !== undefined && (
        <pre className="logs-row-detail-raw" tabIndex={0}>
          <code>{JSON.stringify(row.raw, null, 2)}</code>
        </pre>
      )}
    </div>
  );
}

function formatLine(row: LogRow): string {
  return [new Date(row.ts).toISOString(), row.kind, row.agent, row.status ?? '', row.summary].join(
    '\t',
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function copyText(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => {
    // Clipboard API can fail silently in some contexts (insecure origin,
    // permissions). The operator can still select + copy manually.
  });
}
