/**
 * Barrel exports for the agent-activity feature folder.
 *
 * MultiAgentTab.tsx imports `AgentActivityTabs` from here as the single
 * entry point; everything else is internal to the folder.
 */
export { AgentActivityTabs } from './AgentActivityTabs';
export { AgentLanes } from './AgentLanes';
export { ArtifactsView } from './ArtifactsView';
export { deriveLanes, splitVisibleAndOverflow, LANE_CAP, isRealAgent } from './laneDerivation';
export type { Lane, LaneRow } from './laneDerivation';
