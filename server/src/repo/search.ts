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

export type SearchSessionsResult = {
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
/**
 * Candidate rows fetched from SQLite per page during the backfill scan. The
 * LIKE candidate finder is coarse — a whole page can be dropped by the
 * containment filter (see `collectHits`) — so we page rather than spend the
 * whole `limit` budget on the first LIKE page.
 */
const CANDIDATE_PAGE = 256;
/**
 * Hard ceiling on candidate rows examined per stream before we give up and
 * report `truncated`. Bounds the containment backfill so a query whose LIKE
 * match is a JSON *key* in essentially every stored row (`content`, `type`,
 * `message`, …) can't turn the scan into a full-table walk. Redaction runs
 * once per scanned row, so this also bounds CPU. Beyond this depth the
 * operator narrows scope; FTS5 (R-I2) is the deferred exact answer.
 */
const MAX_CANDIDATE_SCAN = 2000;

/** Keyset cursor into a stream ordered `(ts DESC, id DESC)`. */
type Cursor = { ts: number; id: number };

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
  cursor: Cursor | null,
  pageSize: number,
): EventCandidate[] {
  const clauses: string[] = ["e.raw LIKE ? ESCAPE '\\'", 's.deleted_at IS NULL'];
  const params: unknown[] = [pattern];
  if (q.includeArchived !== true) clauses.push('s.archived = 0');
  if (q.scope === 'this_project' && typeof q.projectId === 'number') {
    clauses.push('s.project_id = ?');
    params.push(q.projectId);
  }
  // Keyset pagination over `(ts DESC, id DESC)`: page PAST candidates the
  // containment filter drops rather than capping the scan at the first LIKE
  // page (see `collectHits`).
  if (cursor) {
    clauses.push('(e.ts < ? OR (e.ts = ? AND e.id < ?))');
    params.push(cursor.ts, cursor.ts, cursor.id);
  }
  params.push(pageSize);
  const sql =
    `SELECT e.id AS id, e.session_id AS session_id, e.ts AS ts, e.raw AS raw, ` +
    `e.type AS type, e.subtype AS subtype, s.project_id AS project_id, p.name AS project_name ` +
    `FROM events e ` +
    `JOIN sessions s ON s.id = e.session_id ` +
    // Cebab-8x8.1.3: `AND p.kind = 'workspace'` keeps the Cebab help
    // assistant's transcripts out of cross-session search. The assistant runs
    // through the single-agent path and writes `events` rows like any project;
    // this JOIN predicate is the one that scopes them out. `queryMultiAgentCandidates`
    // needs no equivalent — a bus session is scoped via `multi_agent_participants`
    // and the assistant is never a participant.
    `JOIN projects p ON p.id = s.project_id AND p.kind = 'workspace' ` +
    `WHERE ${clauses.join(' AND ')} ` +
    `ORDER BY e.ts DESC, e.id DESC LIMIT ?`;
  return getDb()
    .prepare(sql)
    .all(...params) as EventCandidate[];
}

function queryMultiAgentCandidates(
  pattern: string,
  q: SearchSessionsQuery,
  cursor: Cursor | null,
  pageSize: number,
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
  // Same keyset backfill as the single-agent stream: the redacted-value drop
  // can starve this stream too (rarer — its target has no embedded key names).
  if (cursor) {
    clauses.push('(me.ts < ? OR (me.ts = ? AND me.id < ?))');
    params.push(cursor.ts, cursor.ts, cursor.id);
  }
  params.push(pageSize);
  const sql =
    `SELECT me.id AS id, me.session_id AS session_id, me.ts AS ts, me.text AS text, ` +
    `me.source AS source, me.destination AS destination, me.kind AS kind ` +
    `FROM multi_agent_events me ` +
    `JOIN multi_agent_sessions ms ON ms.id = me.session_id ` +
    `WHERE ${clauses.join(' AND ')} ` +
    `ORDER BY me.ts DESC, me.id DESC LIMIT ?`;
  return getDb()
    .prepare(sql)
    .all(...params) as MultiAgentCandidate[];
}

/** Build the emitted hit for one single-agent candidate, or null to drop it. */
function eventRowToHit(
  row: EventCandidate,
  useRaw: boolean,
  queryLower: string,
): SearchResult | null {
  const parsed = safeParseJson(row.raw);
  // Mirror the per-session projector's redaction target exactly: the parsed
  // SDK envelope when available, else a `{ payload: <raw string> }` wrapper so
  // Tier-3 inline patterns still mask secrets in a corrupt/partial row.
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
  if (snippet === null) return null; // match lived in a key/redacted value → drop
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
  return hit;
}

/** Build the emitted hit for one multi-agent candidate, or null to drop it. */
function maRowToHit(
  row: MultiAgentCandidate,
  useRaw: boolean,
  queryLower: string,
): SearchResult | null {
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
  if (snippet === null) return null;
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
  return hit;
}

