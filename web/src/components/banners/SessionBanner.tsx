// Cluster D Phase 3 (spec §8.1): unified <SessionBanner> component.
//
// One generic shell for every per-session banner the operator can see —
// today the migrated set (BypassPermissions, CustomMode, the three
// `.multi-agent-warning` recovery banners in `MultiAgentTab.tsx`) and
// tomorrow the four new recovery banners Phases 4-7 land (RateLimit,
// AuthExpired, SweptSession, ChainReconstruction).
//
// Why one component, not six:
//
//   - **Priority sort + max-3 stacking** is BannerStack's job, but only
//     works if every banner shares a tier vocabulary. SessionBanner's
//     `tier` prop is that vocabulary; BannerStack reads it.
//   - **A11y mapping is tier-driven** (spec §8.4): role + aria-live +
//     focus-stealing all derive from tier. Per-component duplication of
//     that mapping is how the existing banners drift (BypassBanner
//     already does its own first-mount alert dance; multi-agent-warning
//     just hard-codes `role="status"`). Centralising it removes the
//     drift surface.
//   - **Snapshot parity during migration**: spec §8.1 keeps
//     `.tpl-banner` + `.multi-agent-warning` CSS classes as a compat
//     layer for one release. `classStem` + `compatClass` + `layout`
//     together let migrated banners render byte-identical DOM so the
//     visual diff during the Phase 3 PR is zero. New banners (Phases
//     4-7) won't pass these; the `.session-banner-*` styles cover them.
//
// Focus-stealing on danger tier is implemented here (Phase 3) even
// though the only danger-tier callers (`AuthExpiredBanner`,
// `SweptSessionBanner`) ship in Phases 5/6. The hook is one-time per
// banner-id; persistent across re-renders via a per-id sessionStorage
// flag so a page reload mid-flow doesn't keep stealing.

import React, { useEffect, useRef, useState } from 'react';

export type BannerTier = 'info' | 'warn' | 'progress' | 'error' | 'danger' | 'invariant';

export type BannerAction = {
  /** Visible label; also the accessible name. */
  label: string;
  /** Click handler. Either onClick or href must be supplied. */
  onClick?: () => void;
  /** Renders as an <a> instead of a <button>. */
  href?: string;
  /** Primary = the eye-catching call-to-action; ghost = secondary/cancel. */
  variant?: 'primary' | 'ghost';
  /** Spinner + disabled state for async actions (e.g. "Retrying…"). */
  pending?: boolean;
  /** Hover tooltip; reused as aria-label when label is opaque. */
  title?: string;
  /** Disable for transient gates (e.g. countdown active). */
  disabled?: boolean;
};

export type SessionBannerProps = {
  /** Stable across re-renders. Used by BannerStack for sort keys and by
   * the focus-once mechanism to dedupe steals per banner instance. */
  id: string;
  /** Drives styling, priority sort, role + aria-live, and (for danger)
   * the one-time focus steal. */
  tier: BannerTier;
  /** Bold leading line. Optional — some migrated banners (the multi-agent
   * warnings) keep their title inline inside `body` for prose-flow reasons;
   * those pass title omitted. */
  title?: string;
  /** Free-form prose. Accepts ReactNode so migrated banners can preserve
   * their existing `<p><strong>…</strong></p>` shape; new banners pass
   * a string. */
  body?: React.ReactNode;
  /** One leading character — `⚠`, `ⓘ`, `⏳`, etc. CSS forces text-emoji
   * rendering (so forced-colors mode reads the shape, not the platform
   * emoji). */
  glyph?: string;
  /** ≤3 entries by convention; spec §8.1 is not a hard cap but >3 buttons
   * crowds the banner. Order = visual order. */
  actions?: BannerAction[];
  /** Dismiss button in the top-right. Banners without a dismiss prop are
   * non-dismissible (the default for recovery banners — they reflect a
   * state that can't honestly be hidden). */
  dismiss?: () => void;
  /** Collapsed `<details>` panel under the body — for `RecoveryDisclosure`
   * (awaiting-continue) and similar long-form context. */
  detail?: React.ReactNode;
  /** Summary text for `detail`'s `<summary>`. Defaults to "Details". */
  detailLabel?: string;
  /** Override role/aria-live for the rare case the tier-default mapping
   * doesn't fit (e.g. BypassPermissionsBanner's first-mount-alert dance).
   * Otherwise leave undefined and let the tier drive it. */
  role?: 'alert' | 'status' | 'region';
  ariaLive?: 'off' | 'polite' | 'assertive';
  /** Legacy CSS class added alongside `classStem` for Phase 3 migration
   * parity (e.g. `"is-warn"` to match `.tpl-banner.is-warn`). When
   * provided, the tier-derived `is-${tier}` class is suppressed so the
   * legacy class is the sole tier signal. Removed in a later release. */
  compatClass?: string;
  /** Override the default tier→focus-steal mapping. Danger steals once
   * unless explicitly turned off; other tiers never steal unless this
   * is `true`. */
  stealsFocus?: boolean;
  /** Override the rendered className stem ("session-banner" by default).
   * Phase 3 uses this to swap the prefix to `tpl-banner` or
   * `multi-agent-warning` so migrated banners render their pre-existing
   * markup (same root class, same inner class names). */
  classStem?: string;
  /** DOM layout shape.
   *   - `grid` (default): glyph cell + `.${stem}-text` wrapper + actions
   *     inside the wrapper. Used by `.tpl-banner` and the new
   *     `.session-banner` style.
   *   - `flat`: no glyph cell, no `-text` wrapper; body / actions /
   *     detail render as direct children of the root. Used by the
   *     migrated multi-agent inline warnings, which historically have no
   *     glyph and put the title inline inside the body prose. */
  layout?: 'grid' | 'flat';
};

