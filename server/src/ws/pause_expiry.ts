import type { ControlReasonCode, PauseExpiryAction } from '@cebab/shared/protocol';

/**
 * Cluster C Phase 4c2 (spec §5.6 AE-6): pause expiry timer registry.
 *
 * Pause carries a positive `timeoutMs` + an `expiryAction` ('auto_resume'
 * or 'auto_kick') that the operator selects when issuing the pause (Phase
 * 4c). The wire validation in `executePauseParticipant` rejects missing
 * fields; the DB persists `pausedUntil` + `pause_expiry_action`; this
 * module schedules the actual timer that fires the chosen action when
 * the deadline arrives.
 *
 * Why a separate module (vs putting the setTimeout call inline in the
 * WS handler):
 *   - The registry needs to survive across WS-connection lifetimes (a
 *     paused worker should keep its expiry timer even if the operator's
 *     browser closes and reopens; the new connection picks up state via
 *     R-A reattach, the timer is process-global). Inlining setTimeout in
 *     the WS handler would scope it to the handler's closure — the timer
 *     would still fire, but cancel-by-resume couldn't reach it from a
 *     different connection.
 *   - Fake-timer test seams: production passes `setTimeout` /
 *     `clearTimeout` defaults; the test scaffold injects `vi.useFakeTimers`
 *     equivalents so timer behavior is exercised deterministically.
 *   - Centralized teardown: `clearSession` cancels every timer for a
 *     session when it ends (stop/abandon/crash), so a freshly-fired
 *     timer doesn't try to flip state on a row that the teardown path
 *     just deleted/mutated.
 *
 * Lifecycle invariants:
 *   - `schedule(entry, onExpire)` installs a timer keyed by
 *     `(sessionId, projectId)`. A second schedule for the same key
 *     CANCELS the prior timer (matches "operator re-paused with new
 *     timeout" semantics — the new pause replaces the old gate).
 *   - `cancel(sessionId, projectId)` clears the timer if one is
 *     scheduled. Returns true iff a timer was actually cancelled, so
 *     the caller can distinguish "first cancel" from no-op.
 *   - `clearSession(sessionId)` cancels every timer for that session;
 *     called from the orchestrator's `onEnded` sink so a finalized
 *     session never has a stale timer running.
 *   - The `onExpire` callback is invoked with the original entry; the
 *     caller is responsible for the DB defensive re-check, the audit
 *     dual-write, and the state-change ServerMsg emit.
 *
 * R-A/R-B reseed:
 *   v1 doesn't reseed timers from durable state on server restart —
 *   that lands in C4e alongside the rest of the control-state read
 *   path. A server restart between pause + expiry currently means the
 *   pause stays in the DB indefinitely; the operator's next action
 *   (resume/kick) is the only path that clears it. Acceptable for v1
 *   (the operator notices "wait, I paused this 4 hours ago" the next
 *   time they look at the panel — same UX a missing timer fire would
 *   produce anyway).
 *
 * Process-singleton: production code uses `getPauseExpiryRegistry()`;
 * tests can either use the singleton (and clean up with
 * `__resetRegistryForTesting()`) or instantiate `PauseExpiryRegistry`
 * directly with their own fake-time deps.
 */

/**
 * Snapshot of the original pause that the timer needs to fire. Captured
 * at schedule time so a between-tick mutation of the DB row (e.g. the
 * operator updates the reasonText via some future affordance) doesn't
 * change what the expiry action does.
 *
 * `agentName` is the resolved bus_agent_name (the router's key, not the
 * project id) — the timer's resume/kick side effect needs to call
 * `handle.resumeAgent(agentName)` / `handle.kickAgent(agentName)`.
 */
export type PauseExpiryEntry = {
  sessionId: string;
  projectId: number;
  agentName: string;
  /** Absolute epoch ms when the timer fires (same value persisted as
   *  `multi_agent_participants.paused_until`). */
  pausedUntil: number;
  expiryAction: PauseExpiryAction;
  /** Carried from the original pause; the auto_kick path uses this as
   *  the resulting kick's reasonCode so the operator's justification
   *  rides forward. */
  reasonCode: ControlReasonCode;
  reasonText: string | null;
};

/**
 * Injectable deps for fake-time tests. Production callers use the
 * defaults (global `setTimeout` + `clearTimeout` + `Date.now`).
 */
export type RegistryDeps = {
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
};

function compositeKey(sessionId: string, projectId: number): string {
  return `${sessionId}:${projectId}`;
}

export class PauseExpiryRegistry {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly entries = new Map<string, PauseExpiryEntry>();
  private readonly setTimeoutFn: NonNullable<RegistryDeps['setTimeoutFn']>;
  private readonly clearTimeoutFn: NonNullable<RegistryDeps['clearTimeoutFn']>;
  private readonly now: NonNullable<RegistryDeps['now']>;

