/**
 * PR-1: Honesty banners for the multi-agent settings surface.
 *
 * Two banners, neither dismissible:
 *
 *  1. `<BypassPermissionsBanner />` (warning) — always-on whenever
 *     multi-agent UI is visible. Surfaces the load-bearing safety
 *     signal that today is invisible in the UI but baked into every
 *     bus run (`server/src/bus/runner.ts` sets `permissionMode:
 *     'bypassPermissions'` + `allowDangerouslySkipPermissions: true` for
 *     every participant). Mounted at the top of `.multi-agent-draft-body`
 *     AND inside the expanded preview modal's header.
 *
 *  2. `<CustomModeBanner />` (info) — fires only when a stored template
 *     has `mode === 'custom'`. The custom-mode renderer is a stub
 *     (`layoutCustomGrid` delegates to orchestrator); the banner makes
 *     the approximation visible.
 *
 * A11y posture:
 *  - Bypass banner uses `role="alert"` on first mount per session so
 *    screen readers announce the safety statement once, then
 *    `role="status"` on subsequent mounts (modal opens, re-renders) to
 *    avoid alert-spam fatigue. "Per session" = sessionStorage key.
 *  - CustomMode banner is `role="status"` (the condition is informational,
 *    not safety-critical).
 *
 * Shape-coded, never relying on color alone: `⚠` for warning, `ⓘ` for
 * info. CSS in `styles.css` `.tpl-banner` block.
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