// ---- A11y tier mapping (spec §8.4) ----------------------------------
//
// Tier → (role, aria-live) is the canonical mapping. Override via the
// per-banner `role` / `ariaLive` props only when the call site has a
// specific reason (today: BypassPermissionsBanner's first-mount alert).
function ariaForTier(tier: BannerTier): {
  role: 'alert' | 'status' | 'region';
  ariaLive: 'off' | 'polite' | 'assertive';
} {
  switch (tier) {
    case 'info':
    case 'invariant':
      // Invariant = always-on context (BypassPermissionsBanner), not an
      // event. Region landmark; no live announcement.
      return { role: 'region', ariaLive: 'off' };
    case 'warn':
    case 'progress':
      return { role: 'region', ariaLive: 'polite' };
    case 'error':
    case 'danger':
      // Danger gets assertive; the focus steal handles the harder cue.
      return { role: 'region', ariaLive: 'assertive' };
  }
}

// Focus-steal-once memory. Per banner-id, per browser tab session.
// `sessionStorage` (not `localStorage`) so a fresh tab re-announces; not
// at all so a closed-and-reopened browser re-announces. Granularity per
// id (not per tier) so re-mounting the same banner (e.g. modal opens
// and closes) doesn't re-steal, but two different danger banners in
// the same tab do each get their one steal.
const FOCUS_STEAL_PREFIX = 'cebab.banner.focused.';
function consumeFocusOnce(id: string): boolean {
  try {
    const key = FOCUS_STEAL_PREFIX + id;
    if (sessionStorage.getItem(key) === '1') return false;
    sessionStorage.setItem(key, '1');
    return true;
  } catch {
    // Private mode etc. — treat as already-stolen rather than spam-focus.
    return false;
  }
}

