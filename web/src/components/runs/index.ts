// Cluster G Phase 3b (G1 UI): barrel for the active-runs sidebar surface.
// App.tsx mounts `RunsBadge` between brand and connection dot; the
// dropdown is internal and never imported directly by callers.
export { RunsBadge } from './RunsBadge';
export type { RunsBadgeProps } from './RunsBadge';
export { RUNS_DROPDOWN_VISIBLE_CAP, formatElapsed } from './RunsDropdown';
