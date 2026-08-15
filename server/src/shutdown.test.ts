/**
 * [security] Register C15 — the shutdown sequence, which had no test at all.
 *
 * `server/src/index.ts` was 178 lines of boot and teardown with no test file.
 * It could not have had one: `shutdown` was a closure over four locals inside
 * `main()`, and `main()` runs on import.
 *
 * The step that matters is `closeAllQueries()`. Every in-flight SDK `Query`
 * holds a spawned `claude` subprocess; if the server exits without closing
 * them they outlive it and keep consuming the operator's subscription quota,
 * with nothing left running to say so. CLAUDE.md calls this out, `lifecycle.ts`
 * opens with it, and until now nothing checked it.
 *
 * SO THESE TESTS ASSERT ORDER, NOT CALLS. "closeAllQueries was called" is
 * satisfied by a version that calls it after `exit`, which is the same as not
 * calling it. Every case below reads a recorded sequence.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  createShutdown,
  registerSignalHandlers,
  SHUTDOWN_FAILSAFE_MS,
  SHUTDOWN_SIGNALS,
  type ShutdownDeps,
} from './shutdown.js';

/** Deps that append to a shared log, so assertions can read the sequence. */
function trackedDeps(): { deps: ShutdownDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ShutdownDeps = {
    stopSessionPurgeCron: () => calls.push('stopSessionPurgeCron'),
    closeAllQueries: () => calls.push('closeAllQueries'),
    terminateClients: () => calls.push('terminateClients'),
    closeWss: () => calls.push('closeWss'),
    // Fires its callback synchronously, standing in for "connections drained".
    closeServer: (cb) => {
      calls.push('closeServer');
      cb();
    },
    closeLogger: () => {
      calls.push('closeLogger');
    },
    closeDb: () => calls.push('closeDb'),
    exit: (code) => calls.push(`exit(${code})`),
    setTimer: (_fn, ms) => {
      calls.push(`setTimer(${ms})`);
      return { unref: () => calls.push('unref') };
    },
    log: () => {},
  };
  return { deps, calls };
}

/**
 * Drain the microtask queue.
 *
 * Cebab-kji made the post-drain steps await `closeLogger()`, so `closeDb`,
 * the log line and `exit` now land one tick after the handler returns. The
 * ORDER these tests pin is unchanged — only when it is observable is — so
 * every case that reads `calls` past `closeServer` flushes first. `setImmediate`
 * rather than `await Promise.resolve()`: a macrotask drains the whole microtask
 * queue regardless of how many awaits the chain grows.
 */
const flush = () => new Promise((r) => setImmediate(r));

