/**
 * One lane: header + scrollable activity feed + sticky-bottom "↓ N new" pill.
 *
 * Empty state: a placeholder line so the lane looks live (rather than blank)
 * even when the agent hasn't done anything yet. Loading is handled at the
 * parent (lanes always render once `run` exists); per-lane errors aren't
 * possible in the wire model — a malformed event would be filtered out by
 * lane derivation, not a runtime exception.
 */
import { AgentLaneHeader } from './AgentLaneHeader';
import { ActivityRow } from './ActivityRow';
import { useLaneScroll } from './useLaneScroll';
import { WorkingFiles } from './WorkingFiles';
import type { Lane } from './laneDerivation';
import type { MultiAgentRun } from '../../store';

export function AgentLane(props: { lane: Lane; run: MultiAgentRun }) {
  const { lane, run } = props;
  const { containerRef, bottomSentinelRef, paused, newCount, resume } = useLaneScroll(
    lane.rows.length,
  );
  return (
    <section className="lane" aria-label={`agent ${lane.agentName}`}>
      <AgentLaneHeader lane={lane} run={run} />
      <div className="lane-body">
        <div className="lane-scroll" ref={containerRef}>
          {lane.rows.length === 0 ? (
            <p className="lane-empty">waiting for first activity…</p>
          ) : (
            <ol className="lane-rows">
              {lane.rows.map((row, i) => (
                <ActivityRow
                  // eventId alone isn't unique within a lane: the SAME event
                  // can appear twice (outgoing in sender's lane, incoming in
                  // destination's lane). Combine with direction.
                  key={`${row.event.eventId}-${row.direction}-${i}`}
                  row={row}
                  laneAgentName={lane.agentName}
                />
              ))}
            </ol>
          )}
          {/* 0-px sentinel for scrollIntoView — placing it inside the
              scroll container means the browser does the work; we don't
              read scrollHeight ourselves. */}
          <div ref={bottomSentinelRef} aria-hidden="true" />
        </div>
        <WorkingFiles run={run} agentName={lane.agentName} />
        {paused && newCount > 0 && (
          <button
            type="button"
            className="lane-new-pill"
            onClick={resume}
            aria-label={`${newCount} new event${newCount === 1 ? '' : 's'} below — jump to live`}
            title="Jump to the newest row and resume auto-scroll"
          >
            <span aria-hidden="true">↓</span> {newCount} new
          </button>
        )}
      </div>
    </section>
  );
}
