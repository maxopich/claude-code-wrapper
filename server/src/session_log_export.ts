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
 *   - **Redact at display, not at write.** Storage retains raw bytes and the
 *     export never modifies the file. Default `format=redacted`; raw is opt-in.
 *   - **The redacted artifact's corpus is the DURABLE message classes** — the
 *     same set `runner/persist.ts` writes to the `events` table, via the
 *     shared `isStreamPartial` predicate in `runner/message_classes.ts`.
 *     Streaming partials are excluded, and the reason is structural rather
 *     than a missing pattern: `redactSensitive` masks values under sensitive
 *     KEY names plus a few value shapes, a delta carries free text under the
 *     key `text`, and a secret is CHOPPED ACROSS DELTAS so no per-line rule can
 *     match either half. Measured (`Cebab-ygu.47`): a `db_password` masked
 *     correctly in the durable `assistant` message shipped as the fragment
 *     `horse-battery-staple-…` in the `content_block_delta` that built it.
 *
 *     This paragraph used to say the export "applies LogsModal's redaction
 *     policy line-by-line", and that sentence is what let the leak through
 *     review. It was true about the POLICY and false about the CORPUS: the
 *     modal reads `events`, which never contained a partial, so anyone
 *     reasoning from the claimed parity concluded the export was covered.
 *   - **Consequence, stated rather than hidden.** A partial with no durable
 *     counterpart — a turn killed by `query.interrupt()`, an abandoned tool
 *     input — is not in the redacted artifact. `format=raw` is the only
 *     complete trace. Note it is reachable by curl only: both UI call sites
 *     hardcode `redacted`. The operator's escape hatch is that the file itself
 *     is readable on disk (same machine, same uid, mode 0600), not that the
 *     app offers it. Mock fixtures must therefore be captured from the on-disk
 *     file or a raw export, never from a redacted download.
 *   - **Lines that are not valid JSON.** See `redactJsonlLine`.
 *   - **`format=raw` requires `X-Cebab-Acknowledge-Raw: I-understand`**.
 *     The UI (slice 2) sets this header only after a typed-confirmation
 *     modal. Curl users have to set it explicitly — non-trivial, by design.
 *   - **Per-export forensic row.** Every successful export writes a
 *     `safety_audit` row (kind=`session.exported`, reasonCode=`exported_redacted`
 *     or `exported_raw`, plus `payload.contentPolicy` for a redacted one — see
 *     `REDACTED_CONTENT_POLICY`) BEFORE the body lands. If the audit append fails the
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
import { pipeline } from 'node:stream';
import type { Express, Request, Response } from 'express';
import { redactSensitive } from '@cebab/shared';
import { config } from './config.js';
import { verifyToken } from './auth.js';
import { buildAllowedOrigins, isAllowedHost } from './origin.js';
import { recordRejection } from './notifications/origin_rejections.js';
import { appendSafetyAudit } from './notifications/safety_audit.js';
import { isStreamPartial } from './runner/message_classes.js';

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

/**
 * What a `format=redacted` artifact contains, stamped onto every export's
 * `safety_audit` row.
 *
 * `Cebab-ygu.47`'s sharpest point was not the leak itself: it was that the
 * chain asserted `exported_redacted` while the file held plaintext. Read six
 * months later, `reasonCode` alone cannot tell an artifact produced by the
 * leaky build from one produced by this one. A constant naming the CODE PATH
 * closes exactly that gap — bump the string whenever the policy changes.
 *
 * Deliberately a policy tag and NOT a measurement (no dropped-line count, no
 * size, no hash). The row is written BEFORE the body by design (BE-1, below),
 * so nothing about the emitted bytes is knowable yet; producing a count would
 * need a second full read that a live session invalidates anyway, and a second
 * row would break the one-export-one-row invariant and could not amend the
 * first (the chain is hashed over `payload_json`). And a count of what was
 * REMOVED attests nothing about what REMAINS — which is the same
 * looks-like-assurance-but-isn't failure this bead is about. The row attests
 * intent and policy; the artifact attests itself.
 */
export const REDACTED_CONTENT_POLICY = 'redacted/no-stream-partials';

/**
 * Stands in for a line the export could not parse — a hand-edited log, or (the
 * reachable case) a final line torn by a concurrent append while a live session
 * is being exported.
 *
 * Deliberately NOT an SDK message type, and deliberately not silence: a reader
 * can tell a 68-line artifact with one unparsable line from a 67-line one, and
 * `bytes` says how much was there. What it does not do is hand over bytes no
 * rule has inspected.
 */
