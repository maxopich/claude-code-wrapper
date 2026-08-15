import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionLostView } from '../../store';
import { copyToClipboard } from '../../clipboard';
import { INERT_EXEMPT_ATTR } from '../../useModalSurface';
import { formatDiagnostic, type ConnectionLostReason } from './connectionLostReason';

/**
 * Cluster G E3 UI: full-pane overlay that mounts when the app cannot
 * reach the Cebab server. Spec §5 E3:
 *
 * - **Layout.** Centered card over the main pane (sidebar stays
 *   functional). 480px wide on desktop, full-bleed below sm.
 * - **Copy.** One variant per `reason`. Each carries an actionable
 *   line tailored to the failure mode (e.g. origin: "Edit allowed
 *   origins" docs link).
 * - **Affordances.** Always: "Copy diagnostic" (timestamp + reason +
 *   url + close code, no credentials). For `server_unreachable`:
 *   "Retry" plus an auto-retry tag showing the next backoff window.
 * - **A11y.** `role="alert"` on the title+body (NOT the whole card — see
 *   U27 below), announces once on appearance, focus moves to the
 *   primary action. `prefers-reduced-motion` suppresses transition.
 * - **Dismiss.** Operator may dismiss to expose the sidebar; the
 *   slice clears on dismissal AND on the next successful `ws_open`.
 *
 * Auto-retry mechanics for the `server_unreachable` variant are
 * delegated up to the host (App.tsx). This component renders the
 * countdown UI but doesn't reach into the WS layer — `onRetry` is
 * called when the operator clicks Retry OR when the auto-timer
 * elapses. The host decides whether to actually reconnect or wait.
 *
 * Reduced-motion: the animation classes drop to instant when the
 * user's `prefers-reduced-motion: reduce` is set; the CSS sibling of
 * this component implements that.
 */

export type ConnectionLostOverlayProps = {
  /** The view to render. When undefined, the overlay does not mount. */
  view: ConnectionLostView | undefined;
  /** Called when the operator clicks Dismiss / hits Esc. */
  onDismiss: () => void;
  /** Called when the operator clicks Retry (only the server-unreachable
   *  variant renders the button). The host re-runs its auth-token
   *  fetch + WS connect path. */
  onRetry?: () => void;
};

/** Auto-retry backoff schedule for `server_unreachable`. Doubles each
 *  attempt up to a cap. Mirrors common reconnect cadence (1s, 2s, 4s,
 *  8s, …) and gives the operator a visible countdown so the overlay
 *  doesn't feel frozen. */
const AUTO_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

