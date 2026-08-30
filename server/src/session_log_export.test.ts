/**
 * Cluster I C2 backend: tests for the JSONL export endpoint.
 *
 * Two flavors:
 *
 *   - Pure-function tests for `exportFilename()` + `redactJsonlLine()` —
 *     no DB, no HTTP server. These pin the filename contract and the
 *     redaction parity with LogsModal.
 *
 *   - Endpoint tests that spin up an in-process `express()` on a random
 *     port and exercise the actual HTTP surface via `http.request()`.
 *     Raw http.request gives us precise control of the Host + Origin
 *     headers — important because `isAllowedHost` is one of the two
 *     gates, and `fetch()` overrides the Host header silently.
 *     These pin BE-1: a successful export writes a `safety_audit` row
 *     BEFORE the body streams, and an audit-write failure short-circuits.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { initAuthToken } from './auth.js';
import { _resetOperatorIdCache } from './notifications/operator.js';
import * as safetyAudit from './notifications/safety_audit.js';
import {
  exportFilename,
  mountSessionLogExport,
  RAW_ACK_HEADER,
  RAW_ACK_VALUE,
  REDACTED_CONTENT_POLICY,
  redactJsonlLine,
  UNPARSABLE_LINE_TYPE,
} from './session_log_export.js';
import { isStreamPartial } from './runner/message_classes.js';

// ── Pure-function tests ──────────────────────────────────────────────

describe('exportFilename', () => {
  // `Cebab-x1n.3.19`: the stamp is the operator's LOCAL wall-clock, so these
  // assertions must pin a known timezone rather than trust the runner's — a
  // UTC runner would otherwise pass a UTC-stamped filename by coincidence and
  // hide a regression, and a non-UTC runner would fail a UTC-hardcoded expected
  // value. America/Los_Angeles is UTC-8 with no DST on the January dates below,
  // so the offset is a fixed -8h. Node re-reads process.env.TZ per Date op, so
  // setting it here (after import) takes effect for these calls.
  const realTz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'America/Los_Angeles';
  });
  afterEach(() => {
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  test('uses session start time, not Date.now()', () => {
    // 2024-01-15 09:30:45 UTC = 1705311045000 = 2024-01-15 01:30:45 in LA.
    const filename = exportFilename('abcd1234-cafe-beef-0000-000000000000', 1705311045000);
    expect(filename).toBe('cebab-abcd1234-20240115-013045.jsonl');
  });

  test('truncates session id to 8 chars', () => {
    // Same instant, local: 2024-01-15 01:30:45.
    const filename = exportFilename('s', 1705311045000);
    expect(filename).toBe('cebab-s-20240115-013045.jsonl');
  });

  test('stamps LOCAL time, so a late-evening session files under the local day', () => {
    // The `Cebab-x1n.3.19` case: 2024-01-16 05:00:00 UTC is 2024-01-15
    // 21:00:00 in LA. A UTC stamp files this under the 16th (the wrong day for
    // an operator asking "show me the session from Monday evening"); a local
    // stamp files it under the 15th. Before the fix this returned
    // `...-20240116-050000...`.
    const ts = Date.UTC(2024, 0, 16, 5, 0, 0);
    const filename = exportFilename('abcd1234', ts);
    expect(filename).toBe('cebab-abcd1234-20240115-210000.jsonl');
  });

  test('falls back to Date.now() when session start is null', () => {
    const before = Date.now();
    const filename = exportFilename('xx', null);
    const after = Date.now();

    // DO NOT RECONSTRUCT AN INSTANT FROM THE STAMP. The stamp is LOCAL
    // wall-clock, and `new Date(y, m, d, h, mi, s)` is AMBIGUOUS during the
    // repeated hour of a DST fall-back — ECMAScript resolves it with the
    // offset BEFORE the transition. This test pins America/Los_Angeles, so
    // between 09:00 and 10:00 UTC on the US fall-back Sunday the round trip
    // lands exactly one hour early and the lower bound below failed by
    // 3,600,000 ms. Measured; once a year, deterministic, and NOT masked by a
    // UTC runner, because the test supplies the timezone itself.
    //
    // Instead, use the function under test as its own formatting oracle: an
    // explicit timestamp takes the same code path as the fallback, so a stamp
    // the fallback produced must equal one that some instant in [before,
    // after] produces. Sampling every 1000 ms cannot skip a whole second, and
    // `after` is added explicitly so a sub-second window is still covered.
    // The FORMAT itself is pinned by the fixed-timestamp test above, so this
    // is not circular — it tests only that the fallback reads the clock.
    const acceptable = new Set<string>();
    for (let t = before; t < after; t += 1000) acceptable.add(exportFilename('xx', t));
    acceptable.add(exportFilename('xx', after));

    expect(filename).toMatch(/^cebab-xx-\d{8}-\d{6}\.jsonl$/);
    expect([...acceptable]).toContain(filename);
  });
});

describe('redactJsonlLine', () => {
  test('parses + redacts sensitive fields', () => {
    const line = JSON.stringify({
      type: 'assistant',
      text: 'ok',
      auth_token: 'sk-secret',
      apiKey: 'leak-me',
    });
    const out = redactJsonlLine(line);
    // `Cebab-ygu.47` made this non-total; a durable class must never be the
    // null case, so assert that before parsing rather than casting past it.
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.text).toBe('ok');
    expect(parsed.auth_token).toBe('<redacted>');
    expect(parsed.apiKey).toBe('<redacted>');
  });

  test('preserves an empty line verbatim', () => {
    expect(redactJsonlLine('')).toBe('');
  });

  /**
   * [security] Register of0 — the acceptance criterion, stated in the bytes that
   * actually leave the machine.
   *
   * A downloaded session log shipped live third-party API credentials in
   * plaintext. Redaction had RUN on that file — `redactedFields` named
   * `session_id` — which is what made the output look inspected. The body of a
   * project-scoped MCP declaration was simply on no sensitive-path list, and a
   * `Read` puts that body in the line TWICE, only one copy of which has the path
   * as a sibling.
   *
   * This test lives here rather than only in `shared/src/redact.test.ts` because
   * only this site exercises the parse -> redact -> re-serialize round trip that
   * produces the exported line.
   */
  describe('[security] a credential file does not leave the machine (of0)', () => {
    // Assembled at runtime: gitleaks scans text, and this repo removed its
    // blanket `.test.ts` exemption. 40 alphanumerics with no vendor prefix — the
    // shape of the value that actually leaked — so no inline pattern can match
    // it and this test cannot pass for the wrong reason.
    const FILLER = 'A1b2C3d4E5f6G7h8J9k0';
    const SECRET = FILLER + FILLER;
    const MCP_BODY = JSON.stringify({
      mcpServers: { 'project-server': { env: { CLIENT_SECRET: SECRET } } },
    });
    const readOf = (filePath: string): string =>
      JSON.stringify({
        type: 'user',
        message: { content: [{ tool_use_id: 'tu_1', type: 'tool_result', content: MCP_BODY }] },
        tool_use_result: { file: { filePath, content: MCP_BODY, numLines: 3 } },
      });

    test('a Read of a project .mcp.json exports no part of its body', () => {
      const out = redactJsonlLine(readOf('/proj/.mcp.json'));
      expect(out).not.toBeNull();
      expect(out).not.toContain(SECRET);
      const parsed = JSON.parse(out!);
      // Still a valid JSONL line, and the path survives — it is what tells the
      // operator WHICH file was read.
      expect(parsed.tool_use_result.file.filePath).toBe('/proj/.mcp.json');
      expect(parsed.tool_use_result.file.content).toBe('<redacted>');
      expect(parsed.message.content[0].content).toBe('<redacted>');
    });

    test('an ordinary file round-trips with its body intact', () => {
      // The negative for the of0 rule: same bytes, benign path, body NOT masked
      // wholesale. It used to say so as `expect(out).toContain(SECRET)` — one
      // surviving token standing in for the whole body.
      //
      // `Cebab-ygu.51` made that proxy too strong without making the control
      // wrong. The `CLIENT_SECRET` line inside the body is now masked by the
      // credential-named-assignment rule — a strictly better outcome for a
      // README that quotes an MCP config — while the of0 rule stays exactly as
      // unfired as before. Asserting the body's own content is also the stronger
      // control: a rule gone unconditional takes `mcpServers` with it, which no
      // single-token check would notice.
      const out = redactJsonlLine(readOf('/proj/README.md'));
      expect(out).not.toBeNull();
      const body = JSON.parse(out!).message.content[0].content as string;
      expect(body).not.toBe('<redacted>');
      expect(body).toContain('mcpServers');
      expect(body).toContain('project-server');
      expect(body).not.toContain(SECRET);
    });
  });

  test('records that an unparsable line was here, without shipping its bytes', () => {
    // REWRITTEN, not deleted (`Cebab-ygu.47`). This used to assert verbatim
    // passthrough, reasoned as "silently dropping non-JSON would lose forensic
    // data" — and its own name said "torn writes", so the repo already knew
    // about the case and chose to ship the bytes. That choice is the bypass:
    // a torn `content_block_delta` never reaches the class rule, so it sailed
    // through with its text intact. The forensic intent is kept — the fact and
    // the size survive — and the unvetted bytes are what go.
    const garbage = 'this is not json at all';
    const out = redactJsonlLine(garbage);
    expect(out).not.toBeNull();
    expect(out).not.toContain(garbage);
    expect(JSON.parse(out!)).toEqual({
      type: UNPARSABLE_LINE_TYPE,
      bytes: Buffer.byteLength(garbage, 'utf8'),
    });
  });

  test('[security] a TORN delta does not ship its text', () => {
    // The reachable shape, and the whole reason the case above changed:
    // `logger.ts` appends with no coordination against readers, so exporting a
    // live session routinely observes a final line the writer has not finished.
    // Measured: readline emits it, JSON.parse fails.
    //
    // The torn line must be a DELTA carrying the canary — a torn `assistant`
    // line would pass this test while the bypass stayed wide open.
    const torn =
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,' +
      `"delta":{"type":"text_delta","text":"plain_marker = ${'REDACTION' + '-CANARY-' + '77'}`;
    const out = redactJsonlLine(torn);
    expect(out).not.toContain('REDACTION' + '-CANARY-' + '77');
    expect(JSON.parse(out!).type).toBe(UNPARSABLE_LINE_TYPE);
  });

  test('redacts a nested ApiKey case-insensitively', () => {
    const line = JSON.stringify({ tool_use: { input: { ApiKey: 'leak' } } });
    const out = redactJsonlLine(line);
    expect(out).toContain('<redacted>');
    expect(out).not.toContain('leak');
  });
});

