/**
 * Thin wrapper around the local `tmux` binary.
 *
 * Each call shells out via `execFile` (no shell interpretation) so we don't
 * need to worry about quoting agent names, paths, or message bodies — argv
 * elements pass through verbatim.
 *
 * Failure modes returned as typed errors so the WS layer can surface useful
 * messages: `TmuxNotInstalled` (no `tmux` on PATH), `TmuxSessionMissing`
 * (operation on a session that doesn't exist), `TmuxError` (anything else).
 *
 * macOS-only by Cebab's larger constraint. Tested on tmux 3.4 (Homebrew default).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class TmuxNotInstalled extends Error {
  constructor() {
    super('tmux is not installed (or not on PATH). Run `brew install tmux` first.');
    this.name = 'TmuxNotInstalled';
  }
}

export class TmuxSessionMissing extends Error {
  constructor(sessionName: string) {
    super(`tmux session not found: ${sessionName}`);
    this.name = 'TmuxSessionMissing';
  }
}

export class TmuxError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'TmuxError';
  }
}

async function run(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec('tmux', args);
  } catch (err) {
    // execFile rejects on non-zero exit. ENOENT means tmux isn't on PATH.
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new TmuxNotInstalled();
    throw new TmuxError(`tmux ${args.join(' ')} failed`, e.stderr ?? String(err));
  }
}

/** True iff `tmux -V` runs cleanly. Cached after first probe per-process. */
let _available: boolean | null = null;
export async function tmuxAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    await run(['-V']);
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

/**
 * True iff a session with `name` exists. Implemented via `tmux has-session`,
 * which exits 0 on hit, non-zero on miss. The non-zero case is normal — we
 * swallow it rather than treating as an error.
 */
