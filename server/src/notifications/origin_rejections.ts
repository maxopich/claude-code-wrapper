/**
 * Cluster G E3 (server-side): durable diagnostic for Origin/Host rejections
 * at the HTTP layer.
 *
 * Why this exists. The WS upgrade gate (`ws/server.ts:verifyClient`) and
 * the Express `/auth-token` route each reject browser clients whose
 * `Origin` isn't in `buildAllowedOrigins()` or whose `Host` isn't the
 * 127.0.0.1/localhost form. Until now those rejections only landed in
 * `console.warn`, which (a) is silent to the operator (the browser sees
 * a stale-feeling 403 with no actionable copy) and (b) loses the
 * timestamp + reason at process exit.
 *
 * The spec calls this "agentic-systems-low, infra-medium" — it's not an
 * agent-authority surface, but the failure mode (a misconfigured
 * reverse proxy, a stale browser tab from a renamed host, a hostile
 * page attempting CSWSH) deserves a forensic record. So we dual-write:
 *
 *   1. **Ring buffer** in process memory (cap 200, FIFO). Recent
 *      entries within a 5-minute window are emitted as a `recent_rejections`
 *      ServerMsg on the *next* successful WS attach so the operator
 *      gets a single warning toast: "3 origin-rejected WS attempts in
 *      the last 5 min".
 *
 *   2. **Disk log** appended to `~/.cebab/logs/origin_rejections.log`,
 *      one JSON line per rejection. Survives process exit; what the
 *      operator (or an auditor) needs for forensics of repeated abuse.
 *
 * Both writes are best-effort and synchronous in the rejection hot
 * path; the disk write is `fs.appendFileSync` because we're already on
 * the request thread and the volume is low (single-user, mostly empty).
 * A disk-write failure is itself written to `console.warn` — we never
 * want a failed log append to bring down a request.
 *
 * The X-Cebab-Reject-Reason HTTP response header lives at the rejection
 * site (Express + verifyClient), not here, because the response object
 * shape differs between channels. This module only owns the in-process
 * record + disk log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** FIFO cap on the in-process ring. Comfortably exceeds the 5-min window
 *  for any realistic rate (a misconfigured client retry-loop at 1Hz only
 *  fills 300 entries in 5 min; 200 already filters down to the most
 *  recent). Bounded to keep memory finite under a runaway abuser. */
export const REJECTION_RING_CAP = 200;

/** How recent a rejection has to be to show up in the `recentRejections()`
 *  list — i.e. how long the "your browser keeps trying with the wrong
 *  origin" warning is visible after the last rejection. The disk log
 *  keeps everything regardless of this window. */
export const REJECTION_VISIBLE_WINDOW_MS = 5 * 60 * 1000;

/**
 * What we reject for. These two reasons are the only two failure modes
 * at the Origin/Host gate today; a future expansion (auth_token_invalid,
 * session_revoked) would route through structured WS close codes, not
 * this ring — see Channel B in `high/G-run-awareness.md` §4.3.
 */
export type RejectionReason = 'origin_not_allowed' | 'host_not_allowed';

export type RejectionRecord = {
  /** Wall-clock ms at the rejection. */
  ts: number;
  /** The submitted `Origin` header, or null if absent (non-browser
   *  client; we still log non-browser host failures, which is why this
   *  is nullable rather than required). */
  origin: string | null;
  /** The submitted `Host` header, or null if absent. */
  host: string | null;
  reason: RejectionReason;
  /** Which channel rejected: 'ws' = WebSocket upgrade verifyClient,
   *  'http' = Express /auth-token GET. Disambiguates the same
   *  Origin/Host failing in two routes within a few ms. */
  channel: 'ws' | 'http';
};

// Module-local ring. Stays in process memory; cleared on restart (the
// disk log is the durable side of the dual-write).
const rejectionRing: RejectionRecord[] = [];

/**
 * Record a rejection. Idempotent re: ring (same call twice produces two
 * entries — repetition IS the signal). Synchronous on purpose; the
 * rejection callback in `verifyClient` runs on the request thread and
 * we want the disk log to land before the 403 response goes out.
 *
 * Disk-write failures are swallowed to `console.warn`: a misconfigured
 * dataDir or a full disk must not prevent the request from being
 * rejected. The ring entry is still written first so in-process
 * dispatch (the toast) survives even if disk is dead.
 */
export function recordRejection(rec: Omit<RejectionRecord, 'ts'> & { ts?: number }): void {
  const entry: RejectionRecord = {
    ts: rec.ts ?? Date.now(),
    origin: rec.origin,
    host: rec.host,
    reason: rec.reason,
    channel: rec.channel,
  };
  // Ring: append + trim from the front when over cap. We trim
  // unconditionally because the cap is fixed and the cost (one slice)
  // is cheap at length 200.
  rejectionRing.push(entry);
  while (rejectionRing.length > REJECTION_RING_CAP) {
    rejectionRing.shift();
  }
  // Disk: append-only JSON-lines. We use fs.appendFileSync here rather
  // than queuing a write because the rejection path is rare AND the
  // operator hand-tailing the log file mid-flight should see lines as
  // they happen. The mkdir is best-effort idempotent — dataDir is
  // normally created at server boot but tests may swap it under us.
  try {
    fs.mkdirSync(rejectionLogDir(), { recursive: true });
    fs.appendFileSync(rejectionLogPath(), JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  } catch (err) {
    console.warn(`[origin_rejections] disk log append failed: ${(err as Error).message}`);
  }
}

/**
 * Snapshot of rejections in the visible window. Used by the WS attach
 * dispatcher to decide whether to emit a `recent_rejections` envelope
 * to the freshly-attached client. Returns a defensive copy — the
 * caller shouldn't be able to mutate the ring through the return.
 *
 * The `now` parameter is injected so tests can pin the window without
 * mocking `Date.now()`; production calls pass `Date.now()` directly.
 */
export function recentRejections(now: number = Date.now()): RejectionRecord[] {
  const cutoff = now - REJECTION_VISIBLE_WINDOW_MS;
  return rejectionRing.filter((r) => r.ts >= cutoff).map((r) => ({ ...r }));
}

/**
 * Test-only: wipe the in-process ring. Production callers should never
 * touch this; the ring is the authoritative source for the visible
 * window. Tests that need a clean slate between cases use this to
 * avoid cross-test bleeding when their assertion windows overlap.
 */
export function __resetForTests(): void {
  rejectionRing.length = 0;
}

// ---------- paths ----------

/**
 * Where the disk log lives. Exposed for tests so they can read the
 * file back and assert format/content. Lives under `dataDir/logs/`
 * alongside the per-session JSONL transcripts — same parent directory
 * matches the "all forensic byte streams under one folder" convention.
 */
export function rejectionLogPath(): string {
  return path.join(rejectionLogDir(), 'origin_rejections.log');
}

function rejectionLogDir(): string {
  return path.join(config.dataDir, 'logs');
}
