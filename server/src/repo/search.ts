/**
 * Cluster I Phase C4 (UI_Findings spec §4.2): cross-session content search —
 * tier-1 LIKE scan. FTS5 is the deferred v2 escape hatch (spec §3 C4 / R-I2).
 *
 * Two durable streams are scanned and UNION'd:
 *   1. `events.raw`            — single-agent SDK messages (one row per turn-
 *                                level SDKMessage; the same table the LogsModal
 *                                single-agent projector reads).
 *   2. `multi_agent_events.text` — bus hops (one row per `bus_send`).
 *
 * **Containment invariant (C4-5 / R-I5) — the security spine of this module.**
 * A cross-session search must never surface content that the per-session log
 * view (`ws/session_log.ts`) would have redacted. We get this *by construction*:
 *
 *   1. SQL `LIKE` is only the COARSE candidate finder — it scans the raw
 *      (unredacted) column so we don't miss rows. Its output is never shown.
 *   2. For each candidate we rebuild the EXACT object the per-session view
 *      redacts (`{ type, subtype, payload }` for events; `{ source, destination,
 *      kind, text }` for hops), run it through the same `redactSensitive`, and
 *      collect only the STRING VALUES of the redacted tree as the snippet
 *      haystack. Keys are dropped (kills field-name noise, per spec §4.2) and
 *      redacted values are already `<redacted>`.
 *   3. The query is then re-found in that REDACTED haystack. A hit whose only
 *      match lived in a redacted value (e.g. the operator pasted a known
 *      secret) or in a JSON key name yields no match in the haystack, so the
 *      row is DROPPED — we never emit a snippet centered on, or adjacent to, a
 *      `<redacted>` placeholder. Dropping is strictly more conservative than
 *      the per-session view (which still renders the row with the field
 *      masked), so the invariant "returns no results that wouldn't render in
 *      per-session view" holds: our result set is a subset of theirs.
 *
 * The `raw === true` path skips step 2/3's redaction (operator opt-in); the
 * audit row that authorizes it is written by the `executeSearchSessions`
 * delegate (`server/src/search_sessions.ts`), never here — this module is a
 * pure DB+redaction function: same DB → same output, no I/O beyond reads, no
 * WS, no audit.
 */
import { redactSensitive, type SearchResult, type SearchScope } from '@cebab/shared';
import { getDb } from '../db.js';

export type SearchSessionsQuery = {
  query: string;
  scope: SearchScope;
  /** Required for `scope: 'this_project'`; ignored for `'all_projects'`. */
  projectId?: number;
  includeArchived?: boolean;
  raw?: boolean;
  limit?: number;
};

export type SearchSessionsOutcome = {
  results: SearchResult[];
  /** True when the server-side limit capped the scan — UI shows "narrow scope". */
  truncated: boolean;
};

/** Default page size when the client omits `limit`. */
export const DEFAULT_SEARCH_LIMIT = 30;
/** Hard ceiling — a hostile/huge `limit` can't turn the scan into an OOM. */
export const MAX_SEARCH_LIMIT = 100;
/**
 * Sub-2-char queries return nothing. A bare `LIKE '%a%'` matches almost every
 * row, turning the scan into a full-table walk for zero signal — and the UI's
 * result list would be useless noise anyway.
 */
export const MIN_SEARCH_QUERY_LEN = 2;

/** Chars kept on each side of the match → ~80-char window incl. the match. */
const SNIPPET_RADIUS = 36;
/** Absolute snippet cap (defends against a no-whitespace mega-token). */
const SNIPPET_MAX = 160;
/** Mirror `redact.ts`'s recursion cap so we walk the same shapes it does. */
const MAX_WALK_DEPTH = 12;
/**
 * Per-row cap on collected haystack bytes. The LIKE already proved the query
 * is *somewhere* in the row; collecting unboundedly from a multi-MB tool
 * result would waste cycles. 256 KB comfortably covers normal messages; a
 * match past it (vanishingly rare) just drops the row. Keeps snippet
 * generation O(candidates · cap), not O(candidates · row size).
 */
const MAX_HAYSTACK_CHARS = 256 * 1024;

