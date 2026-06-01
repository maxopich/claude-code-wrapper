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
            <dt>scrollback</dt>
            <dd>
              <a href={`#ev-${row.laneRowId}`} title="Jump to this hop in the scrollback">
                ↗ event #{row.laneRowId}
              </a>
            </dd>
          </>
        )}
        {/* TODO(artifacts-anchor): re-add an artifact link when ArtifactsView
            exposes stable per-mutation anchors. The projection carries
            artifactId (= mutation id) but the artifacts list keys by
            filePath, so a #artifact-N href has nothing to resolve against.
            Dropping the link is better than rendering a dead one. */}
      </dl>

      {row.redactedFields && row.redactedFields.length > 0 && (
        <p className="logs-row-detail-redacted">
          <strong>Redacted fields:</strong> <code>{row.redactedFields.join(', ')}</code>
          {' — '}use the toolbar's <em>Reveal sensitive</em> button to un-mask.
        </p>
      )}

      {(() => {
        // Migration 026: dedicated, readable Tool input / Tool output sections
        // for bus tool rows. The same values live inside `row.raw` (and the
        // JSON dump below), but surfacing the command + output as labeled
        // blocks is the point of "review the full log". Guarded so non-tool
        // rows and pre-026 rows render exactly as before.
        const raw = row.raw;
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, unknown>;
        const hasInput = r.toolInput !== undefined && r.toolInput !== null;
        const hasResult = r.toolResult !== undefined && r.toolResult !== null;
        if (!hasInput && !hasResult) return null;
        return (
          <>
            {hasInput && (
              <section className="logs-row-detail-io">
                <span className="logs-row-detail-label">Tool input</span>
                <pre className="logs-row-detail-raw" tabIndex={0}>
                  <code>{renderToolIo(r.toolInput)}</code>
                </pre>
              </section>
            )}
            {hasResult && (
              <section className="logs-row-detail-io">
                <span className="logs-row-detail-label">Tool output</span>
                <pre className="logs-row-detail-raw" tabIndex={0}>
                  <code>{renderToolIo(r.toolResult)}</code>
                </pre>
              </section>
            )}
          </>
        );
      })()}

      {row.raw !== undefined && (
        <pre className="logs-row-detail-raw" tabIndex={0}>
          <code>{JSON.stringify(row.raw, null, 2)}</code>
        </pre>
      )}
    </div>
  );
}

/**
 * Render a captured tool input/output value for the detail drawer. Server-
 * capped values arrive as `{ truncated, bytes, preview }` (see capToolIoJson)
 * — surface the note + preview rather than a confusing object dump. Strings
 * render verbatim; everything else pretty-prints.
 */
function renderToolIo(value: unknown): string {
  if (value && typeof value === 'object' && (value as Record<string, unknown>).truncated === true) {
    const v = value as { bytes?: number; preview?: string };
    return `[truncated — ${v.bytes ?? '?'} bytes total; first 8 KB shown]\n\n${v.preview ?? ''}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
