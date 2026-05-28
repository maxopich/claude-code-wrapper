import { useEffect, useState } from 'react';
import type { ParticipantControlView } from '../../store';
import { countControlledParticipants } from '../../store';
import type { MultiAgentRun } from '../../store';

// Cluster C Phase 4g1: aggregate "N controlled" chip for the
// MultiAgentActivityBar. Mounts next to RouterDropsCounter; same render seam.
//
// Counts participants whose latest control state is "actively constrained":
// muted, paused (and not yet expired), or kicked. A row with all-clear flags
// (the remainder after a resume / unmute that never advanced to kick) is
// NOT counted — see `countControlledParticipants` in `store.ts`.
//
// Hidden when count = 0. Operator's brain shouldn't burn pixels on a "0
// controlled" chip while everything is green. Same UI-B24 intent as the
// RouterDropsCounter chip.
//
// Phase 4g1 ships READ-ONLY: tooltip shows the breakdown but the chip is
// not interactive yet. Click-to-open detail panel + ⋮-menu affordances
// land in Phase 4g2 (the next slice).
//
// Tint: --info by default (operator-initiated controls are informational,
// not warnings). If any controlled participant is in `kicked` state we
// upgrade to --warn — kick is a stronger statement and worth a visual
// nudge so the operator notices the participant is permanently out of
// the loop for this session.

export type ParticipantControlsCounterProps = {
  run: MultiAgentRun;
};

function summarizeBreakdown(
  controls: Record<number, ParticipantControlView>,
  now: number,
): { muted: number; paused: number; kicked: number } {
  let muted = 0;
  let paused = 0;
  let kicked = 0;
  for (const c of Object.values(controls)) {
    if (c.kickedAt !== null) {
      // Kick is terminal and visually loudest — count it under "kicked"
      // even if the participant was previously muted. The breakdown is
      // for operator triage, not arithmetic; total = sum of buckets +
      // (any participant with both mute AND paused alive). For the v1
      // tooltip we keep it simple: kicked supersedes other flags here.
      kicked += 1;
      continue;
    }
    if (c.muted) muted += 1;
    if (c.pausedUntil !== null && c.pausedUntil > now) paused += 1;
  }
  return { muted, paused, kicked };
}

export function ParticipantControlsCounter({ run }: ParticipantControlsCounterProps) {
  // Re-tick every 5s so a paused entry whose deadline passed without the
  // server's auto_resume/auto_kick echo landing yet (rare — server fires
  // synchronously on the timer) decays out of the count without waiting
  // for an unrelated re-render. Same cadence as RouterDropsCounter.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const hasPausedAlive = Object.values(run.participantControls).some(
      (c) => c.pausedUntil !== null && c.pausedUntil > Date.now(),
    );
    if (!hasPausedAlive) return;
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, [run.participantControls]);

  const n = countControlledParticipants(run, now);
  if (n === 0) return null;

  const breakdown = summarizeBreakdown(run.participantControls, now);
  const anyKicked = breakdown.kicked > 0;

  // The breakdown reads as "muted X · paused Y · kicked Z" with zero-
  // buckets elided. e.g. "muted 1 · kicked 1" or "paused 2".
  const parts: string[] = [];
  if (breakdown.muted > 0) parts.push(`muted ${breakdown.muted}`);
  if (breakdown.paused > 0) parts.push(`paused ${breakdown.paused}`);
  if (breakdown.kicked > 0) parts.push(`kicked ${breakdown.kicked}`);
  const breakdownText = parts.join(' · ');

  return (
    <span
      className={`ma-participant-controls-chip${anyKicked ? ' has-kicked' : ''}`}
      aria-label={`${n} participant${n === 1 ? '' : 's'} controlled (${breakdownText})`}
      title={
        anyKicked
          ? `${n} participant${n === 1 ? '' : 's'} controlled this session: ${breakdownText}. At least one has been kicked — they're out of the loop until the session ends.`
          : `${n} participant${n === 1 ? '' : 's'} controlled this session: ${breakdownText}.`
      }
    >
      <span aria-hidden="true">◌</span> {n} controlled
    </span>
  );
}
