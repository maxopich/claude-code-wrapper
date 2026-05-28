// Cluster D Phase 6c (spec §6.4 / UI-D22 follow-up): barrel for the
// AuthRefresh surface (state machine + modal). The AuthExpiredBanner's
// "Re-authenticate" primary action drives this provider, which spawns
// `claude login` server-side (Phase 6b) and shows live output.

export {
  AuthRefreshProvider,
  useAuthRefreshState,
  useAuthRefreshActions,
} from './AuthRefreshContext';
export type { AuthRefreshProviderProps, AuthRefreshState } from './AuthRefreshContext';
export { AuthRefreshModal } from './AuthRefreshModal';
export type { AuthRefreshModalProps } from './AuthRefreshModal';
