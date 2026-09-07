import { randomUUID } from 'node:crypto';
import type { CustomLayout, MultiAgentTemplate } from '@cebab/shared/protocol';
import { getSetting, setSetting } from './settings.js';

// Single JSON-array row in the `settings` table — no dedicated table,
// mirroring how the workspace root rides one settings key.
const SETTING_KEY = 'multi_agent_templates';

// PR-6: defensive allowlist applied on read. A row whose `mode` is none
// of these (older client wrote a value PR-6's union widened past, or a
// corrupted JSON) is silently dropped instead of crashing the renderer.
const VALID_MODES: ReadonlySet<MultiAgentTemplate['mode']> = new Set([
  'chain',
  'orchestrator',
  'custom',
]);

export function listTemplates(): MultiAgentTemplate[] {
  const stored = getSetting<MultiAgentTemplate[]>(SETTING_KEY);
  if (!Array.isArray(stored)) return [];
  // PR-6: defensive mode filter. Drop rows with unknown modes so a
  // future client can't read a row it doesn't understand and either
  // crash or render garbage. `roles?` and `layout?` survive unchanged
  // (the renderer treats absent fields as "no override").
  return stored.filter((t) => VALID_MODES.has(t.mode));
}

/**
 * Upsert by exact (trimmed) name: overwriting an existing name keeps its
 * id so saved Apply/Delete keys stay stable; a new name mints a fresh id.
 * Returns the post-write list so the caller can reply in one round-trip.
 *
 * PR-6: `layout` is optional and only meaningful when `mode === 'custom'`.
 * Persisted as-is — the future editor enforces topology constraints
 * before sending. `roles` and `layout` are stored as `undefined` when
 * absent (settings JSON serializer drops the key, matching the existing
 * `roles?` precedent — there is no migration when a new optional field
 * lands).
 */
export function saveTemplate(input: {
  name: string;
  mode: MultiAgentTemplate['mode'];
  lifecycle: MultiAgentTemplate['lifecycle'];
  participants: number[];
  roles?: Record<string, string>;
  layout?: CustomLayout;
  /** PR-7: optional per-template hop budget override. Clamped server-side
   *  to a positive integer; non-finite or sub-1 input is silently dropped
   *  (the template then falls back to the global default at start). */
  hopBudget?: number;
  /** Cebab-ygu.45: persisted state of the dangerous-command pause toggle.
   *  A SAFETY control — when the operator saved the roster with the pause ON,
   *  applying the template must bring it back ON. Absent → stays undefined
   *  (read back as `false`, the historical pause-off default). */
  pauseOnDangerous?: boolean;
}): MultiAgentTemplate[] {
  const name = input.name.trim();
  const list = listTemplates();
  const idx = list.findIndex((t) => t.name === name);
  // PR-7: defensive clamp. We accept a fractional value gracefully (round
  // down), reject NaN/Infinity/non-numbers, and require >= 1 — sub-1 is
  // a "stop the session immediately" budget that the operator never wants
  // to save accidentally. Absent → field stays undefined (template uses
  // the global default).
  const hopBudget =
    typeof input.hopBudget === 'number' && Number.isFinite(input.hopBudget) && input.hopBudget >= 1
      ? Math.floor(input.hopBudget)
      : undefined;
  const next: MultiAgentTemplate = {
    id: idx >= 0 ? list[idx]!.id : randomUUID(),
    name,
    mode: input.mode,
    lifecycle: input.lifecycle,
    participants: input.participants,
    roles: input.roles,
    layout: input.layout,
    hopBudget,
    // Cebab-ygu.45: store only when explicitly ON. Persisting `false` as
    // `undefined` matches the `roles?`/`layout?` precedent (the settings JSON
    // serializer drops the key) and reads back as pause-off — the safe default.
    pauseOnDangerous: input.pauseOnDangerous === true ? true : undefined,
  };
  const out = idx >= 0 ? list.map((t, i) => (i === idx ? next : t)) : [...list, next];
  setSetting(SETTING_KEY, out);
  return out;
}

export function deleteTemplate(id: string): MultiAgentTemplate[] {
  const out = listTemplates().filter((t) => t.id !== id);
  setSetting(SETTING_KEY, out);
  return out;
}
