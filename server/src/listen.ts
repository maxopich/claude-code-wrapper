/**
 * Acquiring the listening socket, extracted from `index.ts` so it can be
 * tested (Cebab-ygu.41).
 *
 * WHAT WENT WRONG. `server.listen()` had no `'error'` listener, so a bind
 * failure surfaced as an uncaught exception — and `index.ts` installs a
 * blanket `uncaughtException` handler that logs "contained; server stays up".
 * Starting a second server on an occupied port therefore printed five
 * green-looking boot lines, a stack trace, and then sat there forever with no
 * listening socket. The only negative signal was the ABSENCE of "listening
 * at", which is easy to miss in a scrollback.
 *
 * The containment handler is not wrong in general — its motivating case is a
 * wedged bus worker's `Query` rejecting during teardown, where killing the
 * process would take the operator's session and every sibling agent with it.
 * That reasoning simply does not reach a process that never acquired a socket:
 * there is no session to protect and nothing it can still do.
 *
 * WHY THE CALLBACK MATTERS MORE THAN THE MESSAGE. The sharp edge of that bug
 * was not the zombie, it was that `initAuthToken()` ran BEFORE `listen` — it
 * unlinks and rewrites `~/.cebab/auth-token`, so the doomed boot invalidated
 * the HEALTHY server's on-disk token on its way to doing nothing. The live
 * server kept working (it compares against its in-memory copy) while
 * `ws_smoke.ts`, which reads the file, started failing 401 against it.
 *
 * So `onBound` is where every destructive or process-global step goes, and the
 * property worth pinning is one line: on a bind failure, `onBound` never runs.
 *
 * Same shape and the same reason as `shutdown.ts` — deps are injected, so a
 * test can observe ordering without a port, a socket, or a process to kill.
 */

/** Anything that can emit the bind failure. */
export type ErrorSource = {
  on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown;
};

/** The slice of `http.Server` this needs. Narrow on purpose: a test hands it
 *  an EventEmitter with a `listen` stub, and nothing here can accidentally
 *  reach for a real socket. */
export type ListenTarget = ErrorSource & {
  listen(port: number, host: string, callback: () => void): unknown;
};

export type StartListeningDeps = {
  server: ListenTarget;
  port: number;
  host: string;
  /**
   * Runs once, only after the socket is actually bound. Everything
   * destructive (persisting the auth token) or process-global (installing the
   * containment handlers) belongs here — that is what makes "a failed boot
   * changes nothing" structural rather than argued.
   */
  onBound: () => void;
  /**
   * Other emitters that re-emit this server's bind failure, and MUST be
   * guarded too.
   *
   * Measured, not anticipated: `ws`'s `WebSocketServer({ server })` attaches
   * its own forwarder to the http server and re-emits the error on ITSELF.
   * Because it is constructed before this function runs, its listener fires
   * FIRST — and an unheard `'error'` on an EventEmitter throws — so guarding
   * only the http server left the original stack trace on screen and never
   * reached the handler below. The first end-to-end run of the fix is what
   * caught that; the unit tests could not see it.
   */
  errorSources?: readonly ErrorSource[];
  /** Injected so a test can observe it; production passes `process.exit`. */
  exit: (code: number) => void;
  log?: (msg: string) => void;
};

/**
 * The remedy that actually applies. `dev:server` runs under `tsx watch`, a
 * supervisor that outlives its child and squats on the port — CLAUDE.md
 * documents the whole accumulation — and `scripts/predev-server.mjs` is the
 * cleanup that already runs at the next start.
 *
 * Deliberately does NOT shell out to `lsof`/`netstat` to name the holding
 * process: that is three code paths for three platforms, and a boot-failure
 * path that spawns a process in order to explain itself is a worse failure
 * path than the one it is explaining.
 */
function addressInUseMessage(host: string, port: number): string {
  return (
    `[cebab] cannot start: ${host}:${port} is already in use.\n` +
    `        Another Cebab server (or a stale \`tsx watch\` supervisor) holds it.\n` +
    `        \`npm run dev:server\` clears a stale one for you — its predev step\n` +
    `        runs scripts/predev-server.mjs. Otherwise stop the process on that\n` +
    `        port and start again.\n` +
    `        Nothing was changed: this process exits without touching the\n` +
    `        running server's auth token.`
  );
}

/**
 * Attach the failure path, then bind. Returns nothing — the two outcomes are
 * `onBound()` and `exit(1)`, and exactly one of them happens.
 */
export function startListening(deps: StartListeningDeps): void {
  const log = deps.log ?? ((msg: string) => console.error(msg));

  // One failure, one report, one exit — the same error arrives on every
  // emitter that re-emits it, and two copies of the remedy would read as two
  // problems.
  let handled = false;
  const onError = (err: NodeJS.ErrnoException): void => {
    if (handled) return;
    handled = true;
    if (err?.code === 'EADDRINUSE') {
      log(addressInUseMessage(deps.host, deps.port));
    } else {
      // Every other bind failure is fatal too — EACCES on a privileged port,
      // EADDRNOTAVAIL on a host that is not local. A server that cannot listen
      // has nothing left to do, and staying up to say so is what produced the
      // zombie in the first place.
      log(
        `[cebab] cannot start: listen failed on ${deps.host}:${deps.port}` +
          `${err?.code ? ` (${err.code})` : ''} — ${err?.message ?? String(err)}`,
      );
    }
    deps.exit(1);
  };

  // BEFORE `listen`, not after. Attaching it afterwards would leave the same
  // race the bug is made of: `listen` can emit `'error'` before a later
  // statement runs, and an unheard `'error'` on an EventEmitter is thrown.
  deps.server.on('error', onError);
  for (const source of deps.errorSources ?? []) source.on('error', onError);

  deps.server.listen(deps.port, deps.host, () => {
    deps.onBound();
  });
}
