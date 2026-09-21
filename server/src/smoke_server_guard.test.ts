/**
 * The port guard, and the ways it could wave a collision through.
 *
 * The defect it closes (`Cebab-j1dl`) is not "the smoke fails" — it is that the
 * smoke *succeeded at talking to the wrong server* and then failed somewhere
 * else, as an `ENOENT` on a temp path that names neither the port nor the
 * cause. So the cases below care about two things: that an occupied port is
 * actually detected against a REAL listener rather than a mocked one, and that
 * the message says enough to find the process holding it.
 */
import { afterEach, describe, expect, test } from 'vitest';
import net from 'node:net';

import { DEFAULT_PORT } from '@cebab/shared/net';

import {
  checkPortAvailable,
  portUnavailableMessage,
  probeBind,
  resolveSmokeTarget,
  waitForHealthyServer,
  whoHoldsPortCommand,
} from './smoke_server_guard.js';

const open: net.Server[] = [];

/** A real listener on a real, free port — the thing a stray `dev:server` is. */
function squat(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    open.push(s);
    s.listen({ port: 0, host: '127.0.0.1' }, () => {
      resolve((s.address() as net.AddressInfo).port);
    });
  });
}

/** A port nobody holds: take one, then give it back. */
async function freePort(): Promise<number> {
  const s = net.createServer();
  const port = await new Promise<number>((resolve) => {
    s.listen({ port: 0, host: '127.0.0.1' }, () => {
      resolve((s.address() as net.AddressInfo).port);
    });
  });
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

afterEach(async () => {
  while (open.length) {
    const s = open.pop();
    await new Promise<void>((resolve) => s?.close(() => resolve()));
  }
});

describe('probeBind', () => {
  test('an occupied port is not bindable, and says EADDRINUSE', async () => {
    const port = await squat();
    expect(await probeBind(port)).toEqual({ bindable: false, code: 'EADDRINUSE' });
  });

  test('a free port is bindable — the green control', async () => {
    // Without this the suite would pass on a probe that always refused, which
    // is the one wrong answer that still blocks the bad case.
    expect(await probeBind(await freePort())).toEqual({ bindable: true, code: null });
  });

  test('the probe RELEASES the port it tested, so the server can still have it', async () => {
    // A guard that leaves a listener open would turn every clean run into the
    // collision it exists to prevent.
    const port = await freePort();
    expect((await probeBind(port)).bindable).toBe(true);
    expect((await probeBind(port)).bindable).toBe(true);
  });
});

describe('checkPortAvailable', () => {
  test('returns null for a free port and a message for an occupied one', async () => {
    expect(await checkPortAvailable(await freePort())).toBeNull();

    const port = await squat();
    const problem = await checkPortAvailable(port);
    expect(problem).toBeTruthy();
    expect(problem).toContain(String(port));
  });
});

describe('portUnavailableMessage', () => {
  test('EADDRINUSE names the port, the refusal, and how to find the owner', async () => {
    const msg = portUnavailableMessage(DEFAULT_PORT, 'EADDRINUSE', 'darwin');
    expect(msg).toContain(String(DEFAULT_PORT));
    expect(msg).toContain('Refusing to run');
    expect(msg).toContain(whoHoldsPortCommand(DEFAULT_PORT, 'darwin'));
    // The remedy that is right ~every time this fires, said outright.
    expect(msg).toContain('dev:server');
  });

  test('another errno is reported as ITSELF, not guessed at as a collision', async () => {
    // Telling someone to hunt for a process holding the port when the real
    // answer was EACCES sends them looking for something that is not there.
    const msg = portUnavailableMessage(80, 'EACCES', 'darwin');
    expect(msg).toContain('EACCES');
    expect(msg).not.toContain('dev:server');
  });

  test('the diagnostic command follows the platform', () => {
    expect(whoHoldsPortCommand(DEFAULT_PORT, 'win32')).toContain('netstat');
    expect(whoHoldsPortCommand(DEFAULT_PORT, 'linux')).toContain('lsof');
  });
});

describe('waitForHealthyServer', () => {
  /** A clock the test owns, so no case depends on real elapsed time — which
   *  under load is how a poll-loop test becomes a flake that blames whichever
   *  file is nearest the timeout. */
  function clock(startAt = 0) {
    let t = startAt;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }
  const ok = { ok: true } as Response;
  const notOk = { ok: false } as Response;

  test('a 200 from our live server is healthy', async () => {
    const c = clock();
    const verdict = await waitForHealthyServer({
      url: 'http://x/health',
      timeoutMs: 1000,
      isDead: () => false,
      fetchImpl: async () => ok,
      ...c,
    });
    expect(verdict).toBe('healthy');
  });

  test('a 200 that arrives AFTER our child died is NOT healthy', async () => {
    // THE CASE. This is the measured failure: the squatter answers on the first
    // poll, our server is already gone, and a check placed only before the
    // fetch sees a live child and waves it through. `died`, not `healthy`.
    const c = clock();
    let dead = false;
    const verdict = await waitForHealthyServer({
      url: 'http://x/health',
      timeoutMs: 1000,
      isDead: () => dead,
      fetchImpl: async () => {
        dead = true; // the exit event lands while the request is in flight
        return ok;
      },
      ...c,
    });
    expect(verdict).toBe('died');
  });

  test('a child already gone is reported without asking the port at all', async () => {
    // Nobody is asked, so nothing else can answer for us.
    const c = clock();
    let fetches = 0;
    const verdict = await waitForHealthyServer({
      url: 'http://x/health',
      timeoutMs: 1000,
      isDead: () => true,
      fetchImpl: async () => {
        fetches += 1;
        return ok;
      },
      ...c,
    });
    expect(verdict).toBe('died');
    expect(fetches).toBe(0);
  });

  test('it keeps polling through refused connections, then succeeds', async () => {
    // The green control for the loop itself: without it, a waiter that gave up
    // on the first ECONNREFUSED would satisfy every case above.
    const c = clock();
    let calls = 0;
    const verdict = await waitForHealthyServer({
      url: 'http://x/health',
      timeoutMs: 10_000,
      pollMs: 300,
      isDead: () => false,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 4) throw new Error('ECONNREFUSED');
        return ok;
      },
      ...c,
    });
    expect(verdict).toBe('healthy');
    expect(calls).toBe(4);
  });

  test('a server that never answers times out rather than hanging', async () => {
    const c = clock();
    const verdict = await waitForHealthyServer({
      url: 'http://x/health',
      timeoutMs: 900,
      pollMs: 300,
      isDead: () => false,
      fetchImpl: async () => notOk,
      ...c,
    });
    expect(verdict).toBe('timeout');
  });
});

