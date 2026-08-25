/**
 * Autonomous loop — the ONE process seam.
 *
 * Every subprocess the loop starts goes through `makeRunner()`. Nothing else
 * in `scripts/lib/loop/` imports `node:child_process`, which is what lets
 * `gate`, `git`, `forge`, `beads` and `build` be tested with recorded
 * fixtures: each takes a `run` function, and the tests hand it one that
 * returns canned output instead of spawning anything.
 *
 * WINDOWS SHELL. `shell` is set explicitly on every spawn, not omitted. On
 * Windows an npm-installed CLI (`npx`, and the `npm` shim itself) is a `.cmd`
 * file, which Node refuses to execute directly — the failure is an opaque
 * `EINVAL` naming neither the command nor the cause. The repo's semgrep rule
 * `cebab-spawn-missing-win32-shell` enforces the same thing on every spawn
 * carrying a `stdio` option, and it exempts only `process.execPath`.
 *
 * NO SHELL STRING INTERPOLATION, EVER. Commands are `(file, args[])` pairs.
 * With `shell: true` the arguments are still passed as a vector rather than
 * concatenated into a command line here, so a bead title carrying a quote or a
 * `;` cannot become a second command.
 */
import { spawn } from 'node:child_process';

/** A step that exceeded its timeout. Distinguished so callers can say so. */
export class RunTimeoutError extends Error {
  constructor(command, timeoutMs) {
    super(`${command} exceeded ${timeoutMs}ms`);
    this.name = 'RunTimeoutError';
    this.timedOut = true;
  }
}

/**
 * @returns {(file: string, args: string[], opts?: object) =>
 *   Promise<{code: number, stdout: string, stderr: string, ms: number, timedOut: boolean}>}
 *
 * Never rejects on a non-zero exit — the exit code is data here, since a red
 * gate step and a red CI check are ordinary control flow, not exceptions. It
 * rejects only when the process could not be started at all.
 */
export function makeRunner({ cwd, env = process.env, onLine } = {}) {
  return function run(file, args, opts = {}) {
    const startedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? 0;
    return new Promise((resolve, reject) => {
      let child;
      try {
        // Windows shim handling; see the header. The argv is a vector, so
        // `shell: true` does not open an injection path.
        // nosemgrep: cebab-spawn-missing-win32-shell
        child = spawn(file, args, {
          cwd: opts.cwd ?? cwd,
          env: opts.env ?? env,
          shell: process.platform === 'win32',
          // stdin is a pipe only when there is something to write. Commit
          // messages and PR bodies go in over stdin rather than as argv, so a
          // body containing a quote, a newline or a `$` cannot be re-parsed by
          // the Windows shell layer above.
          stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      if (opts.input !== undefined && child.stdin) {
        child.stdin.on('error', () => {
          // EPIPE if the child exited before reading; the exit code is the
          // signal that matters and `close` still fires.
        });
        child.stdin.end(opts.input);
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timer = null;

      const collect = (stream, sink) => {
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          if (sink === 'out') stdout += chunk;
          else stderr += chunk;
          if (onLine) onLine(chunk, sink);
        });
      };
      collect(child.stdout, 'out');
      collect(child.stderr, 'err');

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          // SIGKILL rather than SIGTERM: a wedged `npm` supervisor ignores the
          // polite signal and the loop would then wait out the whole run.
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }, timeoutMs);
      }

      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          code: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr,
          ms: Date.now() - startedAt,
          timedOut,
        });
      });
    });
  };
}

/**
 * Spawn something that outlives this call (the Playground `dev:server`).
 * `detached` puts it in its own process GROUP, which is the only way to kill
 * the whole `npm -> npm -> tsx watch -> node` tree: signalling the npm pid
 * leaves the watcher running, which is precisely how port 4319 ends up squatted
 * (CLAUDE.md, "Stale dev:server orphans").
 */
export function spawnDetached(file, args, { cwd, env = process.env } = {}) {
  // nosemgrep: cebab-spawn-missing-win32-shell
  const child = spawn(file, args, {
    cwd,
    env,
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (c) => {
    output += c;
  });
  child.stderr?.on('data', (c) => {
    output += c;
  });
  return { child, readOutput: () => output };
}

/**
 * Kill a detached child's whole process GROUP, then its own pid as a fallback
 * for Windows (where there is no group and `detached` was not set).
 */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}