// ── Endpoint integration tests ───────────────────────────────────────

const TEST_HOST = '127.0.0.1';

/** Register H09: the Vite dev origin is not allow-listed by default — the
 *  launcher that STARTS that web server declares it. `startServer()`
 *  declares it here, standing in for `npm run dev`. */
const DECLARED_WEB_ORIGIN = 'http://localhost:5173';

let tmpRoot: string;
let originalDataDir: string;
let originalPort: number;
let originalAllowedOrigins: string[];
let server: http.Server;
let serverPort: number;
let token: string;

async function startServer(): Promise<void> {
  // Two-phase start so buildAllowedOrigins() inside mountSessionLogExport
  // captures the bind port. We bind to a random port first, read it,
  // overwrite config.port, then mount the endpoint on the final app.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, TEST_HOST, () => resolve()));
  const addr = probe.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  config.port = addr.port;
  serverPort = addr.port;

  const app = express();
  mountSessionLogExport(app, {
    getSessionStartMs: (sid: string): number | null => {
      // Hardcoded test fixture: 'sess-known' starts at a known time so
      // the Content-Disposition filename is deterministic.
      if (sid === 'sess-known') return 1705311045000;
      return null;
    },
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(serverPort, TEST_HOST, () => resolve());
  });
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-export-'));
  originalDataDir = config.dataDir;
  originalPort = config.port;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.logsDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  getDb(); // applies migrations including 015_safety_audit
  token = initAuthToken();
  originalAllowedOrigins = [...config.allowedOrigins];
  config.allowedOrigins.push(DECLARED_WEB_ORIGIN);
  await startServer();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  closeDb();
  config.dataDir = originalDataDir;
  config.port = originalPort;
  config.allowedOrigins.length = 0;
  config.allowedOrigins.push(...originalAllowedOrigins);
  _resetOperatorIdCache();
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeJsonl(sid: string, lines: unknown[]): void {
  fs.writeFileSync(
    path.join(config.logsDir, `${sid}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

type RawResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

/**
 * Raw HTTP request with precise header control. We can't use fetch()
 * for these tests because undici/fetch silently overrides the Host
 * header (and we need to assert behavior when Host is wrong).
 */
function request(opts: {
  path: string;
  origin?: string;
  hostHeader?: string;
  extraHeaders?: Record<string, string>;
  /** Register S03: the CORS preflight is an OPTIONS request. */
  method?: 'GET' | 'OPTIONS';
}): Promise<RawResponse> {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers['Origin'] = opts.origin;
  if (opts.hostHeader !== undefined) headers['Host'] = opts.hostHeader;
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) headers[k] = v;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: TEST_HOST,
        port: serverPort,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function defaultHostHeader(): string {
  return `localhost:${serverPort}`;
}

describe('[security] /session-log :: origin + host + token gates', () => {
  test('rejects an Origin not in the allow-list', async () => {
    writeJsonl('sess-1', [{ type: 'assistant', text: 'hi' }]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}`,
      origin: 'https://evil.example',
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('origin_not_allowed');
  });

  test('rejects a non-allow-listed Host', async () => {
    writeJsonl('sess-1', [{ type: 'assistant', text: 'hi' }]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: 'wrong.host:9999',
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('host_not_allowed');
  });

  test('rejects a missing token', async () => {
    writeJsonl('sess-1', [{ type: 'assistant', text: 'hi' }]);
    const res = await request({
      path: `/session-log/sess-1`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('bad_token');
  });

  test('rejects a wrong token', async () => {
    writeJsonl('sess-1', [{ type: 'assistant', text: 'hi' }]);
    const res = await request({
      path: `/session-log/sess-1?token=garbage`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('bad_token');
  });

  test('accepts empty Origin (non-browser local client)', async () => {
    writeJsonl('sess-1', [{ type: 'assistant', text: 'hi' }]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}`,
      // No Origin header set — same trust posture as /auth-token.
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(200);
  });
});

describe('/session-log :: redacted format (default)', () => {
  test('serves the file with redaction applied per line', async () => {
    writeJsonl('sess-1', [
      { type: 'assistant', text: 'hi' },
      { type: 'assistant', text: 'secret', api_key: 'sk-leak-me' },
    ]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/x-ndjson');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    const lines = res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ type: 'assistant', text: 'hi' });
    expect(lines[1].api_key).toBe('<redacted>');
    expect(lines[1].text).toBe('secret'); // text is not a sensitive key
  });

  test('defaults to format=redacted when no ?format=', async () => {
    writeJsonl('sess-r', [{ apiKey: 'sk-leak' }]);
    const res = await request({
      path: `/session-log/sess-r?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('sk-leak');
    expect(res.body).toContain('<redacted>');
  });

  test('uses session start time in the filename when getSessionStartMs returns it', async () => {
    writeJsonl('sess-known', [{ type: 'assistant' }]);
    const res = await request({
      path: `/session-log/sess-known?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    // Derive the expected filename from `exportFilename` rather than hardcoding
    // a stamp: the stamp is LOCAL wall-clock (`Cebab-x1n.3.19`), so a literal
    // would be timezone-dependent. The local-vs-UTC contract itself is pinned
    // by the pure `exportFilename` tests above; here we assert only that the
    // endpoint stamps the filename from the resolved session start time.
    expect(String(res.headers['content-disposition'])).toContain(
      `filename="${exportFilename('sess-known', 1705311045000)}"`,
    );
  });
});

describe('[security] /session-log :: a durable message whose only secret is named (Cebab-ygu.51)', () => {
  // `Cebab-ygu.47` closed the stream_event class and recorded that the durable
  // messages were clean. They were clean IN THAT FILE, because every secret in
  // it sat in a string that also held an AKIA key — and the redactor masks a
  // whole string when a vendor pattern hits. Take the vendor token away and the
  // durable copy walked out of the artifact whose whole purpose is to be
  // shareable, under an audit row asserting `exported_redacted`.
  //
  // End to end through the real endpoint rather than against `redactSensitive`,
  // because the unit is not where this went wrong: the rule was fine, the belief
  // about which classes it covered was not.
  //
  // Assembled at runtime; not vendor-shaped, or it would pass for the old reason.
  const PASSWORD = 'correct-horse' + '-battery-staple-' + '9271';

  const durableTurn = () => [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `deploy-notes.txt says db_password = ${PASSWORD}` }],
      },
    },
  ];

  test('the redacted export drops it', async () => {
    writeJsonl('sess-1', durableTurn());
    const res = await request({
      path: `/session-log/sess-1?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(PASSWORD);
    // The turn is still a transcript — the point of masking the span rather than
    // the message. Without this, "drops it" is also satisfied by dropping the
    // line, which is what the stream_event fix does and is wrong here.
    expect(res.body).toContain('deploy-notes.txt says db_password =');
  });

  test('raw still carries it — the two formats have not converged', async () => {
    // The control. A redactor that masked in the wrong layer, or an export that
    // stopped serving raw, would pass the case above for the wrong reason.
    writeJsonl('sess-1', durableTurn());
    const res = await request({
      path: `/session-log/sess-1?token=${token}&format=raw`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
      extraHeaders: { [RAW_ACK_HEADER]: RAW_ACK_VALUE },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain(PASSWORD);
  });
});

describe('[security] /session-log :: raw format', () => {
  test('rejects raw without the acknowledgment header', async () => {
    writeJsonl('sess-1', [{ apiKey: 'sk-leak' }]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}&format=raw`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('raw_acknowledgement_required');
  });

  test('rejects raw with a wrong acknowledgment value', async () => {
    writeJsonl('sess-1', [{ apiKey: 'sk-leak' }]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}&format=raw`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
      extraHeaders: { [RAW_ACK_HEADER]: 'not-the-magic-value' },
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('raw_acknowledgement_required');
  });

  test('serves raw bytes when the acknowledgment header is correct', async () => {
    writeJsonl('sess-1', [{ apiKey: 'sk-leak-me' }]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}&format=raw`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
      extraHeaders: { [RAW_ACK_HEADER]: RAW_ACK_VALUE },
    });
    expect(res.status).toBe(200);
    // The raw secret survives — that's the WHOLE POINT of raw export.
    expect(res.body).toContain('sk-leak-me');
    expect(res.body).not.toContain('<redacted>');
  });
});

describe('/session-log :: input validation', () => {
  test("rejects a session id that doesn't match the safe regex", async () => {
    // Path traversal attempt — express strips the `..` so this lands on
    // 'passwd' as :sid. The regex matches alphanumerics-only; this fails.
    const res = await request({
      path: `/session-log/abc%2Fdef?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('bad session id');
  });

  test('rejects an unknown ?format= value', async () => {
    writeJsonl('sess-1', [{}]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}&format=html`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(400);
  });

  test('returns 404 when the on-disk log does not exist', async () => {
    const res = await request({
      path: `/session-log/sess-missing?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(404);
  });
});

describe('[security] /session-log :: forensic safety_audit', () => {
  test('writes one safety_audit row per successful redacted export', async () => {
    writeJsonl('sess-1', [{ type: 'assistant' }]);
    const before = getDb()
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM safety_audit')
      .get()!.c;
    const res = await request({
      path: `/session-log/sess-1?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(200);
    const after = getDb()
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM safety_audit')
      .get()!.c;
    expect(after - before).toBe(1);
    const row = getDb()
      .prepare<
        [],
        { kind: string; reason_code: string; session_id: string | null; payload_json: string }
      >(
        'SELECT kind, reason_code, session_id, payload_json FROM safety_audit ORDER BY ts DESC LIMIT 1',
      )
      .get()!;
    expect(row.kind).toBe('session.exported');
    expect(row.reason_code).toBe('exported_redacted');
    expect(row.session_id).toBe('sess-1');
    const payload = JSON.parse(row.payload_json);
    expect(payload.format).toBe('redacted');
    expect(payload.sessionId).toBe('sess-1');
  });

  test('writes a row with reason=exported_raw for the raw export path', async () => {
    writeJsonl('sess-raw', [{ apiKey: 'x' }]);
    const res = await request({
      path: `/session-log/sess-raw?token=${token}&format=raw`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
      extraHeaders: { [RAW_ACK_HEADER]: RAW_ACK_VALUE },
    });
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare<[], { reason_code: string; payload_json: string }>(
        "SELECT reason_code, payload_json FROM safety_audit WHERE session_id = 'sess-raw'",
      )
      .get()!;
    expect(row.reason_code).toBe('exported_raw');
    expect(JSON.parse(row.payload_json).format).toBe('raw');
  });

  test('does NOT write an audit row when a gate fails (no audit on rejection)', async () => {
    writeJsonl('sess-1', [{}]);
    const before = getDb()
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM safety_audit')
      .get()!.c;
    // Bad token → 403 before any audit attempt.
    const res = await request({
      path: `/session-log/sess-1?token=garbage`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(403);
    const after = getDb()
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM safety_audit')
      .get()!.c;
    expect(after - before).toBe(0);
  });

  test('does NOT serve the body when audit append throws (BE-1 conservatism)', async () => {
    writeJsonl('sess-1', [{ apiKey: 'sk-leak-me' }]);
    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await request({
      path: `/session-log/sess-1?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('sk-leak-me');
    expect(spy).toHaveBeenCalled();
  });
});

// Register S03. The raw format requires the custom `x-cebab-acknowledge-raw`
// header, which is NOT CORS-safelisted, so a browser fetch preflights first.
// There was no OPTIONS route and no `Access-Control-Allow-Headers`, so the
// preflight failed and the raw-export privilege path was unreachable from the
// very web origin it exists for. curl worked, which is how it passed review.
//
// `Content-Disposition` was set but never exposed, so even a successful export
// left the page unable to read the filename it was being sent.
describe('[security] /session-log :: CORS preflight + exposed headers', () => {
  test('an OPTIONS preflight from an allowed origin permits the ack header', async () => {
    const res = await request({
      method: 'OPTIONS',
      path: `/session-log/sess-1?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    // The whole point: without this the browser never sends the real request.
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      RAW_ACK_HEADER,
    );
    expect(String(res.headers['access-control-allow-methods'])).toContain('GET');
  });

  test('the preflight is NOT a looser way in — a bad origin is refused', async () => {
    // A preflight route that skipped the origin gate would hand an attacker
    // page the CORS grant the GET withholds.
    const res = await request({
      method: 'OPTIONS',
      path: `/session-log/sess-1?token=${token}`,
      origin: 'https://evil.example',
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('origin_not_allowed');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('the preflight applies the same Host gate as the GET', async () => {
    const res = await request({
      method: 'OPTIONS',
      path: `/session-log/sess-1?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: 'wrong.host:9999',
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('host_not_allowed');
  });

  test('the GET exposes Content-Disposition so the page can read the filename', async () => {
    writeJsonl('sess-1', [{ type: 'assistant', text: 'hi' }]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(String(res.headers['access-control-expose-headers'])).toContain('Content-Disposition');
  });

  test('the raw export actually completes with the ack header present', async () => {
    // End-to-end for the path the preflight unblocks: header accepted, raw
    // (unredacted) bytes served.
    writeJsonl('sess-1', [{ apiKey: 'sk-raw-visible' }]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}&format=raw`,
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: defaultHostHeader(),
      extraHeaders: { [RAW_ACK_HEADER]: RAW_ACK_VALUE },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('sk-raw-visible');
  });
});

// ---------------------------------------------------------------------------
// Register S05: an export that is cancelled mid-stream must release its file
// descriptor. Both flavors leaked — the raw path because `pipe` un-pipes but
// does not destroy the source, the redacted path because it waited for a
// `drain` that a destroyed socket never emits.
//
// The assertion is on the READ STREAM's own `destroyed` flag, captured by
// spying on `fs.createReadStream`. That is the fd's lifetime directly, not a
// proxy for it.
// ---------------------------------------------------------------------------

describe('[security] /session-log :: cancelled downloads release the descriptor', () => {
  /** A log big enough that the socket buffer fills and the server is still
   *  mid-stream when the client hangs up. */
  function writeBigJsonl(sid: string, lines = 4000): void {
    const filler = 'y'.repeat(2048);
    writeJsonl(
      sid,
      Array.from({ length: lines }, (_, i) => ({ type: 'assistant', i, text: filler })),
    );
  }

  /** Capture every read stream the endpoint opens. */
  function captureStreams(): fs.ReadStream[] {
    const opened: fs.ReadStream[] = [];
    const real = fs.createReadStream.bind(fs);
    vi.spyOn(fs, 'createReadStream').mockImplementation(((...args: Parameters<typeof real>) => {
      const s = real(...args);
      opened.push(s);
      return s;
    }) as typeof fs.createReadStream);
    return opened;
  }

  /** Issue a GET, abort as soon as the first byte lands, resolve after the
   *  server has had a tick to react. */
  function requestThenAbort(reqPath: string, extraHeaders: Record<string, string> = {}) {
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: TEST_HOST,
          port: serverPort,
          path: reqPath,
          method: 'GET',
          headers: { Host: defaultHostHeader(), ...extraHeaders },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            setTimeout(resolve, 250);
          });
          res.on('error', () => {
            /* expected on abort */
          });
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        // ECONNRESET is our own destroy coming back; anything else is real.
        if (err.code === 'ECONNRESET') return;
        reject(err);
      });
      req.end();
    });
  }

  test('a cancelled RAW export destroys its read stream', async () => {
    writeBigJsonl('sess-raw');
    const opened = captureStreams();
    await requestThenAbort(`/session-log/sess-raw?token=${token}&format=raw`, {
      [RAW_ACK_HEADER]: RAW_ACK_VALUE,
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.destroyed).toBe(true);
  });

  test('a cancelled REDACTED export destroys its read stream', async () => {
    writeBigJsonl('sess-red');
    const opened = captureStreams();
    await requestThenAbort(`/session-log/sess-red?token=${token}`);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.destroyed).toBe(true);
  });

  test('a COMPLETED redacted export still delivers every line', async () => {
    // Anti-vacuity for both cases above: a teardown that fires too eagerly
    // would truncate an ordinary download, and "the stream is destroyed"
    // would still pass.
    writeJsonl('sess-ok', [
      { type: 'assistant', text: 'first' },
      { type: 'assistant', text: 'middle' },
      { type: 'assistant', text: 'last' },
    ]);
    const res = await request({
      path: `/session-log/sess-ok?token=${token}`,
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('first');
    expect(res.body).toContain('middle');
    expect(res.body).toContain('last');
    expect(res.body.trimEnd().split('\n')).toHaveLength(3);
  });

  test('a COMPLETED raw export still delivers the whole body', async () => {
    writeJsonl('sess-ok-raw', [{ marker: 'alpha' }, { marker: 'omega' }]);
    const res = await request({
      path: `/session-log/sess-ok-raw?token=${token}&format=raw`,
      hostHeader: defaultHostHeader(),
      extraHeaders: { [RAW_ACK_HEADER]: RAW_ACK_VALUE },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('alpha');
    expect(res.body).toContain('omega');
  });

  test('a backpressured redacted export parks at most one drain listener', async () => {
    // `rl.pause()` does not discard the lines readline has already buffered,
    // so without a guard every one of them parked its own `once('drain')`.
    // Node reports that itself once the count passes ten — which is both the
    // symptom and the cleanest way to observe it from outside the handler.
    writeBigJsonl('sess-drain');
    const warnings: string[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(w.name);
    };
    process.on('warning', onWarning);
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: TEST_HOST,
            port: serverPort,
            path: `/session-log/sess-drain?token=${token}`,
            method: 'GET',
            headers: { Host: defaultHostHeader() },
          },
          (res) => {
            // Deliberately do not read: the socket buffer fills, every write
            // returns false, and the server sits in the backpressure branch.
            res.pause();
            setTimeout(() => {
              req.destroy();
              setTimeout(resolve, 150);
            }, 400);
          },
        );
        req.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ECONNRESET') return;
          reject(err);
        });
        req.end();
      });
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings).not.toContain('MaxListenersExceededWarning');
  });
});

// ─────────────────────────────────────────────────────────────────────
// `Cebab-ygu.47` — streaming partials are not part of the redacted artifact.
//
// TWO RULES FOR EVERY CASE BELOW, both learned from the measurement:
//
//   1. Never assert on `fields` / `redactedFields` as evidence of safety. The
//      redactor's own registers are about a truthful `fields` sitting beside a
//      leak, and the measured 35 KB leaky artifact contained 183 `<redacted>`
//      tokens. Presence of the token proves the redactor RAN, nothing more.
//   2. Canaries are assembled at RUNTIME and are deliberately NOT
//      vendor-shaped. `sk-…` / `AKIA…` are already masked by
//      SENSITIVE_VALUE_PATTERNS, so a canary of that shape would go green with
//      the bug fully live. Runtime assembly also keeps the required
//      `Secret scan (gitleaks)` check at full strength — no by-value allowlist
//      entry needed, because the literal never appears in the source.
// ─────────────────────────────────────────────────────────────────────

/** Non-vendor-shaped, assembled at runtime. See rule 2 above. */
const CANARY = 'REDACTION' + '-CANARY-' + '77';
/** A secret CHOPPED across two deltas — the shape no per-line rule can match. */
const PHRASE_HEAD = 'correct-horse-battery-';
const PHRASE_TAIL = 'staple-9271';

/**
 * The real envelope shape observed on disk, not a minimised one. A hand-shrunk
 * `{ type: 'stream_event', text: … }` could be masked by an unrelated rule and
 * would prove nothing about the class exclusion.
 */
function delta(sid: string, text: string): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    parent_tool_use_id: null,
    session_id: sid,
    uuid: 'uuid-delta',
  };
}

function typesOf(body: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of body.split('\n')) {
    if (!l) continue;
    try {
      const t = (JSON.parse(l) as { type?: string }).type ?? '(none)';
      out[t] = (out[t] ?? 0) + 1;
    } catch {
      out['(unparsable)'] = (out['(unparsable)'] ?? 0) + 1;
    }
  }
  return out;
}

describe('[security] redactJsonlLine :: streaming partials are dropped', () => {
  test('a delta carrying a non-vendor-shaped secret returns null', () => {
    expect(redactJsonlLine(JSON.stringify(delta('s1', `key = ${CANARY}`)))).toBeNull();
  });

  test('a durable message is NEVER the null case', () => {
    // The other half of the rule. Without this, "drop everything" passes.
    for (const type of ['assistant', 'user', 'system', 'result', 'rate_limit_event']) {
      expect(redactJsonlLine(JSON.stringify({ type, text: 'hello' }))).not.toBeNull();
    }
  });

  test('a line whose parsed value is not an object survives the shape guard', () => {
    // `JSON.parse` legitimately yields these. Reading `.type` on `null` throws,
    // and that throw would land in the catch and be MISREPORTED as "not JSON".
    expect(redactJsonlLine('null')).toBe('null');
    expect(redactJsonlLine('42')).toBe('42');
    expect(redactJsonlLine('[1,2]')).toBe('[1,2]');
    expect(redactJsonlLine('"a string"')).toBe('"a string"');
  });

  test('a line with no `type` at all is kept, not dropped', () => {
    // Reddens a rule that treats a missing/odd type as droppable.
    expect(redactJsonlLine(JSON.stringify({ foo: 1 }))).not.toBeNull();
  });
});

describe('[security] /session-log :: the redacted artifact carries no streaming partials', () => {
  const SID = 'sess-partials';

  /** One turn: init, four deltas (two carrying secrets), the durable reply. */
  function writeLeakyLog(): void {
    writeJsonl(SID, [
      { type: 'system', subtype: 'init', session_id: SID },
      delta(SID, 'here are the notes: '),
      delta(SID, `plain_marker = ${CANARY}`),
      // The chopped secret: neither line contains a matchable value.
      delta(SID, `db_password = ${PHRASE_HEAD}`),
      delta(SID, PHRASE_TAIL),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', session_id: SID },
    ]);
  }

  test('the canary does not cross the socket', async () => {
    // Every pure-function case above can be green while the endpoint leaks —
    // the loop could `String(out)` the null away. At least one canary has to
    // travel the real response body.
    writeLeakyLog();
    const res = await request({ path: `/session-log/${SID}?token=${token}` });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(CANARY);
  });

  test('BOTH halves of a secret split across two deltas are gone', async () => {
    // The load-bearing assertion in this file. Asserting only on the JOINED
    // string passes TODAY, with the bug fully live, because no single line
    // ever contained it — which is precisely why value-pattern redaction can
    // never fix this class.
    writeLeakyLog();
    const res = await request({ path: `/session-log/${SID}?token=${token}` });
    expect(res.body).not.toContain(PHRASE_HEAD);
    expect(res.body).not.toContain(PHRASE_TAIL);
    expect(res.body).not.toContain(PHRASE_HEAD + PHRASE_TAIL);
  });

  test('the durable classes survive — the fix is not "drop everything"', async () => {
    writeLeakyLog();
    const res = await request({ path: `/session-log/${SID}?token=${token}` });
    // Assert the exact multiset of TYPES, not a line count: a count assertion
    // passes just as well when the wrong lines were dropped.
    expect(typesOf(res.body)).toEqual({ system: 1, assistant: 1, result: 1 });
    expect(res.body).toContain('"done"');
  });

  test('a log of nothing but partials exports an empty body, and one audit row', async () => {
    const sid = 'sess-all-partials';
    writeJsonl(sid, [delta(sid, 'a'), delta(sid, 'b')]);
    const countRows = (): number =>
      (getDb().prepare('SELECT COUNT(*) AS c FROM safety_audit').get() as { c: number }).c;
    const before = countRows();
    const res = await request({ path: `/session-log/${sid}?token=${token}` });
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(countRows() - before).toBe(1);
  });

  test('format=raw still ships the partials, byte for byte', async () => {
    // Reddens the class rule leaking onto the raw path — e.g. someone routing
    // raw through the line loop "for consistency". `toContain(CANARY)` alone
    // would still pass if raw dropped OTHER lines, so the assertion is
    // byte-equality with the file: raw is the complete trace, and mock-fixture
    // capture depends on that.
    writeLeakyLog();
    const res = await request({
      path: `/session-log/${SID}?token=${token}&format=raw`,
      extraHeaders: { 'X-Cebab-Acknowledge-Raw': 'I-understand' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain(CANARY);
    expect(res.body).toContain(PHRASE_HEAD);
    expect(res.body).toBe(fs.readFileSync(path.join(config.logsDir, `${SID}.jsonl`), 'utf8'));
  });

  test('the export does not modify the file it read', async () => {
    // Pins "redact at display, not at write", which was otherwise only prose,
    // and reddens an implementation that "fixes" the log instead of the artifact.
    writeLeakyLog();
    const p = path.join(config.logsDir, `${SID}.jsonl`);
    const before = fs.readFileSync(p);
    await request({ path: `/session-log/${SID}?token=${token}` });
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });

  test('the audit row records which code path produced the bytes', async () => {
    // Reddens versioning smuggled into `reasonCode`, and asserts the EXACT
    // constant — "the tag is present" would pass on undefined.
    writeLeakyLog();
    await request({ path: `/session-log/${SID}?token=${token}` });
    const row = getDb()
      .prepare(
        `SELECT reason_code, payload_json FROM safety_audit
         WHERE kind = 'session.exported' ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { reason_code: string; payload_json: string };
    expect(row.reason_code).toBe('exported_redacted');
    expect(JSON.parse(row.payload_json).contentPolicy).toBe(REDACTED_CONTENT_POLICY);
  });

  test('a raw export carries no contentPolicy — it applies no content policy', async () => {
    writeLeakyLog();
    await request({
      path: `/session-log/${SID}?token=${token}&format=raw`,
      extraHeaders: { 'X-Cebab-Acknowledge-Raw': 'I-understand' },
    });
    const row = getDb()
      .prepare(
        `SELECT reason_code, payload_json FROM safety_audit
         WHERE kind = 'session.exported' ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { reason_code: string; payload_json: string };
    expect(row.reason_code).toBe('exported_raw');
    expect(JSON.parse(row.payload_json).contentPolicy).toBeUndefined();
  });
});

describe('[security] the export and the events table agree on what is durable', () => {
  // `Cebab-ygu.47`'s root cause was two independent answers to one question.
  // Testing the predicate alone would prove nothing about the call sites, so
  // this exercises BOTH: the export's null case, and `persistMessage`'s
  // returns-null-for-partials contract.
  test('isStreamPartial classifies every observed type the same way for both', () => {
    const durable = ['assistant', 'user', 'system', 'result', 'rate_limit_event', 'wrapper'];
    for (const t of durable) {
      expect(isStreamPartial(t)).toBe(false);
      expect(redactJsonlLine(JSON.stringify({ type: t }))).not.toBeNull();
    }
    expect(isStreamPartial('stream_event')).toBe(true);
    expect(redactJsonlLine(JSON.stringify({ type: 'stream_event' }))).toBeNull();
    // Unknown and empty default to DURABLE — a deny-list fails visibly (a new
    // type shows up in the artifact) rather than silently losing it.
    expect(isStreamPartial('')).toBe(false);
    expect(isStreamPartial('some_future_type')).toBe(false);
  });
});
