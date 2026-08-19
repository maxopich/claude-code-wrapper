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
  getMultiAgentEventsByIds,
  getMultiAgentMutationsByIds,
  listMultiAgentEventKeys,
  listMultiAgentMutationKeys,
  type MultiAgentEventRow,
  type MutationRecord,
} from '../repo/multi_agent.js';
import { getEventsByIds, listEventKeys, type EventRow } from '../repo/events.js';

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

  // Register S04. Read the SORT KEY for the whole stream, order and slice
  // that, and only then fetch and convert the page's own rows. Converting a
  // row runs `redactSensitive` over its payload, so the old shape — convert
  // everything, sort, slice — redacted the entire session to return 200 rows.
  //
  // The comparator below is unchanged, byte for byte, and that is deliberate:
  // it sorts on `agent`/`id` values DERIVED here (`event:<id>`, the source
  // slug) using `String.localeCompare`, i.e. ICU collation. Pushing the order
  // into SQL would mean arguing a collation equivalence; keeping the sort in
  // JS over cheap keys means there is nothing to argue.
  const eventKeys = listMultiAgentEventKeys(sessionId);
  // Provisional mutations — result never landed — are filtered in SQL now.
  // They appear in the agent's lane as "working files"; a log line for one is
  // noise, and it must not count toward `total` either.
  const mutationKeys = listMultiAgentMutationKeys(sessionId);

  const keys: SortKey[] = [];
  for (const k of eventKeys) {
    keys.push({ ts: k.ts, agent: k.source, id: `event:${k.id}`, stream: 'event', rowId: k.id });
  }
  for (const k of mutationKeys) {
    keys.push({
      ts: k.ts,
      agent: k.agentName,
      id: `mutation:${k.id}`,
      stream: 'mutation',
      rowId: k.id,
    });
  }
  keys.sort(compareSortKeys);

  const total = keys.length;
  const clampedOffset = Math.max(0, Math.min(offset, total));
  const clampedLimit = Math.max(0, limit);
  // The byte cap can stop the page short, so fetch at most `limit` rows and
  // let the cap trim from there. Fetching the whole tail "just in case" would
  // reintroduce exactly the cost this change removes.
  const pageKeys = keys.slice(clampedOffset, clampedOffset + clampedLimit);

  const eventById = new Map(
    getMultiAgentEventsByIds(pageKeys.filter((k) => k.stream === 'event').map((k) => k.rowId)).map(
      (r) => [r.id, r],
    ),
  );
  const mutationById = new Map(
    getMultiAgentMutationsByIds(
      pageKeys.filter((k) => k.stream === 'mutation').map((k) => k.rowId),
    ).map((r) => [r.id, r]),
  );

  const sliced: LogRow[] = [];
  let bytes = 0;
  for (const key of pageKeys) {
    const source = key.stream === 'event' ? eventById.get(key.rowId) : mutationById.get(key.rowId);
    // A row that vanished between the key scan and the fetch (a purge racing
    // a page load) is skipped rather than faked. It still counted toward
    // `total`, which is the honest read: the key scan is what `total` was
    // measured from.
    if (source === undefined) continue;
    const row =
      key.stream === 'event'
        ? eventRowToLogRow(source as MultiAgentEventRow, revealSensitive)
        : mutationToLogRow(source as MutationRecord, revealSensitive);
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

/**
 * The projector's ordering key: what the old code sorted `LogRow`s by, lifted
 * out so it can be built from a narrow DB read instead of a converted row.
 *
 * `stream` + `rowId` are the back-reference used to fetch the page — the
 * numeric id, not the `event:`/`mutation:` string, because that string exists
 * only to disambiguate the two streams inside one sorted list.
 */
type SortKey = {
  ts: number;
  agent: string;
  id: string;
  stream: 'event' | 'mutation';
  rowId: number;
};

/**
 * Stable order on `(ts ASC, agent ASC, id ASC)` so two rows minted in the same
 * millisecond do not flip places between page loads.
 *
 * Identical to the comparator that ran over `LogRow`s before S04 — same
 * fields, same `localeCompare`. `session_log.pagination.test.ts` keeps its own
 * copy inside the pre-S04 oracle rather than importing this one, deliberately:
 * an equivalence test that shared the comparator with the code under test
 * would agree with itself no matter what either one did.
 */
function compareSortKeys(a: SortKey, b: SortKey): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.agent !== b.agent) return a.agent.localeCompare(b.agent);
  return a.id.localeCompare(b.id);
}