export function SessionBanner(props: SessionBannerProps): React.ReactElement {
  const {
    id,
    tier,
    title,
    body,
    glyph,
    actions,
    dismiss,
    detail,
    detailLabel,
    role,
    ariaLive,
    compatClass,
    stealsFocus,
    classStem = 'session-banner',
    layout = 'grid',
  } = props;

  const aria = ariaForTier(tier);
  const effectiveRole = role ?? aria.role;
  const effectiveAriaLive = ariaLive ?? aria.ariaLive;
  const wantsFocusSteal = stealsFocus ?? tier === 'danger';

  // Focus-once ref for the primary action (or root). React's strict-mode
  // double-mount in dev is fine: consumeFocusOnce flips storage on first
  // call so the second mount sees false.
  const [shouldFocus] = useState(() => (wantsFocusSteal ? consumeFocusOnce(id) : false));
  const focusTargetRef = useRef<HTMLButtonElement | HTMLAnchorElement | HTMLDivElement | null>(
    null,
  );
  useEffect(() => {
    if (!shouldFocus) return;
    // Defer to next tick so the focus lands after the banner is in the
    // accessibility tree (matters for VoiceOver / NVDA arrival cues).
    const t = window.setTimeout(() => focusTargetRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [shouldFocus]);

  // Class composition rules (Phase 3 migration parity, spec §8.1):
  //
  //   - Default mode (`classStem === 'session-banner'`):
  //     emit `session-banner is-${tier}` (+ optional compatClass) →
  //     tier-driven styling for new banners.
  //   - Migration mode (any other `classStem`, e.g. `tpl-banner` or
  //     `multi-agent-warning`):
  //     emit `${classStem}` plus whatever `compatClass` adds; SUPPRESS
  //     `is-${tier}`. The legacy CSS carries its own tier conventions
  //     (`.tpl-banner.is-warn`, `.multi-agent-warning` has no tier class
  //     at all). Auto-emitting `is-invariant` next to the legacy classes
  //     would mean two competing tier classes on the same node, and
  //     snapshot tests against the pre-migration markup would diff. The
  //     caller passes whatever legacy tier class is needed via
  //     `compatClass`.
  //
  // We deliberately don't emit a BEM `${classStem}--${tier}` form — it
  // would just be DOM noise for either path.
  const isMigrationMode = classStem !== 'session-banner';
  const tierClass = isMigrationMode ? null : `is-${tier}`;
  const rootClassNames = [classStem, tierClass, compatClass].filter(Boolean).join(' ');

  // Flat layout hoists content children directly into the root, no glyph
  // cell, no `-text` wrapper. Used by the migrated multi-agent inline
  // warnings, where the historical DOM was `<div class="multi-agent-
  // warning"><p>…</p><div class="…-actions">…</div></div>`.
  const isFlat = layout === 'flat';
  const hasActions = !!(actions && actions.length > 0);

  const renderTitle = () => (title ? <div className={`${classStem}-title`}>{title}</div> : null);
  const renderBody = () => (body ? <div className={`${classStem}-body`}>{body}</div> : null);
  const renderActions = () =>
    hasActions ? (
      <div className={`${classStem}-actions`}>
        {actions!.map((a, i) => {
          // First primary action is the focus-steal target; if no
          // primary, the first action wins.
          const isFocusTarget =
            shouldFocus &&
            ((a.variant === 'primary' &&
              i === actions!.findIndex((x) => x.variant === 'primary')) ||
              (!actions!.some((x) => x.variant === 'primary') && i === 0));
          const focusRef = isFocusTarget
            ? (focusTargetRef as React.Ref<HTMLButtonElement | HTMLAnchorElement>)
            : undefined;
          const className =
            a.variant === 'primary' ? 'primary-btn' : a.variant === 'ghost' ? 'ghost-btn' : '';
          if (a.href) {
            return (
              <a
                key={i}
                href={a.href}
                className={className || undefined}
                title={a.title}
                onClick={a.onClick}
                ref={focusRef as React.Ref<HTMLAnchorElement>}
              >
                {a.pending ? <span className="btn-spinner" aria-hidden="true" /> : null}
                {a.label}
              </a>
            );
          }
          return (
            <button
              key={i}
              type="button"
              className={className || undefined}
              onClick={a.onClick}
              title={a.title}
              disabled={a.disabled || a.pending}
              ref={focusRef as React.Ref<HTMLButtonElement>}
            >
              {a.pending ? <span className="btn-spinner" aria-hidden="true" /> : null}
              {a.label}
            </button>
          );
        })}
      </div>
    ) : null;
  const renderDetail = () =>
    detail ? (
      <details className={`${classStem}-detail`}>
        <summary>{detailLabel ?? 'Details'}</summary>
        {detail}
      </details>
    ) : null;

  // Focus target for keyboard-trap-free arrival: the primary action if
  // any (set inside renderActions via focusRef), else the root itself
  // with tabIndex=-1 so VoiceOver lands somewhere meaningful. We only
  // emit tabIndex when the focus-steal is actually wired up — otherwise
  // it's spurious DOM noise and breaks strict snapshot parity on the
  // migrated banners (which don't steal focus).
  const wantsRootFocus = shouldFocus && !hasActions;
  const rootRef = wantsRootFocus ? (focusTargetRef as React.Ref<HTMLDivElement>) : undefined;

  return (
    <div
      id={id}
      className={rootClassNames}
      role={effectiveRole}
      aria-live={effectiveAriaLive === 'off' ? undefined : effectiveAriaLive}
      ref={rootRef}
      tabIndex={wantsRootFocus ? -1 : undefined}
    >
      {!isFlat && glyph && (
        <span className={`${classStem}-glyph`} aria-hidden="true">
          {glyph}
        </span>
      )}
      {isFlat ? (
        <>
          {renderTitle()}
          {renderBody()}
          {renderActions()}
          {renderDetail()}
        </>
      ) : (
        <div className={`${classStem}-text`}>
          {renderTitle()}
          {renderBody()}
          {renderActions()}
          {renderDetail()}
        </div>
      )}
      {dismiss && (
        <button
          type="button"
          className={`${classStem}-dismiss`}
          aria-label="Dismiss"
          onClick={dismiss}
        >
          ×
        </button>
      )}
    </div>
  );
}
