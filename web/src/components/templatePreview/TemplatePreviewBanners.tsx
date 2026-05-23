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
 * A11y posture:
 *  - Bypass banner uses `role="alert"` on first mount per session so
 *    screen readers announce the safety statement once, then
 *    `role="status"` on subsequent mounts (modal opens, re-renders) to
 *    avoid alert-spam fatigue. "Per session" = sessionStorage key.
 *  - CustomMode banner is `role="status"` (the condition is informational,
 *    not safety-critical).
 *  - CustomModeNotice is plain prose; the surrounding banner already
 *    carries the announcement, so the notice has no role attribute.
 *
 * Shape-coded, never relying on color alone: `⚠` for warning, `ⓘ` for
 * info. CSS in `styles.css` `.tpl-banner` block; notice in `.tpl-preview-note`.
 */
import { useState } from 'react';

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
    <div className="tpl-banner is-warn" role={firstMount ? 'alert' : 'status'}>
      <span className="tpl-banner-glyph" aria-hidden="true">
        ⚠
      </span>
      <div className="tpl-banner-text">
        <div className="tpl-banner-title">Auto-approved tool calls</div>
        <div className="tpl-banner-body">
          Every participant in a multi-agent session auto-approves tool calls (
          <code>bypassPermissions</code>). There is no per-tool prompt during the run.
        </div>
      </div>
    </div>
  );
}

export function CustomModeBanner() {
  return (
    <div className="tpl-banner is-info" role="status">
      <span className="tpl-banner-glyph" aria-hidden="true">
        ⓘ
      </span>
      <div className="tpl-banner-text">
        <div className="tpl-banner-title">Custom topology preview</div>
        <div className="tpl-banner-body">
          This topology preview is an approximation — custom routing isn't fully visualized yet.
        </div>
      </div>
    </div>
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
 * supporting copy, not a separate landmark.
 */
export function CustomModeNotice() {
  return (
    <p className="tpl-preview-note">
      This template was saved as <code>custom</code>. The current build renders it using
      orchestrator routing.
    </p>
  );
}