describe('[security] createShutdown', () => {
  test('closeAllQueries runs, and runs before the process exits', async () => {
    // The whole point of the file. An ordering assertion, not a "was called"
    // one: draining after exit is identical to not draining.
    const { deps, calls } = trackedDeps();
    createShutdown(deps)('SIGINT');
    await flush();

    expect(calls).toContain('closeAllQueries');
    expect(calls).toContain('exit(0)');
    expect(calls.indexOf('closeAllQueries')).toBeLessThan(calls.indexOf('exit(0)'));
  });

  test('the full teardown order is the one index.ts had', async () => {
    // Pinning the sequence verbatim so a refactor that reorders it — closing
    // the database before the server has drained, say — is visible.
    const { deps, calls } = trackedDeps();
    createShutdown(deps)('SIGTERM');
    await flush();

    expect(calls.filter((c) => !c.startsWith('setTimer') && c !== 'unref')).toEqual([
      'stopSessionPurgeCron',
      'closeAllQueries',
      'terminateClients',
      'closeWss',
      'closeServer',
      'closeLogger',
      'closeDb',
      'exit(0)',
    ]);
  });

  test('closeDb and exit WAIT for the transcript flush', async () => {
    // Cebab-kji, the shutdown half. `closeLogger` now resolves only once the
    // transcript streams are closed, and this handler awaits it — otherwise
    // `process.exit` could drop buffered bytes off the end of a transcript.
    //
    // Pinned with a gate promise rather than a timer, so it is deterministic:
    // while the flush is outstanding NOTHING past it may have run, and the
    // moment it resolves the rest must follow. Removing the `await` in
    // shutdown.ts reddens the first assertion.
    const { deps, calls } = trackedDeps();
    let release!: () => void;
    const flushed = new Promise<void>((r) => {
      release = r;
    });
    deps.closeLogger = () => {
      calls.push('closeLogger');
      return flushed;
    };

    createShutdown(deps)('SIGINT');
    await flush();

    expect(calls).toContain('closeLogger');
    expect(calls).not.toContain('closeDb');
    expect(calls).not.toContain('exit(0)');

    release();
    await flush();

    expect(calls).toContain('closeDb');
    expect(calls.indexOf('closeLogger')).toBeLessThan(calls.indexOf('closeDb'));
    expect(calls.indexOf('closeDb')).toBeLessThan(calls.indexOf('exit(0)'));
  });

  test('the failsafe timer is armed and unrefd', () => {
    // `.unref()` matters in the ordinary case, not the failure one: without
    // it a clean shutdown still sits for the full failsafe before the event
    // loop empties.
    const { deps, calls } = trackedDeps();
    createShutdown(deps)('SIGINT');

    expect(calls).toContain(`setTimer(${SHUTDOWN_FAILSAFE_MS})`);
    expect(calls.indexOf('unref')).toBeGreaterThan(
      calls.indexOf(`setTimer(${SHUTDOWN_FAILSAFE_MS})`),
    );
  });

  test('the failsafe exits non-zero when the server never drains', () => {
    const calls: string[] = [];
    let fire: (() => void) | null = null;
    const deps: ShutdownDeps = {
      stopSessionPurgeCron: () => {},
      closeAllQueries: () => calls.push('closeAllQueries'),
      terminateClients: () => {},
      closeWss: () => {},
      // Never invokes its callback — a connection that will not drain.
      closeServer: () => calls.push('closeServer'),
      closeLogger: () => {
        calls.push('closeLogger');
      },
      closeDb: () => calls.push('closeDb'),
      exit: (code) => calls.push(`exit(${code})`),
      setTimer: (fn) => {
        fire = fn;
        return { unref: () => {} };
      },
      log: () => {},
    };
    createShutdown(deps)('SIGINT');

    // Nothing has exited yet: the drain ran, the server is still hanging.
    expect(calls).toEqual(['closeAllQueries', 'closeServer']);
    fire!();
    expect(calls).toEqual(['closeAllQueries', 'closeServer', 'exit(1)']);
    // And the quota-critical step still happened before the bail-out, which is
    // the property that must survive the unhappy path too.
    expect(calls.indexOf('closeAllQueries')).toBeLessThan(calls.indexOf('exit(1)'));
  });

  test('a second signal during shutdown is ignored', async () => {
    // index.ts had no guard. A double Ctrl+C — which is precisely when a
    // second signal arrives — re-ran the sequence, and server.close() on an
    // already-closing server fires its callback immediately with an error the
    // callback ignored, reaching exit(0) on a path that never waited.
    const { deps, calls } = trackedDeps();
    const shutdown = createShutdown(deps);
    shutdown('SIGINT');
    await flush();
    const afterFirst = [...calls];
    shutdown('SIGINT');
    await flush();

    expect(calls).toEqual(afterFirst);
    expect(calls.filter((c) => c === 'closeAllQueries')).toHaveLength(1);
    expect(calls.filter((c) => c === 'closeDb')).toHaveLength(1);
  });

  test('the tracked deps actually record — anti-vacuity', async () => {
    // Every assertion above reads `calls`. A deps object that silently did
    // nothing would satisfy several of them by producing an empty array, so
    // pin that the harness itself observes something.
    const { deps, calls } = trackedDeps();
    expect(calls).toEqual([]);
    createShutdown(deps)('SIGINT');
    await flush();
    expect(calls.length).toBeGreaterThan(5);
  });
});

describe('[security] registerSignalHandlers', () => {
  test('registers SIGINT, SIGTERM and SIGBREAK', () => {
    // SIGBREAK is the one whose loss is silent: Windows never delivers
    // SIGTERM, so on that platform Ctrl+Break and a plain `taskkill` reach
    // this handler or nothing does — and the CI matrix runs POSIX too, where
    // dropping it would change no test that did not name it.
    const on = vi.fn();
    registerSignalHandlers(() => {}, on);

    expect(on.mock.calls.map((c) => c[0])).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK']);
    expect(SHUTDOWN_SIGNALS).toContain('SIGBREAK');
  });

  test('each handler passes its own signal name through', () => {
    // A loop that closed over the wrong variable would register three
    // handlers all reporting the last signal — invisible except in the log
    // line an operator reads when diagnosing a shutdown.
    const handlers = new Map<string, () => void>();
    const seen: string[] = [];
    registerSignalHandlers(
      (s) => seen.push(s),
      (sig, h) => handlers.set(sig, h),
    );
    for (const sig of SHUTDOWN_SIGNALS) handlers.get(sig)!();

    expect(seen).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK']);
  });
});