/**
 * Cluster H D12 backend: shared converter. Public so the live `log_row_appended`
 * emitters in `ws/server.ts` can build a tail row from the same `MultiAgentEventRow`
 * shape `appendMultiAgentEvent` returns — keeping the projection between the
 * initial chunk fetch and the streaming tail byte-equivalent. Tail emits always
 * pass `revealSensitive: false`; a Reveal toggle still requires re-fetching via
 * `load_session_log`, matching the chunk contract.
 */
export function multiAgentEventToLogRow(ev: MultiAgentEventRow, revealSensitive: boolean): LogRow {
  return eventRowToLogRow(ev, revealSensitive);
}

/**
 * Cluster H D12 backend: shared converter — same purpose as
 * `multiAgentEventToLogRow` but for mutation rows. Returns `null` for
 * provisional mutations (`confirmedAt === null`) to match the chunk projector's
 * skip rule; the tail emitter falls back to no-op when null is returned.
 */
export function multiAgentMutationToLogRow(
  m: MutationRecord,
  revealSensitive: boolean,
): LogRow | null {
  if (m.confirmedAt === null) return null;
  return mutationToLogRow(m, revealSensitive);
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
    // Migration 026: full tool input/output (null until captured / for pre-026
    // rows). Routed through the same redactSensitive pass below.
    //
    // That pass did NOT mask these two until register of0, and this comment said
    // it did. `filePath` above is a PATH_FIELD_NAME, so the sibling rule fired on
    // this row all along — but `toolInput`/`toolResult` were absent from
    // SIBLING_VALUE_FIELDS, so it masked nothing and `redactedFields` came back
    // empty. Measured on a mutation touching `.env`, a path listed since Phase H:
    // the whole captured input and output reached the operator, and this comment
    // is why nobody looked. Both names are in that set now; the guarantee below
    // is the set's, not this row's.
    toolInput: m.toolInput,
    toolResult: m.toolResult,
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
    severity: m.category,
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

// ---------------------------------------------------------------------------
// Cluster H C3 backend — single-agent projector.
//
// Per spec §4.1: when the LogsModal opens against a non-bus session, the
// server reads rows from the single-agent `events` table (the same table
// `persistMessage()` writes into; see `runner/orchestrator.ts`) and
// classifies each row into the existing `LogRowKind` enum without joining
// multi_agent_events / multi_agent_mutations (those are bus-only).
//
// Classification rules (deliberately conservative — the UI surfaces an
// "unknown" badge per-row via the existing `LogRowDetail` drawer, so when in
// doubt we fall through to `llm` rather than misclassify):
//
//   - type === 'wrapper'                  → kind 'error' (every wrapper_error
//                                            path lands here)
//   - type === 'assistant'   contains tool_use blocks → 'tool'
//   - type === 'user'        contains tool_result blocks → 'tool'
//   - type === 'assistant' | 'user' | 'result' | 'system' (everything else)
//                                          → 'llm'
//
// Rows of `type === 'stream_event'` never reach `events` (see
// orchestrator.ts:24); no special-case needed.
//
// The byte budget, sort, and `redactSensitive` machinery are reused
// verbatim — single-agent rows route through the same chunk slicer as the
// multi-agent projector so the client's pagination contract is identical.
// ---------------------------------------------------------------------------

export type SingleAgentLogRowKind = Extract<LogRow['kind'], 'tool' | 'llm' | 'error'>;

/**
 * Project the single-agent (`events` table) stream for `sessionId`. Returns
 * a single chunk and the total row count across the unfiltered stream so the
 * client toolbar can render "1,234 entries" without scanning.
 *
 * Ordering: the `events` table is already keyed by `(session_id, seq)` —
 * `listEvents` returns rows in seq ASC, which is also ts ASC modulo within-
 * tick monotonicity. We re-sort by `(ts ASC, id ASC)` to match the multi-
 * agent projector's contract: equal `ts` are broken by `id.localeCompare`
 * so two pages of the same chunk don't flip ordering between requests.
 */
export function buildSingleAgentSessionLogChunk(opts: BuildLogRowsOpts): SessionLogChunk {
  const { sessionId, offset, limit, revealSensitive } = opts;

  // Register S04, the half the finding did not name. This is the SAME defect
  // as `buildSessionLogChunk` over the `events` table — and the bigger one in
  // practice, because `events` carries a full SDK envelope per row for every
  // single-agent chat, where the bus table carries one hop.
  //
  // Same shape as above: key scan, sort, slice, then convert only the page.
  // `agent` is the constant 'agent' for every single-agent row, so it drops
  // out of the comparator exactly as it did before.
  const keys: SortKey[] = listEventKeys(sessionId).map((k) => ({
    ts: k.ts,
    agent: 'agent',
    id: `event:${k.id}`,
    stream: 'event' as const,
    rowId: k.id,
  }));
  keys.sort(compareSortKeys);

  const total = keys.length;
  const clampedOffset = Math.max(0, Math.min(offset, total));
  const clampedLimit = Math.max(0, limit);
  const pageKeys = keys.slice(clampedOffset, clampedOffset + clampedLimit);
  const byId = new Map(getEventsByIds(pageKeys.map((k) => k.rowId)).map((r) => [r.id, r]));

  const sliced: LogRow[] = [];
  let bytes = 0;
  for (const key of pageKeys) {
    const source = byId.get(key.rowId);
    if (source === undefined) continue;
    const row = eventTableRowToLogRow(source, revealSensitive);
    const rowBytes = approxByteLength(row);
    if (bytes + rowBytes > CHUNK_BYTE_CAP && sliced.length > 0) break;
    sliced.push(row);
    bytes += rowBytes;
  }

  const hasMore = clampedOffset + sliced.length < total;
  return { rows: sliced, total, hasMore, revealedSensitive: revealSensitive };
}

function eventTableRowToLogRow(ev: EventRow, revealSensitive: boolean): LogRow {
  const parsed = safeParseEventRaw(ev.raw);
  const kind = classifyEventRow(ev, parsed);
  const summary = summarizeEventRow(ev, parsed);
  // The raw row carries the full SDK envelope — we hand it to the drawer
  // unchanged (modulo redaction) so the operator can drill into block
  // contents and message metadata. `parsed` is the parsed JSON when
  // available; we fall back to the raw string so a partial / corrupt row
  // still appears as a `<redacted>`-able row instead of silently vanishing.
  const rawPayload: Record<string, unknown> = {
    type: ev.type,
    subtype: ev.subtype,
    seq: ev.seq,
    payload: parsed ?? ev.raw,
  };
  const { redacted, fields } = revealSensitive
    ? { redacted: rawPayload, fields: [] as string[] }
    : redactSensitive(rawPayload);
  const row: LogRow = {
    id: `event:${ev.id}`,
    ts: ev.ts,
    // Single-agent has no concept of "which participant" — use the literal
    // 'agent' label so the UI's per-agent filter (when present) has a
    // single bucket rather than a meaningless per-row distinct.
    agent: 'agent',
    kind,
    summary,
    status: deriveStatus(ev, parsed),
    raw: redacted,
  };
  if (fields.length > 0) row.redactedFields = fields;
  return row;
}

function classifyEventRow(ev: EventRow, parsed: ParsedEventPayload): SingleAgentLogRowKind {
  // wrapper_error rows are persisted with type='wrapper' (see
  // ws/server.ts:4521 `persistMessage({type:'wrapper',subtype:...})`). The
  // subtype carries the error kind (process_crashed, auth_expired, etc.);
  // we surface them as `'error'` so the UI's red `KIND_MARK` glyph fires.
  if (ev.type === 'wrapper') return 'error';
  if (ev.type === 'assistant' && hasContentBlockOfType(parsed, 'tool_use')) return 'tool';
  if (ev.type === 'user' && hasContentBlockOfType(parsed, 'tool_result')) return 'tool';
  return 'llm';
}

function summarizeEventRow(ev: EventRow, parsed: ParsedEventPayload): string {
  // One-line summary tuned for the row's classification:
  //   - assistant: first text block (trimmed) or "(tool_use: X tools)"
  //   - user: "(tool_result × N)" or first text block
  //   - result: "<subtype> · $<cost> · <duration>"
  //   - wrapper: "<subtype>: <message>" (the user-facing message field)
  //   - system / fallback: "<subtype>" or "<type>"
  if (ev.type === 'assistant') {
    const text = firstText(parsed);
    if (text) return trimToOneLine(text);
    const toolNames = collectToolNames(parsed);
    if (toolNames.length > 0) {
      const head = toolNames.slice(0, 3).join(', ');
      return toolNames.length > 3
        ? `tool_use: ${head}, +${toolNames.length - 3} more`
        : `tool_use: ${head}`;
    }
    return 'assistant';
  }
  if (ev.type === 'user') {
    const blocks = blocksOf(parsed);
    const toolResults = blocks.filter((b) => b.type === 'tool_result');
    if (toolResults.length > 0) {
      return toolResults.length === 1 ? 'tool_result' : `tool_result × ${toolResults.length}`;
    }
    const text = firstText(parsed);
    return text ? trimToOneLine(text) : 'user';
  }
  if (ev.type === 'result') {
    const subtype = ev.subtype ?? 'result';
    const cost = numberField(parsed, 'total_cost_usd');
    const dur = numberField(parsed, 'duration_ms');
    const parts: string[] = [subtype];
    if (cost !== null) parts.push(`$${cost.toFixed(4)}`);
    if (dur !== null) parts.push(`${dur}ms`);
    return parts.join(' · ');
  }
  if (ev.type === 'wrapper') {
    const subtype = ev.subtype ?? 'error';
    const message = stringField(parsed, 'message');
    return message ? `${subtype}: ${trimToOneLine(message)}` : subtype;
  }
  return ev.subtype ?? ev.type;
}

function deriveStatus(ev: EventRow, parsed: ParsedEventPayload): string | undefined {
  // `status` drives the kind-chip discriminator. For tool rows we surface
  // the tool name; for wrapper rows the subtype (process_crashed,
  // auth_expired, ...) so the UI can colour-code by failure mode.
  if (ev.type === 'assistant') {
    const names = collectToolNames(parsed);
    if (names.length > 0) return names[0]!;
  }
  if (ev.type === 'wrapper') return ev.subtype ?? undefined;
  if (ev.subtype) return ev.subtype;
  return undefined;
}

// ---------------------------------------------------------------------------
// Tiny safe-parse helpers — never throw, never assume the SDK shape is
// authoritative (the events table accumulates rows across SDK versions).
// ---------------------------------------------------------------------------

type ParsedEventPayload = Record<string, unknown> | null;

function safeParseEventRaw(raw: string): ParsedEventPayload {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Block = { type: string } & Record<string, unknown>;

function blocksOf(parsed: ParsedEventPayload): Block[] {
  if (!parsed) return [];
  // SDK shapes:
  //   assistant: { message: { content: Block[] } }
  //   user:      { message: { content: Block[] } }
  const message = (parsed as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is Block => !!b && typeof b === 'object' && typeof (b as Block).type === 'string',
  );
}

function hasContentBlockOfType(parsed: ParsedEventPayload, blockType: string): boolean {
  return blocksOf(parsed).some((b) => b.type === blockType);
}

function collectToolNames(parsed: ParsedEventPayload): string[] {
  return blocksOf(parsed)
    .filter((b) => b.type === 'tool_use')
    .map((b) => (typeof b.name === 'string' ? b.name : ''))
    .filter((n) => n.length > 0);
}

function firstText(parsed: ParsedEventPayload): string | null {
  for (const b of blocksOf(parsed)) {
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return null;
}

function trimToOneLine(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? '';
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

function numberField(parsed: ParsedEventPayload, key: string): number | null {
  if (!parsed) return null;
  const v = (parsed as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function stringField(parsed: ParsedEventPayload, key: string): string | null {
  if (!parsed) return null;
  const v = (parsed as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}
