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
 * ---
 *
 * WHAT BOUNDS THIS (`Cebab-l4e`). "The volume is low" above was an
 * assumption about a well-behaved operator, and this module exists for
 * the case where that assumption is false. Nothing that reaches
 * `recordRejection` is trusted: `origin` and `host` are raw request
 * headers, and `GET /auth-token` — one of the two callers — needs no
 * token, so any local page can drive this path as fast as it can issue
 * requests. Under the exact scenario the module was written to record,
 * an unbounded log makes the detector the amplifier.
 *
 * Three independent bounds, because each one leaves a hole the next
 * closes:
 *
 *   1. `MAX_RECORDED_HEADER_CHARS` truncates `origin`/`host` at record
 *      time, so one entry is small. This bounds the ring's memory and
 *      the `recent_rejections` WS frame as well as a log line.
 *   2. `DISK_DEDUPE_WINDOW_MS` writes at most one line per distinct
 *      (origin, host, reason, channel) per window. A retry loop or a
 *      flood on one origin costs one line, not one per attempt — and
 *      the count is carried forward on the next written line rather
 *      than dropped. The RING still records every attempt: repetition
 *      is what the operator's toast counts, and suppressing it there
 *      would hide the abuse instead of the bytes.
 *   3. `MAX_LOG_BYTES` rotates to a single `.1` generation. Needed
 *      because an attacker who VARIES the origin defeats (2) — and
 *      because nothing else stops slow growth over a long-lived
 *      install.
 *
 * The residual, stated rather than implied: (3) means a sufficiently
 * determined flood with varying origins can still push older evidence
 * out of the retained window. (2) is what makes that expensive and
 * conspicuous; closing it entirely would need a policy about which
 * rejections are worth keeping, which is a different decision.
 *
 * The X-Cebab-Reject-Reason HTTP response header lives at the rejection
 * site (Express + verifyClient), not here, because the response object
 * shape differs between channels. This module only owns the in-process
 * record + disk log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { secureFile, secureMkdir } from '../data_perms.js';

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

/** Truncation point for a recorded `Origin` / `Host`, in CHARACTERS (these
 *  are compared against `String.length`, not a byte count — the name says so
 *  because a sibling constant that lied about its unit is register N03).
 *
 *  256 is far past any real value: an origin is `scheme://host:port` and a
 *  host is `host:port`. Node's own 16 KiB header budget is the only other
 *  limit, and it is three orders of magnitude too loose to be a bound. A
 *  truncated value is still diagnostic — it names the scheme and the start of
 *  the authority, which is what an operator reads — and truncation is marked
 *  so nobody mistakes a cut value for the value that was sent. */
export const MAX_RECORDED_HEADER_CHARS = 256;

/** Marker appended to a value truncated by `MAX_RECORDED_HEADER_CHARS`. Kept
 *  short and outside the URL character set so it cannot be confused with the
 *  header's own content. */
export const TRUNCATION_MARKER = '…[cut]';

/** At most one disk line per distinct (origin, host, reason, channel) per
 *  this window. One minute collapses a retry loop and a flood while keeping a
 *  usable timeline — the visible window above is five minutes, so a burst
 *  still produces several lines across the span the operator is shown. */
export const DISK_DEDUPE_WINDOW_MS = 60 * 1000;

/** How many distinct keys the dedupe table tracks. Bounded for the same
 *  reason the ring is: an attacker who varies the origin must not be able to
 *  grow a Map by doing so. Eviction is least-recently-written, which is the
 *  right side to lose — an evicted key simply writes a line again. */
export const DEDUPE_KEYS_CAP = 64;

/** Rotate the log once it would exceed this many BYTES, keeping a single
 *  `.1` generation. Total on-disk cost is therefore bounded at ~2x this.
 *
 *  4 MiB holds tens of thousands of lines at the size (1) permits, which is
 *  far more history than a single-user local tool needs, while staying small
 *  enough that a runaway never becomes the operator's disk-space problem. */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

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
 * Disk-dedupe table: last-written timestamp per rejection key, plus how many
 * writes have been suppressed since. Insertion order is maintained as
 * least-recently-WRITTEN first (a write deletes before it sets), so eviction
 * at `DEDUPE_KEYS_CAP` drops the coldest key.
 *
 * Deliberately NOT derived from the ring. The ring is capped at 200 and holds
 * a 5-minute window, so a key-varying flood would rotate the evidence of a
 * suppression out from under the count and make `suppressed` quietly wrong.
 * A separate bounded table costs ~64 entries and lets the count be exact.
 */
const diskDedupe = new Map<string, { lastWrittenTs: number; suppressed: number }>();

/** Key a rejection by everything that makes two of them the same event. `ts`
 *  is excluded on purpose — the whole point is to collapse repeats over
 *  time — and the separator cannot appear in a header value that survived
 *  `capHeader` (which stops at 256 chars but does not strip newlines), so
 *  keep it distinctive rather than assuming the parts are clean. */
function dedupeKey(entry: RejectionRecord): string {
  return JSON.stringify([entry.origin, entry.host, entry.reason, entry.channel]);
}

