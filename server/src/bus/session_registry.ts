/**
 * Process-level registry of LIVE in-process multi-agent sessions.
 *
 * The tmux bus kept agent state OUTSIDE Cebab (tmux survived restarts), so
 * resume rebuilt a router by reading tmux. The pure-SDK bus keeps agent state
 * IN this process (the `AgentRunner` + router closures). So:
 *
 *   - browser close / refresh / second window  → the session must survive,
 *     and a reconnect re-attaches by swapping the WS sink (`rebind`). No
 *     respawn, no DB rebuild — the live objects are right here.
 *   - Cebab server restart                      → this map is empty (process
 *     died). Nothing to re-attach to here. An *orchestrated* run is then
 *     rebuilt from persisted state by `reconstruct.ts` and re-registered
 *     READ-ONLY (R-B); a chain run (reconstruction deferred) is marked
 *     `crashed` (the old R-A behavior). Single-agent resume is a different
 *     path and is unaffected either way.
 *
 * This is the in-process analogue of `tmux has-session`.
 */
import type { BusEvent } from './runner.js';
import type { MultiAgentEndedReason } from './runtime.js';
import type { MultiAgentLifecycle, MutationRecord } from '../repo/multi_agent.js';
import type {
  NotificationEnvelope,
  PendingRetryDescriptor,
  RouterDropReasonCode,
  ServerMsg,
} from '@cebab/shared/protocol';

/** The WS-facing sink. Swapped on reconnect, silenced on detach. Identical
 *  shape to the old `StartChainOpts.onEvent/onEnded` so the WS layer and the
 *  resume dispatcher need no signature changes.
 *
 *  Optional callbacks (`onPendingRetry`, `onMutation`, `onPendingMutation`)
 *  let test sinks and pre-feature callers stay slim — the routers always
 *  null-check before invoking. */
export type BusSink = {
  onEvent: (sessionId: string, ev: BusEvent, dbEventId: number) => void;
  onEnded: (sessionId: string, reason: MultiAgentEndedReason, iterationId: string | null) => void;
  onPendingRetry?: (sessionId: string, pending: PendingRetryDescriptor | null) => void;
  /** Item #5: a new mutation row appended to `multi_agent_mutations`. Live
   *  forwarding for the Session-info disclosure + activity-bar counter. */
  onMutation?: (sessionId: string, mutation: MutationRecord) => void;
  /** Item #5: the set of workers halted by the pause-on-dangerous gate changed.
   *  Carries the whole current set (`[]` when nothing is waiting) — the gate is
   *  per-agent, so several workers can be halted at once (migration 031). */
  onPendingMutation?: (sessionId: string, pending: MutationRecord[]) => void;
  /**
   * Cluster A Phase 3 (D4): the dispatcher's notification envelope for a
   * router-drop safety event (or a future operational toast originating from
   * the bus runtime). Called AFTER the `safety_audit` row is written
   * (dispatcher.emit enforces BE-1). The WS layer wires this to
   * `send(conn.ws, env)`; reconnect swaps the callback alongside `onEvent`
   * so a re-attached browser keeps receiving live envelopes.
   */
  sendNotification?: (env: NotificationEnvelope & { type: 'notification' }) => void;
  /**
   * Cluster A Phase 3 (D4): typed `router_drop` ServerMsg for future
   * non-toast consumers (Cluster B per-agent routing-trail counter, D4
   * inspector). Optional today — the operator dock is driven by
   * `sendNotification` above; this is forward-compat.
   */
  sendRouterDrop?: (drop: {
    sessionId: string;
    reasonCode: RouterDropReasonCode;
    source: string;
    destination: string;
    kind: string;
    auditRowId: string;
  }) => void;
  /**
   * Cluster A Phase 4: generic ServerMsg sender for new typed events
   * (`session_superseded`, `chain_not_reconstructed`, `bus_auto_installed`,
   * dangerous-mutation safety notifications) and for direct dispatcher.emit
   * fan-out. Subsumes the narrower Phase 3 typed callbacks for new sites;
   * the existing `sendNotification` / `sendRouterDrop` callbacks above stay
   * to preserve the wire shape Phase 3 tests assert.
   */
  sendServerMsg?: (msg: ServerMsg) => void;
};

/** A sink that drops everything — installed by `detach()` so a still-running
 *  session keeps persisting/routing but stops forwarding to a dead WS. */
export const NOOP_SINK: BusSink = {
  onEvent: () => {},
  onEnded: () => {},
  onPendingRetry: () => {},
  onMutation: () => {},
  onPendingMutation: () => {},
  sendNotification: () => {},
  sendRouterDrop: () => {},
  sendServerMsg: () => {},
};

/**
 * The handle surface both Chain and Orchestrator handles satisfy. Stored in
 * the registry so a reconnect returns the ORIGINAL authoritative handle
 * (real `stop`/`detach`, real `iterationId`) with only its WS sink swapped.
 * Declared here (not imported from chain/orchestrator) to avoid a type cycle.
 */
