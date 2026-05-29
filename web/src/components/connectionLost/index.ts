// Cluster G E3 UI: barrel for the connection-lost overlay surface.
// App.tsx mounts `ConnectionLostOverlay`; the reason helpers + diagnostic
// formatter are exported so the host can resolve the variant before
// dispatching the `connection_lost` action.
export { ConnectionLostOverlay } from './ConnectionLostOverlay';
export type { ConnectionLostOverlayProps } from './ConnectionLostOverlay';
export {
  formatDiagnostic,
  resolveFromAuthTokenResponse,
  resolveFromCloseInfo,
} from './connectionLostReason';
export type { ConnectionLostDiagnostic, ConnectionLostReason } from './connectionLostReason';
