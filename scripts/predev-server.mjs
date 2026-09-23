/**
 * predev hook for `server/package.json:dev` — frees the port THIS dev server
 * is about to bind, and nothing else.
 *
 *   npm run dev:server      # predev fires automatically (npm convention)
 *   node scripts/predev-server.mjs --dry-run   # print the decision, kill nothing
 *
 * Background: `tsx watch` is a long-running supervisor. When its child Node
 * crashes (port conflict, syntax error, whatever) the supervisor stays alive
 * polling for file changes, intending to respawn on edit. When a Claude Code
 * session calls `Bash(run_in_background: true)` to spawn dev:server, the
 * `zsh -c → npm → npm → tsx watch → node` subtree gets reparented to launchd
 * once the launching session exits — and lives indefinitely, squatting on the
 * port. This hook clears exactly that squatter before we start.
 *
 * WHY PORT-SCOPED (Cebab-ulfb). The previous version listed every process on
 * the machine whose command line matched the NEEDLE and SIGKILLed all of them.
 * A resource shared across checkouts that no guard could see: starting a dev
 * server from ANY checkout killed the autonomous loop gate's Playground server
 * mid-smoke (and vice-versa), failing a healthy bead and costing a repair
 * budget. The cleanup only ever needed to free ONE thing — the port this
 * server is about to bind — so that is all it now touches. Every other Cebab
 * dev server on the machine (another checkout, a QA server, the loop gate's
 * server on a different port) is left strictly alone.
 *
 * The decision:
 *   - Work out the port the same way the server does (CEBAB_PORT / PORT env,
 *     else DEFAULT_PORT). `npm run dev` reaches this script the same way
 *     (scripts/dev.mjs passes process.env through), so the port matches there
 *     too.
 *   - Find the LISTENER on that port. No listener → kill nothing.
 *   - If the listener (or its `tsx watch` supervisor ancestor) matches the
 *     NEEDLE, it is one of ours: stop the listener AND that supervisor. Killing
 *     only the child is not enough — tsx watch respawns it on the next edit.
 *   - If the listener is anything else, kill nothing: print the pid + command
 *     holding the port and exit non-zero, so the start fails with a reason
 *     rather than the server silently failing to bind.
 *
 * The decision logic is the pure `decideKill` below (process table + listener
 * pids → pids to kill, or a refusal), unit-tested by
 * `scripts/predevServer.test.mjs`. Everything platform-specific — reading the
 * listener and the process table — sits in thin I/O helpers around it.
 *
 * Cross-platform: no shell, no deps.
 *   POSIX:   `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`   (listener pids)
 *            `ps -A -o pid=,ppid=,command=`            (process table)
 *   Windows: `netstat -ano`                            (LISTENING rows → pid)
 *            `wmic process get commandline,parentprocessid,processid /format:csv`
 *            (wmic is deprecated on Win11 23H2+ but still ships on most
 *            installs; if missing, the script silently no-ops and Windows users
 *            see the original no-cleanup behaviour.)
 *
 * Silent on the no-op path; logs only when it acts or refuses.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The default port, mirrored from `shared/src/net.ts`'s `DEFAULT_PORT`. A bare
 * literal here is deliberate: this is a `.mjs` build script, not one of the
 * `.ts` consumers that `scripts/defaultPortSingleSource.test.mjs` binds to the
 * shared constant (its header exempts `scripts/*.mjs` for exactly this reason —
 * a Node script cannot import the un-built TS module).
 */
export const DEFAULT_PORT = 4319;

// Match: `--env-file-if-exists=../.env` + `src/index.ts` (`/` or `\` for
// Windows). These are the two distinctive args on `server.dev`; any process
// command line carrying both is one of our tsx-watch trees. Project-agnostic
// so it still matches in worktrees under `.claude/worktrees/<x>/server`. If
// `server.dev` changes shape this needle must follow — the fail-safe is "match
// nothing" (the port's holder is treated as foreign and we refuse, back to a
// visible failure rather than a silent one).
export const NEEDLE = /--env-file-if-exists=\.\.[/\\]\.env.*\bsrc[/\\]index\.ts\b/;

