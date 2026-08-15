/**
 * Graceful shutdown, extracted from `index.ts` so it can be tested.
 *
 * Register C15: this sequence lived inside `main()` as a closure over four
 * locals, and `main()` runs on import — so nothing could reach it from a test.
 * 178 lines of boot and teardown had no test file at all, including the one
 * step this repo elsewhere calls load-bearing:
 *
 *   `closeAllQueries()` closes every in-flight SDK `Query`. Without it, the
 *   `claude` subprocesses the SDK spawned outlive the server and go on
 *   consuming the operator's subscription quota — silently, because the
 *   server that would have reported it is gone.
 *
 * WHAT IS ACTUALLY WORTH PINNING here is ORDER, not the individual calls.
 * Draining after `process.exit` is the same as not draining. So the tests
 * assert the sequence, and `deps.exit` is injected rather than calling
 * `process.exit` directly — a test cannot observe ordering around a call that
 * kills the runner.
 */

/** Everything the shutdown sequence touches. Injected so a test can watch the
 *  order without a live server, a live database, or a live process. */
export type ShutdownDeps = {
  /** Stop the 7-day soft-delete purge cron. */
  stopSessionPurgeCron: () => void;
  /** Close every in-flight SDK Query — the quota-critical step. */
  closeAllQueries: () => void;
  /** Terminate live WebSocket clients, then close the WS server. */
  terminateClients: () => void;
  closeWss: () => void;
  /** Close the HTTP server; `cb` fires once connections have drained. */
  closeServer: (cb: () => void) => void;
  /** Resolves once the transcript streams are closed; see `runner/logger.ts`. */
  closeLogger: () => void | Promise<void>;
  closeDb: () => void;
  /** Injected so tests can observe it; production passes `process.exit`. */
  exit: (code: number) => void;
  /** Injected for the failsafe timer; production passes `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => { unref: () => void };
  log?: (msg: string) => void;
};

/** How long to wait for `closeServer` to drain before exiting non-zero. */
export const SHUTDOWN_FAILSAFE_MS = 3000;

/**
 * Build the signal handler.
 *
 * Re-entrant calls are ignored. `index.ts` had no such guard: a second
 * `SIGINT` (an impatient double Ctrl+C, which is exactly when someone sends
 * one) re-ran the whole sequence, and `server.close()` on an already-closing
 * server invokes its callback IMMEDIATELY with an `ERR_SERVER_NOT_RUNNING`
 * that the callback ignored — reaching `exit(0)` down a path that never
 * waited for the drain. The drain itself is synchronous and had already run,
 * so the practical damage was small (a double `closeDb`, a double
 * `closeLogger`); the reason to fix it is that "the second signal is a no-op"
 * is a property worth being able to state.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const log = deps.log ?? ((m: string) => console.log(m));
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let started = false;

  return (signal: string) => {
    if (started) {
      log(`[cebab] received ${signal} during shutdown, ignoring`);
      return;
    }
    started = true;
    log(`[cebab] received ${signal}, shutting down`);

    deps.stopSessionPurgeCron();
    // Before anything that can end the process. Everything below is cleanup;
    // this is the step that stops spending money.
    deps.closeAllQueries();
    deps.terminateClients();
    deps.closeWss();
    deps.closeServer(() => {
      // Cebab-kji: awaited. `closeLogger` initiates the close synchronously but
      // only RESOLVES once the transcript streams have finished, and everything
      // after this line used to run while buffered bytes were still in flight —
      // so a Ctrl+C could exit with the tail of a transcript unwritten. The
      // wait is bounded twice over: `closeLogger` has its own per-stream
      // timeout, and the failsafe below still fires at 3s regardless.
      void (async () => {
        await deps.closeLogger();
        deps.closeDb();
        log('[cebab] bye');
        deps.exit(0);
      })();
    });

    // Failsafe: a connection that never drains must not hang the process
    // forever. `.unref()` so the timer itself cannot be the reason we stay
    // alive — without it, a clean shutdown would still sit here for 3s.
    setTimer(() => deps.exit(1), SHUTDOWN_FAILSAFE_MS).unref();
  };
}

/** The signals a shutdown must answer to.
 *
 *  `SIGBREAK` is the Windows one and the one whose loss would be silent:
 *  Windows never delivers `SIGTERM`, so Ctrl+Break and a plain `taskkill`
 *  arrive here or nowhere. Dropping it costs nothing on POSIX (the signal is
 *  simply never raised) and costs the whole drain on Windows. */
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;

/** Wire the handler to every signal in `SHUTDOWN_SIGNALS`. */
export function registerSignalHandlers(
  shutdown: (signal: string) => void,
  on: (signal: string, handler: () => void) => void = (s, h) => {
    process.on(s as NodeJS.Signals, h);
  },
): void {
  for (const signal of SHUTDOWN_SIGNALS) on(signal, () => shutdown(signal));
}
