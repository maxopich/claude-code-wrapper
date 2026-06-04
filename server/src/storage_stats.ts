/**
 * P0-C part 2 (retention VISIBILITY): read-only storage-stats executor for the
 * `get_storage_stats` ClientMsg. Powers the Settings modal's "Storage" section
 * — DB file size, logs-dir size, per-big-table row counts, and the purge
 * cron's last-run heartbeat.
 *
 * Its own module (like `search_sessions.ts` / `get_artifact_content.ts` /
 * `bulk_session_op.ts`) so it's testable against a real temp DB without the
 * WS scaffold, and to keep `ws/server.ts` from growing.
 *
 * Surface-ONLY — no deletion, no reclamation. The (opt-in, recoverable)
 * auto-reclamation half of P0-C part 2 is deferred to its own PR.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ServerMsg } from '@cebab/shared';
import { config } from './config.js';
import { getDb } from './db.js';
import { getSetting } from './repo/settings.js';
import {
  LAST_AUTO_RECLAIM_AT_KEY,
  LAST_AUTO_RECLAIM_COUNT_KEY,
  LAST_PURGE_AT_KEY,
  LAST_PURGE_COUNT_KEY,
  SESSION_PURGE_AFTER_MS,
  SESSION_PURGE_INTERVAL_MS,
} from './bulk_session_op.js';

/**
 * The durable stores that accumulate per session/turn and are never (or only
 * manually) reclaimed — the ones an operator watching disk growth cares about.
 * `events` + `sessions` ARE cascade-purged when a session is hard-deleted, but
 * a never-deleted session keeps both forever, so they belong here too.
 *
 * Fixed, compile-time-LITERAL allowlist: the names are interpolated straight
 * into a COUNT(*) query, so they must never originate from input. The array
 * order is the render order in the Settings "Storage" list.
 */
export const STORAGE_STAT_TABLES = [
  'events',
  'notifications',
  'multi_agent_events',
  'safety_audit',
  'controllability_forensics',
  'recovery_log',
  'sessions',
] as const;

/**
 * On-disk size of the SQLite DB: the main file PLUS its `-wal`/`-shm`
 * sidecars. We stat the files rather than `page_count × page_size` because the
 * DB runs in WAL mode (`db.ts`) — freshly written pages live in the `-wal`
 * file until checkpoint, and page math counts only the main file (understating
 * the footprint mid-write). Each file is ENOENT-guarded: the sidecars are
 * absent when the DB is checkpointed/closed.
 */
export function computeDbSizeBytes(): number {
  let total = 0;
  for (const p of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
    try {
      total += fs.statSync(p).size;
    } catch {
      // ENOENT (sidecar absent) or any stat failure — skip this file.
    }
  }
  return total;
}

/**
 * Sum of the per-session JSONL logs under `~/.cebab/logs/`. The dir is flat
 * (`<sessionId>.jsonl`), so no recursion. Returns 0 when the dir doesn't exist
 * yet (no session has logged). Per-file stat is wrapped so a file removed
 * mid-scan (a concurrent purge rm-ing a log) is skipped rather than throwing.
 */
export function computeLogsDirSizeBytes(): number {
  let names: string[];
  try {
    names = fs.readdirSync(config.logsDir);
  } catch {
    return 0; // dir absent — nothing on disk yet.
  }
  let total = 0;
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(config.logsDir, name));
      if (st.isFile()) total += st.size;
    } catch {
      // removed between readdir and stat (race with purge) — skip.
    }
  }
  return total;
}

/**
 * Row count per allowlisted table. Each name is a compile-time literal from
 * `STORAGE_STAT_TABLES` (never input), so the interpolation is injection-safe.
 * A per-table failure (e.g. a table missing on an older schema) degrades to
 * `rows: 0` rather than failing the whole readout.
 */
export function computeTableStats(): { table: string; rows: number }[] {
  const db = getDb();
  return STORAGE_STAT_TABLES.map((table) => {
    try {
      const row = db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get();
      return { table, rows: row?.c ?? 0 };
    } catch {
      return { table, rows: 0 };
    }
  });
}

/**
 * Compose + send the `storage_stats` reply. Read-only; the only "state" it
 * surfaces is the purge heartbeat the cron writes into the settings table.
 * `getSetting` returns null until the cron has run once — passed through as-is.
 */
export function executeStorageStats(args: { send: (msg: ServerMsg) => void }): void {
  args.send({
    type: 'storage_stats',
    dbSizeBytes: computeDbSizeBytes(),
    logsDirSizeBytes: computeLogsDirSizeBytes(),
    lastPurgeAt: getSetting<number>(LAST_PURGE_AT_KEY),
    lastPurgeCount: getSetting<number>(LAST_PURGE_COUNT_KEY),
    tableStats: computeTableStats(),
    purgeIntervalMs: SESSION_PURGE_INTERVAL_MS,
    purgeAfterMs: SESSION_PURGE_AFTER_MS,
    autoReclaim: {
      enabled: config.autoReclaimDays != null,
      idleDays: config.autoReclaimDays,
      lastRunAt: getSetting<number>(LAST_AUTO_RECLAIM_AT_KEY),
      lastCount: getSetting<number>(LAST_AUTO_RECLAIM_COUNT_KEY),
    },
  });
}
