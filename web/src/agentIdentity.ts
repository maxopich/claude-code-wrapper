/**
 * Deterministic per-agent visual identity for the routing spine + scrollback.
 *
 * Identity is carried by THREE redundant channels so it survives loss of any
 * one (the no-color-only rule): a hue, a glyph, and the slug label. The hue
 * + glyph are a stable `hash(slug)` so an agent keeps the same identity for
 * the whole session and across reloads.
 *
 * Routing sentinels (`_sink`/`user`/`cebab`) and the orchestrator are
 * "chrome", not peers: they get a neutral outline glyph and NO hue, so the
 * operator never misreads the orchestrator as just another colored agent.
 */
import { MA_SENTINELS } from './store';

/** STRICT4: exactly 4 agent hues, picked by `hash(slug) % 4`. Mirrors the
 *  locked `--agent-0..3` CSS custom properties in web/src/styles.css. */
const AGENT_HUE_COUNT = 4;

/** Stable per-agent glyphs, indexed by the same hash. Geometric Unicode
 *  marks that stay distinct in monochrome — the glyph alone disambiguates
 *  agents when the hue is unavailable (no-color-only). */
const GLYPHS = ['●', '▲', '■', '◆', '▼', '★', '⬟', '⬢'] as const;

/** Neutral outline glyph for chrome participants. */
const NEUTRAL_GLYPH = '◇';

/** Chrome (structural, not a peer): the routing sentinels Cebab owns plus
 *  the orchestrator. Superset of the store's `MA_SENTINELS` (which is
 *  `_sink`/`user`/`cebab`) — kept in sync by importing it. */
const NEUTRAL: ReadonlySet<string> = new Set<string>([...MA_SENTINELS, 'orchestrator']);

export type AgentIdentity = {
  /** `var(--agent-N)` for peers; null for chrome (caller draws no swatch
   *  and applies the neutral style). */
  hueVar: string | null;
  glyph: string;
  /** The slug, unchanged — the third identity channel. */
  label: string;
  /** True for sentinels/orchestrator → render as chrome, not a peer. */
  neutral: boolean;
};

/**
 * djb2 string hash — tiny, dependency-free, well-distributed for short
 * slugs. `>>> 0` keeps it an unsigned 32-bit int so `% n` is stable.
 */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Resolve a slug's visual identity. `isOrchestratorChrome` lets a caller
 * force chrome when it knows the run's orchestrator slug (in this codebase
 * that is always the literal `orchestrator`, already in `NEUTRAL`, but the
 * flag keeps callers explicit and future-proof).
 */
export function agentIdentity(
  slug: string,
  opts: { isOrchestratorChrome?: boolean } = {},
): AgentIdentity {
  if (opts.isOrchestratorChrome || NEUTRAL.has(slug)) {
    return { hueVar: null, glyph: NEUTRAL_GLYPH, label: slug, neutral: true };
  }
  const h = hash(slug);
  return {
    hueVar: `var(--agent-${h % AGENT_HUE_COUNT})`,
    glyph: GLYPHS[h % GLYPHS.length],
    label: slug,
    neutral: false,
  };
}
