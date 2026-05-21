/**
 * The Agents-tab content: the grid of per-agent lanes (capped at 4) plus
 * the `+N more` overflow affordance.
 *
 * Lane derivation is recomputed on every render — it's a cheap O(events)
 * walk and React will skip the subtree if no inputs changed.
 *
 * Empty run state: a placeholder section instead of a 4×blank grid so the
 * operator immediately sees what to do next.
 */
import { useMemo } from 'react';
import { AgentLane } from './AgentLane';
import { LaneOverflowPopover } from './LaneOverflowPopover';
import { deriveLanes, splitVisibleAndOverflow } from './laneDerivation';
import type { MultiAgentRun } from '../../store';

export function AgentLanes(props: { run: MultiAgentRun }) {
  const { run } = props;
  const lanes = useMemo(() => deriveLanes(run), [run]);
  const { visible, overflow } = useMemo(() => splitVisibleAndOverflow(lanes), [lanes]);

  if (lanes.length === 0) {
    return (
      <div className="lanes-empty">
        <p>No agents in this run yet.</p>
      </div>
    );
  }

  // Grid column count adapts to visible.length so we don't reserve dead
  // space when only 1 or 2 agents are active. Overflow column is added
  // separately when there's a `+N more`.
  return (
    <div
      className={`lanes lanes-count-${visible.length}${overflow.length > 0 ? ' has-overflow' : ''}`}
    >
      {visible.map((lane) => (
        <AgentLane key={lane.agentName} lane={lane} run={run} />
      ))}
      <LaneOverflowPopover overflow={overflow} />
    </div>
  );
}
