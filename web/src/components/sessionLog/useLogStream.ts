/**
 * Phase H: stream the merged session log from the server, page by page.
 *
 * Lifecycle:
 *   1. Mount: kick off a first chunk request at `offset=0`.
 *   2. While `hasMore`: caller can call `loadMore()` to request the next
 *      chunk (offset advances by the chunk size received).
 *   3. Subscribe to `session_log_chunk` via the App-level side channel; the
 *      reducer doesn't store rows, so we own them locally and re-render via
 *      `useState`. Stale chunks (e.g. session changed) are dropped by id.
 *   4. `revealSensitive` toggle: re-requests the WHOLE stream from offset 0
 *      with the un-redacted flag. The first chunk's `revealedSensitive` echo
 *      gates whether subsequent rows are accepted.
 *
 * No live tail subscription in v1 — the bus persistence layer doesn't emit
 * a "new log row" ServerMsg, and projecting one would be a separate task.
 * `refresh()` re-requests from offset 0 if the operator wants a fresh poll.
 */
import { useEffect, useRef, useState } from 'react';
import type { LogRow, ServerMsg, SessionLogScope } from '@cebab/shared/protocol';

const DEFAULT_PAGE = 500;

/**
 * Cluster H C3: callsite-side default for the projector branch. When a
 * caller omits `scope`, we pass undefined to `onLoadSessionLog` (which sends
 * an envelope without the field — the server defaults to multi_agent on the
 * other end). Older callers still work without changes.
 */
type LoadSessionLog = (
  sessionId: string,
  offset: number,
  limit: number,
  revealSensitive: boolean,
  scope?: SessionLogScope,
) => void;

export type LogStreamState = {
  rows: LogRow[];
  /** Total rows known to exist server-side (across the entire stream). */
  total: number;
  /** True iff the most recent chunk reported more rows past its offset. */
  hasMore: boolean;
  /** True between request-send and first chunk; for the spinner. */
  loading: boolean;
  /** True iff the server is currently honoring revealSensitive=true. */
  revealedSensitive: boolean;
  /** Last error message, if a `wrapper_error` for this session arrived. */
  error: string | null;
};

export type LogStreamHandle = LogStreamState & {
  loadMore: () => void;
  refresh: () => void;
  setRevealSensitive: (value: boolean) => void;
};

export function useLogStream(opts: {
  sessionId: string;
  pageSize?: number;
  /**
   * Cluster H C3: which server-side projector to invoke. Optional — omit
   * (or pass undefined) to keep the historical multi-agent behavior. The
   * value is round-tripped on every fetch (initial load, loadMore, refresh,
   * reveal-flip).
   */
  scope?: SessionLogScope;
  onLoadSessionLog: LoadSessionLog;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
}): LogStreamHandle {
  const { sessionId, scope } = opts;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE;

  const [state, setState] = useState<LogStreamState>({
    rows: [],
    total: 0,
    hasMore: false,
    loading: true,
    revealedSensitive: false,
    error: null,
  });
  const [reveal, setReveal] = useState(false);

  // Latest snapshot in a ref so the subscriber doesn't re-bind on every render.
  // The subscription itself is fire-and-forget per chunk; mutations flow only
  // through setState, not through this ref.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Latest props in a ref so the subscriber callback is stable.
  const onLoadRef = useRef(opts.onLoadSessionLog);
  onLoadRef.current = opts.onLoadSessionLog;

  // Reset when the target session, the reveal flag, OR the projector scope
  // changes. Cluster H C3: scope flips are rare in practice (LogsButton
  // mounts pin it for the modal's lifetime), but including it in the dep
  // array keeps a future `<LogsModal scope={…} />` toggle correct.
  useEffect(() => {
    setState({
      rows: [],
      total: 0,
      hasMore: false,
      loading: true,
      revealedSensitive: false,
      error: null,
    });
    onLoadRef.current(sessionId, 0, pageSize, reveal, scope);
  }, [sessionId, reveal, pageSize, scope]);

  useEffect(() => {
    const unsub = opts.subscribeServerMsg((msg) => {
      if (msg.type === 'session_log_chunk' && msg.sessionId === sessionId) {
        // A chunk that disagrees with our current revealSensitive flag is
        // ALWAYS dropped — even if it's the newer of two concurrent requests
        // — because the only way the server flips revealedSensitive is for
        // the operator to click Reveal sensitive, which fires our reset
        // effect above. Out-of-sync echoes (e.g. a race after a refresh)
        // arrive with the prior flag and would visually leak.
        if (msg.revealedSensitive !== reveal) return;
        setState((prev) => {
          // De-dupe: if this chunk's offset === prev.rows.length, append.
          // If it's offset 0, replace (refresh / reveal toggle landed).
          // If it's behind the cursor (e.g. a duplicate echo), ignore.
          if (msg.offset === 0) {
            return {
              rows: msg.rows,
              total: msg.total,
              hasMore: msg.hasMore,
              loading: false,
              revealedSensitive: msg.revealedSensitive,
              error: null,
            };
          }
          if (msg.offset !== prev.rows.length) {
            // Out-of-order page: drop. The next `loadMore` will re-request.
            return prev;
          }
          return {
            rows: [...prev.rows, ...msg.rows],
            total: msg.total,
            hasMore: msg.hasMore,
            loading: false,
            revealedSensitive: msg.revealedSensitive,
            error: null,
          };
        });
      } else if (msg.type === 'wrapper_error' && msg.sessionId === sessionId) {
        setState((prev) => ({ ...prev, loading: false, error: msg.message }));
      }
    });
    return unsub;
  }, [sessionId, reveal, opts.subscribeServerMsg]);

  function loadMore() {
    if (stateRef.current.loading || !stateRef.current.hasMore) return;
    setState((prev) => ({ ...prev, loading: true }));
    onLoadRef.current(sessionId, stateRef.current.rows.length, pageSize, reveal, scope);
  }

  function refresh() {
    setState((prev) => ({ ...prev, rows: [], total: 0, loading: true, error: null }));
    onLoadRef.current(sessionId, 0, pageSize, reveal, scope);
  }

  return {
    ...state,
    loadMore,
    refresh,
    setRevealSensitive: setReveal,
  };
}