/** Clamp a client-supplied limit into [1, MAX]. */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Escape LIKE wildcards so the operator's query is matched LITERALLY. Without
 * this, a query of `%` or `_` would match everything / any single char. Paired
 * with `ESCAPE '\'` in the SQL. Order matters: escape the escape char first.
 */
function escapeLikePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

type ParsedPayload = Record<string, unknown> | unknown[] | null;

function safeParseJson(raw: string): ParsedPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown> | unknown[])
      : null;
  } catch {
    return null;
  }
}

/**
 * Collect string LEAF values from a JSON-ish value into `out`, depth-capped and
 * byte-capped. Object KEYS are intentionally NOT collected — that's the
 * field-name-noise reduction the spec asks for, and it's also what makes the
 * containment drop work (a query matching only a key name finds nothing here).
 * A top-level string returns itself.
 */
function collectStringValues(
  value: unknown,
  out: string[],
  state: { len: number },
  depth: number,
): void {
  if (state.len >= MAX_HAYSTACK_CHARS) return;
  if (typeof value === 'string') {
    out.push(value);
    state.len += value.length;
    return;
  }
  if (depth >= MAX_WALK_DEPTH || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const el of value) {
      if (state.len >= MAX_HAYSTACK_CHARS) return;
      collectStringValues(el, out, state, depth + 1);
    }
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (state.len >= MAX_HAYSTACK_CHARS) return;
    collectStringValues(v, out, state, depth + 1);
  }
}

function haystackFor(value: unknown): string {
  const out: string[] = [];
  collectStringValues(value, out, { len: 0 }, 0);
  return out.join(' ');
}

/**
 * Find `queryLower` (already lowercased) in `haystack` and return a one-line,
 * ellipsized ~80-char window centered on the match. Returns null when the
 * query isn't present — the caller drops the row (containment + noise).
 */
function buildSnippet(haystack: string, queryLower: string): string | null {
  if (haystack.length === 0) return null;
  const idx = haystack.toLowerCase().indexOf(queryLower);
  if (idx < 0) return null;
  const matchLen = queryLower.length;
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(haystack.length, idx + matchLen + SNIPPET_RADIUS);
  let slice = haystack.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) slice = `…${slice}`;
  if (end < haystack.length) slice = `${slice}…`;
  if (slice.length > SNIPPET_MAX) slice = `${slice.slice(0, SNIPPET_MAX - 1)}…`;
  return slice;
}

// ── SQL candidate rows (post-JOIN column shapes). ──────────────────────────

type EventCandidate = {
  id: number;
  session_id: string;
  ts: number;
  raw: string;
  type: string;
  subtype: string | null;
  project_id: number;
  project_name: string;
};

type MultiAgentCandidate = {
  id: number;
  session_id: string;
  ts: number;
  text: string;
  source: string;
  destination: string;
  kind: string;
};

function querySingleAgentCandidates(
  pattern: string,
  q: SearchSessionsQuery,
  limit: number,
): EventCandidate[] {
  const clauses: string[] = ["e.raw LIKE ? ESCAPE '\\'", 's.deleted_at IS NULL'];
  const params: unknown[] = [pattern];
  if (q.includeArchived !== true) clauses.push('s.archived = 0');
  if (q.scope === 'this_project' && typeof q.projectId === 'number') {
    clauses.push('s.project_id = ?');
    params.push(q.projectId);
  }
  params.push(limit);
  const sql =
    `SELECT e.id AS id, e.session_id AS session_id, e.ts AS ts, e.raw AS raw, ` +
    `e.type AS type, e.subtype AS subtype, s.project_id AS project_id, p.name AS project_name ` +
    `FROM events e ` +
    `JOIN sessions s ON s.id = e.session_id ` +
    `JOIN projects p ON p.id = s.project_id ` +
    `WHERE ${clauses.join(' AND ')} ` +
    `ORDER BY e.ts DESC LIMIT ?`;
  return getDb()
    .prepare(sql)
    .all(...params) as EventCandidate[];
}

