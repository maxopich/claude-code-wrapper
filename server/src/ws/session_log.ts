/**
 * Phase H: server-side projector for the merged multi-agent session log.
 *
 * Two durable streams contribute to a bus session's log:
 *   1. `multi_agent_events` — every inter-agent hop (intro/prompt/reply/final/
 *      error). One row per `bus_send` invocation, including the synthetic
 *      `cebab → user` / `cebab → _sink` rows the routers emit. These are the
 *      "what was said" record.
 *   2. `multi_agent_mutations` — every classified non-`read` tool call from
 *      any agent, with provisional/confirmed state via `confirmed_at` and
 *      promotion via `promoted`. These are the "what was written" record.
 *
 * The per-hop SDK `events` table is intentionally NOT joined here — the bus
 * runner does not persist SDKMessages (no JSONL, no events rows), so there
 * is nothing to project from at that layer. Surfacing the bus hops + the
 * mutation log already gives the operator the full triage view: who said
 * what, to whom, when, and what files they touched.
 *
 * Output: `LogRow[]` ordered by `ts ASC`, with server-side redaction applied
 * to `raw` payloads. The caller paginates via `(offset, limit)` and respects
 * the ~2 MB byte budget enforced here (chunks may return fewer than `limit`
 * rows when the budget trips first — `hasMore` then signals "request more").
 *
 * Pure projection function over DB state: same DB → same output.
 */

import { type LogRow, type MultiAgentEventKind, redactSensitive } from '@cebab/shared';
import {
  listMultiAgentEvents,
  listMultiAgentMutations,
  type MultiAgentEventRow,
  type MutationRecord,
} from '../repo/multi_agent.js';

/**
 * ~2 MB byte budget per chunk. Computed against the JSON-serialized chunk
 * payload (not raw row count) so a single huge `text` field doesn't crash
 * the browser. The cap is a soft heuristic — the loop stops as soon as a
 * row would push the running total over `CHUNK_BYTE_CAP`, leaving the
 * client to fetch the next page on scroll. Pre-existing rate-limit infra
 * (WS frame size, kernel TCP buffer) handles the truly pathological case.
 */
const CHUNK_BYTE_CAP = 2 * 1024 * 1024;

export type SessionLogChunk = {
  rows: LogRow[];
  total: number;
  hasMore: boolean;
  revealedSensitive: boolean;
};

export type BuildLogRowsOpts = {
  sessionId: string;
  offset: number;
  limit: number;
  revealSensitive: boolean;
};

/**
 * Project the merged event + mutation stream for `sessionId`. Returns a
 * single chunk and the total row count across the full stream (so the
 * toolbar can show "1,234 entries" without re-counting client-side).
 *
 * Ordering: stable on `(ts ASC, source ASC, id ASC)` so two rows minted in
 * the same millisecond don't flip places between page loads.
 */
export function buildSessionLogChunk(opts: BuildLogRowsOpts): SessionLogChunk {
  const { sessionId, offset, limit, revealSensitive } = opts;
  const events = listMultiAgentEvents(sessionId);
  const mutations = listMultiAgentMutations(sessionId);

  const rows: LogRow[] = [];
  for (const ev of events) rows.push(eventRowToLogRow(ev, revealSensitive));
  for (const m of mutations) {
    // Skip provisional mutations whose result never landed — they appear
    // in the agent's lane as "working files" but a provisional log line
    // is just noise. Their bus hop (if any) is still in the events stream.
    if (m.confirmedAt === null) continue;
    rows.push(mutationToLogRow(m, revealSensitive));
  }

  rows.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.agent !== b.agent) return a.agent.localeCompare(b.agent);
    return a.id.localeCompare(b.id);
  });

  const total = rows.length;
  const clampedOffset = Math.max(0, Math.min(offset, total));
  const clampedLimit = Math.max(0, limit);

  const sliced: LogRow[] = [];
  let bytes = 0;
  for (let i = clampedOffset; i < total && sliced.length < clampedLimit; i++) {
    const row = rows[i]!;
    // Estimate this row's contribution before adding so we stop BEFORE
    // crossing the cap. JSON.stringify on a single row is O(row size);
    // for the typical multi-agent run this is cheap.
    const rowBytes = approxByteLength(row);
    if (bytes + rowBytes > CHUNK_BYTE_CAP && sliced.length > 0) break;
    sliced.push(row);
    bytes += rowBytes;
  }

  const hasMore = clampedOffset + sliced.length < total;
  return { rows: sliced, total, hasMore, revealedSensitive: revealSensitive };
}

function eventRowToLogRow(ev: MultiAgentEventRow, revealSensitive: boolean): LogRow {
  const kind: 'bus' | 'error' = ev.kind === 'error' ? 'error' : 'bus';
  const summary = summarizeEvent(ev);
  const raw: Record<string, unknown> = {
    source: ev.source,
    destination: ev.destination,
    kind: ev.kind,
    text: ev.text,
  };
  const { redacted, fields } = revealSensitive
    ? { redacted: raw, fields: [] as string[] }
    : redactSensitive(raw);
  const row: LogRow = {
    id: `event:${ev.id}`,
    ts: ev.ts,
    agent: ev.source,
    kind,
    summary,
    status: ev.kind as MultiAgentEventKind,
    laneRowId: ev.id,
    raw: redacted,
  };
  if (fields.length > 0) row.redactedFields = fields;
  return row;
}

function mutationToLogRow(m: MutationRecord, revealSensitive: boolean): LogRow {
  const kind: 'tool' | 'artifact' = m.promoted ? 'artifact' : 'tool';
  const raw: Record<string, unknown> = {
    toolName: m.toolName,
    category: m.category,
    filePath: m.filePath,
    cwd: m.cwd,
    promoted: m.promoted,
    confirmedAt: m.confirmedAt,
  };
  const { redacted, fields } = revealSensitive
    ? { redacted: raw, fields: [] as string[] }
    : redactSensitive(raw);
  const row: LogRow = {
    id: `mutation:${m.id}`,
    ts: m.ts,
    agent: m.agentName,
    kind,
    summary: m.summary,
    status: m.toolName,
    artifactId: m.id,
    raw: redacted,
  };
  if (fields.length > 0) row.redactedFields = fields;
  return row;
}

function summarizeEvent(ev: MultiAgentEventRow): string {
  // Trim the text to a single line for the row summary; the drawer shows
  // the full body. Most hops are < 200 chars; long ones get an ellipsis.
  const firstLine = ev.text.split('\n', 1)[0] ?? '';
  const trimmed = firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
  const arrow = `${ev.source} → ${ev.destination}`;
  return trimmed ? `${arrow}  ${trimmed}` : arrow;
}

function approxByteLength(row: LogRow): number {
  // JSON.stringify is the most faithful approximation of WS-frame bytes.
  // For pathological inputs (cycles) we'd throw; rows are projected from
  // SQLite columns and `redactSensitive` returns a fresh tree, so this is
  // safe.
  try {
    return JSON.stringify(row).length;
  } catch {
    // Fallback: a coarse upper bound (id + summary + raw stringification).
    return row.summary.length + row.id.length + 64;
  }
}
