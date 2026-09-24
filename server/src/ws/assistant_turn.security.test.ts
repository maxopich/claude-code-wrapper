/**
 * Cebab-zqhq [security]: the help assistant refuses every tool call that reaches
 * its permission gate, at once, and its turns load no MCP server and stay out of
 * the operator's notification stack.
 *
 * WHAT WAS WRONG, and therefore what this file has to catch. The assistant runs
 * through the ordinary single-agent path. Its `canUseTool` used to fall through
 * to the AskUserQuestion branch, then `shouldAutoAllow` (always false for the
 * assistant), and finally PARK a `permission_request` in `conn.pendingPermissions`
 * — but the help panel filters `permission_request` out, so nothing could ever
 * answer it and the turn waited until the socket closed. The CLI settles in-KB
 * reads itself, so the calls that DO reach the gate are exactly the out-of-KB
 * reads and any MCP tool: every one of those must now be refused on the spot.
 *
 * The harness drives the REAL `send_message` path with a mocked runner and then
 * calls the `canUseTool` the turn was actually spawned with — the same shape as
 * `ask_user_question.test.ts` next door, and for the same reason: a gate wired
 * to nothing passes every test of its parts. The runner behaviour is switchable
 * so the notification cases can make the iterator throw or yield a result.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const spawned: Record<string, unknown>[] = [];

// Per-test runner behaviour. `empty` just spawns and closes (the gate cases only
// need the captured `canUseTool`); `throw` rejects the iterator (a crashed /
// auth-lapsed turn); `yield` streams the given SDK messages (an error_max_turns
// result). Referenced lazily inside the factory, which only runs once the
// mocked module is first imported below — after these bindings exist.
let runnerBehavior:
  | { kind: 'empty' }
  | { kind: 'throw'; error: Error }
  | {
      kind: 'yield';
      messages: SDKMessage[];
    } = { kind: 'empty' };

vi.mock('../runner/index.js', () => ({
  pickRunner: (opts: Record<string, unknown>) => {
    spawned.push(opts);
    const behavior = runnerBehavior;
    return {
      async *[Symbol.asyncIterator]() {
        if (behavior.kind === 'throw') throw behavior.error;
        if (behavior.kind === 'yield') {
          for (const m of behavior.messages) yield m;
        }
      },
      close: async () => {},
      interrupt: async () => {},
      setPermissionMode: async () => {},
    };
  },
}));

const { config } = await import('../config.js');
const { closeDb, getDb } = await import('../db.js');
const { closeLogger } = await import('../runner/logger.js');
const { upsertProject } = await import('../repo/projects.js');
const { ensureAssistantProject, ASSISTANT_TOOL_REFUSED_TEXT } =
  await import('../assistant/identity.js');
const { handleClientMsg } = await import('./server.js');

type Conn = Parameters<typeof handleClientMsg>[0];
type Decision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };
type Gate = (
  tool: string,
  input: Record<string, unknown>,
  opts?: { toolUseID?: string },
) => Promise<Decision>;

let tmpRoot: string;
let originalDataDir: string;
let assistantId: number;
let ordinaryId: number;
let sent: ServerMsg[];

function makeConn(): Conn {
  sent = [];
  return {
    ws: {
      readyState: 1,
      send: (raw: string) => {
        sent.push(JSON.parse(raw) as ServerMsg);
      },
    },
    authorityCache: new Map(),
    inFlight: new Map(),
    pendingPermissions: new Map(),
    capturedPrompts: new Map(),
    rateLimitedSessions: new Set(),
    probeScheduler: { onProjectSelected: () => {}, cancel: () => {} },
    trustGate: { pending: new Map(), denyOnce: new Set() },
    busInstallGate: { pending: new Map(), denyOnce: new Set() },
  } as unknown as Conn;
}

/** Spawn one turn for `projectId` and hand back its gate, session, and options. */
async function spawnTurn(
  conn: Conn,
  projectId: number,
): Promise<{ gate: Gate; sessionId: string; opts: Record<string, unknown> }> {
  spawned.length = 0;
  await handleClientMsg(conn, { type: 'send_message', projectId, text: 'hi' } as never);
  expect(spawned).toHaveLength(1);
  const opts = spawned[0]!;
  return { gate: opts.canUseTool as Gate, sessionId: opts.sessionId as string, opts };
}

function refusedRows(sessionId: string): unknown[] {
  return getDb()
    .prepare('SELECT subtype FROM events WHERE session_id = ? AND subtype = ?')
    .all(sessionId, 'assistant_tool_refused');
}