describe('resolveSmokeTarget', () => {
  test('PORT wins over the compiled-in default', () => {
    // The Cebab-c0n2 case: ci_smoke starts the server on PORT, so a smoke that
    // reads only DEFAULT_PORT talks to whatever is on the default instead.
    const t = resolveSmokeTarget({ PORT: '4400' }, DEFAULT_PORT);
    expect(t.port).toBe('4400');
    expect(t.wsUrl).toBe('ws://127.0.0.1:4400');
  });

  test('with no PORT it falls back to the shared default', () => {
    const t = resolveSmokeTarget({}, DEFAULT_PORT);
    expect(t.port).toBe(String(DEFAULT_PORT));
    expect(t.wsUrl).toContain(`:${DEFAULT_PORT}`);
  });

  test('WS_URL wins outright — the other-host escape hatch', () => {
    const t = resolveSmokeTarget({ PORT: '4400', WS_URL: 'ws://elsewhere:9/' }, DEFAULT_PORT);
    expect(t.wsUrl).toBe('ws://elsewhere:9/');
  });
});

describe('the health poll cannot park forever', () => {
  test('each request carries an abort signal', () => {
    // A port that accepts and never answers is the shape that hangs `fetch`,
    // and it is reachable from exactly the collision this module guards.
    let sawSignal = false;
    return waitForHealthyServer({
      url: 'http://x/health',
      timeoutMs: 100,
      pollMs: 100,
      isDead: () => false,
      now: (() => {
        let n = 0;
        return () => (n += 10);
      })(),
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        sawSignal = Boolean((init as RequestInit | undefined)?.signal);
        return { ok: false } as Response;
      },
    }).then(() => expect(sawSignal).toBe(true));
  });
});
