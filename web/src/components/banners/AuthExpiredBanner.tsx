// Cluster D Phase 6 (spec §6.4 / UI-D22): operator-facing app-wide
// banner that mounts when the Claude subscription credentials look
// expired. The signal is `wrapper_error { kind: 'auth_expired', ... }`
// which the dispatcher already (Cluster A Phase 6) routes to a toast
// notification AND populates a top-level `authExpired` slice in the
// store (Phase 6 reducer extension); this banner reads that slice.
//
// Why app-wide, not per-session. The subscription is process-level
// state — `~/.claude/.credentials.json` covers every running session
// equally. If it expires, every session is affected; if the operator
// runs `claude login` and renews it, every session is unblocked
// simultaneously. Mounting per-session would either spam N banners
// (one per visible session) or get pinned to whichever session
// happened to be active when the error fired (and disappear when the
// operator switched). The reducer slice + this single mount preserves
// the invariant.
//
// Why danger tier. Per spec §8.4: this is a state the operator MUST
// resolve before continuing — every message they send while expired
// fails identically. Warn = "we got through this but you should know";
// danger = "you cannot proceed." The focus-steal-once contract on
// SessionBanner ensures the Dismiss button (the only honest action
// today) gets keyboard focus the first time per tab session.
//
// Why no "Re-authenticate" primary action. The spec envisions an
// AuthRefreshModal that spawns `claude login` and pipes its prompts
// through the modal — that's substantial server-side work (subprocess
// management, terminal-emulator-like IO) and lives in a follow-up PR.
// For v1, the banner explains the manual fix path; Dismiss is a soft
// hide that re-surfaces on the next observation (reducer flips
// `dismissed` back to false on each populate).
//
// Why a factory (not a JSX component). Same architectural reason as
// the prior phases' factories (Phase 4c/4d/5e): <BannerStack> consumes
// BannerStackItem[] arrays. Even though this PR mounts the banner as
// a solo <SessionBanner /> (the rate-limit / swept patterns), the
// factory shape keeps it composable for a future top-level
// BannerStack — and it makes unit tests Provider-free.

import React from 'react';
import type { AuthExpiredState } from '../../store.js';
import type { BannerStackItem } from './BannerStack.js';

export type AuthExpiredBannerCallbacks = {
  /** Operator clicked Dismiss. The handler should dispatch the
   *  `auth_expired_dismissed` action — the slice persists (count +
   *  first/last timestamps remain useful), only `dismissed` flips.
   *  The next `wrapper_error { kind: 'auth_expired' }` observation
   *  re-surfaces the banner so a fresh failure is honest. */
  onDismiss: () => void;
};

export type BuildAuthExpiredBannerItemArgs = {
  state: AuthExpiredState;
  callbacks: AuthExpiredBannerCallbacks;
  /** Injection seam for tests — defaults to Date.now. Used for the
   *  "last seen" relative-time prose inside the banner body. */
  now?: () => number;
  arrivedAt?: number;
};

export function authExpiredBannerTitle(): string {
  return 'Claude subscription credentials expired';
}

/**
 * Format the lastSeenMs as a coarse, human-readable relative time.
 * Same algorithm as MultiAgentTab.tsx's formatRelativeTime — duplicated
 * here so the banner remains self-contained (no cross-file UI util
 * import) and the factory stays pure.
 */
function formatRelativeMs(diffMs: number): string {
  if (diffMs < 0) return 'just now';
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

export function buildAuthExpiredBannerItem(args: BuildAuthExpiredBannerItemArgs): BannerStackItem {
  const { state, callbacks, arrivedAt } = args;
  const now = args.now ?? Date.now;
  const relTime = formatRelativeMs(now() - state.lastSeenMs);
  // Pluralize honestly — "1 turn" vs "3 turns" — so the message reads
  // naturally for both first observation and a repeating fail.
  const countLabel = state.count === 1 ? 'a turn' : `${state.count} turns`;

  const body = (
    <>
      <p>
        Cebab couldn't complete <strong>{countLabel}</strong> because the Claude subscription
        credentials at <code>~/.claude/.credentials.json</code> look expired (last failure {relTime}
        ).
      </p>
      <p>
        Run <code>claude login</code> in a terminal to renew them. Any messages you send before
        re-authenticating will fail with the same error — the banner clears itself the first time a
        session starts successfully.
      </p>
    </>
  );

  const detail = state.lastMessage ? (
    <pre className="auth-expired-banner-detail-message">{state.lastMessage}</pre>
  ) : null;

  return {
    id: 'auth-expired',
    tier: 'danger',
    title: authExpiredBannerTitle(),
    glyph: '🔒',
    body,
    detail,
    detailLabel: 'Last error message',
    actions: [
      {
        label: 'Dismiss',
        variant: 'ghost',
        onClick: callbacks.onDismiss,
        title:
          'Hide the banner. It will re-appear on the next failed message until you re-authenticate.',
      },
    ],
    arrivedAt,
  };
}
