/**
 * The list of models the operator may choose from (Cebab-ws0.3).
 *
 * WHY IT IS FETCHED RATHER THAN WRITTEN DOWN. A hardcoded table would be wrong
 * in two directions at once: it rots as models ship and retire, and it cannot
 * know which models THIS account is actually entitled to run. The CLI already
 * knows both. `Query.supportedModels()` returns its answer, and — measured, not
 * assumed — it resolves in ~0ms because the list rides the initialize handshake
 * rather than costing a round trip. So the catalogue is a by-product of a spawn
 * Cebab was making anyway (the authority probe), not a spawn of its own.
 *
 * It is also the only way to comply with the rule that no model id may be
 * authored from memory. Nothing in this file names a model.
 *
 * ACCOUNT-WIDE, NOT PER-PROJECT, so it lives in the generic `settings` K/V
 * store and needs no migration. Which model a given project prefers is a
 * separate thing and does live on `projects`.
 *
 * STALENESS IS THE DESIGN, not a defect. The cache is whatever the last probe
 * saw. A model that has since appeared is missing until the next probe; a model
 * that has since gone is offered and would fail at spawn. Both are recoverable
 * by refreshing, and both are better than an empty picker.
 */
import type { ModelCatalogueEntry } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { getSetting, setSetting } from '../repo/settings.js';
import type { Runner } from './index.js';

/** `settings` row key. Account-wide; not namespaced by project on purpose. */
export const MODEL_CATALOGUE_KEY = 'model_catalogue';

export type CachedModelCatalogue = {
  entries: ModelCatalogueEntry[];
  capturedAt: number;
};

/**
 * Its own budget, deliberately separate from `PROBE_TIMEOUT_MS`. The probe's
 * timeout bounds the spawn; this one bounds a control request made INSIDE that
 * spawn. Sharing one budget would let a wedged catalogue call eat the whole
 * probe and turn a free extra into the reason the authority panel never
 * answered. Generous against a measured ~0ms, because the failure we are
 * guarding is a hang, not slowness.
 */
export const CATALOGUE_TIMEOUT_MS = 5_000;

/**
 * Mock-mode catalogue. NOT persisted and never merged with the real cache —
 * `readModelCatalogue` serves this instead of touching the DB when mock mode is
 * on, so a fixture value can never leak into a live spawn through a stale row.
 *
 * The values are ones a real CLI reported on 2026-08-19, not invented: a model
 * chosen while iterating on the UI in mock mode should still be a model that
 * works when the operator turns mock off. It may rot, and rotting costs a stale
 * option in a picker nobody spawns from.
 */
const MOCK_CATALOGUE: ModelCatalogueEntry[] = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Whatever the CLI picks.',
  },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Mock-mode fixture entry.' },
  { value: 'haiku', displayName: 'Haiku', description: 'Mock-mode fixture entry.' },
];

/**
 * Narrow one SDK row to the fields Cebab renders, dropping anything malformed.
 *
 * The SDK is an external boundary here — its shape is documented but the value
 * arrives over a control channel, and a row missing `displayName` would render
 * a blank, unselectable option. Effort levels, fast-mode and adaptive-thinking
 * flags are deliberately NOT carried: Cebab has no surface for them, and a
 * field on the wire that nothing renders is the "data on wire, nothing
 * rendered" gap this codebase has already had to audit once.
 */
function narrow(row: unknown): ModelCatalogueEntry | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.value !== 'string' || r.value.length === 0) return null;
  if (typeof r.displayName !== 'string' || r.displayName.length === 0) return null;
  return {
    value: r.value,
    displayName: r.displayName,
    description: typeof r.description === 'string' ? r.description : '',
    ...(typeof r.resolvedModel === 'string' ? { resolvedModel: r.resolvedModel } : {}),
  };
}

/**
 * Ask a live runner for its catalogue. Never throws and never hangs.
 *
 * Returns `null` — not `[]` — for every failure, so a caller can tell "asked,
 * got nothing" apart from "did not ask". That distinction is what stops a
 * failed refresh from overwriting a good cache with emptiness.
 */
export async function fetchModelCatalogue(
  runner: Runner,
  timeoutMs: number = CATALOGUE_TIMEOUT_MS,
): Promise<ModelCatalogueEntry[] | null> {
  if (typeof runner.supportedModels !== 'function') return null;
  const TIMED_OUT = Symbol('timeout');
  let timer: NodeJS.Timeout | undefined;
  try {
    const raced = await Promise.race([
      runner.supportedModels(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (raced === TIMED_OUT) return null;
    if (!Array.isArray(raced)) return null;
    const entries = raced.map(narrow).filter((e): e is ModelCatalogueEntry => e !== null);
    return entries.length > 0 ? entries : null;
  } catch {
    // A CLI that died mid-handshake, or one too old to know this control
    // request. Neither is worth surfacing: the picker degrades to its cached
    // list, or to no list, which it renders as a legitimate state.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch and persist, best-effort. Called from the authority probe, so it must
 * be incapable of making that probe fail — it swallows everything.
 *
 * A failed fetch LEAVES THE PRIOR CACHE ALONE. Writing an empty catalogue on
 * failure would turn one bad spawn into a permanently empty picker.
 */
export async function refreshModelCatalogue(runner: Runner): Promise<void> {
  // Mock mode never writes: see MOCK_CATALOGUE. A fixture in the DB would
  // outlive the mock session and be offered as a real choice later.
  if (config.mock) return;
  try {
    const entries = await fetchModelCatalogue(runner);
    if (!entries) return;
    setSetting<CachedModelCatalogue>(MODEL_CATALOGUE_KEY, { entries, capturedAt: Date.now() });
  } catch (err) {
    console.error('[model_catalogue] refresh failed', err);
  }
}

/** The catalogue to render. `null` means nothing has been captured yet. */
export function readModelCatalogue(): CachedModelCatalogue | null {
  if (config.mock) return { entries: MOCK_CATALOGUE, capturedAt: 0 };
  const cached = getSetting<CachedModelCatalogue>(MODEL_CATALOGUE_KEY);
  if (!cached || !Array.isArray(cached.entries) || cached.entries.length === 0) return null;
  return cached;
}
