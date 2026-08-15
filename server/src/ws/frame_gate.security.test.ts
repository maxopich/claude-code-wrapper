/**
 * [security] Registers S17 + H10 — the frame boundary, driven end to end.
 *
 * `upgrade_gate.security.test.ts` covers who may OPEN a socket. This file
 * covers what may come DOWN one, which until now was: anything, of any size.
 *
 * `validate_client_msg.test.ts` proves the validator's own logic. What it
 * cannot prove is that the validator is WIRED — a unit-tested function nobody
 * calls is the register's own favourite finding. So the case below drives a
 * real `ws` client through a real `startWsServer` and watches the reply.
 *
 * THE BARRIER, since "assert nothing arrived" needs one. A malformed frame is
 * followed by a valid `get_settings`, and the test resolves on the first
 * `settings` reply. Nothing sends `settings` on connect (`onConnection` emits
 * `env_scrubbed` / `inbox_snapshot` / `recent_rejections` / `active_runs`),
 * and WS preserves frame order, so `settings` in hand means the malformed
 * frame has already been fully processed. No sleep, no polling.
 *
 * Before the fix that frame reached `set_workspace_root`, threw a `TypeError`
 * inside `expandHome` (`p.startsWith` on a number), and the handler's catch
 * sent `wrapper_error { kind: 'process_crashed' }` — followed by its own
 * `emitSettings`, so the `wrapper_error` is already in hand by the time the
 * barrier trips. Deterministic in both directions.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import type { ServerMsg } from '@cebab/shared';
import { config } from '../config.js';
import { initAuthToken } from '../auth.js';
import { closeDb } from '../db.js';
import { MAX_WS_FRAME_BYTES, startWsServer } from './server.js';

const TEST_HOST = '127.0.0.1';

let server: http.Server;
let wss: WebSocketServer;
let serverPort: number;
let token: string;
let tmpRoot: string;
let originalDataDir: string;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ws-frame-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  token = initAuthToken();

  server = http.createServer();
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
  // Same Windows unlink hazard `upgrade_gate.security.test.ts` documents: an
  // accepted connection opens the SQLite handle against the temp dataDir, and
  // windows-2022 cannot rmSync a file that is still open.
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Open a socket, send `frames` in order, and collect every ServerMsg until one
 * of `untilType` arrives.
 */
function exchange(frames: unknown[], untilType: string): Promise<ServerMsg[]> {
  return new Promise((resolve, reject) => {
    const seen: ServerMsg[] = [];
    const ws = new WebSocket(`ws://${TEST_HOST}:${serverPort}/?token=${token}`, {
      // The upgrade gate reads Host, and buildAllowedOrigins() was built from
      // config.port while we listen on an ephemeral one.
      headers: { host: `${TEST_HOST}:${config.port}` },
    });
    const done = (fn: () => void): void => {
      ws.close();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error(`no ${untilType} arrived`))), 8000);
    ws.on('error', (err) => {
      clearTimeout(timer);
      done(() => reject(err));
    });
    ws.on('open', () => {
      for (const f of frames) ws.send(JSON.stringify(f));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      seen.push(msg);
      if (msg.type === untilType) {
        clearTimeout(timer);
        done(() => resolve(seen));
      }
    });
  });
}

describe('[security] S17 — the validator is wired into the message path', () => {
  test('a wrong-typed field is dropped instead of reaching its handler', async () => {
    const seen = await exchange(
      [
        // `path` is declared `string`. A number used to reach `expandHome`.
        { type: 'set_workspace_root', path: 123 },
        { type: 'get_settings' },
      ],
      'settings',
    );
    expect(seen.filter((m) => m.type === 'wrapper_error')).toEqual([]);
  });

  test('an unknown message type is dropped WITH a reason in the server log', async () => {
    // Asserting "no wrapper_error" would be vacuous here, and the
    // revert-check caught it: an unknown type falls through
    // `handleClientMsg`'s switch and returns silently either way. The log
    // line IS the deliverable for a dropped frame — the design deliberately
    // sends nothing back over the wire — so that is what gets asserted.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const seen = await exchange(
        [{ type: 'definitely_not_a_verb', sessionId: 's' }, { type: 'get_settings' }],
        'settings',
      );
      expect(seen.filter((m) => m.type === 'wrapper_error')).toEqual([]);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('rejected frame'))).toBe(true);
      expect(lines.some((l) => l.includes('definitely_not_a_verb'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('a well-formed frame still reaches its handler', async () => {
    // The other direction: the gate must not simply be swallowing everything.
    // Without this, deleting the whole `ws.on('message')` body would pass the
    // two cases above.
    const seen = await exchange([{ type: 'get_settings' }], 'settings');
    expect(seen.some((m) => m.type === 'settings')).toBe(true);
  });
});

describe('[security] H10 — a single frame is bounded', () => {
  test('the server sets an explicit maxPayload well under the 100 MiB default', () => {
    // `ws` defaults to 100 MiB per frame, and `raw.toString()` plus
    // `JSON.parse` duplicate whatever arrives. Reading the option off the
    // constructed server is the assertion — this is configuration, and the
    // only failure mode is that nobody passed it.
    const configured = (wss.options as { maxPayload?: number }).maxPayload;
    expect(configured).toBe(MAX_WS_FRAME_BYTES);
    expect(MAX_WS_FRAME_BYTES).toBeLessThan(100 * 1024 * 1024);
    // …and large enough for the biggest legitimate frame: an operator-edited
    // `Write` tool input in a permission card.
    expect(MAX_WS_FRAME_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });
});
