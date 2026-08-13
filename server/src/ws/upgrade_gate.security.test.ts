/**
 * [security] Register C03 — the WebSocket upgrade gate, driven end to end.
 *
 * `startWsServer`'s `verifyClient` is the front door to Cebab's entire
 * control plane: it decides, for every upgrade, whether a caller may open a
 * socket that can start sessions, read transcripts and flip trust. It has
 * four decision points (bad Origin → 403, bad Host → 403, bad token → 401,
 * else accept) plus one deliberate allowance (empty Origin).
 *
 * Until this file, NONE of that was tested. `origin.security.test.ts` covers
 * `buildAllowedOrigins`/`isAllowedHost` and `auth.test.ts` covers
 * `verifyToken`, but the composition — and, crucially, its ORDER and the
 * empty-Origin carve-out — had no coverage at all. Flipping the origin
 * condition or deleting the token check broke no test, in a file CODEOWNERS
 * specifically protects.
 *
 * WHY RAW `http.request` AND NOT A `ws` CLIENT. Same reason
 * `auth_token_route.security.test.ts` gives for its own probes: `fetch` (and
 * a `ws` client) manages the Host header for you, and Host is one of the
 * gates under test. Raw requests also surface the status code and the
 * `X-Cebab-Reject-Reason` header directly, which is what the gate actually
 * emits — a `ws` client would collapse every rejection into one opaque error.
 *
 * The gate itself is NOT refactored by this file. `verifyClient` stays inline
 * in the `new WebSocketServer({...})` call because `.semgrep/cebab-bus.yaml`
 * rule F4 asserts exactly that shape.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { initAuthToken } from '../auth.js';
import { closeDb } from '../db.js';
import { startWsServer } from './server.js';

const TEST_HOST = '127.0.0.1';

/** Register H09: the Vite dev origin is no longer trusted by default —
 *  Cebab trusts the port it BINDS, and whoever STARTS the web server
 *  declares that one (`npm run dev` does, via CEBAB_ALLOWED_ORIGINS).
 *  These probes stand in for the browser app, so they declare it the same
 *  way. The default posture is pinned in `origin.security.test.ts`. */
const DECLARED_WEB_ORIGIN = `http://${TEST_HOST}:5173`;