export async function hasSession(name: string): Promise<boolean> {
  try {
    await run(['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

export type NewSessionOpts = {
  /** Tmux session name (used as -s). */
  name: string;
  /** First-window name (used as -n). */
  windowName: string;
  /** Working directory for the new session's first window. */
  cwd: string;
  /** Shell command to run in the window. Detached mode (-d) keeps it from
   *  hijacking the caller's terminal. */
  command: string;
  /** Optional env vars set in the session (used as -e KEY=VALUE). Useful for
   *  passing `BUS_AGENT_NAME` so the bus scripts know who's invoking them
   *  without depending on the project's `.claude/settings.json` env injection. */
  env?: Record<string, string>;
};

/** Create a new detached tmux session. Throws if it already exists. */
export async function newSession(opts: NewSessionOpts): Promise<void> {
  const args: string[] = [
    'new-session',
    '-d',
    '-s',
    opts.name,
    '-n',
    opts.windowName,
    '-c',
    opts.cwd,
  ];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  args.push(opts.command);
  await run(args);
}

export type NewWindowOpts = {
  sessionName: string;
  windowName: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
};

/** Add a new window to an existing session. */
export async function newWindow(opts: NewWindowOpts): Promise<void> {
  if (!(await hasSession(opts.sessionName))) throw new TmuxSessionMissing(opts.sessionName);
  const args: string[] = [
    'new-window',
    '-d',
    '-t',
    opts.sessionName,
    '-n',
    opts.windowName,
    '-c',
    opts.cwd,
  ];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  args.push(opts.command);
  await run(args);
}

/**
 * Send keystrokes to a target window/pane. `target` is the tmux selector,
 * typically `"<session>:<window>"`. Each entry in `keys` is one tmux key
 * spec — literal strings are typed as-is, named keys like `"Enter"` are
 * interpreted. To send literal text followed by Enter, pass `["my text",
 * "Enter"]`.
 */
export async function sendKeys(target: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await run(['send-keys', '-t', target, ...keys]);
}

/**
 * Start piping the contents of a target pane into `outPath` (appended).
 * `-O` makes the pipe survive subsequent commands until `pipe-pane` is
 * called again with no command. Useful for capturing per-agent transcripts.
 */
export async function pipePane(target: string, outPath: string): Promise<void> {
  await run(['pipe-pane', '-O', '-t', target, `cat >> ${escapeForShell(outPath)}`]);
}

/** Stop any active pipe on the target pane. */
export async function unpipePane(target: string): Promise<void> {
  await run(['pipe-pane', '-t', target]);
}

/** Kill the session. Idempotent: missing session is treated as success. */
export async function killSession(name: string): Promise<void> {
  if (!(await hasSession(name))) return;
  await run(['kill-session', '-t', name]);
}

/**
 * Enumerate live tmux session names via `list-sessions -F #{session_name}`.
 *
 * Returns an empty array on any failure: tmux not installed, no server
 * running (tmux 3.x exits non-zero with "no server running on ..." when
 * there are zero sessions), or any other surprise. Callers treat "no live
 * sessions" identically to "tmux unavailable" — both mean "nothing to act
 * on" — so collapsing both into `[]` keeps the call sites tidy.
 *
 * Used by the WS `clear_iterations` handler to reap `cebab-bus-*` tmux
 * sessions whose DB rows no longer exist (Cebab restarts, crashes, or a
 * past Clear that landed before this code shipped).
 */
export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await run(['list-sessions', '-F', '#{session_name}']);
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** Capture the recent visible contents of a pane (for debug/snapshot use). */
export async function capturePane(target: string): Promise<string> {
  const { stdout } = await run(['capture-pane', '-t', target, '-p']);
  return stdout;
}

/**
 * Wait up to `maxWaitMs` for claude-code's "Bypass Permissions mode"
 * startup warning modal to render in `target`, then dismiss it by
 * sending "2" + Enter (the "Yes, I accept" option).
 *
 * Why this is necessary: claude-code prints this modal on EVERY TUI
 * start under `--permission-mode bypassPermissions` (or
 * `--dangerously-skip-permissions`), and there's no per-host state key
 * that caches the acceptance — verified empirically (`~/.claude.json`
 * has no bypass-mode acceptance key) and confirmed via the claude-code
 * docs (no flag, env var, or settings key suppresses it). The default
 * highlighted option is "No, exit" — Enter would kill the worker — so
 * dismissing this modal is a HARD precondition before any wake
 * keystroke containing Enter is sent.
 *
 * Returns true if the modal was found and dismissed; false on timeout
 * (which can mean either: claude crashed before rendering, the worker
 * was already at the chat prompt, or a future claude-code version
 * stopped showing this modal). Timeout is benign — callers should
 * proceed regardless; the wake send-keys will either land on an
 * already-ready TUI, or fizzle harmlessly.
 *
 * Polls `capturePane` rather than blind-sending because:
 *   1. Sending "2 Enter" into an empty chat prompt makes claude
 *      respond as if the user typed "2" — confusing the agent and
 *      wasting a turn.
 *   2. Timing of modal render varies (~200ms–2s on a warm cache);
 *      polling adapts to that variance instead of a fixed sleep.
 */
export async function dismissBypassPermissionsModal(
  target: string,
  maxWaitMs = 4000,
  pollIntervalMs = 250,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const pane = await capturePane(target);
      if (/Bypass Permissions mode/.test(pane)) {
        await sendKeys(target, ['2', 'Enter']);
        return true;
      }
    } catch {
      // Pane may still be initializing — keep polling rather than
      // surfacing the error. If the modal really won't appear, we time
      // out and the caller decides what to do.
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return false;
}

/**
 * Conservative shell-escape for a path passed inside the `pipe-pane`
 * command argument. tmux interprets the command in a sub-shell, so the
 * path needs to be quoted there even though we passed it through execFile
 * already. Single-quote everything and escape any internal `'` by closing
 * the quote, prepending an escaped `'`, and reopening — the classic POSIX
 * dance.
 */
function escapeForShell(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the argv tmux would receive for a `new-session` call. Exported so
 * tests can assert the command shape without invoking the binary.
 */
export function _buildNewSessionArgs(opts: NewSessionOpts): string[] {
  const args: string[] = [
    'new-session',
    '-d',
    '-s',
    opts.name,
    '-n',
    opts.windowName,
    '-c',
    opts.cwd,
  ];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  args.push(opts.command);
  return args;
}

/** Mirror of `_buildNewSessionArgs` for `new-window`, for the same testing purpose. */
export function _buildNewWindowArgs(opts: NewWindowOpts): string[] {
  const args: string[] = [
    'new-window',
    '-d',
    '-t',
    opts.sessionName,
    '-n',
    opts.windowName,
    '-c',
    opts.cwd,
  ];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  args.push(opts.command);
  return args;
}