/**
 * Page a candidate stream until we have `limit` SURVIVING hits, the stream is
 * exhausted, or we hit `MAX_CANDIDATE_SCAN`. This is the fix for the recall
 * defect: the SQL `LIMIT` used to cap the coarse LIKE scan, so a page of
 * candidates whose match lived only in a JSON key name (or a redacted value)
 * was dropped by `toHit` with no backfill — a term that is a key in every
 * stored envelope could return zero hits while an older genuine value match
 * sat one row past the budget. We now keep fetching past the dropped rows.
 *
 * `truncated` is true when we stopped WITHOUT exhausting the stream — either we
 * filled `limit` (more may exist) or we hit the scan ceiling — mirroring the
 * pre-fix "the cap was reached" signal but keyed off surviving hits, not raw
 * candidate count.
 */
function collectHits<T extends { ts: number; id: number }>(
  fetchPage: (cursor: Cursor | null, pageSize: number) => T[],
  limit: number,
  toHit: (row: T) => SearchResult | null,
): { hits: SearchResult[]; truncated: boolean } {
  const hits: SearchResult[] = [];
  let cursor: Cursor | null = null;
  let scanned = 0;
  let exhausted = false;
  while (hits.length < limit && scanned < MAX_CANDIDATE_SCAN) {
    const pageSize = Math.min(CANDIDATE_PAGE, MAX_CANDIDATE_SCAN - scanned);
    const rows = fetchPage(cursor, pageSize);
    for (const row of rows) {
      scanned++;
      const hit = toHit(row);
      if (hit !== null) {
        hits.push(hit);
        if (hits.length >= limit) break;
      }
    }
    // A short page means the DB had no more matching candidates.
    if (rows.length < pageSize) {
      exhausted = true;
      break;
    }
    const last = rows[rows.length - 1]!;
    cursor = { ts: last.ts, id: last.id };
  }
  return { hits, truncated: hits.length >= limit || !exhausted };
}

/**
 * Tier-1 cross-session search. See the module header for the containment
 * invariant. Returns up to `limit` hits, newest-first, merged across the
 * single-agent and multi-agent streams.
 */
export function searchSessions(q: SearchSessionsQuery): SearchSessionsResult {
  const query = q.query.trim();
  if (query.length < MIN_SEARCH_QUERY_LEN) return { results: [], truncated: false };

  // Register D11: fail CLOSED on a scope that names no project. Both query
  // builders append their project predicate only when `projectId` is a number;
  // without this guard an absent id dropped the predicate entirely and a
  // "this project" search returned hits from EVERY project, while
  // `executeSearchSessions` echoed `scope: 'this_project'` back — the reply
  // asserted a restriction that had not been applied.
  //
  // Reachable from the shipped UI, no hostile client required: the modal seeds
  // `scope` from `activeProjectId` on mount but the two are independent state
  // afterwards, so a project closing under an open modal leaves scope at
  // `this_project` with `projectId` undefined, and the dispatch effect refires
  // on that very change.
  //
  // WHY NOT DOWNGRADE TO `all_projects` AND SAY SO — the shape this module
  // already uses for `raw`. `useSessionSearch` version-keys replies on the
  // echoed `(query, scope)` and discards any mismatch; its header explains it
  // omits `raw` from that key precisely so a downgraded reply isn't dropped.
  // A downgraded SCOPE echo would hit exactly that discard, leaving the
  // operator on a spinner that never clears. Failing closed keeps the echo
  // truthful by construction and needs no protocol change.
  //
  // The builders keep their own `typeof` checks as defence-in-depth, matching
  // the posture the bus keeps for the F2/F3 source-allowlist filters.
  if (q.scope === 'this_project' && typeof q.projectId !== 'number') {
    return { results: [], truncated: false };
  }

  const limit = clampLimit(q.limit);
  const useRaw = q.raw === true;
  const pattern = escapeLikePattern(query);
  const queryLower = query.toLowerCase();

  const events = collectHits<EventCandidate>(
    (cursor, pageSize) => querySingleAgentCandidates(pattern, q, cursor, pageSize),
    limit,
    (row) => eventRowToHit(row, useRaw, queryLower),
  );
  const bus = collectHits<MultiAgentCandidate>(
    (cursor, pageSize) => queryMultiAgentCandidates(pattern, q, cursor, pageSize),
    limit,
    (row) => maRowToHit(row, useRaw, queryLower),
  );

  const results = [...events.hits, ...bus.hits];
  results.sort((a, b) => b.ts - a.ts);

  // Either stream stopping short of exhaustion, OR the merged set overflowing
  // `limit`, means there may be more matches than we're returning.
  const truncated = events.truncated || bus.truncated || results.length > limit;

  return { results: results.slice(0, limit), truncated };
}
