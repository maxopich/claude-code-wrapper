/**
 * Phase H: filter chips + action toolbar for the Logs modal.
 *
 * Layout:
 *   [search] [agent ▾] [kind ▾]    [refresh] [download] [reveal-sensitive]
 *
 * Multi-select dropdowns are rendered as inline checkbox panels — kept
 * simple to avoid pulling a popover lib. The "reveal sensitive" button is
 * deliberately styled as a danger action; the click handler in the modal
 * pops a `window.confirm` before flipping the server-side flag.
 */
import { LOG_ROW_KINDS, type LogRowKind } from '@cebab/shared/protocol';
import type { LogFiltersHandle } from './useLogFilters';

const KIND_LABELS: Record<LogRowKind, string> = {
  tool: 'tool',
  bus: 'bus',
  llm: 'llm',
  error: 'error',
  artifact: 'artifact',
};

export function LogToolbar(props: {
  filters: LogFiltersHandle;
  agents: readonly string[];
  revealedSensitive: boolean;
  loading: boolean;
  onRevealSensitive: () => void;
  onRefresh: () => void;
  onDownload: () => void;
}) {
  const { filters } = props;
  const hasFilter = filters.search.length > 0 || filters.agents.size > 0 || filters.kinds.size > 0;
  return (
    <div className="logs-toolbar" role="toolbar" aria-label="Log filters and actions">
      <input
        type="search"
        className="logs-search"
        placeholder="Search summary, agent, raw…"
        value={filters.search}
        onChange={(e) => filters.setSearch(e.target.value)}
        aria-label="Search log rows"
      />

      <details className="logs-filter-dropdown">
        <summary className="logs-filter-summary">
          Agents
          {filters.agents.size > 0 && (
            <span className="logs-filter-count">{filters.agents.size}</span>
          )}
        </summary>
        <div className="logs-filter-panel" role="group" aria-label="Filter by agent">
          {props.agents.length === 0 ? (
            <p className="logs-filter-empty">No agents yet.</p>
          ) : (
            props.agents.map((a) => (
              <label key={a} className="logs-filter-option">
                <input
                  type="checkbox"
                  checked={filters.agents.has(a)}
                  onChange={() => filters.toggleAgent(a)}
                />
                <span>{a}</span>
              </label>
            ))
          )}
        </div>
      </details>

      <details className="logs-filter-dropdown">
        <summary className="logs-filter-summary">
          Kinds
          {filters.kinds.size > 0 && (
            <span className="logs-filter-count">{filters.kinds.size}</span>
          )}
        </summary>
        <div className="logs-filter-panel" role="group" aria-label="Filter by kind">
          {[...LOG_ROW_KINDS].map((k) => (
            <label key={k} className="logs-filter-option">
              <input
                type="checkbox"
                checked={filters.kinds.has(k)}
                onChange={() => filters.toggleKind(k)}
              />
              <span>{KIND_LABELS[k]}</span>
            </label>
          ))}
        </div>
      </details>

      {hasFilter && (
        <button
          type="button"
          className="ghost-btn logs-clear-filters"
          onClick={filters.reset}
          title="Clear all filters"
        >
          Clear
        </button>
      )}

      <span className="logs-toolbar-spacer" />

      <button
        type="button"
        className="ghost-btn"
        onClick={props.onRefresh}
        disabled={props.loading}
        title="Re-fetch the log from offset 0"
      >
        {props.loading ? 'Loading…' : 'Refresh'}
      </button>
      <button
        type="button"
        className="ghost-btn"
        onClick={props.onDownload}
        title="Download the filtered view as NDJSON (one JSON object per line)"
      >
        Download .ndjson
      </button>
      <button
        type="button"
        className={`ghost-btn logs-reveal-btn${props.revealedSensitive ? ' is-revealed' : ''}`}
        onClick={props.onRevealSensitive}
        title={
          props.revealedSensitive
            ? 'Re-mask sensitive fields (requires a re-fetch)'
            : 'Un-mask sensitive fields. You will be asked to confirm.'
        }
      >
        {props.revealedSensitive ? 'Re-mask sensitive' : 'Reveal sensitive…'}
      </button>
    </div>
  );
}
