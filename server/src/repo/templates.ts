import { randomUUID } from 'node:crypto';
import type { MultiAgentTemplate } from '@cebab/shared/protocol';
import { getSetting, setSetting } from './settings.js';

// Single JSON-array row in the `settings` table — no dedicated table,
// mirroring how the workspace root rides one settings key.
const SETTING_KEY = 'multi_agent_templates';

export function listTemplates(): MultiAgentTemplate[] {
  const stored = getSetting<MultiAgentTemplate[]>(SETTING_KEY);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Upsert by exact (trimmed) name: overwriting an existing name keeps its
 * id so saved Apply/Delete keys stay stable; a new name mints a fresh id.
 * Returns the post-write list so the caller can reply in one round-trip.
 */
export function saveTemplate(input: {
  name: string;
  mode: MultiAgentTemplate['mode'];
  lifecycle: MultiAgentTemplate['lifecycle'];
  participants: number[];
  notes?: string;
}): MultiAgentTemplate[] {
  const name = input.name.trim();
  const list = listTemplates();
  const idx = list.findIndex((t) => t.name === name);
  const next: MultiAgentTemplate = {
    id: idx >= 0 ? list[idx]!.id : randomUUID(),
    name,
    mode: input.mode,
    lifecycle: input.lifecycle,
    participants: input.participants,
    notes: input.notes,
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