/**
 * Truncate a recorded header value to `MAX_RECORDED_HEADER_CHARS`, marking
 * the cut. `null` passes through — an absent header is a fact worth keeping
 * distinct from an empty one.
 */
export function capHeader(value: string | null): string | null {
  if (value === null || value.length <= MAX_RECORDED_HEADER_CHARS) return value;
  return value.slice(0, MAX_RECORDED_HEADER_CHARS) + TRUNCATION_MARKER;
}

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
    // `Cebab-l4e`: capped HERE rather than at the two call sites, so the ring,
    // the `recent_rejections` WS frame and the disk line are all bounded by
    // one rule that a caller cannot forget to apply.
    origin: capHeader(rec.origin),
    host: capHeader(rec.host),
    reason: rec.reason,
    channel: rec.channel,
  };
  // Ring: append + trim from the front when over cap. We trim
  // unconditionally because the cap is fixed and the cost (one slice)
  // is cheap at length 200.
  //
  // EVERY attempt lands here, including ones the disk dedupe below drops.
  // Repetition is what `recentRejections()` counts for the operator's toast;
  // suppressing it here would hide the abuse rather than the bytes.
  rejectionRing.push(entry);
  while (rejectionRing.length > REJECTION_RING_CAP) {
    rejectionRing.shift();
  }
  const suppressed = suppressedCountForDisk(entry);
  if (suppressed === null) return;
  // Disk: append-only JSON-lines. We use fs.appendFileSync here rather
  // than queuing a write because the rejection path is rare AND the
  // operator hand-tailing the log file mid-flight should see lines as
  // they happen. The mkdir is best-effort idempotent — dataDir is
  // normally created at server boot but tests may swap it under us.
  //
  // `suppressed` is only present when it is non-zero: the common line keeps
  // exactly the shape it has always had, and a reader who sees the field
  // knows it means something.
  const line = JSON.stringify(suppressed > 0 ? { ...entry, suppressed } : entry) + '\n';
  try {
    // H01: rejection records name origins and hosts, so they get the same
    // owner-only treatment as the transcripts they sit beside. Tightening
    // AFTER the append rather than passing a create `mode` also covers a log
    // left 0644 by a build that predates this — `mode` only applies on create.
    secureMkdir(rejectionLogDir());
    rotateIfOversize(Buffer.byteLength(line, 'utf8'));
    fs.appendFileSync(rejectionLogPath(), line, { encoding: 'utf8' });
    secureFile(rejectionLogPath());
  } catch (err) {
    console.warn(`[origin_rejections] disk log append failed: ${(err as Error).message}`);
  }
}

/**
 * Decide whether this entry earns a disk line, and with what suppressed
 * count. Returns `null` to suppress the write entirely.
 *
 * Bookkeeping happens here rather than inside the `try` around the append,
 * because a disk failure must not make the NEXT identical rejection think it
 * already wrote one. The cost of getting that backwards is a silent hole in
 * the log exactly when the disk is misbehaving.
 */
function suppressedCountForDisk(entry: RejectionRecord): number | null {
  const key = dedupeKey(entry);
  const prev = diskDedupe.get(key);
  if (prev && entry.ts - prev.lastWrittenTs < DISK_DEDUPE_WINDOW_MS) {
    prev.suppressed += 1;
    return null;
  }
  // Delete-then-set so insertion order tracks recency of WRITE, which is what
  // the eviction below wants to order by.
  diskDedupe.delete(key);
  diskDedupe.set(key, { lastWrittenTs: entry.ts, suppressed: 0 });
  while (diskDedupe.size > DEDUPE_KEYS_CAP) {
    const coldest = diskDedupe.keys().next();
    if (coldest.done) break;
    diskDedupe.delete(coldest.value);
  }
  return prev?.suppressed ?? 0;
}

/**
 * Rotate `origin_rejections.log` to `.log.1` when the next line would take it
 * past `MAX_LOG_BYTES`, keeping exactly one previous generation.
 *
 * `rename` rather than copy+truncate: it is atomic, it carries the owner-only
 * mode across with the inode, and a reader tailing the old path simply stops
 * seeing new lines rather than seeing a half-truncated file.
 *
 * A missing file is the normal first-write case, not an error — `statSync`
 * throwing ENOENT means there is nothing to rotate.
 */
function rotateIfOversize(nextLineBytes: number): void {
  const logPath = rejectionLogPath();
  let size: number;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return;
  }
  if (size + nextLineBytes <= MAX_LOG_BYTES) return;
  fs.renameSync(logPath, `${logPath}.1`);
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
  // The dedupe table has to go too. It is keyed by header values, not by data
  // directory, so a case that writes the same rejection as the previous one
  // would otherwise find its own write already suppressed and see an empty
  // log — a false pass that looks exactly like the feature working.
  diskDedupe.clear();
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

/** The single retained previous generation, written by `rotateIfOversize`.
 *  Exposed so tests assert against the same name production uses rather than
 *  re-deriving the suffix and passing while the two disagree. */
export function rotatedRejectionLogPath(): string {
  return `${rejectionLogPath()}.1`;
}

function rejectionLogDir(): string {
  return path.join(config.dataDir, 'logs');
}
