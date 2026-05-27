// Cluster D Phase 3 (spec §8.2): the host that owns banner sort + cap +
// overflow. Single point of policy for the per-session banner zone.
//
// Why a separate component (instead of letting every caller stack
// banners themselves):
//
//   - **Priority must be enforced regardless of arrival order**.
//     `dispatch` ordering at the call sites is non-deterministic
//     (auth_expired and rate_limit can arrive in either order); the
//     stack must sort the same way every time so operator muscle memory
//     ("danger banner sits at top") holds.
//   - **The max-3 cap is a safety stance** (agentic-reviewer §5):
//     more than 3 simultaneous banners means the stack is its own
//     usability problem. Past 3, we collapse into "+N more" so the top
//     three remain readable instead of pushing scrollback off-screen.
//   - **Single landmark for screen readers** (spec §8.4): one
//     `role="region" aria-label="Session notices"` wraps every banner.
//     Only the top banner's title gets announced on arrival; the rest
//     are reachable by tab. Mounting banners as siblings (no stack)
//     would create N landmarks and the announcement vocabulary would
//     be overwhelming.
//
// Phase 3 ships the host + ordering policy; the per-tier banners that
// _populate_ the stack (rate-limit, auth-expired, swept-session,
// chain-reconstruction) land in Phases 4-7. The two banners that
// already exist (BypassPermissions, CustomMode) and the three
// multi-agent inline warnings (awaiting-continue, pending-retry,
// pending-mutation) are migrated to render via `<SessionBanner>` here
// in Phase 3; whether they go through `<BannerStack>` or stay as
// individual mounts depends on their call site. (`BypassPermissions`
// in particular is mounted both in DraftView and inside the template
// preview modal — those will keep being direct mounts; stacking is
// for the in-session per-recovery-event surfaces.)

import React from 'react';
import { SessionBanner, type BannerTier, type SessionBannerProps } from './SessionBanner.js';

// ---- Priority ordering (spec §8.2) ----------------------------------
//
// Lower number = higher priority (top of stack). `invariant` is the
// bottom because it's always-on context (BypassPermissionsBanner), not
// an event — it shouldn't visually compete with a fresh danger.
const TIER_PRIORITY: Record<BannerTier, number> = {
  danger: 0,
  error: 1,
  warn: 2,
  progress: 3,
  info: 4,
  invariant: 5,
};

export type BannerStackItem = SessionBannerProps & {
  /** When the banner first mounted; used as tiebreaker within a tier
   * so newest-of-same-priority renders on top. Defaults to insertion
   * order in `banners` prop. */
  arrivedAt?: number;
};

export type BannerStackProps = {
  /** Banners to render. The stack sorts them; caller-side order is not
   * authoritative. */
  banners: BannerStackItem[];
  /** Maximum visible before "+N more" collapse. Defaults to 3 per spec
   * §8.2; the prop is here mostly for tests (varying the cap to confirm
   * the overflow boundary). */
  maxVisible?: number;
  /** Optional className on the root region — for placement-specific
   * margins (e.g. `multi-agent-banner-stack`). */
  className?: string;
};

/**
 * Sort comparator: tier-priority asc, then arrivedAt desc within tier.
 * Stable across React re-renders because `arrivedAt` is caller-supplied
 * (the source-of-truth lives in whatever reducer/state owns the
 * banners).
 */
function compareBanners(a: BannerStackItem, b: BannerStackItem): number {
  const tierDiff = TIER_PRIORITY[a.tier] - TIER_PRIORITY[b.tier];
  if (tierDiff !== 0) return tierDiff;
  // Newer first within same tier.
  return (b.arrivedAt ?? 0) - (a.arrivedAt ?? 0);
}

export function BannerStack(props: BannerStackProps): React.ReactElement | null {
  const { banners, maxVisible = 3, className } = props;
  if (banners.length === 0) return null;

  // Defensive copy — never mutate the caller's array.
  const sorted = [...banners].sort(compareBanners);
  const visible = sorted.slice(0, maxVisible);
  const overflow = sorted.slice(maxVisible);

  const rootClass = ['session-banner-stack', className].filter(Boolean).join(' ');

  return (
    <section className={rootClass} role="region" aria-label="Session notices">
      {visible.map((b) => (
        <SessionBanner key={b.id} {...b} />
      ))}
      {overflow.length > 0 && (
        <details className="session-banner-stack-overflow">
          <summary>
            +{overflow.length} more notice{overflow.length === 1 ? '' : 's'}
          </summary>
          <div className="session-banner-stack-overflow-body">
            {overflow.map((b) => (
              <SessionBanner key={b.id} {...b} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
