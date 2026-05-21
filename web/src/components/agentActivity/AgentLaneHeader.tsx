/**
 * One lane's header: monogram + name + status + counters.
 *
 * Status derivation:
 *   - If `activity?.agentName === lane.agentName`, use the live phase
 *     (`working` / `stalled` / `idle`). The activity tick is ephemeral
 *     and only ever pinned to one agent at a time.
 *   - Otherwise, the lane is idle in the heartbeat sense. We label as
 *     `done` when the lane has any events (it did something earlier in
 *     the run) and `idle` when it has none (declared participant, no
 *     activity yet).
 *
 * No-color-only: every status carries a text label AND a glyph AND a
 * tinted background — losing any single channel still surfaces the state.
 */
import type { Lane } from './laneDerivation';
import type { MultiAgentRun } from '../../store';
import { agentIdentity } from '../../agentIdentity';

type LaneStatus = 'working' | 'stalled' | 'idle' | 'done' | 'error';

function deriveStatus(lane: Lane, run: MultiAgentRun): LaneStatus {
  const act = run.activity;
  if (act && act.agentName === lane.agentName) {
    if (act.phase === 'working') return 'working';
    if (act.phase === 'stalled') return 'stalled';
    // act.phase === 'idle' → fall through to event-based derivation
  }
  // Error-ish: the most recent row for this lane is a kind=error hop.
  const lastRow = lane.rows[lane.rows.length - 1];
  if (lastRow && lastRow.event.kind === 'error') return 'error';
  if (lane.eventCount > 0) return 'done';
  return 'idle';
}

const STATUS_LABEL: Record<LaneStatus, string> = {
  working: 'working',
  stalled: 'stalled',
  idle: 'idle',
  done: 'done',
  error: 'error',
};

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function lastActionLine(lane: Lane): string {
  const last = lane.rows[lane.rows.length - 1];
  if (!last) return 'no activity yet';
  const dir = last.direction === 'incoming' ? '←' : '→';
  const peer = last.direction === 'incoming' ? last.event.source : last.event.destination || 'end';
  const firstLine = last.event.text.split('\n')[0] ?? '';
  const snippet =
    firstLine.length > 64 ? `${firstLine.slice(0, 61)}…` : firstLine || `(${last.event.kind})`;
  return `${dir} ${peer} · ${snippet}`;
}

export function AgentLaneHeader(props: { lane: Lane; run: MultiAgentRun }) {
  const { lane, run } = props;
  const id = agentIdentity(lane.agentName);
  const status = deriveStatus(lane, run);
  return (
    <header className="lane-header">
      <span
        className={`lane-monogram${id.neutral ? ' is-chrome' : ''}`}
        style={id.hueVar ? ({ '--agent-hue': id.hueVar } as React.CSSProperties) : undefined}
        aria-hidden="true"
      >
        {id.glyph}
      </span>
      <span className="lane-name" title={lane.agentName}>
        {id.label}
      </span>
      <span
        className={`lane-status status-${status}`}
        data-state={status}
        role="status"
        aria-label={`status: ${STATUS_LABEL[status]}`}
      >
        <span className="lane-status-dot" aria-hidden="true" />
        <span className="lane-status-text">{STATUS_LABEL[status]}</span>
      </span>
      <span className="lane-meta" aria-label={`${lane.eventCount} events`}>
        <span className="lane-meta-count">{lane.eventCount}</span>
        {lane.lastActivityTs > 0 && (
          <>
            <span className="lane-meta-sep" aria-hidden="true">
              ·
            </span>
            <span className="lane-meta-ts" title={new Date(lane.lastActivityTs).toLocaleString()}>
              {formatTs(lane.lastActivityTs)}
            </span>
          </>
        )}
      </span>
      <div className="lane-subline">
        <span className="lane-last">{lastActionLine(lane)}</span>
      </div>
    </header>
  );
}
