import { useEffect, useMemo, useState } from 'react';
import type { RouterDropView } from '../../store';
import { RouterDropsModal } from './RouterDropsModal';

// Cluster B Phase 6d (UI-B24 / B28 / spec §6.3): activity-bar counter chip
// for router drops. Mounts next to MutationsCounterChip in
// MultiAgentActivityBar.
//
// UI-B24: rendered ONLY when count ≥ 1 (zero = hidden — operator's brain
// doesn't need a "0 drops" chip taking up bar space). UI-B28's "zero=gray-
// chip-hidden" is the same intent.
//
// UI-B28 four-regime calibration:
//   zero       — chip hidden
//   occasional — yellow (≤ 3 drops, no recent burst)
//   persistent — orange (4-9 drops OR ≥ 1/min sustained)
//   burst      — red (≥ 10 drops total OR ≥ 5 drops in a 30s window)
//
// The thresholds are tuned for the 4 router-drop sites
// (`bus/orchestrator.ts:518-557`) — under healthy operation drops should be
// zero. ANY drop is worth surfacing; the regimes are about urgency, not
// "should you care at all".
//
// Spec §6.3 says zero=`--fg-3`, occasional=`--warn`, persistent=`--warn` +
// sparkline, burst=`--err`. The sparkline is deferred until the data
// pipeline has enough resolution to make a sparkline informative — Phase 6d
// ships the chip; the sparkline would be a polish PR. Persistent uses the
// same warn token as occasional but with the orange-tint background.
//
// Click opens RouterDropsLog in a modal — the spec's UI-B25 talks about
// LogsModal pre-filtered by `kind=router_drop`, but the cross-cluster
// LogRowKind widening is a separate follow-up; the modal approach gives
// operators the per-drop detail today.

type Regime = 'occasional' | 'persistent' | 'burst';

const BURST_WINDOW_MS = 30_000;
const BURST_THRESHOLD = 5;
const PERSISTENT_TOTAL = 4;
const BURST_TOTAL = 10;

function classifyRegime(drops: RouterDropView[], now: number): Regime {
  const total = drops.length;
  if (total >= BURST_TOTAL) return 'burst';
  const recent = drops.filter((d) => now - d.receivedAt <= BURST_WINDOW_MS).length;
  if (recent >= BURST_THRESHOLD) return 'burst';
  if (total >= PERSISTENT_TOTAL) return 'persistent';
  return 'occasional';
}

const REGIME_CLASS: Record<Regime, string> = {
  occasional: 'ma-router-drops-chip-occasional',
  persistent: 'ma-router-drops-chip-persistent',
  burst: 'ma-router-drops-chip-burst',
};

const REGIME_TOOLTIP: Record<Regime, string> = {
  occasional: 'Router drops detected. Each drop already wrote a safety_audit row.',
  persistent:
    'Multiple drops — bus router is rejecting events consistently. ' +
    'Check participant config (forged-source guard / orchestrator routing).',
  burst:
    'Burst of router drops in a short window. Investigate participants for ' +
    'a routing-rule violation or a misconfigured forwarder.',
};

export function RouterDropsCounter(props: { drops: RouterDropView[]; sessionId: string }) {
  const { drops, sessionId } = props;
  const [open, setOpen] = useState(false);

  // Regime is time-sensitive (burst depends on a rolling window). Recompute
  // every 5s so the chip can decay back to a lower regime as drops age out
  // of the burst window — operator's eye on the chip should track reality.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (drops.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, [drops.length]);

  const regime = useMemo(
    () => (drops.length === 0 ? null : classifyRegime(drops, now)),
    [drops, now],
  );

  // UI-B24: hidden when count = 0. The parent could short-circuit too, but
  // doing it here keeps the chip self-contained.
  if (drops.length === 0 || !regime) return null;

  const label = `${drops.length} drop${drops.length === 1 ? '' : 's'}`;
  return (
    <>
      <button
        type="button"
        className={`ma-router-drops-chip ${REGIME_CLASS[regime]}`}
        title={`${REGIME_TOOLTIP[regime]} Click to view detail.`}
        aria-label={`Router drops: ${drops.length} (${regime}). Click to view detail.`}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">✕</span>
        {label}
      </button>
      {open && (
        <RouterDropsModal drops={drops} sessionId={sessionId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