function queryMultiAgentCandidates(
  pattern: string,
  q: SearchSessionsQuery,
  limit: number,
): MultiAgentCandidate[] {
  const clauses: string[] = ["me.text LIKE ? ESCAPE '\\'"];
  const params: unknown[] = [pattern];
  if (q.includeArchived !== true) clauses.push('ms.archived = 0');
  if (q.scope === 'this_project' && typeof q.projectId === 'number') {
    // A bus session is "in" a project iff it has a participant rooted there.
    clauses.push(
      'me.session_id IN (SELECT session_id FROM multi_agent_participants WHERE project_id = ?)',
    );
    params.push(q.projectId);
  }
  params.push(limit);
  const sql =
    `SELECT me.id AS id, me.session_id AS session_id, me.ts AS ts, me.text AS text, ` +
    `me.source AS source, me.destination AS destination, me.kind AS kind ` +
    `FROM multi_agent_events me ` +
    `JOIN multi_agent_sessions ms ON ms.id = me.session_id ` +
    `WHERE ${clauses.join(' AND ')} ` +
    `ORDER BY me.ts DESC LIMIT ?`;
  return getDb()
    .prepare(sql)
    .all(...params) as MultiAgentCandidate[];
}

/**
 * Tier-1 cross-session search. See the module header for the containment
 * invariant. Returns up to `limit` hits, newest-first, merged across the
 * single-agent and multi-agent streams.
 */
export function searchSessions(q: SearchSessionsQuery): SearchSessionsOutcome {
  const query = q.query.trim();
  if (query.length < MIN_SEARCH_QUERY_LEN) return { results: [], truncated: false };

  const limit = clampLimit(q.limit);
  const useRaw = q.raw === true;
  const pattern = escapeLikePattern(query);
  const queryLower = query.toLowerCase();

  const eventRows = querySingleAgentCandidates(pattern, q, limit);
  const maRows = queryMultiAgentCandidates(pattern, q, limit);

  const results: SearchResult[] = [];

  for (const row of eventRows) {
    const parsed = safeParseJson(row.raw);
    // Mirror the per-session projector's redaction target exactly: the parsed
    // SDK envelope when available, else a `{ payload: <raw string> }` wrapper
    // so Tier-3 inline patterns still mask secrets in a corrupt/partial row.
    const target = parsed ?? { payload: row.raw };
    let haystack: string;
    let redactedFields: string[] | undefined;
    if (useRaw) {
      haystack = haystackFor(parsed ?? row.raw);
    } else {
      const { redacted, fields } = redactSensitive(target);
      haystack = haystackFor(redacted);
      if (fields.length > 0) redactedFields = fields;
    }
    const snippet = buildSnippet(haystack, queryLower);
    if (snippet === null) continue; // match lived in a key/redacted value → drop
    const hit: SearchResult = {
      sessionId: row.session_id,
      projectId: row.project_id,
      projectName: row.project_name,
      ts: row.ts,
      snippet,
      matchedField: 'events.raw',
      matchedKind: row.type,
    };
    if (redactedFields) hit.redactedFields = redactedFields;
    results.push(hit);
  }

  for (const row of maRows) {
    // The SAME shape `ws/session_log.ts`'s `eventRowToLogRow` redacts.
    const target: Record<string, unknown> = {
      source: row.source,
      destination: row.destination,
      kind: row.kind,
      text: row.text,
    };
    let haystack: string;
    let redactedFields: string[] | undefined;
    if (useRaw) {
      haystack = haystackFor(target);
    } else {
      const { redacted, fields } = redactSensitive(target);
      haystack = haystackFor(redacted);
      if (fields.length > 0) redactedFields = fields;
    }
    const snippet = buildSnippet(haystack, queryLower);
    if (snippet === null) continue;
    // No projectId/projectName: a bus session spans multiple participant
    // projects, so there's no single owner to name (see SearchResult docs).
    const hit: SearchResult = {
      sessionId: row.session_id,
      ts: row.ts,
      snippet,
      matchedField: 'multi_agent_events.text',
      matchedKind: row.kind,
    };
    if (redactedFields) hit.redactedFields = redactedFields;
    results.push(hit);
  }

  // Either stream hitting the per-query cap, OR the merged set overflowing
  // `limit`, means there may be more matches than we're returning.
  const truncated = eventRows.length >= limit || maRows.length >= limit || results.length > limit;

  results.sort((a, b) => b.ts - a.ts);
  return { results: results.slice(0, limit), truncated };
}
