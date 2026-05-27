/**
 * PR-1 / PR-2: Honesty surfaces for the multi-agent settings.
 *
 * Three exports, all non-dismissible:
 *
 *  1. `<BypassPermissionsBanner />` (warning) — always-on whenever
 *     multi-agent UI is visible. Surfaces the load-bearing safety
 *     signal that today is invisible in the UI but baked into every
 *     bus run (`server/src/bus/runner.ts` sets `permissionMode:
 *     'bypassPermissions'` + `allowDangerouslySkipPermissions: true` for
 *     every participant). Mounted at the top of `.multi-agent-draft-body`
 *     AND inside the expanded preview modal's header.
 *
 *  2. `<CustomModeBanner />` (info, PR-1) — fires only when a stored
 *     template has `mode === 'custom'`. The custom-mode renderer is a
 *     stub (`layoutCustomGrid` delegates to orchestrator); the banner
 *     makes the *preview-is-an-approximation* part visible.
 *
 *  3. `<CustomModeNotice />` (plain prose, PR-2) — render-time
 *     companion to the banner. The banner says "approximation"; the
 *     notice states the **factual fallback** at the card level: the
 *     template was saved as `custom` but the build renders it via
 *     orchestrator routing. Two surfaces because the audiences differ:
 *     the banner is the screen-reader cue, the notice is the operator's
 *     "why does this template look like an orchestrator" answer.
 *
 * Cluster D Phase 3 migration (spec §8.1): the two banners now render
 * through `<SessionBanner>` with `classStem="tpl-banner"` so the DOM
 * stays byte-identical to the pre-migration markup (same root, same
 * `.tpl-banner-glyph`, same `.tpl-banner-text`/`.tpl-banner-title`/
 * `.tpl-banner-body` inside) while inheriting the tier→a11y mapping +
 * forthcoming focus-steal contract. Snapshot tests assert parity.
 * `CustomModeNotice` is plain prose, not a banner — left untouched.
 *
 * A11y posture (unchanged from PR-1):
 *  - Bypass banner uses `role="alert"` on first mount per session so
 *    screen readers announce the safety statement once, then
 *    `role="status"` on subsequent mounts. SessionBanner honours the
 *    explicit `role` override so this dance survives the migration.
 *  - CustomMode banner is `role="status"` (override the default
 *    `role="region"` for the info tier — the existing markup uses
 *    "status" and operator tools have learned to expect it there).
 *  - CustomModeNotice is plain prose; the surrounding banner already
 *    carries the announcement.
 *
 * Shape-coded, never relying on color alone: `⚠` for warning, `ⓘ` for
 * info.
 */
import { useState } from 'react';
import { SessionBanner } from '../banners/SessionBanner.js';

const BYPASS_SEEN_KEY = 'cebab.bypass-banner-seen';

/** True if this is the first time we're rendering the bypass banner in
 * the current browser tab session. Memoized at mount; never flips, so
 * the role attribute is stable for the lifetime of this banner instance. */
function consumeFirstMountFlag(): boolean {
  try {
    if (sessionStorage.getItem(BYPASS_SEEN_KEY) === '1') return false;
    sessionStorage.setItem(BYPASS_SEEN_KEY, '1');
    return true;
  } catch {
    // Private mode / disabled storage → treat as first-mount (announce once).
    return true;
  }
}

export function BypassPermissionsBanner() {
  // `useState` initializer runs once per mount, so each new mount in the
  // same session sees a `false` (already-seen) flag, and the very first
  // mount in a session gets `true` (announce via role="alert").
  const [firstMount] = useState<boolean>(consumeFirstMountFlag);
  return (
    <SessionBanner
      id="bypass-permissions-banner"
      // Invariant = "always-on context, bottom of stack" per spec §8.2.
      // Tier doesn't drive a11y here because we override role explicitly
      // to preserve the first-mount alert pattern from before migration.
      tier="invariant"
      glyph="⚠"
      title="Auto-approved tool calls"
      body={
        <>
          Every participant in a multi-agent session auto-approves tool calls (
          <code>bypassPermissions</code>). There is no per-tool prompt during the run.
        </>
      }
      role={firstMount ? 'alert' : 'status'}
      // Suppress aria-live entirely on subsequent mounts; the alert role
      // is its own announcement signal on first mount, and `region` +
      // polite would compete with that.
      ariaLive="off"
      // Phase 3 compat: render through `.tpl-banner.is-warn` so the
      // existing CSS keeps applying byte-identically and snapshot tests
      // pass.
      classStem="tpl-banner"
      compatClass="is-warn"
      stealsFocus={false}
    />
  );
}

export function CustomModeBanner() {
  return (
    <SessionBanner
      id="custom-mode-banner"
      tier="info"
      glyph="ⓘ"
      title="Custom topology preview"
      body="This topology preview is an approximation — custom routing isn't fully visualized yet."
      // Existing markup used role="status" for status-like info; preserve
      // that for operators relying on it. (The tier default for info
      // would have been role="region".)
      role="status"
      ariaLive="off"
      classStem="tpl-banner"
      compatClass="is-info"
      stealsFocus={false}
    />
  );
}

/**
 * PR-2: Plain-prose inline notice that pairs with `<CustomModeBanner />`.
 *
 * The banner above warns about preview fidelity ("approximation"); this
 * notice states the **concrete render fallback**: the template carries
 * `mode === 'custom'` but the running build draws it via the orchestrator
 * layout (`layoutCustomGrid` delegates there until the custom renderer
 * matures). Stored data is **not** auto-mutated — switching modes on a
 * persisted template is an explicit user action.
 *
 * No role/aria: the sibling banner already owns the announcement. This is
 * supporting copy, not a separate landmark. Not migrated to SessionBanner
 * — it's a `<p>`, not a banner.
 */
export function CustomModeNotice() {
  return (
    <p className="tpl-preview-note">
      This template was saved as <code>custom</code>. The current build renders it using
      orchestrator routing.
    </p>
  );
}