export function ConnectionLostOverlay({ view, onDismiss, onRetry }: ConnectionLostOverlayProps) {
  // Auto-retry attempt counter — increments only for the
  // `server_unreachable` variant. Reset when the overlay unmounts so
  // a fresh failure restarts at the first backoff window.
  const [attempt, setAttempt] = useState(0);
  const [tickNow, setTickNow] = useState(() => Date.now());
  const cardRef = useRef<HTMLDivElement | null>(null);
  const primaryBtnRef = useRef<HTMLButtonElement | null>(null);

  // Track when the current `view` (re)mounted so the countdown anchor
  // is wall-clock-stable. Re-keyed on every new failure (overlay
  // unmount-then-mount). Using `view?.diagnostic.ts` would be wrong
  // for `auth_token_invalid` (the same ts could re-arrive after a
  // user-initiated retry).
  //
  // W07: keyed on `view.reason`, NOT on the `view` object. The store's
  // `connection_lost` case always stores a fresh literal, and the
  // `/auth-token` non-OK branch in App.tsx dispatches unguarded (unlike the
  // fetch-threw branch, which checks the existing slice first). So against a
  // 502/504 — which `resolveFromAuthTokenResponse` maps to
  // `server_unreachable` — a new object arrived on every attempt, reset the
  // counter, and pinned the 2/4/8/15/30s ladder at 2s while the server was
  // already struggling. Keying on the reason means a repeat of the SAME
  // failure keeps the ladder climbing, a genuinely different failure resets
  // it, and dismiss-then-fail resets too (the dep passes through undefined).
  const startedAtRef = useRef<number>(Date.now());
  useEffect(() => {
    if (!view) return;
    startedAtRef.current = Date.now();
    setAttempt(0);
    // Cebab-1uk: `[view?.reason]` is PR #322's fix (W07), not an oversight —
    // the reducer rebuilds `view` on unrelated updates, and depending on the
    // object restarted the retry countdown every time. The body reads `view`
    // only as a null guard, and `undefined` ⇄ a reason string both show up in
    // the narrowed value, so the dependency is behaviourally complete. Undoing
    // this to satisfy the rule would reintroduce the bug #322 fixed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.reason]);

  // Esc dismisses. Bound only while the overlay is mounted so it
  // doesn't swallow Esc in unrelated views.
  useEffect(() => {
    if (!view) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [view, onDismiss]);

  // Move focus to the primary action on mount per spec a11y rule.
  useEffect(() => {
    if (!view) return;
    primaryBtnRef.current?.focus();
  }, [view]);

  // 1Hz tick for the auto-retry countdown. Only meaningful for the
  // `server_unreachable` variant; we still tick for other variants but
  // they don't read the value (cheap enough).
  useEffect(() => {
    if (!view) return;
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [view]);

  // Auto-retry timer for the unreachable variant. Fires `onRetry`
  // when the countdown hits zero; the host owns whether that actually
  // re-attempts. The local `attempt` counter advances so the next
  // retry uses a longer backoff window.
  useEffect(() => {
    if (!view || view.reason !== 'server_unreachable') return;
    if (!onRetry) return;
    const delay = AUTO_RETRY_DELAYS_MS[Math.min(attempt, AUTO_RETRY_DELAYS_MS.length - 1)]!;
    const startedAt = startedAtRef.current;
    const remaining = startedAt + delay - Date.now();
    if (remaining <= 0) {
      onRetry();
      setAttempt((n) => n + 1);
      startedAtRef.current = Date.now();
      return;
    }
    const id = setTimeout(() => {
      onRetry();
      setAttempt((n) => n + 1);
      startedAtRef.current = Date.now();
    }, remaining);
    return () => clearTimeout(id);
  }, [view, attempt, tickNow, onRetry]);

  const onClickCopy = useCallback(() => {
    if (!view) return;
    const text = formatDiagnostic(view.reason as ConnectionLostReason, view.diagnostic);
    // U42: was a raw `navigator.clipboard` call, justified by "a fallback
    // textarea-select would be more robust but adds noise for our 127.0.0.1
    // deployment (always secure context)". The shared helper already carries
    // that fallback, so the noise argument no longer buys anything — and this
    // is the copy button that matters most, since the operator reaches for it
    // precisely when Cebab is unreachable and they need the diagnostic to go
    // somewhere else.
    void copyToClipboard(text).then((ok) => {
      if (!ok) console.warn('[connection-lost] clipboard copy failed');
    });
  }, [view]);

  if (!view) return null;

  const copy = COPY[view.reason as ConnectionLostReason];
  const showRetry = view.reason === 'server_unreachable';
  // Auto-retry visible countdown (seconds remaining until next attempt).
  // Floored at 0 to defend NTP slew.
  const retryDelay = AUTO_RETRY_DELAYS_MS[Math.min(attempt, AUTO_RETRY_DELAYS_MS.length - 1)]!;
  const retrySecondsLeft = Math.max(
    0,
    Math.ceil((startedAtRef.current + retryDelay - tickNow) / 1000),
  );

  return (
    <div
      className="connection-lost-overlay"
      role="presentation"
      // U28, second half: `useModalSurface` marks every sibling of an open
      // modal `inert`, and this overlay IS a sibling (both are children of
      // `.app`). So a modal opened while the overlay is already up left the
      // one surface saying "the server is unreachable" not merely dimmed but
      // non-interactive — Retry, Copy diagnostic and Dismiss all dead. This
      // attribute is the single exemption the walk honours. The opposite
      // order escaped it, because the inert effect has `[]` deps and this
      // component renders null until a failure — which is exactly why the
      // bug would read as intermittent.
      {...{ [INERT_EXEMPT_ATTR]: '' }}
    >
      <div ref={cardRef} className="connection-lost-card">
        <div className="connection-lost-stripe" aria-hidden="true" />
        {/* U27: the alert is the MESSAGE, not the dialog.
         *
         *  `role="alert"` carries an implicit `aria-atomic="true"`, so a
         *  region marked that way is re-read IN FULL whenever any part of it
         *  changes. This used to wrap the whole card — including the Retry
         *  button, whose label holds a countdown that ticks once a second. So
         *  every tick assertively re-announced the title, the body, the docs
         *  link and all three button labels, interrupting whatever the
         *  operator was listening to, once a second, until they acted.
         *
         *  Scoped to the title + body, the region holds only what changed
         *  when the overlay appeared, and that content is static for the
         *  overlay's whole life — so it announces exactly once, on mount.
         *  The countdown stays in the button label, which is where a sighted
         *  operator reads it. */}
        <div className="connection-lost-message" role="alert" aria-live="assertive">
          <h2 id="connection-lost-title" className="connection-lost-title">
            {copy.title}
          </h2>
          <p id="connection-lost-body" className="connection-lost-body">
            {copy.body}
          </p>
          {copy.docsHref ? (
            <p className="connection-lost-docs">
              <a href={copy.docsHref} target="_blank" rel="noopener noreferrer">
                {copy.docsLabel ?? 'Learn more'}
              </a>
            </p>
          ) : null}
        </div>
        <div className="connection-lost-actions">
          {showRetry && onRetry ? (
            <button
              ref={primaryBtnRef}
              type="button"
              className="connection-lost-btn connection-lost-btn-primary"
              onClick={() => {
                onRetry();
                setAttempt((n) => n + 1);
                startedAtRef.current = Date.now();
              }}
            >
              Retry now
              {retrySecondsLeft > 0 ? (
                <span className="connection-lost-countdown"> (auto in {retrySecondsLeft}s)</span>
              ) : null}
            </button>
          ) : null}
          <button
            ref={showRetry ? undefined : primaryBtnRef}
            type="button"
            className="connection-lost-btn connection-lost-btn-ghost"
            onClick={onClickCopy}
          >
            Copy diagnostic
          </button>
          <button
            type="button"
            className="connection-lost-btn connection-lost-btn-ghost"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- copy table ----------

type CopyVariant = {
  title: string;
  body: string;
  /** Optional inline docs link surfaced as a small line under the
   *  body. Used by `origin_not_allowed` / `host_not_allowed` to point
   *  at the CEBAB_ALLOWED_ORIGINS env var docs. Falls back to no
   *  link when undefined. */
  docsHref?: string;
  docsLabel?: string;
};

const COPY: Record<ConnectionLostReason, CopyVariant> = {
  origin_not_allowed: {
    title: 'Origin not allowed',
    body: "Cebab refused this connection because the page origin isn't allowed. Check that you opened Cebab from the correct URL.",
    docsLabel: 'Edit allowed origins',
    docsHref: 'https://github.com/maxopich/claude-code-wrapper#configuration',
  },
  host_not_allowed: {
    title: 'Host not allowed',
    body: 'The Cebab server rejected the requested host. Confirm you reached 127.0.0.1 or localhost on the configured port.',
    docsLabel: 'Edit allowed hosts',
    docsHref: 'https://github.com/maxopich/claude-code-wrapper#configuration',
  },
  auth_token_invalid: {
    title: 'Authentication failed',
    body: "Cebab couldn't authenticate this browser session. The launch token may be expired — open Cebab from a fresh launch URL.",
  },
  session_revoked: {
    title: 'Session revoked',
    body: 'The Cebab server revoked this browser session. Re-open Cebab from a launch URL to start a new session.',
  },
  server_unreachable: {
    title: 'Cebab server unreachable',
    body: "The Cebab server isn't responding. Make sure it's running, then click Retry. We'll keep trying in the background.",
  },
  unknown: {
    title: 'Connection to Cebab failed',
    body: 'Something prevented this browser from reaching Cebab. Copy the diagnostic for more detail and check the server log.',
  },
};