let server: http.Server;
let wss: WebSocketServer;
let serverPort: number;
let token: string;
let tmpRoot: string;
let originalDataDir: string;
let originalAllowedOrigins: string[];

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ws-upgrade-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  token = initAuthToken();
  originalAllowedOrigins = [...config.allowedOrigins];
  config.allowedOrigins.push(DECLARED_WEB_ORIGIN);

  server = http.createServer();
  // config.port is left at its real value: buildAllowedOrigins() reads it
  // eagerly inside startWsServer, and the probes send a Host header matching
  // it while connecting to the ephemeral listen port. Same split as
  // auth_token_route.security.test.ts.
  wss = startWsServer(server);
  await new Promise<void>((resolve) => {
    server.listen(0, TEST_HOST, () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterEach(async () => {
  wss.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  // An ACCEPTED upgrade reaches `onConnection`, which emits through the
  // notification dispatcher and so opens the SQLite handle against the temp
  // dataDir. `getDb` caches it in module state, and on Windows `rmSync` cannot
  // unlink an open file — windows-2022 failed here with
  // `EBUSY: resource busy or locked, unlink ...\cebab.sqlite` until this
  // close was added. POSIX happily unlinks open files, which is exactly why
  // it passed locally and only broke on CI.
  closeDb();
  config.dataDir = originalDataDir;
  config.allowedOrigins.length = 0;
  config.allowedOrigins.push(...originalAllowedOrigins);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Host header matching the allow-list entry for the configured port. */
function allowedHost(): string {
  return `${TEST_HOST}:${config.port}`;
}

type ProbeResult = { status: number; headers: http.IncomingHttpHeaders };

/**
 * Send a real WebSocket upgrade and report what the gate did with it.
 *
 * A 101 arrives as the request's `upgrade` event (the socket is torn down
 * immediately — this file asserts on the handshake, not on the protocol);
 * every rejection arrives as an ordinary `response`.
 */
function probeUpgrade(opts: {
  origin?: string;
  hostHeader?: string;
  token?: string | null;
}): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
  };
  // `undefined` means "omit the header entirely" — distinct from an empty
  // string, which is how a caller with no Origin is modelled.
  if (opts.origin !== undefined) headers['Origin'] = opts.origin;
  if (opts.hostHeader !== undefined) headers['Host'] = opts.hostHeader;

  const query = opts.token == null ? '' : `?token=${encodeURIComponent(opts.token)}`;

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: TEST_HOST,
      port: serverPort,
      path: `/${query}`,
      method: 'GET',
      headers,
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 101, headers: res.headers });
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('[security] WS upgrade gate — origin', () => {
  test('rejects a cross-origin upgrade with 403 and a reason header', async () => {
    // The CSWSH case the gate exists for: any tab the operator has open could
    // otherwise reach the local control plane.
    const res = await probeUpgrade({
      origin: 'http://evil.example',
      hostHeader: allowedHost(),
      token,
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('origin_not_allowed');
  });

  test('accepts a declared web origin', async () => {
    const res = await probeUpgrade({
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: allowedHost(),
      token,
    });
    expect(res.status).toBe(101);
  });

  test('accepts an ABSENT Origin — this allowance is deliberate', async () => {
    // Browsers always set Origin on a WS upgrade, so an absent one cannot be
    // a cross-site hijack; it means a local non-browser client (ws_smoke,
    // curl), and the token below is the real gate for those. Pinned because
    // it reads like an oversight to anyone who hasn't read the threat model,
    // and "tightening" it would silently break the smoke tests.
    const res = await probeUpgrade({ hostHeader: allowedHost(), token });
    expect(res.status).toBe(101);
  });
});

describe('[security] WS upgrade gate — host', () => {
  test('rejects a foreign Host with 403 and a reason header', async () => {
    // DNS-rebinding shape: the Origin is fine, the Host is not.
    const res = await probeUpgrade({
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: 'evil.example',
      token,
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('host_not_allowed');
  });

  test('rejects an allow-listed hostname on the wrong port', async () => {
    // isAllowedHost pins host AND port; a different local service proxying
    // through must not inherit the allowance.
    const res = await probeUpgrade({
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: `${TEST_HOST}:1`,
      token,
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('host_not_allowed');
  });
});

describe('[security] WS upgrade gate — token', () => {
  test('rejects a missing token with 401', async () => {
    // The gate that actually stops a local process (a bus worker running as
    // the operator's uid) from opening its own control-plane socket: Origin
    // and Host are headers any Node client sets freely.
    const res = await probeUpgrade({
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: allowedHost(),
      token: null,
    });
    expect(res.status).toBe(401);
  });

  test('rejects a wrong token of the same length with 401', async () => {
    // Same length so the comparison reaches timingSafeEqual rather than
    // short-circuiting on the length check.
    const wrong = 'f'.repeat(token.length);
    expect(wrong).not.toBe(token);
    const res = await probeUpgrade({
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: allowedHost(),
      token: wrong,
    });
    expect(res.status).toBe(401);
  });

  test('rejects a token that is a prefix of the real one', async () => {
    const res = await probeUpgrade({
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: allowedHost(),
      token: token.slice(0, -1),
    });
    expect(res.status).toBe(401);
  });
});

describe('[security] WS upgrade gate — check order', () => {
  test('a bad origin is reported even when the host is also bad', async () => {
    // Pins the order of the three checks. Not cosmetic: the reason header
    // feeds the operator's origin-rejection diagnostics, and a reordering
    // that made every rejection read `host_not_allowed` would quietly blind
    // the CSWSH signal while every other test here still passed.
    const res = await probeUpgrade({
      origin: 'http://evil.example',
      hostHeader: 'evil.example',
      token,
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('origin_not_allowed');
  });

  test('origin and host are both checked before the token', async () => {
    // A bad origin with NO token must still read as an origin rejection —
    // otherwise an attacker learns "your origin was fine, your token wasn't".
    const res = await probeUpgrade({
      origin: 'http://evil.example',
      hostHeader: allowedHost(),
      token: null,
    });
    expect(res.status).toBe(403);
    expect(res.headers['x-cebab-reject-reason']).toBe('origin_not_allowed');
  });
});

// ---------------------------------------------------------------------------
// Register H07: an ACCEPTED upgrade must re-verify the audit chain.
//
// `chain_reverify.security.test.ts` covers `reverifyChainOnAttach` itself —
// the reporting, the throttle, the fail-open posture. What it cannot cover is
// whether `onConnection` still CALLS it: that function is not exported, so the
// one line wiring the two together is only exercised by a real connection.
// Deleting it broke nothing until this case existed.
// ---------------------------------------------------------------------------
describe('[security] H07 — attach re-verifies the audit chain', () => {
  test('a real accepted upgrade reports a chain broken during uptime', async () => {
    const { appendSafetyAudit } = await import('../notifications/safety_audit.js');
    const { getDb } = await import('../db.js');
    const { _resetChainVerifyThrottle } = await import('./server.js');
    // The throttle is process-global (one chain, one walk, shared by every
    // socket), so the accepted upgrades in the cases above already consumed
    // this window. Clear it so this case observes a real verification.
    _resetChainVerifyThrottle();

    // Break the chain the way tampering would: mutate a row in place.
    appendSafetyAudit({ ts: 1, kind: 'test.event', reasonCode: 'r', payload: {} });
    getDb()
      .prepare(`UPDATE safety_audit SET payload_json = '{"tampered":1}' WHERE kind = 'test.event'`)
      .run();

    const before = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM safety_audit WHERE kind = 'audit.tamper_detected'`)
        .get() as { n: number }
    ).n;

    const res = await probeUpgrade({
      origin: DECLARED_WEB_ORIGIN,
      hostHeader: allowedHost(),
      token,
    });
    expect(res.status).toBe(101);

    // The audit row is the obligation — it must exist whether or not the
    // browser stayed connected long enough to receive the notification.
    const after = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM safety_audit WHERE kind = 'audit.tamper_detected'`)
        .get() as { n: number }
    ).n;
    expect(after).toBeGreaterThan(before);
  });
});
