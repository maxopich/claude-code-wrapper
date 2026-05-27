// Cluster D Phase 4c (spec §4.2, B2, UI-D6/D7): the operator-facing
// rate-limit surface. Mounted via <BannerStack> on both single-agent
// (App.tsx) and multi-agent (MultiAgentTab.tsx) views; both call
// `buildRateLimitBannerItem(...)` and push the returned item into the
// stack's `banners` array.
//
// Architecture note: this module exports a FACTORY (not a JSX component)
// because <BannerStack> consumes plain props arrays (BannerStackItem[]),
// not children — see `BannerStack.tsx`. The factory shape lets us own all
// banner-specific composition (title, body prose, action set, detail
// disclosure) in one place while reusing SessionBanner's generic shell.
//
// Coupling boundary:
//   - In:  `RateLimitState` + `heldMessages` from the per-session store,
//          plus the four callbacks the App-level dispatch site exposes.
//   - Out: a `BannerStackItem` ready to render. The factory does not
//          import the store directly — every input is a prop, so unit
//          tests don't need a Provider tree.
//
// Pause semantics: spec §4.2 puts retry cadence on the client (see the
// retry_rate_limited JSDoc rationale: "tab close + reopen doesn't lose
// pause state to the wrong source of truth"). When `paused === true`,
// the CountdownChip freezes AND the auto-fire onElapsed becomes a no-op
// (because the chip itself respects `paused`). Manual retry stays
// available — the operator can hit "Retry now" even while auto is
// paused.
//
// Held-message queue (UI-D7): when the slice contains queued messages,
// the banner surfaces a count + a `<details>` with the actual texts and
// per-message "Drop" buttons. The drain itself is a separate effect in
// App.tsx (it watches for `!rateLimit && heldMessages.length > 0` and
// ws-sends one at a time, dispatching `rl_drain_one` per ship).

import React from 'react';
import type { RateLimitState } from '../../store.js';
import type { BannerStackItem } from './BannerStack.js';
import type { BannerAction } from './SessionBanner.js';
import { CountdownChip } from './CountdownChip.js';

export type RateLimitBannerCallbacks = {
  /** Operator-initiated retry (manual click). The handler should send
   *  `retry_rate_limited { auto: false }` to the server AND dispatch
   *  `rl_retry_sent` so the banner can debounce the button until the
   *  next session_running echo. */
  onManualRetry: () => void;
  /** Auto-retry fired by the countdown elapsing. Same as above but
   *  `auto: true` so the recovery_log row tags the attempt. The chip
   *  guarantees it only fires once per (un)pause cycle. */
  onAutoRetry: () => void;
  /** Toggle the operator-level pause. Banner reflects the live `paused`
   *  field and re-renders the action label accordingly. */
  onPauseToggle: (next: boolean) => void;
  /** Drop a queued held message by index (UI-D7 escape hatch). */
  onDropHeld: (index: number) => void;
};

/**
 * Construct the title for the rate-limit banner. Pure function — the
 * banner's title is a string in `SessionBannerProps`, so we can't embed
 * a live CountdownChip in the title slot itself. The countdown goes in
 * the body instead. This is exported only for test reuse; production
 * callers go through `buildRateLimitBannerItem`.
 */
export function rateLimitBannerTitle(state: RateLimitState): string {
  if (state.autoRetry) {
    return `Rate limit — auto-retry attempt ${state.autoRetry.attempt} of ${state.autoRetry.maxAttempts}`;
  }
  return 'Rate limit reached';
}

/**
 * Compose the banner body. Always renders the reset-time CountdownChip
 * (when a target is known) plus optional overage and held-queue prose.
 */