export const UNPARSABLE_LINE_TYPE = 'cebab_unparsable_line';

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
 * The stamp is the operator's **LOCAL** wall-clock, not UTC (`Cebab-x1n.3.19`).
 * "Show me the session from Tuesday morning" is a question asked in the
 * operator's own timezone: a session started at 21:00 local in a western
 * zone is 05:00 UTC the *next* calendar day, so a UTC stamp filed it under
 * Wednesday and defeated the whole point. Cebab is single-user and bound to
 * 127.0.0.1, so "local" is unambiguously the one operator's clock. We
 * deliberately do NOT append a `Z`: that marker would honestly label a UTC
 * stamp but leave it filed under the wrong day — the disambiguation the
 * forensic use-case needs is the right day, not a units label on the wrong one.
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
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `cebab-${short}-${stamp}.jsonl`;
}

/**
 * The whole per-line decision for a `format=redacted` export. **Returns `null`
 * when the line is not part of the artifact at all** — it is no longer a total
 * function, and the name predates that.
 *
 * Each JSONL line is a JSON-encoded SDKMessage. Three outcomes:
 *
 *   - **A streaming partial → `null`** (`Cebab-ygu.47`). Dropped BEFORE the
 *     redactor, so the code says "this class never reaches it" rather than
 *     "we redact and then discard" — and so 42 of the 68 lines in the measured
 *     session skip a full walk. See `runner/message_classes.ts` for why the
 *     rule is shared with the `events` writer rather than spelled here.
 *   - **Anything else → parsed, redacted, re-serialized.**
 *   - **Not valid JSON → a placeholder recording that a line was here.** This
 *     used to ship the bytes verbatim, reasoned as "the operator may have
 *     hand-edited the file, and silently dropping it would lose forensic
 *     data". The reasoning is right and the conclusion was the bypass: a
 *     concurrent write TEARS the final line, which is the ordinary case when
 *     exporting a live session — `runner/logger.ts` appends to a `flags: 'a'`
 *     stream with no coordination against readers, and this route opens a read
 *     stream with none either. Measured: `readline` emits the truncated tail as
 *     a line, `JSON.parse` fails, and a torn `content_block_delta` therefore
 *     sailed past the class rule with its text intact. So the FACT of the line
 *     survives — with its byte count, which is the forensic signal — and the
 *     unvetted bytes do not. Empty lines (the newline after the last line) pass
 *     through unchanged.
 *
 * The shape guard before reading `.type` is not defensive noise: `JSON.parse`
 * legitimately returns `null`, a number, a string or an array for a hand-edited
 * line, and `parsed.type` on `null` THROWS — into the `catch` below, where it
 * would be misreported as "not JSON" and shipped verbatim.
 */
