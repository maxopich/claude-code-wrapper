import { useEffect, useRef, useState } from 'react';
import type { ClientMsg, SearchResult, SearchScope, ServerMsg } from '@cebab/shared';

/**
 * Cluster I Phase C4 UI (UI_Findings spec §4.2): the data hook behind
 * `SessionSearchModal`. Owns the debounced query, dispatches `search_sessions`,
 * and consumes `search_results` over the WS side-channel (NOT the main store
 * reducer — search results are modal-local + query-versioned, same posture as
 * `useLogStream`'s `session_log_chunk` consumption).
 *
 * Stale-reply discard. The protocol has no request id, so we version by the
 * echoed `(query, scope)`. A reply whose echo doesn't match the most recent
 * dispatch is for a superseded keystroke and is dropped — the operator may
 * have typed past it. We deliberately do NOT key on `raw`: the server may
 * DOWNGRADE a `raw: true` request to redacted (when its audit write fails),
 * replying `raw: false` — keying on raw would discard that legitimate reply
 * and show nothing. The server never escalates (a redacted request can't come
 * back raw), so `(query, scope)` is a sufficient version key, and the exposed
 * `raw` lets the UI reflect the actual (possibly downgraded) redaction state.
 * (`includeArchived`/`projectId` aren't echoed; the latest dispatch pins them.)
 *
 * `send` / `subscribeServerMsg` are mirrored in refs so an unstable parent
 * closure (App re-renders with a fresh `(m) => wsRef.current?.send(m)` each
 * tick) doesn't reset the debounce timer or churn the subscription.
 */

export type UseSessionSearchOpts = {
  send: (msg: ClientMsg) => void;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
  scope: SearchScope;
  /** Names the project for `scope: 'this_project'`; ignored otherwise. */
  projectId?: number;
  includeArchived: boolean;
  /** When true, request unredacted snippets (the audited opt-in path). */
  raw: boolean;
  /** Debounce window in ms; overridable for tests. */
  debounceMs?: number;
};

export type SessionSearchState = {
  query: string;
  setQuery: (q: string) => void;
  results: SearchResult[];
  truncated: boolean;
  /** Whether the CURRENTLY shown results are unredacted (echoed by server —
   *  may be false even when `raw` was requested, if the server downgraded). */
  raw: boolean;
  loading: boolean;
};

/** Debounce before firing a scan — matches a comfortable type-pause. */
export const SEARCH_DEBOUNCE_MS = 180;
/** Mirror the server's `MIN_SEARCH_QUERY_LEN`: sub-2-char queries don't scan. */
export const MIN_SEARCH_QUERY_LEN = 2;

export function useSessionSearch(opts: UseSessionSearchOpts): SessionSearchState {
  const { scope, projectId, includeArchived, raw } = opts;
  const debounceMs = opts.debounceMs ?? SEARCH_DEBOUNCE_MS;

  const sendRef = useRef(opts.send);
  sendRef.current = opts.send;
  const subscribeRef = useRef(opts.subscribeServerMsg);
  subscribeRef.current = opts.subscribeServerMsg;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [resultsRaw, setResultsRaw] = useState(false);
  const [loading, setLoading] = useState(false);

  // The (query, scope) of the most recent dispatch — the version key the
  // subscriber matches replies against. null while the query is too short.
  // NOT keyed on `raw` (see module header: the server may downgrade raw→
  // redacted, and we must accept that reply rather than discard it).
  const expectedRef = useRef<{ query: string; scope: SearchScope } | null>(null);

  // Subscribe once. The closure reads the live refs, so it never goes stale.
  useEffect(() => {
    const unsub = subscribeRef.current((msg) => {
      if (msg.type !== 'search_results') return;
      const exp = expectedRef.current;
      if (!exp) return;
      if (msg.query !== exp.query || msg.scope !== exp.scope) return;
      setResults(msg.results);
      setTruncated(msg.truncated);
      setResultsRaw(msg.raw);
      setLoading(false);
    });
    return unsub;
  }, []);

  // Debounced dispatch on any input change.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_SEARCH_QUERY_LEN) {
      expectedRef.current = null;
      setResults([]);
      setTruncated(false);
      setResultsRaw(false);
      setLoading(false);
      return;
    }
    const handle = setTimeout(() => {
      expectedRef.current = { query: trimmed, scope };
      setLoading(true);
      const msg: ClientMsg = {
        type: 'search_sessions',
        query: trimmed,
        scope,
        includeArchived,
        raw,
        ...(scope === 'this_project' && projectId !== undefined ? { projectId } : {}),
      };
      sendRef.current(msg);
    }, debounceMs);
    return () => clearTimeout(handle);
  }, [query, scope, projectId, includeArchived, raw, debounceMs]);

  return { query, setQuery, results, truncated, raw: resultsRaw, loading };
}
