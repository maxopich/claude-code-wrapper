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