export type BusSessionHandle = {
  sessionId: string;
  iterationId: string;
  participantAgentNames: string[];
  lifecycle: MultiAgentLifecycle;
  sessionFolder: string;
  stop: (reason: MultiAgentEndedReason) => Promise<void>;
  /**
   * Silence the WS sink without tearing the session down.
   *
   * Register B01: pass the `sinkEpoch` you were handed by `rebind` and the
   * detach is IGNORED unless you still own the sink. Two browser windows on
   * one session used to be a trap — window B re-attaches (rebind), then
   * window A's close fires `detach()` and blanks B's live stream, including
   * `multi_agent_ended`, while B's UI still shows an active run.
   *
   * Calling it with NO epoch silences unconditionally, which is what a
   * deliberate switch-away wants (`executeReopenSessionConfirmed`). Only the
   * WS-close path should pass an epoch.
   */
  detach: (sinkEpoch?: number) => void;
  /**
   * Re-deliver the captured prompt of the worker named in this session's
   * persisted pending-retry slot. No-op when the slot is empty (idempotent
   * — a racing second click sees the cleared slot). Implemented by both
   * chain and orchestrator handles via the shared `setPendingRetry(null)
   * → deliver` flow; the slot is cleared FIRST so a re-fail can re-assert
   * a fresh descriptor.
   */
  retry: () => Promise<void>;
  /**
   * Item #5: operator clicked Continue on one pause-on-dangerous banner.
   * Moves that mutation from `pending` to `approved` — the one-shot grant the
   * replayed turn spends — and re-delivers the paused worker's last captured
   * prompt. The gate re-arms: every later dangerous command pauses again.
   * No-op when `mutationId` isn't currently pending (idempotent).
   */
  continueThroughMutation: (mutationId: number) => Promise<void>;
};

export type LiveBusSession = {
  sessionId: string;
  mode: 'chain' | 'orchestrator';
  handle: BusSessionHandle;
  /**
   * Swap the live WS sink (reconnect). Returns the new **sink epoch** — a
   * monotonic per-session counter identifying who owns the sink right now.
   * Hand it back to `handle.detach(epoch)` so a stale window's close can't
   * silence a newer window's stream (register B01).
   */
  rebind: (sink: BusSink) => number;
  /**
   * Register B17: send a ServerMsg to whoever owns this session's sink **right
   * now**, resolved at call time rather than captured by the caller.
   *
   * The pause-expiry registry is a process singleton whose timers are cleared
   * on session end, not on connection close — so a timer armed by one browser
   * window routinely fires after that window is gone. Its callback used to
   * `send(conn.ws, …)` into the closed socket while the DB and audit writes
   * landed anyway, which is how an auto-kick could be durably recorded and
   * never shown to the operator still watching from another window.
   *
   * Delegates to the router the same way `rebind` does, so it reads the
   * router's live `sink` variable. That matters: a copy held here would keep
   * sending after `detach()` swapped the router's sink for `NOOP_SINK`,
   * un-silencing a session the operator deliberately detached.
   */
  sendServerMsg: (msg: ServerMsg) => void;
};

const live = new Map<string, LiveBusSession>();

export function registerLiveSession(s: LiveBusSession): void {
  live.set(s.sessionId, s);
}

export function getLiveSession(sessionId: string): LiveBusSession | undefined {
  return live.get(sessionId);
}

export function unregisterLiveSession(sessionId: string): void {
  live.delete(sessionId);
}

export function hasLiveSession(sessionId: string): boolean {
  return live.has(sessionId);
}

/**
 * Every session still live in THIS process, in registration order.
 *
 * Register B02: `start_multi_agent` guards on this, not just on the starting
 * connection's own `conn.multiAgent`. The per-connection guard let two browser
 * windows each start a session; both then stayed live, and the next resume
 * sweep reported the older one `crashed` while its agents kept taking turns.
 *
 * Rows left `running` by a dead process are NOT in here (the map is
 * process-local and empty after a restart), so a stale DB row can never block
 * a new session — only a genuinely live one can.
 */
export function listLiveSessionIds(): string[] {
  return [...live.keys()];
}

/**
 * Register B18: the gap between "no session is live" and "a session is live".
 *
 * `registerLiveSession` is called from inside `startOrchestratorSession` /
 * `startChainSession`, and the WS handler awaits `gateProjectsForSpawn` before
 * either of those — a gate that parks until the OPERATOR answers a trust
 * prompt. So `listLiveSessionIds()` stays empty for as long as a human takes
 * to click, and two browser windows can both pass the process-wide check and
 * both start. The register's consequence is the bad half: the next connect's
 * resume sweep reports one of them `crashed` while its AgentRunner keeps
 * delivering turns, leaving agents running with no session the UI can stop.
 *
 * The claim closes that window. It lives here rather than in the WS layer
 * because "is a session being started right now" is the same question this
 * module already answers for "is one running", and because the answer must be
 * process-wide, not per connection.
 *
 * Deliberately NOT folded into `listLiveSessionIds()`: a claim token is not a
 * session id, and that list feeds an operator-facing message that names ids.
 *
 * The owner token is the claiming connection's, and `ws.on('close')` releases
 * it. That is the property that matters — the WS message dispatch wraps only
 * `JSON.parse` in a try, so a rejection between the claim and registration
 * would skip an explicit release and wedge every future start until restart.
 * A claim that cannot outlive its connection cannot fail that way.
 */
const startClaims = new Set<string>();

/** Returns false when a session is already live or another start is in
 *  flight; the caller must refuse. Idempotent for a token that already
 *  holds the claim. */
export function claimSessionStart(owner: string): boolean {
  if (startClaims.has(owner)) return true;
  if (live.size > 0 || startClaims.size > 0) return false;
  startClaims.add(owner);
  return true;
}

/** Owner-scoped: releasing with a token that does not hold the claim is a
 *  no-op, so a late release from a stale connection cannot free a newer
 *  connection's claim. */
export function releaseSessionStart(owner: string): void {
  startClaims.delete(owner);
}

export function isSessionStartInFlight(): boolean {
  return startClaims.size > 0;
}
