// Cluster D Phase 4c (spec §4.2 / B2): a tiny self-contained countdown
// chip used by the RateLimitBanner (and any future banner that needs an
// "elapsed-until" display — auth-refresh hint, swept-session
// dismissal-window, etc.).
//
// Why a separate component (rather than inline ticking in the banner):
//
//   - The banner re-renders on every reducer dispatch (router_drop, every
//     held-message enqueue, …). Putting the ticker inside the banner
//     would either (a) make the banner re-render every second wasting
//     work, or (b) require a memo boundary the chip then becomes
//     anyway. Extracting it keeps the boundary explicit.
//   - The fire-once `onElapsed` callback is what triggers the auto-retry
//     in single-agent mode (the parent dispatches `retry_rate_limited
//     { auto: true }`). Owning the timer in one place means we can
//     reason about double-fires without auditing every consumer.
//   - The screen-reader announcement (`aria-live="polite"` on a hidden
//     mirror) belongs to whatever is being counted down, not the host
//     banner. The chip ships it; the banner doesn't have to coordinate.
//
// The chip is paused-aware: when `paused === true` it stops ticking but
// keeps showing the most recent display so the operator sees the time it
// was paused at. Manual retry from the banner is independent of the
// chip's countdown.

import { useEffect, useRef, useState } from 'react';

export type CountdownChipProps = {
  /** Wall-clock ms to count down to. Past values render "0:00" + don't
   *  fire `onElapsed` (the elapse already happened before mount). */
  targetMs: number;
  /** When true, the chip freezes at the current display and does NOT call
   *  `onElapsed`. Toggling back to false resumes ticking from the live
   *  remaining time (which may already be 0; in that case onElapsed will
   *  fire on the next tick). */
  paused?: boolean;
  /** Fired exactly once per chip lifetime when the remaining time first
   *  reaches ≤ 0 AND the chip is not paused. Re-mount with a new
   *  `targetMs` to arm a fresh fire. */
  onElapsed?: () => void;
  /** Tick interval ms. Defaults to 1000 (one second). Tests inject 50ms
   *  + a fake `now()` to assert tick math without real-time waits. */
  intervalMs?: number;
  /** Injection seam for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Visual label prefix; defaults to "in" → renders "in 0:23". Use
   *  "after" or "" or a custom string for different banner contexts. */
  label?: string;
  /** Extra className on the root span (for placement-specific tweaks). */
  className?: string;
};

/** Pure formatter — exported for testability + reuse by sibling chips. */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  // M:SS up to 60 minutes (the SDK's five-hour cap can hit > 60min on
  // launch, but the rate-limit reset window is bounded at 5h ≅ 300m;
  // we let the minute counter overflow rather than rolling to H:MM:SS
  // because the chip is one row tall in a 4-line banner — vertical
  // compactness wins over hour-correctness for this surface).
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function CountdownChip(props: CountdownChipProps) {
  const {
    targetMs,
    paused = false,
    onElapsed,
    intervalMs = 1000,
    now = Date.now,
    label = 'in',
    className,
  } = props;

  // Snapshot remaining ms in component state so re-renders happen on tick.
  const [remaining, setRemaining] = useState<number>(() => Math.max(0, targetMs - now()));
  // Per-chip-lifetime fired flag (idempotency for onElapsed).
  const firedRef = useRef(false);

  // Re-arm on `targetMs` change (rate-limit refreshed mid-flight with a
  // new resetsAtMs): clear the fired flag so the new target can fire
  // anew. Kept separate from the tick effect so we can also re-arm even
  // while paused (the chip just won't fire until unpaused).
  useEffect(() => {
    firedRef.current = false;
    // `now` is intentionally NOT in the deps — it's an injection seam,
    // not user state. Listing it would make tests churn.
  }, [targetMs]);

  useEffect(() => {
    if (paused) return; // Frozen — don't tick, don't fire.
    // Unified "tick" function: recompute remaining, fire onElapsed when
    // first hit ≤ 0. Called immediately on mount/unpause so an
    // already-elapsed target fires synchronously (no `intervalMs` wait)
    // and unpause-into-elapsed catches up in one step.
    function tick() {
      const next = Math.max(0, targetMs - now());
      setRemaining(next);
      if (next <= 0 && !firedRef.current) {
        firedRef.current = true;
        try {
          onElapsed?.();
        } catch (err) {
          // The chip is rendered inside a banner that's already inside a
          // larger reducer-dispatching tree; a thrown callback shouldn't
          // tear down the entire stack. Mirror the pattern used by other
          // handlerRef bridges.
          console.error('[countdown-chip] onElapsed threw', err);
        }
      }
    }
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
    // `onElapsed` is allowed to be a fresh fn each render (parent
    // typically inlines it); we capture the latest via the closure on
    // every tick anyway, so omitting it is intentional. `now` is an
    // injection seam.
  }, [targetMs, intervalMs, paused]);

  const display = formatRemaining(remaining);
  const rootClass = ['countdown-chip', paused ? 'is-paused' : null, className]
    .filter(Boolean)
    .join(' ');

  // The visible chip is brief — "in 0:23" or "0:23" (when label is "").
  // The polite aria-live mirror restates it in a sentence so a screen
  // reader's announcement is grammatical rather than ticker-like. The
  // mirror only announces every ~5s (we throttle by updating it less
  // often) to avoid screen-reader spam.
  const liveText = `${label ? `${label} ` : ''}${display}${paused ? ' (paused)' : ''}`;
  return (
    <span className={rootClass} data-testid="countdown-chip">
      {label ? `${label} ` : ''}
      <span className="countdown-chip-time">{display}</span>
      {paused ? <span className="countdown-chip-paused"> · paused</span> : null}
      <span className="sr-only" aria-live="polite">
        {liveText}
      </span>
    </span>
  );
}
