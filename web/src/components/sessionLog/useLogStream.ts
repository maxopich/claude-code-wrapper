/**
 * Phase H: stream the merged session log from the server, page by page,
 * with a live tail signal layered on top (Cluster H D12).
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
 *   5. **Cluster H D12 client (tail-mode)**: the same subscriber also handles
 *      `log_row_appended` envelopes — append a single LogRow on the live edge
 *      without re-fetching a chunk. Dedup by `row.id` so a tail event that
 *      raced an in-flight `loadMore()` doesn't double-append. Tail rows are
 *      ALWAYS server-masked (`revealSensitive: false`); while the consumer's
 *      `reveal` flag is on, tail events are dropped so the un-mask view
 *      cannot silently re-mask itself one row at a time.
 *
 * Agentic-safety AC (D12 client): an unbounded tail subscription on a busy
 * bus run can blow the heap. The `tailSafetyCap` opt is a hard ceiling on
 * how many tail rows may accumulate between `refresh()` calls — once tripped,
 * further `log_row_appended` events are dropped and `tailSafetyTripped`
 * flips so the UI can surface a "live feed paused — refresh" notice. The
 * cap is per-mount and resets on `refresh()` (which re-fetches from offset 0
 * and re-arms the tail).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogRow, ServerMsg, SessionLogScope } from '@cebab/shared/protocol';

const DEFAULT_PAGE = 500;

/**
 * Cluster H D12 client default cap. Holds ~ a single multi-agent run's worth
 * of bus hops + classified mutations without blowing the heap; a long-running
 * operator-watched feed that exceeds this almost certainly wants to take a
 * snapshot via Refresh (which resets the counter) rather than scroll back N
 * thousand rows. Override via `tailSafetyCap`.
 */
const DEFAULT_TAIL_SAFETY_CAP = 2000;

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
  /**
   * Cluster H D12 client: count of rows appended via the live `log_row_appended`
   * tail signal since the last `refresh()`. Distinct from `total - initialTotal`
   * because dedup against in-flight chunk pages can suppress an append.
   *
   * Surfaces in the toolbar/banner so the operator sees the live edge growing
   * even when the scroll position hasn't moved. Zeroes on every refresh.
   */
  tailAppendedCount: number;
  /**
   * Cluster H D12 client agentic-safety: true once the tail-rows counter has
   * met `tailSafetyCap`. Further `log_row_appended` envelopes for this session
   * are dropped. Clears on `refresh()`.
   *
   * The UI can render a "live feed paused — Refresh to resume" notice on this
   * flag without doing its own row counting.
   */
  tailSafetyTripped: boolean;
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
  /**
   * Cluster H D12 client: hard ceiling on rows appended via the live
   * `log_row_appended` tail. Defaults to `DEFAULT_TAIL_SAFETY_CAP`. Set to
   * `0` to disable tail-mode entirely (the subscriber still installs but
   * every envelope counts as "would have appended" → safety trips on the
   * first row, effectively a no-op tail). The cap resets on `refresh()`.
   */
  tailSafetyCap?: number;
  onLoadSessionLog: LoadSessionLog;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
}): LogStreamHandle {
  const { sessionId, scope } = opts;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE;
  const tailSafetyCap = opts.tailSafetyCap ?? DEFAULT_TAIL_SAFETY_CAP;

  const [state, setState] = useState<LogStreamState>({
    rows: [],
    total: 0,
    hasMore: false,
    loading: true,
    revealedSensitive: false,
    error: null,
    tailAppendedCount: 0,
    tailSafetyTripped: false,
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

  // Cluster H D12 client: the consumer's scope, normalized so the
  // tail-envelope filter can match `undefined` (default) against the
  // server-side `'multi_agent'`. Memoized to keep the subscriber stable.
  const expectedTailScope: SessionLogScope = useMemo(() => scope ?? 'multi_agent', [scope]);

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
      tailAppendedCount: 0,
      tailSafetyTripped: false,
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
              ...prev,
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
            ...prev,
            rows: [...prev.rows, ...msg.rows],
            total: msg.total,
            hasMore: msg.hasMore,
            loading: false,
            revealedSensitive: msg.revealedSensitive,
            error: null,
          };
        });
      } else if (msg.type === 'log_row_appended' && msg.sessionId === sessionId) {
        // Cluster H D12 client: tail signal. Filter by scope so a single-
        // agent inspector ignores multi_agent envelopes for the same id and
        // vice versa. The server always emits `revealSensitive: false`, so
        // while the consumer is in Reveal mode we drop tail events — the
        // un-masked view would otherwise silently re-mask itself one row at
        // a time. Re-issue `load_session_log` to refresh while revealed.
        if (msg.scope !== expectedTailScope) return;
        if (reveal) return;
        setState((prev) => {
          // Safety cap: stop appending once the per-refresh quota is met.
          // The flag stays true until refresh() resets it.
          if (prev.tailSafetyTripped) return prev;
          if (prev.tailAppendedCount >= tailSafetyCap) {
            return { ...prev, tailSafetyTripped: true };
          }
          // Dedup vs in-flight chunk pages: an `appended` envelope can race
          // a paginated `session_log_chunk` that already included the row.
          // The projector's `LogRow.id` is unique (`event:N` / `mutation:N`),
          // so a linear scan is fine for D12-cap-sized arrays.
          for (const existing of prev.rows) {
            if (existing.id === msg.row.id) return prev;
          }
          return {
            ...prev,
            rows: [...prev.rows, msg.row],
            total: prev.total + 1,
            tailAppendedCount: prev.tailAppendedCount + 1,
          };
        });
      } else if (msg.type === 'wrapper_error' && msg.sessionId === sessionId) {
        setState((prev) => ({ ...prev, loading: false, error: msg.message }));
      }
    });
    return unsub;
  }, [sessionId, reveal, expectedTailScope, tailSafetyCap, opts.subscribeServerMsg]);

  function loadMore() {
    if (stateRef.current.loading || !stateRef.current.hasMore) return;
    setState((prev) => ({ ...prev, loading: true }));
    onLoadRef.current(sessionId, stateRef.current.rows.length, pageSize, reveal, scope);
  }

  function refresh() {
    // Cluster H D12 client: refresh also re-arms the tail. The safety
    // counter resets and the dropped-since-trip envelopes are gone forever —
    // the server-side `multi_agent_events` / `multi_agent_mutations` rows
    // they referenced come back via the initial chunk fetch below.
    setState((prev) => ({
      ...prev,
      rows: [],
      total: 0,
      loading: true,
      error: null,
      tailAppendedCount: 0,
      tailSafetyTripped: false,
    }));
    onLoadRef.current(sessionId, 0, pageSize, reveal, scope);
  }

  return {
    ...state,
    loadMore,
    refresh,
    setRevealSensitive: setReveal,
  };
}
