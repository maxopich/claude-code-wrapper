import { useState } from 'react';
import type { RouterDropView } from '../../store';

// Cluster B Phase 6d (UI-B27 / spec §6.1 D4): RouterDropsLog panel — rows
// for the modal RouterDropsCounter opens.
//
// Per UI-B27: each row shows
//   - ts                       (client-receive-time; the server's audit row
//                               is the authoritative ts, this is the
//                               best-available client-side label)
//   - source → intended dest   (formatted with arrow)
//   - reason chip              (color-coded per reasonCode severity)
//   - expandable raw payload   (auditRowId + kind + raw shape so an
//                               operator can correlate to safety_audit DB)
//
// Reason-code → severity tint:
//   - forged_source       — danger (F3, spoof attempt)
//   - worker_to_user      — warn (F2, wrong recipient)
//   - worker_to_worker    — warn (F2, bypass orchestrator)
//   - unknown_source      — warn (F2, source not in roster)
//   - muted_source        — info (Cluster C Phase 4b: operator muted
//                                 this agent; drop is intended, not a
//                                 security violation, so it tints info
//                                 not warn)
//   - kicked_source       — info (Cluster C Phase 4d: drain-in-progress
//                                 outbound from kicked agent's in-flight
//                                 turn; operator-driven, not alarming)
//   - kicked_destination  — info (Cluster C Phase 4d: stale routing
//                                 attempt addressed at a kicked agent;
//                                 operator-driven, not alarming)
//   - unknown_destination — warn (register B16: a legitimate participant
//                                 addressed a name nobody has; the message
//                                 is lost and the sender was told otherwise)
//   - unauthorized_sink   — warn (register B08: an agent addressed `_sink`
//                                 without being entitled to end the run —
//                                 in chain mode anyone but the last
//                                 participant, in orchestrator mode anyone)
//   - self_addressed      — warn (register B24: source === destination; the
//                                 sender would have been woken with its own
//                                 text, looping until the budget ran out)
//
// Forged-source is the only danger tier — it's a spoof attempt. F2 routing
// violations tint warn. Operator-driven mute/kick drops tint info because
// the operator explicitly asked for them; they belong in the log as
// forensics (so "what did the muted agent try to say?" or "did the
// orchestrator try to talk to the kicked worker after the kick?" is
// recoverable) but are expected, not alarming.

const REASON_TINT: Record<RouterDropView['reasonCode'], string> = {
  forged_source: 'router-drops-reason-danger',
  worker_to_user: 'router-drops-reason-warn',
  worker_to_worker: 'router-drops-reason-warn',
  unknown_source: 'router-drops-reason-warn',
  muted_source: 'router-drops-reason-info',
  kicked_source: 'router-drops-reason-info',
  kicked_destination: 'router-drops-reason-info',
  // Register B16: warn, not info. Nobody asked for this one — a real
  // participant addressed a name that does not exist, so a message the
  // sender was told had been delivered is gone.
  unknown_destination: 'router-drops-reason-warn',
  // Register B08: an agent tried to end the run without being entitled to.
  // Warn, not danger — danger is reserved for `forged_source`, which is an
  // identity spoof; this is a routing-authorization failure by a participant
  // who is who it claims to be.
  unauthorized_sink: 'router-drops-reason-warn',
  // Register B24: an agent addressed itself. Warn — nobody asked for it, and
  // left unchecked it burns the hop budget without another agent running.
  self_addressed: 'router-drops-reason-warn',
};

const REASON_LABEL: Record<RouterDropView['reasonCode'], string> = {
  forged_source: 'forged source (F3)',
  worker_to_user: 'worker → user (F2)',
  worker_to_worker: 'worker → worker (F2)',
  unknown_source: 'unknown source (F2)',
  muted_source: 'muted source',
  kicked_source: 'kicked source (drain)',
  kicked_destination: 'kicked destination',
  unknown_destination: 'unknown destination',
  // No `(F2)` suffix on these two: the siblings carry it because they came
  // from that hardening pass, and tagging a new rule with it would be false.
  unauthorized_sink: 'not entitled to end the run',
  self_addressed: 'addressed itself',
};

function formatTime(ts: number): string {
  // Match the elsewhere-format: HH:MM:SS to fit in a chip-width column.
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function RouterDropsLog(props: { drops: RouterDropView[] }) {
  const { drops } = props;
  if (drops.length === 0) {
    return <div className="router-drops-log-empty">No router drops recorded for this session.</div>;
  }
  // Newest first — operators care most about what just happened.
  const sorted = [...drops].sort((a, b) => b.receivedAt - a.receivedAt);
  return (
    <ul className="router-drops-log" aria-label="Router drops">
      {sorted.map((d) => (
        <RouterDropRow key={d.auditRowId} drop={d} />
      ))}
    </ul>
  );
}

function RouterDropRow(props: { drop: RouterDropView }) {
  const { drop } = props;
  const [open, setOpen] = useState(false);
  return (
    <li className="router-drops-row">
      <button
        type="button"
        className="router-drops-row-summary"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <time className="router-drops-row-ts" dateTime={new Date(drop.receivedAt).toISOString()}>
          {formatTime(drop.receivedAt)}
        </time>
        <span className="router-drops-row-route">
          <code className="router-drops-row-source">{drop.source}</code>
          <span className="router-drops-row-arrow" aria-hidden="true">
            →
          </span>
          <code className="router-drops-row-dest">{drop.destination}</code>
        </span>
        <span className={`router-drops-reason-chip ${REASON_TINT[drop.reasonCode]}`}>
          {REASON_LABEL[drop.reasonCode]}
        </span>
        <span className="router-drops-row-glyph" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <dl className="router-drops-row-detail">
          <div className="router-drops-row-detail-row">
            <dt>Event kind</dt>
            <dd>
              <code>{drop.kind}</code>
            </dd>
          </div>
          <div className="router-drops-row-detail-row">
            <dt>Reason code</dt>
            <dd>
              <code>{drop.reasonCode}</code>
            </dd>
          </div>
          <div className="router-drops-row-detail-row">
            <dt>Audit row id</dt>
            <dd>
              <code className="router-drops-row-audit-id">{drop.auditRowId}</code>
            </dd>
          </div>
          <div className="router-drops-row-detail-row">
            <dt>Source / dest</dt>
            <dd>
              <code>{drop.source}</code> → <code>{drop.destination}</code>
            </dd>
          </div>
        </dl>
      )}
    </li>
  );
}
