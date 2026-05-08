import { getDb } from '../db.js';

type Row = { key: string; value: string };

export function getSetting<T = unknown>(key: string): T | null {
  const row = getDb()
    .prepare<[string], Row>('SELECT key, value FROM settings WHERE key = ?')
    .get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setSetting<T = unknown>(key: string, value: T): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), Date.now());
}

export function listSettings(): Record<string, unknown> {
  const rows = getDb().prepare<[], Row>('SELECT key, value FROM settings').all();
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = null;
    }
  }
  return out;
}
