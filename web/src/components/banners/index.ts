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
