// Cluster D Phase 3 (spec §8.1, §8.2): banner barrel.
//
// Exposes the unified <SessionBanner> + <BannerStack> family. Re-exports
// types so callers in Phases 4-7 (RateLimitBanner, AuthExpiredBanner,
// SweptSessionBanner, ChainReconstructionBanner) can compose without
// drilling into specific file paths.

export { SessionBanner } from './SessionBanner.js';
export type { SessionBannerProps, BannerAction, BannerTier } from './SessionBanner.js';

export { BannerStack } from './BannerStack.js';
export type { BannerStackProps, BannerStackItem } from './BannerStack.js';

export { CountdownChip, formatRemaining } from './CountdownChip.js';
export type { CountdownChipProps } from './CountdownChip.js';

// Cluster D Phase 4c: rate-limit banner factory + callbacks contract.
// Imported by App.tsx + MultiAgentTab.tsx to compose the BannerStack item.
export { buildRateLimitBannerItem, rateLimitBannerTitle } from './RateLimitBanner.js';
export type { BuildRateLimitBannerItemArgs, RateLimitBannerCallbacks } from './RateLimitBanner.js';

// Cluster D Phase 4d: observe-only multi-agent bus auto-retry banner
// factory + callbacks contract. Imported by MultiAgentTab.tsx — the
// bus runs its own retry loop server-side, so there's no operator
// "retry" or "pause" action (those would race the bus).
export { buildBusAutoRetryBannerItem, busAutoRetryBannerTitle } from './RateLimitBanner.js';
export type {
  BuildBusAutoRetryBannerItemArgs,
  BusAutoRetryBannerCallbacks,
} from './RateLimitBanner.js';

// Cluster D Phase 5e: swept-session danger-tier banner factory. The
// in-session counterpart to the swept-session toast — surfaces Reopen
// + Archive whenever the operator views an iteration whose row has
// been displaced to status = 'crashed' (auto-sweep or operator-reopen).
export { buildSweptSessionBannerItem, sweptSessionBannerTitle } from './SweptSessionBanner.js';
export type {
  BuildSweptSessionBannerItemArgs,
  SweptSessionBannerCallbacks,
} from './SweptSessionBanner.js';
