import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { ClientMsg, SearchResult, SearchScope, ServerMsg } from '@cebab/shared';
import { useModalSurface } from '../useModalSurface';
import { MIN_SEARCH_QUERY_LEN, useSessionSearch } from '../useSessionSearch';

/**
 * Cluster I Phase C4 UI (UI_Findings spec §4.2, C4-1..C4-5): cross-session
 * content search, opened by `Cmd/Ctrl+P`. Sends `search_sessions`, renders the
 * `search_results` reply (snippets redacted by the backend — containment
 * invariant C4-5), and navigates to a hit on click / Enter (C4-4).
 *
 * Scope chips (C4-2): `This project` / `All projects` (radio) + `Include
 * archived` (composes). Raw, unredacted search (C4-3) is an audited opt-in
 * gated behind a typed acknowledgment — mirrors the C2 raw-export speed bump.
 *
 * Deferred (own follow-up): the dual "jump to session by name" mode + Tab
 * toggle (spec §5 C4). This slice ships content search — the capability the
 * C4 backend enables.
 */

/** The operator must type this verbatim to arm an unredacted (raw) search. */
export const RAW_ACK_PHRASE = 'I understand';

export type SessionSearchModalProps = {
  onClose: () => void;
  send: (msg: ClientMsg) => void;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
  activeProjectId: number | null;
  /** Navigate to a hit. App switches project/session (single-agent) or the
   *  multi-agent tab (bus hits) — see App.navigateToSearchResult. */
  onNavigate: (result: SearchResult) => void;
};

