import { useEffect, useState } from 'react';

// Cluster G Phase 4 (D6/D11) BusInstalledBadge: 30-second highlight on a
// participant row, mounted alongside the existing
// `.participant-bus-tag.installed` chip, that announces "this project's
// bus install just landed". The visual reinforcement to Cluster A's
// `bus_auto_installed` info toast — operators who blink past the toast
// still see the badge on the participant row for 30s.
//
// State source: the parent (MultiAgentTab DraftView) passes
// `installedAt`, which is `lastBusInstallAt[projectId]` from the store.
// That map is populated only by `bus_integration_changed { installed:
// true }` reducer arm, which the server emits AFTER the bus trust gate
// in `install_trust_gate.ts` has dual-written `bus.trust_decided` +
// `projects.bus_trust_decision`. So the badge appearing IS proof an
// audit row exists — the agentic-reviewer's anti-pattern guard (spec
// §4.4 "BusInstalledBadge MUST NOT appear unless a corresponding
// safety_audit row exists for the trust decision + install") is
// satisfied structurally.
//
// Why 30 seconds and not "until next render":
//   - operators who switch tabs mid-install should still see the
//     highlight when they come back (within window)
//   - the toast TTL in the dock is shorter than that for info-tier; the
//     badge picks up the affordance gap
//   - a session-long highlight would lose its "this just changed" signal
//
// `prefers-reduced-motion` is honored by CSS — the
// `.bus-installed-badge` class declares opacity-only transitions under
// the reduced-motion media query, while the default keyframe is
// allowed to use small transforms.

/** Total highlight window in ms. Spec §5 D6/D11: "30-second highlight". */
export const HIGHLIGHT_MS = 30_000;

export type BusInstalledBadgeProps = {
  /**
   * ms since epoch when `bus_integration_changed { installed: true }`
   * was observed for this project. `undefined` means no install event
   * during this session — badge renders nothing (the anti-pattern guard
   * relies on this short-circuit; a pre-existing bus install from
   * before the page loaded has no entry in `lastBusInstallAt` and
   * therefore no badge).
   */
  installedAt: number | undefined;
};

export function BusInstalledBadge({ installedAt }: BusInstalledBadgeProps) {
  // Local visibility state so the 30s window controls the render cycle
  // directly. Initial render computes whether we're still inside the
  // window; subsequent timeouts flip to false when the window closes.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (installedAt === undefined) {
      setVisible(false);
      return;
    }
    const remaining = HIGHLIGHT_MS - (Date.now() - installedAt);
    if (remaining <= 0) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timerId = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(timerId);
  }, [installedAt]);

  if (!visible) return null;

  // role="status" + aria-live="polite" so screen readers announce the
  // highlight on appearance without preempting whatever the operator
  // is doing. The glyph is decorative (hidden from AT) — the visible
  // text "installed" is what gets read.
  return (
    <span className="bus-installed-badge" role="status" aria-live="polite">
      <span aria-hidden="true" className="bus-installed-badge-glyph">
        ✓
      </span>
      installed
    </span>
  );
}