export function redactJsonlLine(line: string): string | null {
  if (line.length === 0) return line;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const type = (parsed as { type?: unknown }).type;
      if (typeof type === 'string' && isStreamPartial(type)) return null;
    }
    const { redacted } = redactSensitive(parsed);
    return JSON.stringify(redacted);
  } catch {
    return JSON.stringify({
      type: UNPARSABLE_LINE_TYPE,
      bytes: Buffer.byteLength(line, 'utf8'),
    });
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
 *
 * Note on `js/missing-rate-limiting` (CodeQL): this route reads a file
 * from disk based on a user-provided `:sid`, which trips CodeQL's
 * "expensive op without rate-limiting middleware" heuristic. Cebab's
 * threat model makes a rate limit theater: the HTTP server binds to
 * 127.0.0.1, every route is gated on Origin+Host AND a per-launch
 * random token from `~/.cebab/auth-token` (mode 0600), and the only
 * legitimate caller is the operator on the same machine. A "rate
 * limit" against the operator pulling their own data adds nothing. The
 * query is excluded at the CodeQL config layer (`.github/workflows/
 * codeql.yml`); see that file's comment for the full rationale and the
 * conditions under which to revisit (multi-user, remote, or non-
 * operator caller — none planned for v1).
 */
export function mountSessionLogExport(app: Express, deps: ExportEndpointDeps = {}): void {
  const allowedOrigins = buildAllowedOrigins();

  /**
   * The Origin + Host gate (same as /auth-token). Extracted so the GET and the
   * OPTIONS preflight below cannot drift — a preflight route with a looser
   * origin check would be a way in that the GET doesn't have.
   *
   * Returns false and has already answered 403 when the request is rejected.
   */
  const passesOriginHostGate = (req: Request, res: Response): boolean => {
    const origin = String(req.headers.origin ?? '');
    const host = String(req.headers.host ?? '');
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
      return false;
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
      return false;
    }
    return true;
  };

  /**
   * Register S03: CORS preflight for the export.
   *
   * The raw format requires the custom `x-cebab-acknowledge-raw` header, which
   * is NOT CORS-safelisted — so a browser fetch preflights. There was no
   * OPTIONS route and no `Access-Control-Allow-Headers`, so the preflight
   * failed and the raw-export privilege path was unreachable from the very
   * web origin it was built for. (curl worked, which is how it passed review.)
   *
   * Gated on the same Origin + Host check as the GET. Deliberately NOT gated
   * on the auth token: a preflight response carries no data, and requiring the
   * token here only adds a failure mode. The GET still requires it.
   */
  app.options('/session-log/:sid', (req: Request, res: Response): void => {
    if (!passesOriginHostGate(req, res)) return;
    const origin = String(req.headers.origin ?? '');
    if (origin) {
      // Reflective CORS, gated on allowedOrigins immediately above.
      // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', RAW_ACK_HEADER);
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  });

  app.get('/session-log/:sid', (req: Request, res: Response): void => {
    const origin = String(req.headers.origin ?? '');

    // ── Origin + Host gate (same as /auth-token, shared with OPTIONS). ──
    if (!passesOriginHostGate(req, res)) return;
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
        payload: {
          sessionId: sid,
          format,
          origin: origin || null,
          // Which code path produced the bytes. See REDACTED_CONTENT_POLICY.
          ...(format === 'redacted' ? { contentPolicy: REDACTED_CONTENT_POLICY } : {}),
        },
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
      // Register S03: without this the page gets the file but cannot read the
      // filename it was sent — `Content-Disposition` is not a CORS-safelisted
      // RESPONSE header, so cross-origin JS can't see it unless it's exposed.
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    }
    const startMs = deps.getSessionStartMs?.(sid) ?? null;
    const filename = exportFilename(sid, startMs);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // ── Stream the body. ─────────────────────────────────────────────
    // Register S05, both paths: the operator can cancel a large download at
    // any moment, and nothing here used to notice. `res` emits 'close' when
    // that happens; without a teardown the read stream stays open and its
    // descriptor is held for the life of the PROCESS, not the request.
    if (format === 'raw') {
      // `pipeline` rather than `pipe`: `pipe` un-pipes when the destination
      // goes away but does NOT destroy the source, so a cancelled raw export
      // leaked its fd. `pipeline` destroys both ends on any outcome —
      // success, source error, or the client hanging up.
      const stream = fs.createReadStream(filePath);
      pipeline(stream, res, (err) => {
        if (!err) return;
        // ERR_STREAM_PREMATURE_CLOSE is the ordinary "operator cancelled"
        // signal, not a fault: the fd is already released by then, and
        // logging it at error level would cry wolf on every cancelled
        // download.
        if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        console.error('[http] /session-log raw stream error', err);
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });
      return;
    }

    // Redacted path: line-by-line. `readline` handles CRLF + final-line
    // edge cases. Backpressure: pause the readline when `res.write`
    // returns false; resume on drain.
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    // Teardown. `rl.close()` alone does not close the underlying stream, so
    // destroy both. Idempotent — 'close' can arrive after we already ended.
    const teardown = (): void => {
      rl.close();
      stream.destroy();
    };
    res.on('close', teardown);

    // `rl.pause()` does not discard lines readline has already buffered, so
    // several more 'line' events arrive after the first failed write. Without
    // this flag each of them parked ANOTHER `once('drain')` listener — enough
    // to trip Node's MaxListenersExceededWarning at 11 on any large export,
    // and to fire `rl.resume()` once per listener when drain finally landed.
    let waitingForDrain = false;
    rl.on('line', (line: string) => {
      const out = redactJsonlLine(line);
      // `Cebab-ygu.47`: a dropped line is a NO-OP here and nothing else. It must
      // not touch `waitingForDrain`, pause/resume the readline, call `res.end()`
      // (`rl.on('close')` is the sole end — an early end on a trailing partial
      // would truncate the artifact) or run `teardown()`. Dropping strictly
      // reduces writes, so it can only relieve backpressure, never create it.
      if (out === null) return;
      let ok: boolean;
      try {
        ok = res.write(out + '\n');
      } catch (err) {
        // Socket closed mid-stream — log once and bail.
        console.warn('[http] /session-log redacted write after close', err);
        teardown();
        return;
      }
      if (!ok && !waitingForDrain) {
        waitingForDrain = true;
        rl.pause();
        res.once('drain', () => {
          waitingForDrain = false;
          rl.resume();
        });
      }
    });
    rl.on('close', () => {
      res.end();
    });
    rl.on('error', (err: unknown) => {
      console.error('[http] /session-log redacted stream error', err);
      stream.destroy();
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  });
}
