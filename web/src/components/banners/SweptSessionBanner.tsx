// Cluster D Phase 5e (spec §6.3 / UI-D17): the in-session, always-on
// counterpart to the swept-session toast notification.
//
// What this banner is for. The Phase 4 server-side sweep emits a
// `session_superseded` ServerMsg with reasonCode = `'swept_competing'`
// (auto-sweep) or `'operator_reopen'` (operator-initiated swap).
// Notification dispatch turns that into a transient toast offering
// Reopen + Archive. But a toast disappears — the operator may dismiss
// it, miss it during a Cebab restart, or simply navigate away. The
// swept iteration's state (status = 'crashed' in the multi_agent_sessions
// row) is durable; the operator can land on this view at any time by
// clicking the iteration row in the Iterations list. The toast can't
// promise "you'll always see Reopen/Archive options" — only an
// in-session banner can.
//
// Why danger tier (not warn). Per spec §8.4: the swept state is not a
// passive informational signal — it's a STATE the operator must
// acknowledge by either acting (Reopen / Archive) or explicitly
// dismissing the session view. Warn tier is for "we got through this
// but you should know"; danger is for "you cannot proceed without a
// decision." The focus-steal-once-per-banner-id behaviour of
// SessionBanner (sessionStorage-backed) ensures the Reopen action gets
// keyboard focus the first time the operator navigates here per tab
// session — subsequent revisits don't re-steal.
//
// Why a factory (not a JSX component). Same architectural reason as
// `buildRateLimitBannerItem` / `buildBusAutoRetryBannerItem` in
// `RateLimitBanner.tsx`: <BannerStack> consumes BannerStackItem[]
// arrays, not children. Even though this PR mounts the banner as a
// solo <SessionBanner /> (not yet via a stack), the factory shape
// keeps it composable for a future ActiveRunView migration to a
// proper BannerStack — and it makes the unit tests Provider-free.
//
// Coupling boundary: the factory takes the sessionId plus two
// callbacks (Reopen + Archive). It does NOT import ReopenContext or
// the WS sink — every input is a prop. The mount site (ActiveRunView)
// is responsible for plumbing the callbacks to the ReopenContext
// `requestReopen` action and the App.tsx `archive_session` ClientMsg
// dispatch, mirroring the toast notification's action wiring.

import React from 'react';
import type { BannerStackItem } from './BannerStack.js';

export type SweptSessionBannerCallbacks = {
  /** Operator clicked Reopen. The handler should call the
   *  ReopenContext `requestReopen(sessionId)` action — the same
   *  entrypoint the toast notification's Reopen button uses.
   *  Identical downstream flow: probe → confirm modal → commit. */
  onReopen: () => void;
  /** Operator clicked Archive. The handler should send the
   *  `archive_session` ClientMsg, identically to the toast
   *  notification's Archive button. The server replies
   *  `iteration_archived`; the client reducer removes the row from
   *  the iterations list. The active view persists until the
   *  operator navigates away (no auto-redirect — leaving the
   *  scrollback visible after Archive lets the operator finish
   *  reviewing it before clearing). */
  onArchive: () => void;
};

export type BuildSweptSessionBannerItemArgs = {
  sessionId: string;
  callbacks: SweptSessionBannerCallbacks;
  /** When true, the Reopen action renders disabled — a reopen modal
   *  is already in flight (or a commit is mid-roundtrip). The
   *  ReopenContext also guards via its `state.kind !== 'idle'`
   *  predicate so a stray click here would be a benign no-op, but
   *  visually communicating the busy state is honest UX. */
  reopenInFlight?: boolean;
  arrivedAt?: number;
};

export function sweptSessionBannerTitle(): string {
  return 'This iteration has been swept';
}

export function buildSweptSessionBannerItem(
  args: BuildSweptSessionBannerItemArgs,
): BannerStackItem {
  const { sessionId, callbacks, reopenInFlight, arrivedAt } = args;
  const shortId = sessionId.slice(0, 8);

  const body = (
    <>
      <p>
        A newer run for this project took over the active slot — this iteration (
        <code>{shortId}</code>) is no longer the one your next message would reach.
      </p>
      <p>
        <strong>Reopen</strong> sets aside the current active session and brings this one back.
        You'll review the workspace diff first and (when files have changed) type a confirmation
        before the swap. <strong>Archive</strong> hides this iteration from the list; the session
        folder and transcripts on disk are preserved.
      </p>
    </>
  );

  return {
    id: `swept-session-${sessionId}`,
    tier: 'danger',
    title: sweptSessionBannerTitle(),
    glyph: '⚠',
    body,
    actions: [
      {
        label: 'Reopen this iteration',
        variant: 'primary',
        onClick: callbacks.onReopen,
        disabled: reopenInFlight,
        title: reopenInFlight
          ? 'A reopen flow is already in progress — finish or cancel it first.'
          : 'Bring this iteration back to active and set aside the current run. Reviews the workspace diff first.',
      },
      {
        label: 'Archive',
        variant: 'ghost',
        onClick: callbacks.onArchive,
        title:
          'Hide this iteration from the Iterations list. Artifacts on disk are preserved; archiving is reversible.',
      },
    ],
    arrivedAt,
  };
}
