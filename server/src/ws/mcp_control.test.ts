/**
 * `Cebab-ormv`: what `handleMcpControl` guarantees.
 *
 * THE CASE THAT MATTERS IS `a refused reconnect still ships the server list`.
 * It is the one measured non-trivial outcome this feature has — a `needs-auth`
 * server answers `reconnect` with a throw, verbatim `Server status: needs-auth`
 * — and the tempting implementation returns early on that throw, which blanks
 * the operator's panel at exactly the moment it becomes useful. Every other
 * case here exists to stop a plausible simplification of that one.
 *
 * The session is a fake on purpose. A real one spawns a `claude` process, and
 * the interesting behaviour is ORDERING and FAILURE-HANDLING, neither of which
 * a live CLI would demonstrate more honestly — it would just make the suite
 * slow, credential-dependent, and unable to produce the failures on demand.
 */
import { describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import type { McpServerLive } from '@cebab/shared';
import type { McpControlSession } from '../runner/mcp_control.js';
import { handleMcpControl, type McpControlRequest } from './mcp_control.js';

const ROSTER: McpServerLive[] = [
  { name: 'ok', status: 'connected', toolNames: ['mcp__ok__a'] },
  { name: 'locked', status: 'needs-auth', toolNames: [] },
];

type Calls = string[];

function fakeSession(calls: Calls, over: Partial<McpControlSession> = {}): McpControlSession {
  return {
    status: async () => {
      calls.push('status');
      return ROSTER.map((r) => ({ ...r }));
    },
    reconnect: async (n) => {
      calls.push(`reconnect:${n}`);
    },
    authenticate: async (n) => {
      calls.push(`authenticate:${n}`);
      return { kind: 'open_url', authUrl: 'https://example.invalid/auth' };
    },
    clearAuth: async (n) => {
      calls.push(`clearAuth:${n}`);
    },
    toggle: async (n, e) => {
      calls.push(`toggle:${n}:${e}`);
    },
    close: () => {
      calls.push('close');
    },
    ...over,
  };
}

async function run(
  req: McpControlRequest,
  session: McpControlSession,
  openThrows?: Error,
): Promise<{ sent: ServerMsg[] }> {
  const sent: ServerMsg[] = [];
  await handleMcpControl(
    {
      openSession: async () => {
        if (openThrows) throw openThrows;
        return session;
      },
      send: (m) => sent.push(m),
    },
    req,
  );
  return { sent };
}

/** Narrow to the one envelope this handler emits, so cases can read fields
 *  without repeating the type guard. */
function only(sent: ServerMsg[]): Extract<ServerMsg, { type: 'mcp_control_result' }> {
  expect(sent).toHaveLength(1);
  const m = sent[0];
  if (m?.type !== 'mcp_control_result')
    throw new Error(`expected mcp_control_result, got ${m?.type}`);
  return m;
}

describe('handleMcpControl', () => {
  test('THE BUG IT PREVENTS: a refused reconnect still ships the server list', async () => {
    const calls: Calls = [];
    const session = fakeSession(calls, {
      reconnect: async () => {
        calls.push('reconnect');
        // The live CLI's own words, measured 2026-09-18.
        throw new Error('Server status: needs-auth');
      },
    });
    const { sent } = await run({ projectId: 1, op: 'reconnect', serverName: 'locked' }, session);
    const msg = only(sent);

    // Both halves. Returning early on the throw would give the operator the
    // error and an empty panel.
    expect(msg.error).toBe('Server status: needs-auth');
    expect(msg.servers).toHaveLength(2);
    // And the read happened AFTER the failed op, not instead of it.
    expect(calls).toEqual(['reconnect', 'status', 'close']);
  });

  test('the CLI error is passed through verbatim, not paraphrased', async () => {
    const session = fakeSession([], {
      reconnect: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:9999');
      },
    });
    const { sent } = await run({ projectId: 1, op: 'reconnect', serverName: 'ok' }, session);
    // Cebab has not measured what each failure means; a mapping table here
    // would be a guess that goes stale in silence.
    expect(only(sent).error).toBe('ECONNREFUSED 127.0.0.1:9999');
  });

  test('servers: null means the READ failed, and [] means there are none', async () => {
    // The distinction the protocol doc calls out. Collapsing them tells an
    // operator with no servers that Cebab is broken.
    const dead = fakeSession([], {
      status: async () => {
        throw new Error('Query closed before response received');
      },
    });
    expect(only((await run({ projectId: 1, op: 'status' }, dead)).sent).servers).toBeNull();

    const empty = fakeSession([], { status: async () => [] });
    expect(only((await run({ projectId: 1, op: 'status' }, empty)).sent).servers).toEqual([]);
  });

  test('an op error outranks a read error, being the more specific of the two', async () => {
    const session = fakeSession([], {
      reconnect: async () => {
        throw new Error('the op failed');
      },
      status: async () => {
        throw new Error('the read failed');
      },
    });
    const msg = only(
      (await run({ projectId: 1, op: 'reconnect', serverName: 'ok' }, session)).sent,
    );
    expect(msg.error).toBe('the op failed');
    expect(msg.servers).toBeNull();
  });

  test('authenticate ships the URL alongside a fresh read', async () => {
    const calls: Calls = [];
    const msg = only(
      (await run({ projectId: 1, op: 'authenticate', serverName: 'locked' }, fakeSession(calls)))
        .sent,
    );
    expect(msg.authUrl).toBe('https://example.invalid/auth');
    expect(msg.servers).toHaveLength(2);
    expect(msg.callbackUnsupported).toBeUndefined();
  });

  test('a callback-expecting server is REFUSED, with no url and no error', async () => {
    // The unmeasured arm. It must not read as a failure — nothing went wrong —
    // and it must not ship a url the operator could visit to no effect.
    const session = fakeSession([], {
      authenticate: async () => ({ kind: 'callback_required' }),
    });
    const msg = only(
      (await run({ projectId: 1, op: 'authenticate', serverName: 'locked' }, session)).sent,
    );
    expect(msg.callbackUnsupported).toBe(true);
    expect(msg.authUrl).toBeUndefined();
    expect(msg.error).toBeUndefined();
  });

  test('toggle without `enabled` disables nothing by accident', async () => {
    const calls: Calls = [];
    await run({ projectId: 1, op: 'toggle', serverName: 'ok' }, fakeSession(calls));
    // `=== true`, so an absent flag is `false` — but the point of the case is
    // that the value is EXPLICIT rather than inherited from truthiness games.
    expect(calls).toContain('toggle:ok:false');
    const calls2: Calls = [];
    await run({ projectId: 1, op: 'toggle', serverName: 'ok', enabled: true }, fakeSession(calls2));
    expect(calls2).toContain('toggle:ok:true');
  });

  test('an op that needs a server name and has none is refused without a spawn', async () => {
    const calls: Calls = [];
    let opened = 0;
    const sent: ServerMsg[] = [];
    await handleMcpControl(
      {
        openSession: async () => {
          opened += 1;
          return fakeSession(calls);
        },
        send: (m) => sent.push(m),
      },
      { projectId: 1, op: 'reconnect' },
    );
    // A spawn is a `claude` process and the project's SessionStart hooks. A
    // frame that cannot possibly succeed must not cost one.
    expect(opened).toBe(0);
    expect(only(sent).error).toMatch(/needs a server name/);
  });

  test('status needs no server name', async () => {
    const msg = only((await run({ projectId: 1, op: 'status' }, fakeSession([]))).sent);
    expect(msg.error).toBeUndefined();
    expect(msg.servers).toHaveLength(2);
  });

  test('the session is closed on every path, including a throwing read', async () => {
    // It holds a live `claude` process; a leak here accumulates per click.
    for (const session of [
      fakeSession([]),
      fakeSession([], {
        status: async () => {
          throw new Error('boom');
        },
      }),
    ]) {
      const calls: Calls = [];
      const s = { ...session, close: () => calls.push('close') };
      await run({ projectId: 1, op: 'status' }, s);
      expect(calls).toContain('close');
    }
  });

  test('a session that cannot be opened is a refusal, not a crash', async () => {
    const { sent } = await run(
      { projectId: 9, op: 'status' },
      fakeSession([]),
      new Error('unknown project 9'),
    );
    const msg = only(sent);
    expect(msg.servers).toBeNull();
    expect(msg.error).toBe('unknown project 9');
    expect(msg.projectId).toBe(9);
  });

  test('the reply echoes op and serverName so a row can match its own answer', async () => {
    const msg = only(
      (await run({ projectId: 3, op: 'clear_auth', serverName: 'locked' }, fakeSession([]))).sent,
    );
    expect(msg.op).toBe('clear_auth');
    expect(msg.serverName).toBe('locked');
    expect(msg.projectId).toBe(3);
  });
});
