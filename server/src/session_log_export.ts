/**
 * Cluster I C2 backend: per-session JSONL export endpoint.
 *
 *     GET /session-log/:sid?token=<wsToken>&format=redacted|raw
 *
 * Streams `~/.cebab/logs/<sid>.jsonl` (the file written by
 * `runner/logger.ts` on every SDK turn) back to the operator's browser
 * with `Content-Disposition: attachment`. v1 surface for the C2 finding:
 * the per-session log exists on disk but had no UI affordance.
 *
 * Gating mirrors `/auth-token`:
 *
 *   1. Origin allow-list (`buildAllowedOrigins`) — a cross-origin browser
 *      tab can't fetch a session's history. Empty Origin is permitted (a
 *      local non-browser client could read the file directly anyway; same
 *      trust model as the WS upgrade gate).
 *   2. Host allow-list (`isAllowedHost`) — 127.0.0.1 / localhost on the
 *      configured port only.
 *   3. `?token=` matches the per-launch WS auth token. The browser
 *      already holds it; non-browser callers must read
 *      `~/.cebab/auth-token` from disk (same posture as `/auth-token`).
 *
 * Privacy posture (per UI_Findings/medium/I-session-management.md §3 +
 * agentic-reviewer constraints):
 *
 *   - **Redact at display, not at write.** Storage retains raw bytes; the
 *     export reads the on-disk file as-is and applies LogsModal's redaction
 *     policy (`shared/src/redact.ts`) line-by-line via `redactSensitive()`.
 *     Default `format=redacted`; raw output is opt-in.
 *   - **`format=raw` requires `X-Cebab-Acknowledge-Raw: I-understand`**.
 *     The UI (slice 2) sets this header only after a typed-confirmation
 *     modal. Curl users have to set it explicitly — non-trivial, by design.
 *   - **Per-export forensic row.** Every successful export writes a
 *     `safety_audit` row (kind=`session.exported`, reasonCode=`exported_redacted`
 *     or `exported_raw`) BEFORE the body lands. If the audit append fails the
 *     stream never starts (BE-1: the operator's intent must be recorded; if
 *     we can't, we don't ship the data). Audit rows survive session deletion
 *     because of Cluster I's bulk-delete preservation invariant.
 *
 * Non-features in this slice (deferred per §10 sequencing):
 *
 *   - No UI affordance — that's slice 2 (per-session row `⤓` icon + the
 *     SessionSettingsPanel "Data" entry + the success toast).
 *   - No bulk export (C5) — that's a later slice.
 *   - Multi-agent session bodies live in DB rows (`multi_agent_events` +
 *     `multi_agent_mutations`), not on disk. v1 only serves
 *     `logger.ts`-written single-agent JSONLs; multi-agent export gets a
 *     dedicated projector in a future slice.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Express, Request, Response } from 'express';
import { redactSensitive } from '@cebab/shared';
import { config } from './config.js';
import { verifyToken } from './auth.js';
import { buildAllowedOrigins, isAllowedHost } from './origin.js';
import { recordRejection } from './notifications/origin_rejections.js';
import { appendSafetyAudit } from './notifications/safety_audit.js';

/** Header the UI sends to opt into a raw (non-redacted) export. */
export const RAW_ACK_HEADER = 'x-cebab-acknowledge-raw';
/**
 * Literal value the operator must send to opt into a raw export. Not a
 * secret — its purpose is to be friction-y enough that a casual curl
 * --header on autopilot won't include it. The UI typed-acknowledgment
 * modal (slice 2) is the operator-facing speed bump; this header is the
 * machine-readable carrier.
 */
export const RAW_ACK_VALUE = 'I-understand';

/**
 * Restrict `:sid` to the alphabet our session IDs actually use (UUIDs
 * + short alphanumerics from fixtures). This is belt-and-suspenders
 * against a hostile `:sid` like `../../etc/passwd`: even though we use
 * `path.join` + an `existsSync` check, narrowing the regex prevents the
 * filename from ever escaping `config.logsDir`.
 */
