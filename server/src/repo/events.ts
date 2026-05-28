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
    .prepare<
      [string],
      { max_seq: number | null }
    >('SELECT MAX(seq) AS max_seq FROM events WHERE session_id = ?')
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
 * Cluster C Phase 3: tail of the events table for a session, in seq order
 * (oldest → newest), capped to the most-recent `limit` rows. Used by the
 * forensic-snapshot capture on single-agent Stop. Returned in ascending
 * order so a renderer can show the trail chronologically without sorting.
 */
export function listEventsTail(sessionId: string, limit: number): EventRow[] {
  if (limit <= 0) return [];
  const recent = getDb()
    .prepare<
      [string, number],
      EventRow
    >('SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?')
    .all(sessionId, limit);
  // Flip back to ascending — the DESC query was just to LIMIT the tail.
  return recent.reverse();
}
