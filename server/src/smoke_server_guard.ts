/**
 * Refuse to run a smoke against a server we did not start.
 *
 * Two halves of one rule. `checkPortAvailable` settles it BEFORE the spawn —
 * nobody held the port, so whoever answers is ours. `waitForHealthyServer`
 * closes the window left after it, where our child dies and something else
 * answers before the exit event lands.
 *
 * WHY THIS EXISTS (`Cebab-j1dl`). `ci_smoke` spawns its own mock server on
 * `PORT`, polls `/health`, and runs `ws_smoke` as soon as **anything** answers
 * 200. It never checked that the thing answering was the server it started, and
 * a developer's `dev:server` sits on exactly that port by default.
 *
 * Measured, in both directions, on 2026-09-21:
 *
 *   - With a 20-line http server bound to the default port answering `/health`,
 *     the spawned server fails to bind and dies; `waitForHealth` gets its 200
 *     from the SQUATTER on the first poll, before the child's exit event fires,
 *     so the `serverExited` guard does not catch it; ci_smoke prints
 *     `server healthy — running ws_smoke` and proceeds; and `ws_smoke` dies
 *     reading an auth token that the never-started server never wrote:
 *     `ENOENT … open '<tmp>/.cebab/auth-token'`.
 *   - With the port free, the same command passes end to end.
 *
 * THE COST IS THE MISATTRIBUTION, not the failure. That ENOENT names a temp
 * path in an unrelated file and says nothing about a port, so it reads as flaky
 * infrastructure — which is how it has been read. On 2026-09-18 it cost a
 * FINISHED feature: an autonomous run reached a complete implementation, the
 * gate failed only here against an out-of-band dev server, two repair attempts
 * were spent on a phantom, and teardown discarded work that was never
 * committed. A tracked bug still attributes the same ENOENT to a local Node
 * version, which appears in the trace only because it is the local Node.
 *
 * THE RULE IS BINDABILITY, not "is someone listening". If this probe cannot
 * bind the port, the server about to be spawned cannot either — whatever the
 * errno. So there is no third "unknown, carry on anyway" verdict to degrade
 * into the behaviour this replaces.
 */
import net from 'node:net';

export type BindProbe = {
  /** True iff a listener could be opened on this port, and then closed again. */
  bindable: boolean;
  /** The errno that refused it — `EADDRINUSE` in the case this exists for. */
  code: string | null;
};

/**
 * Open a listener on `port` and immediately close it.
 *
 * There is a window between this closing and the server binding, and it is
 * accepted: the failure this guards against is a process that has been sitting
 * on the port for hours, not one that races us for it in a millisecond.
 */
export function probeBind(port: number, host = '127.0.0.1'): Promise<BindProbe> {
  return new Promise((resolve) => {
    const socket = net.createServer();
    socket.once('error', (err: NodeJS.ErrnoException) => {
      resolve({ bindable: false, code: err.code ?? null });
    });
    socket.once('listening', () => {
      socket.close(() => resolve({ bindable: true, code: null }));
    });
    socket.listen({ port, host, exclusive: true });
  });
}

/** The command that names the process holding a port, per platform. */
export function whoHoldsPortCommand(port: number, platform: string = process.platform): string {
  return platform === 'win32'
    ? `netstat -ano | findstr :${port}`
    : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

/**
 * What to print when the port cannot be bound.
 *
 * `EADDRINUSE` gets the specific sentence because it is the case that has
 * actually cost work, and because the remedy differs: something else is running,
 * and you need to know what. Every other errno is reported as itself rather
 * than guessed at.
 */
export function portUnavailableMessage(
  port: number,
  code: string | null,
  platform: string = process.platform,
): string {
  if (code === 'EADDRINUSE') {
    return (
      `port ${port} is already in use, so the server this smoke is about to ` +
      `start cannot bind it. Refusing to run: a smoke that talks to somebody ` +
      `else's server proves nothing, and fails later as an unrelated error. ` +
      `Find the owner with:\n    ${whoHoldsPortCommand(port, platform)}\n` +
      `A stray \`npm run dev:server\` is the usual answer — it binds this same ` +
      `port by default.`
    );
  }
  return (
    `port ${port} cannot be bound (${code ?? 'unknown error'}), so the server ` +
    `this smoke is about to start cannot bind it either. Refusing to run.`
  );
}

/**
 * The guard as one call: probe, and hand back the message when it fails.
 *
 * Returns `null` when the port is free, so a caller reads as
 * `const problem = await checkPortAvailable(...); if (problem) { … }` and
 * cannot accidentally treat a verdict object as truthy-means-good.
 */
export async function checkPortAvailable(
  port: number,
  host = '127.0.0.1',
  platform: string = process.platform,
): Promise<string | null> {
  const probe = await probeBind(port, host);
  return probe.bindable ? null : portUnavailableMessage(port, probe.code, platform);
}

/** Why the health wait ended. Tri-state, because "healthy" and "not healthy"
 *  collapse two failures whose messages have to differ: a server that never
 *  came up, and one that came up and died. */
export type HealthVerdict = 'healthy' | 'died' | 'timeout';

export type HealthWaitDeps = {
  url: string;
  timeoutMs: number;
  /** Has the server WE started exited? */
  isDead: () => boolean;
  pollMs?: number;
  /** Cap on ONE request. A port can accept a connection and never answer —
   *  `fetch` has no default timeout, so without this the loop parks on the
   *  first await and never reaches its own deadline or the `isDead` check. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Poll until our server answers.
 *
 * `isDead` is checked on BOTH sides of the fetch, and the second check is the
 * one that matters (`Cebab-j1dl`). `/health` is answered by whoever holds the
 * port, so a 200 is not by itself evidence that our process is up — and in the
 * measured failure the squatter's 200 arrived on the first poll, before the
 * child's exit event had fired. Checking only before the fetch reproduces the
 * bug exactly: the guard is present, runs, and is a tick too early to see
 * anything.
 */
export async function waitForHealthyServer(deps: HealthWaitDeps): Promise<HealthVerdict> {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 300;
  const deadline = now() + deps.timeoutMs;

  while (now() < deadline) {
    if (deps.isDead()) return 'died';
    try {
      const r = await doFetch(deps.url, {
        signal: AbortSignal.timeout(deps.requestTimeoutMs ?? 5_000),
      });
      if (r.ok) return deps.isDead() ? 'died' : 'healthy';
    } catch {
      /* not up yet */
    }
    await sleep(pollMs);
  }
  return deps.isDead() ? 'died' : 'timeout';
}

/** Where a smoke should point, and it is not always the default. */
export type SmokeTarget = { port: string; wsUrl: string };

/**
 * Resolve the server a smoke is meant to talk to (`Cebab-c0n2`).
 *
 * `ws_smoke` read only the compiled-in default, while `ci_smoke` passes the
 * port it actually started the server on. On any non-default port that meant
 * the smoke connected to whatever happened to be sitting on the default one —
 * the same "talks to a server it did not start" defect the port guard above
 * closes from the other side, arriving by a different route.
 *
 * `WS_URL` still wins outright: it is the escape hatch for pointing a smoke at
 * a server on another host, where no port arithmetic applies.
 */
export function resolveSmokeTarget(env: NodeJS.ProcessEnv, defaultPort: number): SmokeTarget {
  const port = env.PORT ?? String(defaultPort);
  return { port, wsUrl: env.WS_URL ?? `ws://127.0.0.1:${port}` };
}