/** Resolve the gate decision, but never let a parked promise hang the test. */
async function settleQuickly(pending: Promise<Decision>): Promise<Decision | 'PARKED'> {
  return Promise.race([
    pending,
    new Promise<'PARKED'>((resolve) => setTimeout(() => resolve('PARKED'), 200)),
  ]);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-assist-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  runnerBehavior = { kind: 'empty' };

  // The assistant row. Its path is a real directory so the spawn gate resolves.
  const kbDir = path.join(tmpRoot, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  assistantId = ensureAssistantProject(kbDir)!.id;

  // An ordinary UNTRUSTED workspace project at 'default' — the control.
  const projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projDir, '.claude'), { recursive: true });
  ordinaryId = upsertProject('proj', projDir).id;
});

afterEach(async () => {
  closeDb();
  // Before the rmSync and awaited — see the ask_user_question harness header:
  // the transcript logger holds write streams into this directory and opens
  // fds on a later tick, so removing the dir first races that open and fails
  // the whole run with an EnvironmentTeardownError.
  await closeLogger();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('[security] the assistant refuses every tool call at the gate', () => {
  test('[security] Read outside the KB is denied at once, not parked', async () => {
    const conn = makeConn();
    const { gate, sessionId } = await spawnTurn(conn, assistantId);

    const decision = await settleQuickly(gate('Read', { file_path: '/etc/hosts' }));
    // If the refusal branch is removed, the Read parks a permission_request and
    // this resolves to 'PARKED' — the frozen turn this bead fixes.
    expect(decision).toEqual({ behavior: 'deny', message: ASSISTANT_TOOL_REFUSED_TEXT });
    expect(sent.filter((m) => m.type === 'permission_request')).toHaveLength(0);
    expect(sent.filter((m) => m.type === 'ask_user_question')).toHaveLength(0);
    expect(conn.pendingPermissions.size).toBe(0);
    expect(refusedRows(sessionId)).toHaveLength(1);
  });

  test('[security] the deny is returned even when the refusal row cannot be written', async () => {
    // Review of PR #697: removing the try/catch around the refusal write left
    // every test green. A failed audit write must never turn a refusal into a
    // thrown gate (which the SDK would read as an error, not a deny).
    const conn = makeConn();
    const { gate } = await spawnTurn(conn, assistantId);
    getDb().exec('DROP TABLE events'); // insertEvent now throws
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const decision = await settleQuickly(gate('Read', { file_path: '/etc/hosts' }));
    expect(decision).toEqual({ behavior: 'deny', message: ASSISTANT_TOOL_REFUSED_TEXT });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('assistant_tool_refused persist failed'),
      expect.anything(),
    );
    errSpy.mockRestore();
    expect(sent.filter((m) => m.type === 'permission_request')).toHaveLength(0);
  });

  test('[security] Bash, AskUserQuestion, and an MCP tool are all refused the same way', async () => {
    const conn = makeConn();
    const { gate, sessionId } = await spawnTurn(conn, assistantId);

    // AskUserQuestion carries a valid questions input, so this proves the
    // assistant arm sits ABOVE the AskUserQuestion branch: a valid question
    // would otherwise park a card.
    const ONE_QUESTION = {
      questions: [
        {
          question: 'Which database?',
          header: 'DB',
          multiSelect: false,
          options: [{ label: 'Postgres' }],
        },
      ],
    };
    for (const [tool, input] of [
      ['Bash', { command: 'ls' }],
      ['AskUserQuestion', ONE_QUESTION],
      ['mcp__x__y', { anything: true }],
    ] as const) {
      const decision = await settleQuickly(gate(tool, input));
      expect(decision).toEqual({ behavior: 'deny', message: ASSISTANT_TOOL_REFUSED_TEXT });
    }
    expect(sent.filter((m) => m.type === 'permission_request')).toHaveLength(0);
    expect(sent.filter((m) => m.type === 'ask_user_question')).toHaveLength(0);
    expect(conn.pendingPermissions.size).toBe(0);
    expect(refusedRows(sessionId)).toHaveLength(3);
  });

  test('CONTROL: an ordinary untrusted project DOES send a permission_request for the same Read', async () => {
    // The anti-vacuity control. If the assistant arm accidentally caught every
    // project, this ordinary turn would deny instead of prompting.
    const conn = makeConn();
    const { gate } = await spawnTurn(conn, ordinaryId);
    void gate('Read', { file_path: '/etc/hosts' });
    // The card is emitted synchronously, but the promise is parked only after an
    // `await persistMessage`, so wait for both facts.
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'permission_request')).toHaveLength(1);
      expect(conn.pendingPermissions.size).toBe(1);
    });
  });

  test('[security] forced trust does not loosen the posture — still default, [], still denied', async () => {
    // The assistant must never be treated as trusted: `shouldAutoAllow(true, …)`
    // would auto-allow every tool. Force the row trusted and re-send.
    getDb().prepare(`UPDATE projects SET trusted = 1 WHERE kind = 'assistant'`).run();
    const conn = makeConn();
    const { gate, opts } = await spawnTurn(conn, assistantId);

    expect(opts.permissionMode).toBe('default');
    expect(opts.settingSources).toEqual([]);
    const decision = await settleQuickly(gate('Read', { file_path: '/etc/hosts' }));
    expect(decision).toEqual({ behavior: 'deny', message: ASSISTANT_TOOL_REFUSED_TEXT });
  });
});

