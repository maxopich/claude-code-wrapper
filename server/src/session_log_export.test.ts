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
  redactJsonlLine,
} from './session_log_export.js';

// ── Pure-function tests ──────────────────────────────────────────────

describe('exportFilename', () => {
  test('uses session start time, not Date.now()', () => {
    // 2024-01-15 09:30:45 UTC = 1705311045000
    const filename = exportFilename('abcd1234-cafe-beef-0000-000000000000', 1705311045000);
    expect(filename).toBe('cebab-abcd1234-20240115-093045.jsonl');
  });

  test('truncates session id to 8 chars', () => {
    const filename = exportFilename('s', 1705311045000);
    expect(filename).toBe('cebab-s-20240115-093045.jsonl');
  });

  test('falls back to Date.now() when session start is null', () => {
    const before = Date.now();
    const filename = exportFilename('xx', null);
    const after = Date.now();
    const m = filename.match(/^cebab-xx-(\d{8})-(\d{6})\.jsonl$/);
    expect(m).not.toBeNull();
    if (!m) return;
    const [, ymd, hms] = m;
    const stampMs = Date.UTC(
      Number(ymd!.slice(0, 4)),
      Number(ymd!.slice(4, 6)) - 1,
      Number(ymd!.slice(6, 8)),
      Number(hms!.slice(0, 2)),
      Number(hms!.slice(2, 4)),
      Number(hms!.slice(4, 6)),
    );
    // Allow up to a second of slop for the second-precision stamp.
    expect(stampMs).toBeGreaterThanOrEqual(before - 1000);
    expect(stampMs).toBeLessThanOrEqual(after + 1000);
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
    const parsed = JSON.parse(out);
    expect(parsed.text).toBe('ok');
    expect(parsed.auth_token).toBe('<redacted>');
    expect(parsed.apiKey).toBe('<redacted>');
  });

  test('preserves an empty line verbatim', () => {
    expect(redactJsonlLine('')).toBe('');
  });

  test('preserves non-JSON lines verbatim (hand-edited or torn writes)', () => {
    const garbage = 'this is not json at all';
    expect(redactJsonlLine(garbage)).toBe(garbage);
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

let tmpRoot: string;
let originalDataDir: string;
let originalPort: number;
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
  await startServer();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  closeDb();
  config.dataDir = originalDataDir;
  config.port = originalPort;
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
        method: 'GET',
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
      origin: 'http://localhost:5173',
      hostHeader: 'wrong.host:9999',
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('host_not_allowed');
  });

  test('rejects a missing token', async () => {
    writeJsonl('sess-1', [{ type: 'assistant', text: 'hi' }]);
    const res = await request({
      path: `/session-log/sess-1`,
      origin: 'http://localhost:5173',
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('bad_token');
  });

  test('rejects a wrong token', async () => {
    writeJsonl('sess-1', [{ type: 'assistant', text: 'hi' }]);
    const res = await request({
      path: `/session-log/sess-1?token=garbage`,
      origin: 'http://localhost:5173',
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
      origin: 'http://localhost:5173',
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
      origin: 'http://localhost:5173',
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
      origin: 'http://localhost:5173',
      hostHeader: defaultHostHeader(),
    });
    expect(String(res.headers['content-disposition'])).toContain(
      'filename="cebab-sess-kno-20240115-093045.jsonl"',
    );
  });
});

describe('[security] /session-log :: raw format', () => {
  test('rejects raw without the acknowledgment header', async () => {
    writeJsonl('sess-1', [{ apiKey: 'sk-leak' }]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}&format=raw`,
      origin: 'http://localhost:5173',
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('raw_acknowledgement_required');
  });

  test('rejects raw with a wrong acknowledgment value', async () => {
    writeJsonl('sess-1', [{ apiKey: 'sk-leak' }]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}&format=raw`,
      origin: 'http://localhost:5173',
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
      origin: 'http://localhost:5173',
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
      origin: 'http://localhost:5173',
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('bad session id');
  });

  test('rejects an unknown ?format= value', async () => {
    writeJsonl('sess-1', [{}]);
    const res = await request({
      path: `/session-log/sess-1?token=${token}&format=html`,
      origin: 'http://localhost:5173',
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(400);
  });

  test('returns 404 when the on-disk log does not exist', async () => {
    const res = await request({
      path: `/session-log/sess-missing?token=${token}`,
      origin: 'http://localhost:5173',
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
      origin: 'http://localhost:5173',
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
      >('SELECT kind, reason_code, session_id, payload_json FROM safety_audit ORDER BY ts DESC LIMIT 1')
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
      origin: 'http://localhost:5173',
      hostHeader: defaultHostHeader(),
      extraHeaders: { [RAW_ACK_HEADER]: RAW_ACK_VALUE },
    });
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare<
        [],
        { reason_code: string; payload_json: string }
      >("SELECT reason_code, payload_json FROM safety_audit WHERE session_id = 'sess-raw'")
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
      origin: 'http://localhost:5173',
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
      origin: 'http://localhost:5173',
      hostHeader: defaultHostHeader(),
    });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('sk-leak-me');
    expect(spy).toHaveBeenCalled();
  });
});
