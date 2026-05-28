// Cluster D Phase 6b (spec §6.4 / UI-D22 follow-up): server-side
// runner for the `claude login` subprocess that the AuthRefreshModal
// drives. Shares no state with `runner/claude.ts` — the SDK runner
// owns `query()` invocations (per-turn agent runs); this module owns
// the auth-credentials renewal subprocess, which is process-level
// state rather than per-turn.
//
// Lifecycle: one spawn at a time process-wide (single-flight). The
// credentials file at `~/.claude/.credentials.json` is global shared
// state across every Cebab session AND every concurrent `claude`
// invocation; racing two `claude login` subprocesses would produce
// undefined behavior (whichever finishes last wins the file, the
// other's OAuth session may also have written, etc.). The guard is
// process-wide because the file is process-wide.
//
// Cleanup: on SIGINT/SIGTERM/SIGBREAK the registered subprocess is
// killed via `lifecycle.ts`. On a 5-min timeout the subprocess is
// killed and a synthetic completion is emitted. On WS disconnect we
// do NOT kill — the operator may still complete the OAuth flow in
// their browser, and the subprocess writing credentials is desired
// behavior; the client just won't see the live stream.
//
// Why not `execFileAsync` (the workspace_diff pattern). `claude login`
// is long-running (waits for OAuth callback) and emits incremental
// output. `execFile` buffers everything until exit; `spawn` gives us
// the live streams we need to feed the modal's terminal-style view.
//
// Why not a long-running `claude` daemon. The SDK runner uses
// `query()` which spawns a fresh subprocess per turn. For credentials
// refresh, we use the `claude` CLI directly because: (a) the SDK
// doesn't expose a `login` operation; (b) the credentials file is
// shared so we don't need an in-process integration; (c) spawning the
// CLI in a separate child process means a crash in `claude login`
// can't take down the WS server.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SCRUBBED_ENV_VAR_NAMES } from './runner/claude.js';
import { registerQuery } from './runner/lifecycle.js';

export type AuthRefreshCallbacks = {
  /** Subprocess spawned successfully; modal moves to "running" state.
   *  Called once per run before any output. */
  onStarted: (args: { runId: string; pid: number }) => void;
  /** Chunk of subprocess output. `stream` is 'stdout' or 'stderr'.
   *  Multiple chunks per logical line are possible — the modal should
   *  concatenate. Already decoded as UTF-8 (the spawn stdio uses the
   *  default encoding which we override below). */
  onOutput: (args: { runId: string; stream: 'stdout' | 'stderr'; text: string }) => void;
  /** Subprocess exited. `success` is `exitCode === 0`. `exitCode` is
   *  null when killed before exiting (cancel or timeout). The module
   *  guarantees this is called EXACTLY ONCE per run — even on timeout
   *  + late natural exit, the second event is suppressed. */
  onCompleted: (args: { runId: string; exitCode: number | null; success: boolean }) => void;
};

export type StartAuthRefreshResult =
  | { ok: true; runId: string }
  | { ok: false; reason: 'already_running'; existingRunId: string }
  | { ok: false; reason: 'spawn_failed'; error: string };

export type AuthRefreshOptions = {
  /** Injection seam for tests. Defaults to `child_process.spawn`. */
  spawnFn?: typeof spawn;
  /** Override the timeout window (ms). Defaults to 5 min — long
   *  enough for the operator to find the auth URL, open it in their
   *  browser, complete OAuth, and have the callback return. */
  timeoutMs?: number;
  /** Override the binary name. Defaults to `'claude'`. Tests use a
   *  no-op alternative like `'node'` with a stub script. */
  binary?: string;
  /** Override the args. Defaults to `['login']`. */
  args?: string[];
};

