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

let server: http.Server;
let serverPort: number;
let token: string;
let tmpRoot: string;
let originalDataDir: string;
let originalPort: number;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-auth-route-'));
  originalDataDir = config.dataDir;
  originalPort = config.port;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  token = initAuthToken();

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
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function request(opts: { origin?: string; hostHeader?: string }): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers['Origin'] = opts.origin;
  if (opts.hostHeader !== undefined) headers['Host'] = opts.hostHeader;
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
      origin: `http://${TEST_HOST}:5173`,
      hostHeader: allowedHost(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(token);
    // CORS echo so the dev-mode cross-port fetch can read the response.
    expect(res.headers['access-control-allow-origin']).toBe(`http://${TEST_HOST}:5173`);
    expect(res.headers['vary']).toBe('Origin');
  });

  test('rejects an empty Origin — non-browser clients must read the file', async () => {
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
      origin: `http://${TEST_HOST}:5173`,
      hostHeader: 'evil.example',
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('host_not_allowed');
    expect(res.body).not.toContain(token);
  });
});