export function SessionSearchModal(props: SessionSearchModalProps) {
  const { onClose, send, subscribeServerMsg, activeProjectId, onNavigate } = props;
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });

  const [scope, setScope] = useState<SearchScope>(
    activeProjectId != null ? 'this_project' : 'all_projects',
  );
  const [includeArchived, setIncludeArchived] = useState(false);
  // Raw opt-in: `rawArmed` only flips true after the typed ack lands.
  const [rawArmed, setRawArmed] = useState(false);
  const [rawGateOpen, setRawGateOpen] = useState(false);
  const [rawAck, setRawAck] = useState('');
  const [selected, setSelected] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { query, setQuery, results, truncated, raw, loading } = useSessionSearch({
    send,
    subscribeServerMsg,
    scope,
    projectId: activeProjectId ?? undefined,
    includeArchived,
    raw: rawArmed,
  });

  // Keep the highlighted row in range as results churn.
  useEffect(() => {
    setSelected((s) => (results.length === 0 ? 0 : Math.min(s, results.length - 1)));
  }, [results]);

  function navigate(r: SearchResult | undefined): void {
    if (!r) return;
    onNavigate(r);
    onClose();
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(0, results.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      navigate(results[selected]);
    }
  }

  const tooShort = query.trim().length < MIN_SEARCH_QUERY_LEN;
  const titleId = 'session-search-title';

  return (
    <div
      ref={overlayRef}
      className="session-search-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="session-search-modal modal-surface">
        <h2 id={titleId} className="sr-only">
          Search sessions
        </h2>

        <div className="session-search-header">
          <input
            ref={inputRef}
            className="session-search-input"
            type="search"
            placeholder="Search session content…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="session-search-results"
            aria-label="Search session content"
          />
        </div>

        <div className="session-search-scopes" role="group" aria-label="Search scope">
          <button
            type="button"
            className={`session-search-chip${scope === 'this_project' ? ' on' : ''}`}
            aria-pressed={scope === 'this_project'}
            disabled={activeProjectId == null}
            title={activeProjectId == null ? 'No project is open' : undefined}
            onClick={() => setScope('this_project')}
          >
            This project
          </button>
          <button
            type="button"
            className={`session-search-chip${scope === 'all_projects' ? ' on' : ''}`}
            aria-pressed={scope === 'all_projects'}
            onClick={() => setScope('all_projects')}
          >
            All projects
          </button>
          <label className="session-search-archived">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Include archived
          </label>
        </div>

        <div className="session-search-raw">
          {rawArmed ? (
            <div className="session-search-raw-armed">
              <span className="session-search-raw-pill">RAW</span>
              {/* The server downgrades a raw request to redacted when its
                  audit write fails (BE-1). Reflect the ACTUAL state (`raw`
                  from the hook) once a reply has landed, not just the intent. */}
              {!raw && !loading && results.length > 0 ? (
                <span className="session-search-raw-downgrade">
                  Raw search was refused (audit unavailable) — showing redacted snippets.
                </span>
              ) : (
                <span>Showing unredacted snippets — this search is audited.</span>
              )}
              <button
                type="button"
                className="session-search-raw-link"
                onClick={() => {
                  setRawArmed(false);
                  setRawAck('');
                }}
              >
                Back to redacted
              </button>
            </div>
          ) : rawGateOpen ? (
            <div className="session-search-raw-gate">
              <p className="session-search-raw-warn">
                Unredacted search returns secrets that are normally masked, and writes a
                safety-audit row. Type <code>{RAW_ACK_PHRASE}</code> to enable.
              </p>
              <div className="session-search-raw-row">
                <input
                  className="session-search-raw-ack"
                  type="text"
                  value={rawAck}
                  onChange={(e) => setRawAck(e.target.value)}
                  placeholder={RAW_ACK_PHRASE}
                  aria-label="Type the acknowledgment phrase to enable raw search"
                />
                <button
                  type="button"
                  className="session-search-raw-confirm"
                  disabled={rawAck !== RAW_ACK_PHRASE}
                  onClick={() => {
                    setRawArmed(true);
                    setRawGateOpen(false);
                  }}
                >
                  Enable raw search
                </button>
                <button
                  type="button"
                  className="session-search-raw-link"
                  onClick={() => {
                    setRawGateOpen(false);
                    setRawAck('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="session-search-raw-link"
              onClick={() => setRawGateOpen(true)}
            >
              Search unredacted content…
            </button>
          )}
        </div>

        <div className="session-search-results" id="session-search-results" role="listbox">
          {tooShort ? (
            <p className="session-search-hint">
              Type at least {MIN_SEARCH_QUERY_LEN} characters to search across sessions.
            </p>
          ) : loading && results.length === 0 ? (
            <p className="session-search-hint">Searching…</p>
          ) : results.length === 0 ? (
            <p className="session-search-hint">No matches.</p>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.matchedField}:${r.sessionId}:${r.ts}:${i}`}
                type="button"
                role="option"
                aria-selected={i === selected}
                className={`session-search-result${i === selected ? ' selected' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => navigate(r)}
              >
                <span className="session-search-result-snippet">
                  {highlightSnippet(r.snippet, query.trim())}
                </span>
                <span className="session-search-result-meta">
                  <span className="session-search-result-loc">{locationLabel(r)}</span>
                  {r.redactedFields && r.redactedFields.length > 0 ? (
                    <span
                      className="session-search-redacted-badge"
                      title="This entry contained redacted content"
                    >
                      redacted
                    </span>
                  ) : null}
                  <span className="session-search-result-time">{formatRelative(r.ts)}</span>
                </span>
              </button>
            ))
          )}

          {truncated ? (
            <p className="session-search-truncated">
              Showing the first matches — narrow your scope or refine the query.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Human label for a hit's origin: project name (single-agent) or a bus tag. */
function locationLabel(r: SearchResult): string {
  const where =
    r.projectName ?? (r.matchedField === 'multi_agent_events.text' ? 'Bus session' : 'Session');
  const shortId = r.sessionId.slice(0, 8);
  const kind = r.matchedKind ? ` · ${r.matchedKind}` : '';
  return `${where} · ${shortId}${kind}`;
}

/**
 * Wrap case-insensitive occurrences of `query` in the (already-redacted)
 * snippet with `<mark>`. The snippet is server-redacted, so this only ever
 * highlights non-sensitive text. Falls back to the plain string when the
 * query isn't literally present (e.g. the match was reflowed by the window).
 */
function highlightSnippet(snippet: string, query: string): React.ReactNode {
  if (query.length === 0) return snippet;
  const lower = snippet.toLowerCase();
  const q = query.toLowerCase();
  if (lower.indexOf(q) < 0) return snippet;
  // Keys are derived from the slice offsets (strictly increasing), so they're
  // unique without a mutable counter.
  const parts: React.ReactNode[] = [];
  let from = 0;
  let idx = lower.indexOf(q, from);
  while (idx >= 0) {
    if (idx > from) parts.push(<Fragment key={`t${from}`}>{snippet.slice(from, idx)}</Fragment>);
    parts.push(<mark key={`m${idx}`}>{snippet.slice(idx, idx + query.length)}</mark>);
    from = idx + query.length;
    idx = lower.indexOf(q, from);
  }
  if (from < snippet.length)
    parts.push(<Fragment key={`t${from}`}>{snippet.slice(from)}</Fragment>);
  return parts;
}

/** Compact relative time — mirrors ProjectList's `formatRelative` style. */
function formatRelative(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${Math.max(0, sec)}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}