  constructor(deps: RegistryDeps = {}) {
    this.setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    this.now = deps.now ?? Date.now;
  }

  /**
   * Install a timer for this pause. If one was already scheduled for
   * the (sessionId, projectId) key, the prior timer is cancelled first
   * — operator-re-pause replaces the gate cleanly.
   *
   * The delay is computed from `entry.pausedUntil - now()`. A
   * non-positive delay (the deadline already passed) fires the
   * callback synchronously on the next tick via `setTimeoutFn(cb, 0)`
   * — this is the path R-A reattach would take if a paused worker's
   * deadline lapsed while the browser was closed (today: a
   * fresh-server-start reseed would fire it immediately).
   *
   * The callback runs in a try/catch so a throw inside the operator's
   * onExpire handler doesn't poison the registry — it logs + clears
   * the map entry so the slot is reusable.
   */
  schedule(entry: PauseExpiryEntry, onExpire: (entry: PauseExpiryEntry) => void): void {
    const key = compositeKey(entry.sessionId, entry.projectId);
    // Replace any prior timer for this key — operator re-pause.
    const prior = this.timers.get(key);
    if (prior !== undefined) {
      this.clearTimeoutFn(prior);
    }
    const remaining = Math.max(0, entry.pausedUntil - this.now());
    const handle = this.setTimeoutFn(() => {
      // Drop the entry FIRST so the onExpire callback's own cancel-by-
      // resume call (defensive: the operator might race a resume into
      // the same tick) sees an empty slot and no-ops cleanly.
      this.timers.delete(key);
      this.entries.delete(key);
      try {
        onExpire(entry);
      } catch (err) {
        console.error(
          `[pause_expiry] onExpire for ${entry.sessionId}/${entry.projectId} (${entry.agentName}) threw`,
          err,
        );
      }
    }, remaining);
    this.timers.set(key, handle);
    this.entries.set(key, entry);
  }

  /**
   * Cancel the timer for (sessionId, projectId). Returns true iff a
   * timer was actually scheduled (so the caller can distinguish a
   * real cancel from a no-op without consulting `isScheduled`
   * separately).
   */
  cancel(sessionId: string, projectId: number): boolean {
    const key = compositeKey(sessionId, projectId);
    const handle = this.timers.get(key);
    if (handle === undefined) return false;
    this.clearTimeoutFn(handle);
    this.timers.delete(key);
    this.entries.delete(key);
    return true;
  }

  /**
   * Cancel every timer for a session. Called from the orchestrator's
   * `onEnded` sink so a finalized session leaves no stale timer
   * behind.
   */
  clearSession(sessionId: string): number {
    let cleared = 0;
    for (const key of [...this.timers.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        const handle = this.timers.get(key);
        if (handle !== undefined) {
          this.clearTimeoutFn(handle);
        }
        this.timers.delete(key);
        this.entries.delete(key);
        cleared += 1;
      }
    }
    return cleared;
  }

  /** Probe — used by tests + future inspector affordances. */
  isScheduled(sessionId: string, projectId: number): boolean {
    return this.timers.has(compositeKey(sessionId, projectId));
  }

  /** Diagnostic — total scheduled timers across all sessions. */
  getScheduledCount(): number {
    return this.timers.size;
  }

  /**
   * Snapshot of the entry that was scheduled for this key. Returns
   * undefined if no timer is currently scheduled. Used by tests to
   * verify the entry survived the schedule call intact.
   */
  getEntry(sessionId: string, projectId: number): PauseExpiryEntry | undefined {
    return this.entries.get(compositeKey(sessionId, projectId));
  }
}

let _singleton: PauseExpiryRegistry | undefined;

/**
 * Process-wide singleton accessor. Production code (WS handlers, the
 * orchestrator's onEnded hook) calls this; tests can either use this
 * (and reset via `__resetRegistryForTesting()`) or build a fresh
 * `new PauseExpiryRegistry(deps)` directly when they need fake-time
 * control.
 */
export function getPauseExpiryRegistry(): PauseExpiryRegistry {
  if (_singleton === undefined) {
    _singleton = new PauseExpiryRegistry();
  }
  return _singleton;
}

/**
 * Reset the singleton — for test isolation. Cancels every pending
 * timer first so leftover state from one test doesn't bleed into the
 * next.
 */
export function __resetRegistryForTesting(): void {
  if (_singleton !== undefined) {
    // Cancel every pending timer the singleton has — leak prevention
    // for fake-timer tests that might otherwise wedge.
    for (const handle of _singleton['timers'].values()) {
      clearTimeout(handle);
    }
  }
  _singleton = undefined;
}