const SAFE_SID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export type ExportFormat = 'redacted' | 'raw';

/**
 * Filename per spec §5: `cebab-<shortid>-<YYYYMMDD-HHMMSS>.jsonl`.
 *
 * The timestamp is the **session start** time, NOT the export time, so a
 * folder of exports sorts in the order the sessions actually ran (matters
 * for forensics — "show me the session from Tuesday morning"). If we
 * can't resolve the session start (single-agent session row missing for
 * some reason; multi-agent log file streamed without a `getSessionStartMs`
 * lookup wired), we fall back to `Date.now()` so the export still proceeds
 * — better a slightly-misleading filename than a 500.
 *
 * The short id is the first 8 chars of `sessionId` (matches the existing
 * ChatHeader `{props.sessionId.slice(0, 8)}` convention).
 */
export function exportFilename(sessionId: string, sessionStartMs: number | null): string {
  const short = sessionId.slice(0, 8);
  const ts = sessionStartMs ?? Date.now();
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `cebab-${short}-${stamp}.jsonl`;
}

/**
 * Per-line redaction. Each JSONL line is a JSON-encoded SDKMessage; we
 * parse, run `redactSensitive`, and re-serialize. Lines that aren't valid
 * JSON are preserved verbatim — operator may have hand-edited the file
 * (or it could be a partial line during concurrent writes mid-export),
 * and silently dropping non-JSON would lose forensic data. Empty lines
 * (the final newline after the last line) pass through.
 */
export function redactJsonlLine(line: string): string {
  if (line.length === 0) return line;
  try {
    const parsed: unknown = JSON.parse(line);
    const { redacted } = redactSensitive(parsed);
    return JSON.stringify(redacted);
  } catch {
    return line;
  }
}

export type ExportEndpointDeps = {
  /**
   * Looks up session start time in ms for the export filename. The endpoint
   * works without it (falls back to Date.now()); pass when wired into
   * `index.ts` so filenames match the session start. Splitting this out
   * keeps the endpoint testable without a DB dependency.
   */
  getSessionStartMs?: (sessionId: string) => number | null;
};

/**
 * Resolve the on-disk path for a session's JSONL log. Exposed for tests
 * (the test rig writes its own .jsonl into `config.logsDir`).
 */
export function sessionLogFilePath(sessionId: string): string {
  return path.join(config.logsDir, `${sessionId}.jsonl`);
}

/**
 * Mount the export route on the provided express app. Call after
 * `initAuthToken()` (so `verifyToken` has a value) and after
 * `applyMigrations()` (so `appendSafetyAudit` can write).
 */
