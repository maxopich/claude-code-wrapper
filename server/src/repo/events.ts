import { getDb } from '../db.js';

export type EventRow = {
  id: number;
  session_id: string;
  seq: number;
  ts: number;
  raw: string;
  type: string;
  subtype: string | null;
};

export function nextSeq(sessionId: string): number {
  const row = getDb()
    .prepare<[string], { max_seq: number | null }>(
      'SELECT MAX(seq) AS max_seq FROM events WHERE session_id = ?',
    )
    .get(sessionId);
  return (row?.max_seq ?? 0) + 1;
}

export function insertEvent(
  sessionId: string,
  seq: number,
  type: string,
  subtype: string | null,
  raw: string,
): void {
  getDb()
    .prepare(
      'INSERT INTO events (session_id, seq, ts, type, subtype, raw) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(sessionId, seq, Date.now(), type, subtype, raw);
}

export function listEvents(sessionId: string): EventRow[] {
  return getDb()
    .prepare<[string], EventRow>('SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId);
}

export function countEvents(sessionId: string): number {
  return (
    getDb()
      .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM events WHERE session_id = ?')
      .get(sessionId)?.c ?? 0
  );
}

/**
 * Sort key for one `events` row — everything the session-log projector needs
 * to ORDER and PAGE the stream, and nothing that costs anything to read.
 *
 * Register S04: the projector used to `listEvents()` the whole session, build
 * a `LogRow` for every row (which runs `redactSensitive` over each `raw` SDK
 * envelope), sort, and then slice to a 200-row page. Reading the key first
 * makes the sort O(n) over ~16-byte records and the conversion O(page).
 */
export type EventKey = {
  id: number;
  ts: number;
};

/**
 * Keys for every event in a session, for the projector's sort. NOT ordered
 * here on purpose: the projector re-sorts with its own comparator
 * (`ts` numeric, then `id.localeCompare` over the derived `event:<id>` string)
 * and an SQL ORDER BY that merely *looked* equivalent would be a second,
 * unproven ordering to keep in step with the first.
 *
 * Unbounded by design — the caller needs `total` and the position of the page
 * within the whole stream. The cost is bounded by the row WIDTH instead: two
 * integers per event rather than a full SDK envelope.
 */
export function listEventKeys(sessionId: string): EventKey[] {
  return getDb()
    .prepare<[string], EventKey>('SELECT id, ts FROM events WHERE session_id = ?')
    .all(sessionId);
}

/**
 * Resolve full rows for an explicit id list — the page the projector decided
 * on. Returns them in the id order SQLite gives; the caller re-orders to the
 * page's own sequence, since that is the ordering it already computed.
 *
 * Empty in → empty out, without touching the DB: `IN ()` is a syntax error in
 * SQLite, so the guard is load-bearing rather than an optimisation.
 */
export function getEventsByIds(ids: number[]): EventRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb()
    .prepare<number[], EventRow>(`SELECT * FROM events WHERE id IN (${placeholders})`)
    .all(...ids);
}

/**
 * Cluster C Phase 3: tail of the events table for a session, in seq order
 * (oldest → newest), capped to the most-recent `limit` rows. Used by the
 * forensic-snapshot capture on single-agent Stop. Returned in ascending
 * order so a renderer can show the trail chronologically without sorting.
 */
export function listEventsTail(sessionId: string, limit: number): EventRow[] {
  if (limit <= 0) return [];
  const recent = getDb()
    .prepare<[string, number], EventRow>(
      'SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?',
    )
    .all(sessionId, limit);
  // Flip back to ascending — the DESC query was just to LIMIT the tail.
  return recent.reverse();
}
