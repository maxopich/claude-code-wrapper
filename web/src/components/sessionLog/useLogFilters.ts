/**
 * Phase H: client-side filter overlay for the Logs surface.
 *
 * Filter composition is AND across three predicates:
 *   - Free-text search (case-insensitive substring against `summary`,
 *     `agent`, `status`, and the JSON-stringified `raw` blob).
 *   - Agent membership (multi-select; empty = no filter).
 *   - Kind membership (multi-select; empty = no filter).
 *
 * The search is `String.includes`, not regex — regex was deferred per the
 * v1 scope to keep the matching predictable and avoid ReDoS exposure on
 * operator-typed patterns.
 *
 * URL-state sync is intentionally NOT done here in v1: the modal opens in
 * a route-backed pattern (`#/session/:id/logs`) but the filter chips reset
 * to default on every open. Persisting filters across reloads is a future
 * polish.
 */
import { useState } from 'react';
import type { LogRow, LogRowKind } from '@cebab/shared/protocol';

export type LogFiltersState = {
  search: string;
  agents: Set<string>;
  kinds: Set<LogRowKind>;
};

export type LogFiltersHandle = LogFiltersState & {
  setSearch: (text: string) => void;
  toggleAgent: (agent: string) => void;
  toggleKind: (kind: LogRowKind) => void;
  reset: () => void;
};

export function useLogFilters(): LogFiltersHandle {
  const [search, setSearch] = useState('');
  const [agents, setAgents] = useState<Set<string>>(new Set());
  const [kinds, setKinds] = useState<Set<LogRowKind>>(new Set());

  function toggleAgent(agent: string) {
    setAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  }
  function toggleKind(kind: LogRowKind) {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }
  function reset() {
    setSearch('');
    setAgents(new Set());
    setKinds(new Set());
  }

  return { search, agents, kinds, setSearch, toggleAgent, toggleKind, reset };
}

/**
 * Apply the filter overlay to a row list. Pure; the predicate is rebuilt
 * on every change (cheap — the lists are bounded by the chunk-cap).
 */
export function applyLogFilters(rows: readonly LogRow[], f: LogFiltersState): LogRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.agents.size > 0 && !f.agents.has(r.agent)) return false;
    if (f.kinds.size > 0 && !f.kinds.has(r.kind)) return false;
    if (q.length === 0) return true;
    if (r.summary.toLowerCase().includes(q)) return true;
    if (r.agent.toLowerCase().includes(q)) return true;
    if (r.status && r.status.toLowerCase().includes(q)) return true;
    if (r.raw !== undefined) {
      try {
        const json = JSON.stringify(r.raw).toLowerCase();
        if (json.includes(q)) return true;
      } catch {
        // raw not JSON-serializable (should never happen — server projected
        // it) — fall through.
      }
    }
    return false;
  });
}