export function mountSessionLogExport(app: Express, deps: ExportEndpointDeps = {}): void {
  const allowedOrigins = buildAllowedOrigins();

  app.get('/session-log/:sid', (req: Request, res: Response): void => {
    const origin = String(req.headers.origin ?? '');
    const host = String(req.headers.host ?? '');

    // ── Origin + Host gate (same as /auth-token). ────────────────────
    if (origin && !allowedOrigins.has(origin)) {
      console.warn(`[http] /session-log reject: bad origin ${JSON.stringify(origin)}`);
      recordRejection({
        origin: origin || null,
        host: host || null,
        reason: 'origin_not_allowed',
        channel: 'http',
      });
      res.setHeader('X-Cebab-Reject-Reason', 'origin_not_allowed');
      res.status(403).end();
      return;
    }
    if (!isAllowedHost(host)) {
      console.warn(`[http] /session-log reject: bad host ${JSON.stringify(host)}`);
      recordRejection({
        origin: origin || null,
        host: host || null,
        reason: 'host_not_allowed',
        channel: 'http',
      });
      res.setHeader('X-Cebab-Reject-Reason', 'host_not_allowed');
      res.status(403).end();
      return;
    }
    if (!origin) {
      console.warn('[http] /session-log: serving to empty-Origin client');
    }

    // ── Auth token gate. ─────────────────────────────────────────────
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!verifyToken(token)) {
      res.setHeader('X-Cebab-Reject-Reason', 'bad_token');
      res.status(403).end();
      return;
    }

    // ── Validate :sid. Belt-and-suspenders vs. path traversal. ───────
    // Express 5 types `req.params[name]` as `string | string[]` to cover
    // wildcard / repeated patterns. Our route declares a single `:sid`
    // so the runtime value is always a string; the cast is purely a
    // type assertion narrowed immediately by the regex below.
    const sid = String(req.params.sid ?? '');
    if (!SAFE_SID_RE.test(sid)) {
      res.status(400).type('text/plain').send('bad session id');
      return;
    }

    // ── Validate ?format=. Default redacted. ─────────────────────────
    const fmtRaw = typeof req.query.format === 'string' ? req.query.format : 'redacted';
    if (fmtRaw !== 'redacted' && fmtRaw !== 'raw') {
      res.status(400).type('text/plain').send('bad format (expected redacted|raw)');
      return;
    }
    const format: ExportFormat = fmtRaw;

    // ── Raw export requires the acknowledgment header. ───────────────
    if (format === 'raw') {
      const ack = String(req.headers[RAW_ACK_HEADER] ?? '');
      if (ack !== RAW_ACK_VALUE) {
        res.setHeader('X-Cebab-Reject-Reason', 'raw_acknowledgement_required');
        res
          .status(403)
          .type('text/plain')
          .send(`raw export requires header ${RAW_ACK_HEADER}: ${RAW_ACK_VALUE}`);
        return;
      }
    }

    // ── Resolve the on-disk file. ────────────────────────────────────
    const filePath = sessionLogFilePath(sid);
    if (!fs.existsSync(filePath)) {
      res.status(404).type('text/plain').send('session log not found');
      return;
    }

    // ── Write the forensic audit row BEFORE serving the body. ────────
    // BE-1 conservatism: the audit captures intent regardless of whether
    // the stream completes (operator could disconnect, disk could go
    // away mid-stream). If we can't record the intent, we don't ship
    // the data — silent download with no audit row is the worst case.
    try {
      appendSafetyAudit({
        ts: Date.now(),
        sessionId: sid,
        kind: 'session.exported',
        reasonCode: format === 'raw' ? 'exported_raw' : 'exported_redacted',
        payload: { sessionId: sid, format, origin: origin || null },
      });
    } catch (err) {
      console.error('[http] /session-log: safety_audit append failed', err);
      res.status(500).type('text/plain').send('audit write failed');
      return;
    }

    // ── Response headers (after gates + audit). ──────────────────────
    if (origin) {
      // Reflective CORS is the canonical safe pattern when the value is
      // already gated against allowedOrigins above. Semgrep's generic
      // rule can't see the upstream check.
      // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    const startMs = deps.getSessionStartMs?.(sid) ?? null;
    const filename = exportFilename(sid, startMs);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // ── Stream the body. ─────────────────────────────────────────────
    if (format === 'raw') {
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err: unknown) => {
        console.error('[http] /session-log raw stream error', err);
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });
      stream.pipe(res);
      return;
    }

    // Redacted path: line-by-line. `readline` handles CRLF + final-line
    // edge cases. Backpressure: pause the readline when `res.write`
    // returns false; resume on drain. The HTTP socket may close mid-
    // stream (operator cancelled the download) — in that case the
    // readline gets a stream error and we just stop emitting; the next
    // `res.write` would be a no-op (or throw `ERR_STREAM_DESTROYED`),
    // which we swallow because the operator already has what they got.
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      const out = redactJsonlLine(line);
      let ok: boolean;
      try {
        ok = res.write(out + '\n');
      } catch (err) {
        // Socket closed mid-stream — log once and bail.
        console.warn('[http] /session-log redacted write after close', err);
        rl.close();
        return;
      }
      if (!ok) {
        rl.pause();
        res.once('drain', () => rl.resume());
      }
    });
    rl.on('close', () => {
      res.end();
    });
    rl.on('error', (err: unknown) => {
      console.error('[http] /session-log redacted stream error', err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  });
}
