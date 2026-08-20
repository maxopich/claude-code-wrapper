/**
 * Cebab-ws0.7: when to spend a process on an authority probe.
 *
 * `probeSessionStarted` already knows HOW to ask the SDK what a project
 * actually loads, and it is cheap as these things go — it breaks at
 * `system/init`, so it costs a process spawn and no model turn. What it has
 * never had is a caller other than the operator pressing Refresh, which means
 * the one answer the authority panel exists to give arrives only if they know
 * to ask for it. This module decides when to ask on their behalf.
 *
 * ALL THREE RULES HERE EXIST TO STOP A SPAWN STORM, and they stop different
 * ones:
 *
 *   - **Settle before starting.** Arrowing down a sidebar of twenty projects
 *     is twenty selections in a couple of seconds, and nineteen of them are
 *     places the operator is passing through. Bounding CONCURRENCY alone does
 *     not help: twenty spawns two at a time is still twenty spawns, just
 *     slower, and by the time most of them run their project is long gone from
 *     the screen. So each selection cancels the pending one and nothing starts
 *     until a project has been held for `settleMs`.
 *   - **Never probe the same project twice at once.** A probe takes seconds
 *     and the snapshot does not exist until it finishes, so "do we already
 *     have one?" answers NO for the whole time one is running. Clicking away
 *     and back inside that window would start a second.
 *   - **A cap, and it is process-global.** The thing worth bounding is
 *     processes on this machine, which several browser tabs share; per-
 *     connection state would let N tabs cost N times the cap. Same reasoning
 *     as `lastChainVerifyAt` in `ws/server.ts`. With the settle timer in front
 *     of it the realistic count is about one per tab, so this is a backstop
 *     rather than the main brake — which is why hitting it SKIPS rather than
 *     queues. A queue would reintroduce exactly the deferred storm the settle
 *     timer exists to prevent, and Refresh is still there for the project the
 *     operator is actually looking at.
 *
 * The scheduler owns timing and nothing else: `hasSnapshot` and `runProbe`
 * arrive as dependencies so this is testable without a WebSocket, a database
 * or a spawn. One instance per connection — the cache it consults through
 * `hasSnapshot` is per-connection, so a probe another tab ran does not fill
 * this one's panel and must not be deduped against.
 */

/**
 * How long a project must stay selected before it is worth a process.
 *
 * Long enough that arrowing through a list starts nothing, short enough that
 * an operator who clicks a project and reaches for the authority panel finds
 * it already filling. The neighbouring `debounceTimer` in `ws/server.ts` uses
 * 200ms for a wire emit; this is a process spawn, so it buys more room.
 */
export const PROBE_SETTLE_MS = 400;

/** Concurrent probes allowed across the whole process. See the header. */
export const MAX_CONCURRENT_PROBES = 2;

let activeProbes = 0;

/** Test-only: forget the global count so a case starts from an empty machine.
 *  Nothing in production may call this — a live decrement is owned by the
 *  `finally` that incremented it. */
export function __resetProbeConcurrencyForTests(): void {
  activeProbes = 0;
}

/** Test-only: how many probes this process currently has running. */
export function activeProbeCount(): number {
  return activeProbes;
}

export type ProbeScheduler = {
  /** The operator landed on a project. Cancels any pending probe — including
   *  one for this same project — and re-arms if this one is worth probing. */
  onProjectSelected(projectId: number): void;
  /** Connection closed. Disarms the pending timer and refuses further arming.
   *  A probe already running is left alone: it is registered with the runner
   *  lifecycle, which is what stops it outliving the server. */
  cancel(): void;
};

export type ProbeSchedulerDeps = {
  /** Does this connection already hold an authority snapshot for the project?
   *  True for a snapshot from an earlier probe AND for one a real turn left
   *  behind — same data from the same source, so neither needs a respawn. */
  hasSnapshot: (projectId: number) => boolean;
  /** Run the probe and do whatever the caller does with the result. Must not
   *  reject; a rejection is swallowed here so one failure cannot wedge the
   *  concurrency slot, but the caller owns reporting it. */
  runProbe: (projectId: number) => Promise<void>;
  /** Overridable for tests. Production uses `PROBE_SETTLE_MS`. */
  settleMs?: number;
};

export function createProbeScheduler(deps: ProbeSchedulerDeps): ProbeScheduler {
  const settleMs = deps.settleMs ?? PROBE_SETTLE_MS;
  const inFlight = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  function disarm(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function fire(projectId: number): void {
    timer = null;
    // EVERY guard lives here and none at arm time, which is both simpler and
    // more correct. `settleMs` is long enough for a real turn to have filled
    // the cache and for a previous probe of this same project to still be
    // running, so an arm-time answer is a guess about the future — and a copy
    // of these checks up there would be code no test could redden.
    //
    // There is deliberately no `cancelled` check here. `cancel()` clears the
    // only timer that can reach this function, so one would be unreachable —
    // the barrier that does the work is the `cancelled` check in
    // `onProjectSelected`, which stops a later selection re-arming.
    if (deps.hasSnapshot(projectId)) return;
    if (inFlight.has(projectId)) return;
    if (activeProbes >= MAX_CONCURRENT_PROBES) return;

    activeProbes++;
    inFlight.add(projectId);
    void (async () => {
      try {
        await deps.runProbe(projectId);
      } catch {
        // Swallowed on purpose. The slot must be released whatever happened,
        // and `probeSessionStarted` already turns every failure into a null
        // result rather than a throw — anything reaching here is the caller's
        // own bug and must not also cost a permanently-held slot.
      } finally {
        activeProbes--;
        inFlight.delete(projectId);
      }
    })();
  }

  return {
    onProjectSelected(projectId: number): void {
      if (cancelled) return;
      // Disarm FIRST, unconditionally. Selecting a project that needs no probe
      // still means the operator left the previous one, and probing where they
      // no longer are is the behaviour this whole module exists to avoid.
      disarm();
      // Then arm unconditionally too, and let `fire` decide. Arming a timer
      // that turns out to be a no-op costs one cleared entry; deciding here
      // would be deciding on state that has `settleMs` left to change.
      timer = setTimeout(() => fire(projectId), settleMs);
      // Never hold the process open for a probe that has not been asked for.
      timer.unref?.();
    },
    cancel(): void {
      cancelled = true;
      disarm();
    },
  };
}