describe('[security] the assistant spawn loads no MCP server', () => {
  test('[security] assistant options carry strictMcpConfig + disableClaudeAiConnectors', async () => {
    const conn = makeConn();
    const { opts } = await spawnTurn(conn, assistantId);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.disableClaudeAiConnectors).toBe(true);
  });

  test('an ordinary project carries neither key', async () => {
    const conn = makeConn();
    const { opts } = await spawnTurn(conn, ordinaryId);
    expect('strictMcpConfig' in opts).toBe(false);
    expect('disableClaudeAiConnectors' in opts).toBe(false);
  });
});

describe('[security] help-turn failures stay out of the notification stack', () => {
  function notifications(): ServerMsg[] {
    return sent.filter((m) => m.type === 'notification');
  }
  function wrapperErrors(): Extract<ServerMsg, { type: 'wrapper_error' }>[] {
    return sent.filter(
      (m): m is Extract<ServerMsg, { type: 'wrapper_error' }> => m.type === 'wrapper_error',
    );
  }

  test('[security] a crashed assistant turn sends a wrapper_error but NO notification', async () => {
    runnerBehavior = { kind: 'throw', error: new Error('kaboom') };
    const conn = makeConn();
    const { sessionId } = await spawnTurn(conn, assistantId);
    const errs = wrapperErrors();
    expect(errs).toHaveLength(1);
    expect(errs[0]!.sessionId).toBe(sessionId);
    expect(errs[0]!.kind).toBe('process_crashed');
    expect(notifications()).toHaveLength(0);
  });

  test('CONTROL: an ordinary crashed turn DOES send a notification', async () => {
    runnerBehavior = { kind: 'throw', error: new Error('kaboom') };
    const conn = makeConn();
    await spawnTurn(conn, ordinaryId);
    expect(wrapperErrors()).toHaveLength(1);
    expect(notifications().length).toBeGreaterThanOrEqual(1);
  });

  test('[security] an auth_expired assistant turn DOES send the notification', async () => {
    // A lapsed login is account-wide and its Re-authenticate action works, so
    // this is the one kind the assistant still surfaces.
    runnerBehavior = { kind: 'throw', error: new Error('OAuth token expired') };
    const conn = makeConn();
    await spawnTurn(conn, assistantId);
    const errs = wrapperErrors();
    expect(errs[0]!.kind).toBe('auth_expired');
    expect(notifications().length).toBeGreaterThanOrEqual(1);
  });

  test('[security] error_max_turns sends no notification for the assistant', async () => {
    const maxTurnsResult: SDKMessage = {
      type: 'result',
      subtype: 'error_max_turns',
      duration_ms: 1,
      total_cost_usd: 0,
      num_turns: 13,
    } as unknown as SDKMessage;
    runnerBehavior = { kind: 'yield', messages: [maxTurnsResult] };
    const conn = makeConn();
    await spawnTurn(conn, assistantId);
    expect(notifications()).toHaveLength(0);
    // ...but the cap hit still reaches the hash-chained audit log: skipping the
    // toast must not leave a gap in it (review of PR #697).
    const rows = getDb()
      .prepare(`SELECT payload_json FROM safety_audit WHERE kind = 'max_turns.hit'`)
      .all() as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({ assistant: true });
  });

  test('CONTROL: error_max_turns DOES notify for an ordinary project', async () => {
    const maxTurnsResult: SDKMessage = {
      type: 'result',
      subtype: 'error_max_turns',
      duration_ms: 1,
      total_cost_usd: 0,
      num_turns: 13,
    } as unknown as SDKMessage;
    runnerBehavior = { kind: 'yield', messages: [maxTurnsResult] };
    const conn = makeConn();
    await spawnTurn(conn, ordinaryId);
    expect(notifications().length).toBeGreaterThanOrEqual(1);
  });
});