type ActiveRun = {
  runId: string;
  child: ChildProcess;
  startedAtMs: number;
  /** Unregister hook from lifecycle.ts; called once on completion. */
  unregister: () => void;
  /** Timer fires after timeoutMs if the child hasn't exited yet. */
  timeoutHandle: NodeJS.Timeout;
  /** Guard so completion only fires once even if natural exit + cancel
   *  race or stdin close + exit fire in succession. */
  completed: boolean;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// Process-wide single-flight. Exported only for test cleanup; production
// code should NEVER read this directly — use `getActiveAuthRefresh()`.
let activeRun: ActiveRun | null = null;

/**
 * Returns the currently-running auth-refresh run, if any. For
 * diagnostics / test inspection. Production handlers should not need
 * this — they get the runId back from `startAuthRefresh()`.
 */
export function getActiveAuthRefreshRunId(): string | null {
  return activeRun?.runId ?? null;
}

/**
 * Stripped env for the spawn — mirrors `runner/claude.ts`'s
 * `subscriptionOnlyEnv()` so a stray `ANTHROPIC_API_KEY` in the
 * operator's shell rc can't poison the OAuth flow (which would route
 * the new credentials toward the paid-billing identity instead of
 * the subscription one).
 */
function subscriptionOnlyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const blocked = new Set(SCRUBBED_ENV_VAR_NAMES);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (blocked.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Spawn `claude login` and wire its output to the supplied callbacks.
 * Process-wide single-flight: concurrent calls return `already_running`
 * without spawning. Returns the runId on success so the caller can
 * correlate the subsequent onStarted / onOutput / onCompleted events
 * (and use it for `cancelAuthRefresh`).
 */
export function startAuthRefresh(
  callbacks: AuthRefreshCallbacks,
  opts: AuthRefreshOptions = {},
): StartAuthRefreshResult {
  if (activeRun) {
    return { ok: false, reason: 'already_running', existingRunId: activeRun.runId };
  }

  const spawnFn = opts.spawnFn ?? spawn;
  const binary = opts.binary ?? 'claude';
  const args = opts.args ?? ['login'];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let child: ChildProcess;
  try {
    child = spawnFn(binary, args, {
      env: subscriptionOnlyEnv(process.env),
      // Detached:false so SIGINT propagates from server → child on
      // shutdown. stdin closed so the child doesn't block on a prompt
      // it won't get (claude login uses browser-redirect, no stdin
      // input expected).
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'spawn_failed', error: message };
  }

  // `spawn()` can also emit an 'error' event asynchronously when the
  // binary doesn't exist (ENOENT). We catch it below + finalize.

  const runId = randomUUID();
  const startedAtMs = Date.now();

  // Set utf8 encoding on the pipes so we receive strings, not Buffers.
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  // Lifecycle: register a Closable so server shutdown kills the
  // subprocess. The Closable.close() returns void; the actual exit
  // event still flows through child.on('exit') below.
  const unregister = registerQuery({
    close: () => {
      if (!child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore — child may have already exited
        }
      }
    },
  });

  function finalize(exitCode: number | null): void {
    if (!activeRun || activeRun.runId !== runId) return;
    if (activeRun.completed) return;
    activeRun.completed = true;
    clearTimeout(activeRun.timeoutHandle);
    activeRun.unregister();
    activeRun = null;
    const success = exitCode === 0;
    try {
      callbacks.onCompleted({ runId, exitCode, success });
    } catch (err) {
      // Callback threw — log + swallow. The state is already cleared;
      // we don't want a callback bug to leave activeRun pointing at a
      // dead subprocess.
      console.error('[auth_refresh] onCompleted callback threw', err);
    }
  }

  const timeoutHandle = setTimeout(() => {
    if (activeRun?.runId !== runId || activeRun.completed) return;
    try {
      if (!child.killed) child.kill('SIGTERM');
    } catch {
      // ignore
    }
    finalize(null);
  }, timeoutMs);

  activeRun = {
    runId,
    child,
    startedAtMs,
    unregister,
    timeoutHandle,
    completed: false,
  };

  child.stdout?.on('data', (text: string) => {
    if (activeRun?.runId !== runId) return;
    try {
      callbacks.onOutput({ runId, stream: 'stdout', text });
    } catch (err) {
      console.error('[auth_refresh] onOutput stdout callback threw', err);
    }
  });
  child.stderr?.on('data', (text: string) => {
    if (activeRun?.runId !== runId) return;
    try {
      callbacks.onOutput({ runId, stream: 'stderr', text });
    } catch (err) {
      console.error('[auth_refresh] onOutput stderr callback threw', err);
    }
  });

  child.on('error', (err) => {
    // Async spawn failure (ENOENT, EACCES, etc.). If we never made it
    // past `onStarted`, the modal still expects an onCompleted to
    // exit its running state — finalize with exitCode=null.
    console.error('[auth_refresh] subprocess error', err);
    finalize(null);
  });

  child.on('exit', (code) => {
    finalize(code);
  });

  // Emit onStarted last so any synchronous handler errors in the
  // caller don't fire BEFORE the child is fully attached.
  try {
    callbacks.onStarted({ runId, pid: child.pid ?? -1 });
  } catch (err) {
    console.error('[auth_refresh] onStarted callback threw', err);
  }

  return { ok: true, runId };
}

/**
 * Cancel the currently-running auth refresh. Returns true if a matching
 * run was found and killed, false if no run is active or the runId
 * doesn't match (defensive: a stale Cancel after completion shouldn't
 * kill a freshly-started run).
 *
 * The kill triggers child.on('exit') which calls finalize() → onCompleted
 * with exitCode=null + success=false.
 */
export function cancelAuthRefresh(runId: string): boolean {
  if (!activeRun) return false;
  if (activeRun.runId !== runId) return false;
  if (activeRun.completed) return false;
  try {
    if (!activeRun.child.killed) {
      activeRun.child.kill('SIGTERM');
    }
  } catch {
    // ignore
  }
  return true;
}

/**
 * Test-only: forcibly clear the active run without going through the
 * normal exit path. NEVER call from production code — leaves the
 * subprocess running. Used by test cleanup to reset module state
 * between cases.
 */
export function _resetForTesting(): void {
  if (activeRun) {
    try {
      activeRun.child.kill('SIGTERM');
    } catch {
      // ignore
    }
    clearTimeout(activeRun.timeoutHandle);
    activeRun.unregister();
    activeRun = null;
  }
}
