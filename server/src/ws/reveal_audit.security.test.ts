import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import type { ServerMsg } from '@cebab/shared';
import { config } from '../config.js';
import { initAuthToken } from '../auth.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from '../repo/projects.js';
import { createSession } from '../repo/sessions.js';
import { resolveRevealAudit, startWsServer } from './server.js';

/**
 * [security] Register H06 — the reveal path leaves a trail.
 *
 * `load_session_log` with `revealSensitive: true` is the cheapest route to
 * unredacted transcript bytes, and it was the only one of three that recorded
 * nothing. Its comment justified that with "the connection is already bound
 * to 127.0.0.1" — true of the HTTP export and raw search too, and both of
 * those audit first.
 *
 * Two halves, tested two ways. The DECISION (audit, and downgrade if the
 * append fails) is a pure function with an injected seam, because a real
 * socket cannot make SQLite throw on demand. The WIRING — that the handler
 * actually calls it — is driven end to end through a real `ws` client, since
 * a unit-tested function nobody calls is the register's favourite finding.
 */

const TEST_HOST = '127.0.0.1';

let server: http.Server;
let wss: WebSocketServer;
let serverPort: number;
let token: string;
let tmpRoot: string;
let originalDataDir: string;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-reveal-audit-'));
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
  // Windows cannot rmSync a file whose handle is still open — same hazard
  // `upgrade_gate.security.test.ts` documents.
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Open a socket, send `frames`, collect ServerMsgs until `untilType`. */
function exchange(frames: unknown[], untilType: string): Promise<ServerMsg[]> {
  return new Promise((resolve, reject) => {
    const seen: ServerMsg[] = [];
    const ws = new WebSocket(`ws://${TEST_HOST}:${serverPort}/?token=${token}`, {
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

function seedSingleAgentSession(sessionId: string): void {
  // Repo helpers rather than hand-rolled SQL — the tables have NOT NULL
  // columns (`projects.created_at`) that a literal INSERT has to keep in
  // step with every future migration.
  const project = upsertProject('p', '/tmp/p');
  createSession(sessionId, project.id);
}

function revealRows(): Array<{ reason_code: string; session_id: string | null }> {
  return getDb()
    .prepare(
      `SELECT reason_code, session_id FROM safety_audit WHERE kind = 'session.revealed' ORDER BY id`,
    )
    .all() as Array<{ reason_code: string; session_id: string | null }>;
}

describe('[security] the reveal decision records intent, and fails closed', () => {
  test('a reveal writes session.revealed / revealed_raw before it is granted', () => {
    const calls: Array<Record<string, unknown>> = [];
    const granted = resolveRevealAudit({
      requested: true,
      sessionId: 'sess-1',
      scope: 'single',
      offset: 0,
      limit: 200,
      appendAudit: ((input: Record<string, unknown>) => {
        calls.push(input);
        return { id: 'a1' };
      }) as never,
    });

    expect(granted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'session.revealed',
      reasonCode: 'revealed_raw',
      sessionId: 'sess-1',
    });
  });

  test('the payload carries no transcript content', () => {
    // A reveal is often FOR a secret, and audit rows are append-only and
    // outlive the session — the same reason the raw-search row omits its
    // query string.
    const calls: Array<{ payload?: unknown }> = [];
    resolveRevealAudit({
      requested: true,
      sessionId: 'sess-1',
      scope: 'multi_agent',
      offset: 40,
      limit: 20,
      appendAudit: ((input: { payload?: unknown }) => {
        calls.push(input);
        return { id: 'a1' };
      }) as never,
    });
    expect(calls[0]!.payload).toEqual({ scope: 'multi_agent', offset: 40, limit: 20 });
  });

  test('an audit-write failure DOWNGRADES to redacted rather than erroring', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const granted = resolveRevealAudit({
      requested: true,
      sessionId: 'sess-1',
      scope: 'single',
      offset: 0,
      limit: 200,
      appendAudit: (() => {
        throw new Error('chain is broken');
      }) as never,
    });

    // Raw search's posture, not the export's 500: the operator still gets
    // their logs, just masked.
    expect(granted).toBe(false);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('downgrading to redacted'),
      expect.anything(),
    );
    err.mockRestore();
  });

  test('a NON-reveal request writes nothing — the common path stays free', () => {
    const calls: unknown[] = [];
    const granted = resolveRevealAudit({
      requested: false,
      sessionId: 'sess-1',
      scope: 'single',
      offset: 0,
      limit: 200,
      appendAudit: ((input: unknown) => {
        calls.push(input);
        return { id: 'a1' };
      }) as never,
    });
    expect(granted).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('[security] the reveal audit is WIRED into load_session_log', () => {
  test('a revealed load lands a row; the reply says it was revealed', async () => {
    seedSingleAgentSession('sess-live');
    const seen = await exchange(
      [
        {
          type: 'load_session_log',
          sessionId: 'sess-live',
          scope: 'single',
          offset: 0,
          limit: 50,
          revealSensitive: true,
        },
      ],
      'session_log_chunk',
    );

    const chunk = seen.find((m) => m.type === 'session_log_chunk') as {
      revealedSensitive?: boolean;
    };
    expect(chunk.revealedSensitive).toBe(true);

    const rows = revealRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason_code: 'revealed_raw', session_id: 'sess-live' });
  });

  test('a redacted load lands NO row — anti-vacuity for the case above', async () => {
    // Without this, the assertion above would pass on a handler that audited
    // unconditionally, which is a different (and noisier) bug.
    seedSingleAgentSession('sess-quiet');
    await exchange(
      [
        {
          type: 'load_session_log',
          sessionId: 'sess-quiet',
          scope: 'single',
          offset: 0,
          limit: 50,
        },
      ],
      'session_log_chunk',
    );

    expect(revealRows()).toEqual([]);
  });
});
