import { useEffect, useState } from 'react';
import type { ParticipantControlView } from '../../store';

// Cluster C Phase 4g1: small pill cluster rendering muted / paused /
// kicked state for ONE participant. Mounted inline next to the agent's
// name in the activity bar (when that agent has any control state) and
// reusable as a per-row badge in future C4g2 surfaces (participant cards,
// draft view, etc.).
//
// Render rules:
//   - returns null when the input is undefined OR all flags clear (the
//     "row exists because of a prior verb but everything has since been
//     resumed/unmuted" case).
//   - kicked has the loudest visual treatment (--err tint, "kicked" word).
//     Once kicked, no other pills are rendered — kick is terminal and
//     supersedes prior states for the operator's mental model.
//   - paused includes a live countdown "Xs left" / "Xm left" derived
//     from `pausedUntil - now`. Re-ticks every second so the value
//     reflects elapsed time without forcing a full activity-bar re-render
//     cadence on the parent. Stops ticking when the deadline passes.
//   - muted is the lightest pill (--info tint, no countdown).
//
// A11y: each pill carries `aria-label` with the reason code in parens
// when one is known, so a screen reader reads "muted, reason: ack_required"
// not just "muted". The pill text itself stays terse.

export type ParticipantStatePillsProps = {
  control: ParticipantControlView | undefined;
};

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0s left';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h left`;
}

function reasonSuffix(reasonCode?: string, reasonText?: string): string {
  if (reasonText && reasonText.trim().length > 0) return `: ${reasonText}`;
  if (reasonCode) return ` (${reasonCode})`;
  return '';
}

export function ParticipantStatePills({ control }: ParticipantStatePillsProps) {
  // Re-tick every 1s only when there's a live paused-until to count down.
  // Hooks must be called unconditionally — the gate inside the effect
  // skips the interval when there's nothing to refresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!control) return;
    if (control.pausedUntil === null || control.pausedUntil <= Date.now()) return;
    if (control.kickedAt !== null) return; // kick supersedes paused render
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [control]);

  if (!control) return null;

  // Kick supersedes — render only the kicked pill once a kick lands.
  if (control.kickedAt !== null) {
    const reason = reasonSuffix(control.kickReasonCode, control.kickReasonText);
    return (
      <span className="ma-control-pills" role="group" aria-label="participant control state">
        <span
          className="ma-control-pill is-kicked"
          aria-label={`kicked${reason}`}
          title={`This participant has been kicked from the session${reason ? '. Reason' + reason : ''}. They will not send or receive any further bus events.`}
        >
          <span aria-hidden="true">⨯</span> kicked
        </span>
      </span>
    );
  }

  const pills: JSX.Element[] = [];
  if (control.muted) {
    const reason = reasonSuffix(control.mutedReasonCode, control.mutedReasonText);
    pills.push(
      <span
        key="muted"
        className="ma-control-pill is-muted"
        aria-label={`muted${reason}`}
        title={`This participant is muted — outbound bus_send calls succeed for the agent but are dropped at the router${reason ? '. Reason' + reason : ''}.`}
      >
        <span aria-hidden="true">⊘</span> muted
      </span>,
    );
  }

  if (control.pausedUntil !== null && control.pausedUntil > now) {
    const reason = reasonSuffix(control.pauseReasonCode, control.pauseReasonText);
    const remainingMs = control.pausedUntil - now;
    const remaining = formatRemaining(remainingMs);
    const expiryAction =
      control.pauseExpiryAction === 'auto_kick'
        ? 'auto-kick'
        : control.pauseExpiryAction === 'auto_resume'
          ? 'auto-resume'
          : 'expiry';
    pills.push(
      <span
        key="paused"
        className="ma-control-pill is-paused"
        aria-label={`paused, ${remaining}, expiry action ${expiryAction}${reason}`}
        title={`Paused — incoming deliverTurn calls queue behind the gate. On expiry, ${expiryAction}${reason ? '. Reason' + reason : ''}.`}
      >
        <span aria-hidden="true">⏸</span> paused · {remaining}
      </span>,
    );
  }

  if (pills.length === 0) return null;
  return (
    <span className="ma-control-pills" role="group" aria-label="participant control state">
      {pills}
    </span>
  );
}
