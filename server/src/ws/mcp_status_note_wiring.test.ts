/**
 * Cebab-ws0.15: the note actually reaches a spawn, and only when it should.
 *
 * `runner/mcp_status_note.test.ts` proves the prose is right and
 * `runner/build_sdk_options.test.ts` proves the options assembly forwards it.
 * Neither says the two are connected — a builder wired to nothing passes every
 * test of its parts, which is the failure `probe_on_select_wiring.test.ts` was
 * written next door to catch for the same reason.
 *
 * So this drives the real `send_message` path with a recording runner and reads
 * the options a turn was actually spawned with. `vi.mock` is file-scoped, hence
 * the separate file.
 *
 * THE CASE THAT MATTERS MOST IS THE NEGATIVE ONE. A connection whose authority
 * probe has not landed yet holds no cache entry at all, and that turn has to
 * spawn byte-identically to Cebab before this feature existed. A test suite
 * that only proved the note appears would pass just as happily on an
 * implementation that attached an empty override to every project on earth.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const spawned: Record<string, unknown>[] = [];

vi.mock('../runner/index.js', () => ({
  pickRunner: (opts: Record<string, unknown>) => {
    spawned.push(opts);
    // Shaped like a Query that produced nothing and closed cleanly: the turn
    // only needs to iterate and be closeable for the options to have been
    // committed, and yielding SDK messages would drag persistence and
    // translation into a test about one field.
    return {
      async *[Symbol.asyncIterator]() {
        // deliberately empty
      },
      close: async () => {},
      interrupt: async () => {},
      setPermissionMode: async () => {},
    };
  },
}));

const { config } = await import('../config.js');
const { closeDb, getDb } = await import('../db.js');
const { upsertProject } = await import('../repo/projects.js');
const { handleClientMsg } = await import('./server.js');

let tmpRoot: string;
let originalDataDir: string;
let projectId: number;

type Conn = Parameters<typeof handleClientMsg>[0];

/** A Conn just real enough for `runOneTurn`: the authority cache under test,
 *  and inert stand-ins for everything the turn touches on its way past. */
function connWith(mcpServers?: { name: string; status: string }[]): Conn {
  const authorityCache = new Map<number, { capturedAt: number; mcpServers?: typeof mcpServers }>();
  if (mcpServers !== undefined) authorityCache.set(projectId, { capturedAt: 0, mcpServers });
  return {
    ws: { readyState: 1, send: () => {} },
    authorityCache,
    inFlight: new Map(),
    pendingPermissions: new Map(),
    capturedPrompts: new Map(),
    probeScheduler: { onProjectSelected: () => {}, cancel: () => {} },
    trustGate: { pending: new Map(), denyOnce: new Set() },
    busInstallGate: { pending: new Map(), denyOnce: new Set() },
  } as unknown as Conn;
}

async function sendOneTurn(conn: Conn, sessionId?: string): Promise<Record<string, unknown>> {
  spawned.length = 0;
  await handleClientMsg(conn, {
    type: 'send_message',
    projectId,
    text: 'hello',
    ...(sessionId ? { sessionId } : {}),
  } as never);
  expect(spawned).toHaveLength(1);
  return spawned[0]!;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-note-wiring-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  const projectDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  projectId = upsertProject('proj', projectDir).id;
});

afterEach(() => {
  // closeDb before rm: Windows cannot unlink an open SQLite file.
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('a turn carries the MCP status note', () => {
  test('an unhealthy server in the cache reaches the spawn', async () => {
    const opts = await sendOneTurn(connWith([{ name: 'ledger', status: 'failed' }]));
    expect(typeof opts.systemPrompt).toBe('string');
    expect(String(opts.systemPrompt)).toContain('ledger');
    expect(String(opts.systemPrompt)).toContain('failed');
  });

  test('a healthy cache spawns with no systemPrompt at all', async () => {
    const opts = await sendOneTurn(connWith([{ name: 'ledger', status: 'connected' }]));
    expect('systemPrompt' in opts).toBe(false);
  });

  test('NO cache entry — the probe has not landed — spawns with no systemPrompt', async () => {
    // The commonest state on a fresh connection, and the one an implementation
    // that defaults the lookup (`?? []` over a whole-map read, or a `get()`
    // without the optional chain) would turn into a crash or an override.
    const opts = await sendOneTurn(connWith(undefined));
    expect('systemPrompt' in opts).toBe(false);
  });

  test('an empty server list spawns with no systemPrompt', async () => {
    const opts = await sendOneTurn(connWith([]));
    expect('systemPrompt' in opts).toBe(false);
  });
});

describe('the note is recomputed per turn, not fixed at session creation', () => {
  test('a server that comes up between turns stops being mentioned', async () => {
    // The measured reason this is possible at all: a system prompt supplied on
    // a `--resume` turn binds (`src/system_prompt_smoke.ts`). An implementation
    // that computed the note once and cached it on the session would keep
    // telling the model about a server that is now fine — reddens here.
    const conn = connWith([{ name: 'ledger', status: 'failed' }]);
    const first = await sendOneTurn(conn);
    expect(String(first.systemPrompt)).toContain('ledger');

    // What `cacheSessionStartedIfNeeded` does when the next init reports health.
    (conn.authorityCache as Map<number, { capturedAt: number; mcpServers: unknown }>).set(
      projectId,
      { capturedAt: 1, mcpServers: [{ name: 'ledger', status: 'connected' }] },
    );

    const second = await sendOneTurn(conn, String(first.sessionId ?? '') || undefined);
    expect('systemPrompt' in second).toBe(false);
  });

  test('and a server that BREAKS between turns starts being mentioned', async () => {
    // The mirror. Attaching only on the session-creating turn passes the case
    // above (it never attaches on turn 2 either) and fails here.
    const conn = connWith([{ name: 'ledger', status: 'connected' }]);
    const first = await sendOneTurn(conn);
    expect('systemPrompt' in first).toBe(false);

    (conn.authorityCache as Map<number, { capturedAt: number; mcpServers: unknown }>).set(
      projectId,
      { capturedAt: 1, mcpServers: [{ name: 'ledger', status: 'failed' }] },
    );

    const second = await sendOneTurn(conn, String(first.sessionId ?? '') || undefined);
    expect(String(second.systemPrompt)).toContain('ledger');
  });
});