/**
 * Resolve the port this dev server will bind, matching `server/src/config.ts`:
 * the prefixed `CEBAB_PORT` wins when meaningfully set, else the bare `PORT`,
 * else `DEFAULT_PORT`; a non-integer or out-of-range value falls back too.
 *
 * `fileVars` is the repo-root `.env`, and it has to be read HERE because this
 * hook runs BEFORE the server loads it. `server.dev` passes
 * `--env-file-if-exists=../.env`, so a `PORT` declared only in `.env` is the
 * port the server binds, while this script's own `process.env` never sees it.
 * Without `fileVars` an operator whose `.env` says `PORT=4400` got 4319 freed,
 * someone else's server stopped, and their own squatter left in place. Node's
 * env-file rule is per KEY and the process env wins, so each key is resolved
 * env-first before the CEBAB_PORT-over-PORT precedence applies.
 */
export function resolveTargetPort(env = process.env, fileVars = {}) {
  const pick = (key) => (isSet(env[key]) ? env[key] : fileVars[key]);
  const raw = [pick('CEBAB_PORT'), pick('PORT')].find(isSet);
  const n = Number(raw);
  if (raw != null && Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return DEFAULT_PORT;
}

function isSet(v) {
  return v != null && String(v).trim() !== '';
}

/**
 * `CEBAB_PORT` and `PORT` from a dotenv file, or `{}` when it is absent or
 * unreadable. The same deliberately small parser as `readEnvFileOrigins` in
 * `dev-origins.mjs`: `export ` prefixes and surrounding quotes are handled,
 * the last assignment wins, and nothing else is interpreted.
 */
export function readEnvFilePorts(envFilePath) {
  let text;
  try {
    text = fs.readFileSync(envFilePath, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/^export\s+/, '');
    for (const key of ['CEBAB_PORT', 'PORT']) {
      if (!t.startsWith(`${key}=`)) continue;
      const raw = t.slice(key.length + 1).trim();
      out[key] =
        (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw;
    }
  }
  return out;
}

/**
 * The pure decision. Given the full process table (`{ pid, ppid, command }[]`)
 * and the pids listening on the target port, return one of:
 *   { action: 'noop' }                          — nothing is on the port
 *   { action: 'kill',  kill: number[] }         — our stale server; stop these
 *   { action: 'refuse', holder: { pid, command } } — someone else holds it
 *
 * A listener is "ours" when it, or any ancestor up its ppid chain, matches the
 * NEEDLE. The kill set is that listener plus every NEEDLE-matching process on
 * its ancestor chain (the tsx-watch supervisor), so respawn-on-edit is stopped
 * along with the child that binds the port. A NEEDLE-matching server on a
 * DIFFERENT port is never a listener here, so it never enters this function's
 * kill set — that is the whole point.
 */
export function decideKill(processes, listenerPids) {
  const pids = [...new Set((listenerPids ?? []).filter((p) => Number.isFinite(p)))];
  if (pids.length === 0) return { action: 'noop' };

  const byPid = new Map(processes.map((p) => [p.pid, p]));

  for (const listenerPid of pids) {
    const kill = new Set();
    let matched = false;
    let cur = byPid.get(listenerPid);
    const seen = new Set();
    while (cur && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      if (NEEDLE.test(cur.command)) {
        matched = true;
        kill.add(cur.pid);
      }
      cur = byPid.get(cur.ppid);
    }
    if (matched) {
      // Always include the listener itself: tsx-watch's child may not carry
      // the NEEDLE args, but it is the process holding the port.
      kill.add(listenerPid);
      return { action: 'kill', kill: [...kill] };
    }
  }

  // The port is held, but by nothing we recognise. Refuse loudly rather than
  // kill a stranger's process or let the server silently fail to bind.
  const holder = byPid.get(pids[0]);
  return {
    action: 'refuse',
    holder: { pid: pids[0], command: holder?.command ?? '(command unavailable)' },
  };
}

/** POSIX: pids listening on `port`, via `lsof`. */
function listenerPidsPosix(port) {
  try {
    // /usr/sbin/lsof is a real binary — the .cmd-shim problem is Windows-only.
    // nosemgrep: cebab-spawn-missing-win32-shell
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    // lsof exits non-zero when nothing is listening — that is the common,
    // healthy path (no orphan on the port), not an error.
    return [];
  }
}

/** POSIX: full process table with parent pids. */
function processTablePosix() {
  try {
    // nosemgrep: cebab-spawn-missing-win32-shell
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((line) => {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Windows: pids in LISTENING state on `port`, via `netstat -ano`. */
function listenerPidsWin(port) {
  try {
    // netstat.exe lives in System32 — a real executable, no shell needed.
    // nosemgrep: cebab-spawn-missing-win32-shell
    const out = execFileSync('netstat', ['-ano'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      // Columns: Proto  Local  Foreign  State  PID. Match a local address
      // ending `:<port>` on a LISTENING row and take the trailing pid.
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      if (!/^TCP/i.test(cols[0]) || !/LISTENING/i.test(cols[3])) continue;
      // Local address is `127.0.0.1:<port>` or `[::]:<port>`; the port is the
      // final `:`-delimited field. Compared as a string to keep the linter's
      // non-literal-RegExp rule satisfied (port is already a validated int).
      if (cols[1].split(':').pop() !== String(port)) continue;
      const pid = Number(cols[cols.length - 1]);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

/** Windows: full process table via wmic CSV (Node,CommandLine,ParentProcessId,ProcessId). */
function processTableWin() {
  try {
    // wmic.exe is a real Windows executable under System32\wbem, not an npm
    // .cmd shim, so Node spawns it directly and needs no shell.
    // nosemgrep: cebab-spawn-missing-win32-shell
    const out = execFileSync(
      'wmic',
      ['process', 'get', 'commandline,parentprocessid,processid', '/format:csv'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split(/\r?\n/)
      .map((line) => {
        // Trailing two comma-separated fields are ppid,pid; everything between
        // the first comma (after the Node host column) and them is the command.
        const m = line.match(/^[^,]*,(.*),(\d+),(\d+)\s*$/);
        return m ? { pid: Number(m[3]), ppid: Number(m[2]), command: m[1] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function gather(port) {
  if (process.platform === 'win32') {
    return { listenerPids: listenerPidsWin(port), processes: processTableWin() };
  }
  return { listenerPids: listenerPidsPosix(port), processes: processTablePosix() };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = resolveTargetPort(process.env, readEnvFilePorts(path.join(repoRoot, '.env')));
  const { listenerPids, processes } = gather(port);
  const decision = decideKill(processes, listenerPids);

  if (decision.action === 'noop') {
    if (dryRun) console.log(`[predev:server] nothing listening on port ${port} — nothing to do`);
    return 0;
  }

  if (decision.action === 'refuse') {
    console.error(
      `[predev:server] port ${port} is held by pid ${decision.holder.pid}, which is not a ` +
        `Cebab dev server:\n    ${decision.holder.command}\n` +
        `[predev:server] refusing to kill it. Free the port or set CEBAB_PORT/PORT, then retry.`,
    );
    return 1;
  }

  // action === 'kill'
  const label = decision.kill.length === 1 ? 'process' : 'processes';
  const verb = dryRun ? 'would stop' : 'stopping';
  console.log(
    `[predev:server] ${verb} stale Cebab dev server on port ${port} ` +
      `(${decision.kill.length} ${label}): ${decision.kill.join(', ')}`,
  );
  if (dryRun) return 0;

  // Never target our own process tree (defensive — the port is not ours yet).
  const selfChain = new Set([process.pid, process.ppid]);
  const targets = decision.kill.filter((pid) => !selfChain.has(pid));

  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ESRCH (already gone) / EPERM (different user) — nothing actionable.
    }
  }
  return { targets };
}

// Only act as a CLI when invoked directly, not when imported by the test.
//
// Compared through realpath on BOTH sides. `import.meta.url` is already the
// resolved path; `process.argv[1]` is whatever path the caller typed. Under a
// symlinked directory (macOS's own /tmp and /var are symlinks into /private)
// the two differ, and a plain comparison made the whole hook a silent no-op.
function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
const invokedDirectly =
  realOrSelf(process.argv[1] ?? '') === realOrSelf(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const result = main();
  if (typeof result === 'number') {
    process.exit(result);
  } else {
    // A kill happened — give SIGTERM a grace period, then SIGKILL survivors.
    // 250ms is well under any noticeable npm post-script lag and ample for
    // tsx-watch's SIGTERM handler to tear down its watchers and inner node.
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const pid of result.targets) {
      try {
        process.kill(pid, 0); // existence probe — throws ESRCH if gone
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone — clean exit
      }
    }
    process.exit(0);
  }
}
