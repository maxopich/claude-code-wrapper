/**
 * predev hook for `server/package.json:dev` — clears stale tsx-watch
 * supervisors targeting this codebase before launching a new one.
 *
 *   npm run dev:server      # predev fires automatically (npm convention)
 *   node scripts/predev-server.mjs --dry-run   # print matches, kill nothing
 *
 * Background: `tsx watch` is a long-running supervisor. When its child
 * Node crashes (port conflict, syntax error, whatever) the supervisor
 * stays alive polling for file changes, intending to respawn on edit.
 * When a Claude Code session calls `Bash(run_in_background: true)` to
 * spawn dev:server, the `zsh -c → npm → npm → tsx watch → node` subtree
 * gets reparented to launchd once the launching session exits — and
 * lives indefinitely. Across sessions and worktrees these accumulate.
 * Each new dev:server launch succeeds (the orphan watchers aren't bound
 * to port 4319) but leaves the orphans untouched. This hook clears them.
 *
 * Matching strategy: scan all processes for a command line containing
 * the exact arg string `--env-file-if-exists=../.env` followed by
 * `src/index.ts` (the only two args on `server.dev`). Specific enough
 * that an unrelated `tsx watch` in some other project won't match, and
 * project-agnostic enough that it still works in worktrees under
 * `.claude/worktrees/<x>/server`. If `server.dev` changes shape, this
 * needle must follow — the fail-safe is "match nothing, do nothing"
 * (orphans accumulate again, back to status quo). Self-excludes by PID
 * + PPID so it never targets the process tree it was launched from.
 *
 * Cross-platform: no shell, no deps.
 *   POSIX: `ps -A -o pid=,command=`  (macOS BSD ps + Linux procps agree
 *          on this form — the `=` suffix suppresses the column header).
 *   Windows: `wmic process get processid,commandline /format:csv`
 *          (wmic is deprecated on Win11 23H2+ but still ships on most
 *          installs; if missing, the script silently no-ops and Windows
 *          users see the original behavior).
 *
 * Silent on the no-op path; logs only when it actually kills something.
 */
import { execFileSync } from 'node:child_process';

const DRY_RUN = process.argv.includes('--dry-run');

// Match: `--env-file-if-exists=../.env` + `src/index.ts` (`/` or `\` for
// Windows). These are the two distinctive args on `server.dev`; any
// process command line carrying both is one of our tsx-watch trees.
const NEEDLE = /--env-file-if-exists=\.\.[/\\]\.env.*\bsrc[/\\]index\.ts\b/;

function listMatchingProcessIds() {
  if (process.platform === 'win32') {
    // wmic CSV: Node,CommandLine,ProcessId  (the leading Node column is
    // the WMI host name, not a number). PID is the trailing field.
    try {
      const out = execFileSync(
        'wmic',
        ['process', 'get', 'processid,commandline', '/format:csv'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return out
        .split(/\r?\n/)
        .filter((line) => NEEDLE.test(line))
        .map((line) => {
          const m = line.match(/(\d+)\s*$/);
          return m ? Number(m[1]) : null;
        })
        .filter((pid) => Number.isFinite(pid));
    } catch {
      return [];
    }
  }
  // POSIX (macOS, Linux).
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .filter((line) => NEEDLE.test(line))
      .map((line) => {
        const m = line.match(/^\s*(\d+)\s+/);
        return m ? Number(m[1]) : null;
      })
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

const selfChain = new Set([process.pid, process.ppid]);
const candidates = listMatchingProcessIds().filter((pid) => !selfChain.has(pid));

if (candidates.length === 0) {
  if (DRY_RUN) console.log('[predev:server] no stale tsx-watch processes found');
  process.exit(0);
}

const label = candidates.length === 1 ? 'process' : 'processes';
const verb = DRY_RUN ? 'would kill' : 'killing';
console.log(
  `[predev:server] ${verb} ${candidates.length} stale tsx-watch ${label}: ${candidates.join(', ')}`,
);

if (DRY_RUN) process.exit(0);

for (const pid of candidates) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ESRCH (already gone) / EPERM (different user, e.g. left over from
    // a sudo run) — nothing actionable, carry on.
  }
}

// Brief grace period before SIGKILL — give tsx-watch a chance to clean up
// its file watchers and propagate SIGTERM to the inner node. 250ms is
// well under any noticeable npm post-script lag and ample for the
// SIGTERM handler to fire.
await new Promise((resolve) => setTimeout(resolve, 250));

for (const pid of candidates) {
  try {
    process.kill(pid, 0); // existence probe — throws ESRCH if gone
    process.kill(pid, 'SIGKILL');
  } catch {
    // gone — clean exit
  }
}
