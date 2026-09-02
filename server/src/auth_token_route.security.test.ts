/**
 * [security] Origin posture of `GET /auth-token`.
 *
 * This endpoint is the only surface that HANDS OUT the per-launch WS token
 * rather than merely checking it, so it is the one place where an empty Origin
 * means "some local non-browser process is asking for the control-plane
 * credential". It used to serve them, on the reasoning that such a process
 * could read `~/.cebab/auth-token` anyway — but that made the code contradict
 * `origin.ts`'s stated contract and gave any local process a one-request path
 * to the token with no filesystem access at all.
 *
 * Contrast `/session-log`, which deliberately still accepts an empty Origin:
 * it requires `verifyToken`, so its callers already hold the secret.
 *
 * Uses raw `http.request` rather than `fetch()` for the same reason
 * session_log_export.test.ts does — fetch silently overrides the Host header,
 * and Host is one of the two gates under test.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import { config } from './config.js';
import { initAuthToken } from './auth.js';
import { mountAuthTokenRoute } from './auth_token_route.js';

const TEST_HOST = '127.0.0.1';

/** The dev web origin, which `beforeEach` declares. Not allow-listed by
 *  default — see the comment there and `origin.security.test.ts`. */
const DECLARED_WEB_ORIGIN = `http://${TEST_HOST}:5173`;

let server: http.Server;
let serverPort: number;
let token: string;
let tmpRoot: string;
let originalDataDir: string;
let originalPort: number;
let originalAllowedOrigins: string[];

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-auth-route-'));
  originalDataDir = config.dataDir;
  originalPort = config.port;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  token = initAuthToken();
  // Register H09: :5173 is not allow-listed by default any more. It is
  // DECLARED by whatever starts that web server — `npm run dev` for a real
  // launch, this line for the probe standing in for the browser app. The
  // CORS echo below is the reason the declaration matters: an allow-listed
  // origin can READ the token, not merely request it.
  originalAllowedOrigins = [...config.allowedOrigins];
  config.allowedOrigins.push(DECLARED_WEB_ORIGIN);

  const app = express();
  // Mount AFTER config.port is still the original: buildAllowedOrigins() reads
  // config.port eagerly, and the allow-list must match the Host we send.
  mountAuthTokenRoute(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, TEST_HOST, () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  config.dataDir = originalDataDir;
  config.port = originalPort;
  config.allowedOrigins.length = 0;
  config.allowedOrigins.push(...originalAllowedOrigins);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function request(opts: { origin?: string; hostHeader?: string; fetchSite?: string }): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers['Origin'] = opts.origin;
  if (opts.hostHeader !== undefined) headers['Host'] = opts.hostHeader;
  if (opts.fetchSite !== undefined) headers['Sec-Fetch-Site'] = opts.fetchSite;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: TEST_HOST, port: serverPort, path: '/auth-token', method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Host header matching the allow-list entry for the configured port. */
function allowedHost(): string {
  return `${TEST_HOST}:${config.port}`;
}

describe('[security] GET /auth-token origin posture', () => {
  test('serves the token to the allow-listed browser origin', async () => {
    const res = await request({
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: allowedHost(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(token);
    // CORS echo so the dev-mode cross-port fetch can read the response.
    expect(res.headers['access-control-allow-origin']).toBe(DECLARED_WEB_ORIGIN);
    expect(res.headers['vary']).toBe('Origin');
  });

  test('rejects an empty Origin — non-browser clients must read the file', async () => {
    // Unchanged by single-port serving, and that is the point: a bare curl
    // sends no `Sec-Fetch-Site`, so the posture this endpoint has always had
    // still holds. Gating the empty-Origin case on `Host` instead would have
    // flipped this case to 200, because curl sets Host itself.
    const res = await request({ hostHeader: allowedHost() });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('origin_not_allowed');
    expect(res.body).not.toContain(token);
  });

  test('rejects a cross-origin browser tab (CSWSH pivot)', async () => {
    const res = await request({
      origin: 'http://evil.example',
      hostHeader: allowedHost(),
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('origin_not_allowed');
    expect(res.body).not.toContain(token);
  });

  test('rejects a disallowed Host even with a good Origin (DNS rebinding)', async () => {
    const res = await request({
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: 'evil.example',
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('host_not_allowed');
    expect(res.body).not.toContain(token);
  });
});

describe('[security] GET /auth-token same-origin posture (single-port serving)', () => {
  // When the server serves the SPA itself (`static_web.ts`), the app's fetch
  // is same-origin and browsers OMIT `Origin` entirely. `Sec-Fetch-Site` is
  // what separates that request from any other empty-Origin caller: it is a
  // forbidden header name, so page JS cannot set or override it via `fetch()`.

  test('serves the token to a same-origin browser fetch with no Origin', async () => {
    const res = await request({ fetchSite: 'same-origin', hostHeader: allowedHost() });
    expect(res.status).toBe(200);
    expect(res.body).toBe(token);
    // No Origin to echo, so no CORS header — but `Vary` is still set, because
    // WHICH requests get answered depends on Origin.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['vary']).toBe('Origin');
  });

  test('rejects Sec-Fetch-Site: cross-site with no Origin', async () => {
    const res = await request({ fetchSite: 'cross-site', hostHeader: allowedHost() });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('origin_not_allowed');
    expect(res.body).not.toContain(token);
  });

  test('rejects Sec-Fetch-Site: none — a typed address bar is not the app', async () => {
    const res = await request({ fetchSite: 'none', hostHeader: allowedHost() });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('origin_not_allowed');
    expect(res.body).not.toContain(token);
  });

  test('still enforces Host on the same-origin path (DNS rebinding)', async () => {
    // The two checks are independent: satisfying Sec-Fetch-Site must not
    // become a way around the Host gate, which is the whole reason the
    // empty-Origin branch falls THROUGH to it rather than returning early.
    const res = await request({ fetchSite: 'same-origin', hostHeader: 'evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('host_not_allowed');
    expect(res.body).not.toContain(token);
  });
});