function rateLimitBannerBody(
  state: RateLimitState,
  heldMessages: string[],
  onAutoRetry: () => void,
  now: () => number,
): React.ReactNode {
  // Primary countdown: prefer the autoRetry retryAt (specific to the
  // next bus retry) when present; otherwise the SDK's resetsAtMs (the
  // hard cap reset). The bus retry usually fires BEFORE the hard cap
  // resets — operators care more about "when's the next attempt?" than
  // the cap clock.
  const primaryTarget = state.autoRetry?.retryAt ?? state.resetsAtMs;
  const hasOverage =
    state.overageStatus !== undefined ||
    state.overageResetsAtMs !== undefined ||
    state.isUsingOverage !== undefined;

  return (
    <>
      <p className="rate-limit-banner-prose">
        {state.autoRetry ? (
          <>
            The bus is auto-retrying this turn.{' '}
            {primaryTarget !== undefined ? (
              <>
                Next attempt{' '}
                <CountdownChip
                  targetMs={primaryTarget}
                  paused={state.paused}
                  onElapsed={onAutoRetry}
                  now={now}
                  label="in"
                />
                .
              </>
            ) : (
              'Next attempt firing now.'
            )}{' '}
            {state.paused
              ? 'Auto-retry is paused — Resume to let it fire, or hit Retry now to fire manually.'
              : 'Pause auto-retry if you want to wait, or hit Retry now to fire immediately.'}
          </>
        ) : (
          <>
            The API is rate-limiting this session.{' '}
            {primaryTarget !== undefined ? (
              <>
                Resets{' '}
                <CountdownChip
                  targetMs={primaryTarget}
                  paused={state.paused}
                  onElapsed={onAutoRetry}
                  now={now}
                  label="in"
                />
                .
              </>
            ) : (
              'Reset time unknown — try again shortly.'
            )}{' '}
            {state.paused
              ? 'Auto-retry is paused. Hit Retry now to fire manually.'
              : 'The captured turn will auto-retry when the countdown reaches zero.'}
          </>
        )}
      </p>
      {hasOverage ? (
        <p className="rate-limit-banner-overage">
          <strong>Overage budget:</strong>{' '}
          {state.isUsingOverage ? 'in use' : (state.overageStatus ?? 'available')}
          {state.overageResetsAtMs !== undefined ? (
            <>
              {' · '}refills{' '}
              <CountdownChip
                targetMs={state.overageResetsAtMs}
                paused={state.paused}
                now={now}
                label="in"
              />
            </>
          ) : null}
          .
        </p>
      ) : null}
      {heldMessages.length > 0 ? (
        <p className="rate-limit-banner-held">
          <strong>{heldMessages.length} held</strong>{' '}
          {heldMessages.length === 1 ? 'message' : 'messages'} waiting to send when this clears.{' '}
          Expand the details below to inspect or drop entries.
        </p>
      ) : null}
    </>
  );
}

/**
 * Held-message detail panel. Each entry has a per-row "Drop" button so
 * the operator can prune one stale draft without blowing away the whole
 * queue (UI-D7).
 */
function heldDetail(heldMessages: string[], onDropHeld: (index: number) => void): React.ReactNode {
  if (heldMessages.length === 0) return undefined;
  return (
    <ol className="rate-limit-banner-held-list">
      {heldMessages.map((text, idx) => (
        <li key={idx} className="rate-limit-banner-held-item">
          <span className="rate-limit-banner-held-text">{text}</span>
          <button
            type="button"
            className="rate-limit-banner-held-drop"
            onClick={() => onDropHeld(idx)}
            aria-label={`Drop queued message ${idx + 1}`}
            title="Drop this queued message"
          >
            Drop
          </button>
        </li>
      ))}
    </ol>
  );
}

export type BuildRateLimitBannerItemArgs = {
  sessionId: string;
  state: RateLimitState;
  heldMessages: string[];
  callbacks: RateLimitBannerCallbacks;
  /** Injection seam for tests; defaults to Date.now. */
  now?: () => number;
  /** When the banner first became visible — drives the BannerStack
   *  tiebreak (newest first within same tier). Caller persists this in
   *  whatever state holds the banner array; not derived here. */
  arrivedAt?: number;
};

/**
 * Factory. Returns the props object BannerStack consumes for this
 * banner. Returns `null` if the slice is in a state where no banner
 * should render (currently never — but kept as a forward-compat escape
 * hatch for "soft" rate-limit states that should be silent).
 */
export function buildRateLimitBannerItem(args: BuildRateLimitBannerItemArgs): BannerStackItem {
  const { sessionId, state, heldMessages, callbacks, arrivedAt } = args;
  const now = args.now ?? Date.now;

  // Manual retry is always available; disable when a retry is in flight
  // (debounce until the next session_running echo).
  const manualRetryDisabled = state.retryInFlight;
  const actions: BannerAction[] = [
    {
      label: state.retryInFlight ? 'Retrying…' : 'Retry now',
      variant: 'primary',
      onClick: callbacks.onManualRetry,
      disabled: manualRetryDisabled,
      pending: state.retryInFlight,
      title:
        'Fire the captured turn against the API immediately. If the limit is still hot, you' +
        " 'll get a fresh rate_limit_event and the countdown restarts.",
    },
    {
      label: state.paused ? 'Resume auto-retry' : 'Pause auto-retry',
      variant: 'ghost',
      onClick: () => callbacks.onPauseToggle(!state.paused),
      title: state.paused
        ? 'Resume the countdown. Auto-retry will fire when it reaches zero.'
        : 'Freeze the countdown. The captured turn stays held; use Retry now to fire manually.',
    },
  ];

  return {
    id: `rate-limit-${sessionId}`,
    tier: 'warn',
    title: rateLimitBannerTitle(state),
    glyph: '⏳',
    body: rateLimitBannerBody(state, heldMessages, callbacks.onAutoRetry, now),
    actions,
    detail: heldDetail(heldMessages, callbacks.onDropHeld),
    detailLabel:
      heldMessages.length > 0
        ? `${heldMessages.length} held message${heldMessages.length === 1 ? '' : 's'}`
        : undefined,
    // Tier=warn defaults to role=region + ariaLive=polite per SessionBanner's
    // tier mapping — that matches spec §8.4 for a warn-tier informational
    // recovery banner, so no overrides.
    arrivedAt,
  };
}
