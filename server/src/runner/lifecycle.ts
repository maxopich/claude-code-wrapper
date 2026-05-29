// Tracks all in-flight Query objects so shutdown can close them deterministically.
// Without this, the SDK's spawned `claude` subprocesses can outlive the server
// and silently consume subscription quota.
//
// Cluster G Phase 3 (G1): the registry also carries optional descriptor metadata
// (`InFlightMeta`) so the WS `active_runs` ServerMsg can project a per-conn view
// of "what's currently spending tokens for this Cebab process". Existing callers
// that don't pass metadata stay tracked-for-shutdown but invisible to the
// active-runs surface — that lets us roll the meta in at one site at a time
// without breaking shutdown.
type Closable = { close?: () => void };

/**
 * Descriptor for an in-flight Query, surfaced via `snapshotInFlight()` so the
 * WS layer can project the wire-side `active_runs` envelope.
 *
 * `kind` discriminates the run shape so the UI can show the right icon /
 * action menu:
 *   - `'single'`: a single-agent runOneTurn (`ws/server.ts`).
 *   - `'bus-worker'`: a bus participant's per-hop `query()` (chain or
 *     orchestrator worker; the distinction with `'orchestrator'` is
 *     refined in a follow-up phase).
 *   - `'orchestrator'`: the orchestrator's own per-hop `query()` (reserved;
 *     no caller passes this kind yet — Phase 4 work).
 *
 * `sessionId` is the OPERATOR-facing id (single-agent's session.id or the
 * multi_agent_sessions.id), NOT a per-hop CLI session — the UI groups by
 * the stable run, not the underlying subprocess.
 *
 * `projectId` is optional because the auth_refresh subprocess (which also
 * uses `registerQuery`) is not a model call — passing `undefined` keeps it
 * out of the snapshot (`snapshotInFlight` filters on `meta != null`, and
 * auth_refresh doesn't pass meta at all).
 */
export type InFlightMeta = {
  sessionId: string;
  projectId?: number;
  kind: 'single' | 'bus-worker' | 'orchestrator';
  startedAt: number;
};

const inFlight = new Map<Closable, InFlightMeta | undefined>();

/**
 * Listeners notified on add/remove. The WS layer wraps this with a 200ms
 * debounce so a burst (e.g. chain switching agents) collapses into one wire
 * emit per conn — see `ws/server.ts`'s active-runs dispatcher.
 *
 * Listeners are notified `(): void` — they call `snapshotInFlight()` to read
 * current state. Keeping the API push-without-payload avoids stale views and
 * matches the existing dispatcher pattern (Cluster A `notifications`).
 */
type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (err) {
      // Listener failures must not block registry mutations — log and continue.
      console.error('[lifecycle] change-listener failed', err);
    }
  }
}

/**
 * Register a Query for shutdown tracking. When metadata is supplied, the
 * query also shows up in `snapshotInFlight()` and triggers
 * `onInFlightChange` notifications so the WS layer can re-emit
 * `active_runs`.
 *
 * The returned unregister callback removes the query from the registry and
 * fires `onInFlightChange` if the meta-carrying entry was present.
 */
export function registerQuery(q: Closable, meta?: InFlightMeta): () => void {
  inFlight.set(q, meta);
  if (meta) notify();
  return () => {
    const wasTracked = inFlight.has(q);
    const hadMeta = inFlight.get(q) != null;
    inFlight.delete(q);
    if (wasTracked && hadMeta) notify();
  };
}

/**
 * Subscribe to add/remove events. The callback is invoked AFTER the
 * registry mutation, so a synchronous `snapshotInFlight()` from within the
 * callback observes the post-mutation state.
 *
 * Returns an unsubscribe function — call on conn close to avoid leaks.
 */
export function onInFlightChange(cb: ChangeListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Snapshot of currently-registered queries that carry metadata. Order is
 * insertion (Map iteration order), so the most-recently-started run sorts
 * last — the UI's "active runs dropdown" can sort by `startedAt` if it
 * wants a different order without needing the registry to track it.
 *
 * Queries registered WITHOUT metadata (auth_refresh today) are filtered
 * out — they're tracked for shutdown but are not user-facing runs.
 */
export function snapshotInFlight(): InFlightMeta[] {
  const out: InFlightMeta[] = [];
  for (const m of inFlight.values()) if (m) out.push(m);
  return out;
}

export function closeAllQueries(): void {
  for (const q of inFlight.keys()) {
    try {
      q.close?.();
    } catch (err) {
      console.error('[lifecycle] close failed', err);
    }
  }
  inFlight.clear();
  // Best-effort: fire one final notify so any still-attached listeners
  // observe the empty registry. The shutdown path is right before
  // process exit so the listener fan-out is short-lived, but the wire
  // envelope going out is a clean "drained to 0" record.
  notify();
}

export function inFlightCount(): number {
  return inFlight.size;
}

/**
 * Test-only: reset registry + listeners between tests. Production code never
 * calls this; production lifecycle is "register on start, unregister on
 * finally, closeAllQueries on SIGTERM".
 */
export function __resetForTests(): void {
  inFlight.clear();
  listeners.clear();
}
