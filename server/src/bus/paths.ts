/**
 * Filesystem layout for the local agent bus.
 *
 * After migration 007 the layout splits into two locations:
 *
 *   1. **Stable global state** under `~/.cebab/bus/` (Cebab data dir):
 *      ```
 *      ~/.cebab/bus/
 *        bin/{bus-send-msg,bus-check-inbox,bus-status}.sh   # shared scripts
 *      ```
 *      The shared scripts' absolute paths are baked into each project's
 *      `.claude/settings.json` (Stop hook, allow patterns) at install time,
 *      so they MUST stay stable across sessions and Cebab upgrades.
 *
 *   2. **Per-project state** under `<projectPath>/.cebab/`:
 *      ```
 *      <projectPath>/.cebab/comm.md                         # protocol doc
 *      ```
 *      `comm.md` is the per-agent bus-protocol doc imported from
 *      `CLAUDE.md` via `@.cebab/comm.md`. It lives **inside** the project
 *      so the import is a project-relative path, not an external one —
 *      external imports trigger claude-code's startup trust modal, which
 *      cannot be dismissed headlessly in a tmux-spawned TUI and silently
 *      eats the first wake keystroke. Keeping the import internal sidesteps
 *      that modal entirely. (Pre-fix builds wrote comm.md to a global
 *      `~/.cebab/bus/agents/<slug>/comm.md`; install/uninstall now migrate
 *      that legacy state.)
 *
 *   3. **Per-session state** under `<workspaceRoot>/.cebab-session-<id>/`,
 *      computed via `computeSessionPaths`:
 *      ```
 *      <workspaceRoot>/.cebab-session-<sessionId>/
 *        orchestrator/{CLAUDE.md, .claude/settings.json, .cebab/comm.md}
 *        inboxes/<agent>/<ts>-<from>-<rand>.msg             # live traffic
 *        archive/<agent>/...                                # consumed messages
 *        bus.log                                            # JSONL event stream
 *        iterations/NNN/<agent>/{prompt.md, reply.md, transcript.log}
 *      ```
 *      The bus scripts find these via the `BUS_SESSION_ROOT` env var that
 *      Cebab passes when spawning each tmux window (see `bus-*.sh`).
 *
 * For pre-007 sessions that predate this split, the legacy global helpers
 * (`busInboxDir`, `busArchiveDir`, `busLogPath`, `busIterationDir`,
 * `orchestratorWorkspaceDir`) still resolve to `~/.cebab/bus/...` and
 * `~/.cebab/orchestrator/`. Resume falls back to these when a session row
 * has `session_folder=NULL`.
 */
import path from 'node:path';
import { config } from '../config.js';

/** Root of all bus state. Tests can override `config.dataDir` to relocate. */
export function busRoot(): string {
  return path.join(config.dataDir, 'bus');
}

export function busBinDir(): string {
  return path.join(busRoot(), 'bin');
}

/**
 * Relative path of the per-project bus protocol doc, used as-is in the
 * `@import` line in each project's CLAUDE.md. Project-relative (not
 * absolute) so claude-code's startup external-import trust modal never
 * triggers — see the file header for the why.
 */
export const PROJECT_COMM_MD_REL = '.cebab/comm.md';

/** Per-project `.cebab/` dir — holds the bus protocol doc and any future
 *  per-project bus state. Hidden dot-prefixed so it doesn't clutter the
 *  project root in Finder. */
export function projectCebabDir(projectPath: string): string {
  return path.join(projectPath, '.cebab');
}

/** Per-project bus protocol doc. The `@import` line in CLAUDE.md points
 *  here via the relative `PROJECT_COMM_MD_REL` constant. */
export function projectCommMdPath(projectPath: string): string {
  return path.join(projectCebabDir(projectPath), 'comm.md');
}

export function busInboxDir(agentName: string): string {
  return path.join(busRoot(), 'inboxes', agentName);
}

export function busArchiveDir(agentName: string): string {
  return path.join(busRoot(), 'archive', agentName);
}

export function busLogPath(): string {
  return path.join(busRoot(), 'bus.log');
}

export function busIterationsDir(): string {
  return path.join(busRoot(), 'iterations');
}

export function busIterationDir(iterationId: string, agentName?: string): string {
  const base = path.join(busIterationsDir(), iterationId);
  return agentName ? path.join(base, agentName) : base;
}

/** Canonical orchestrator workspace, generated on first multi-agent run.
 *  Legacy global path — used by pre-007 sessions and by unit tests that
 *  don't need the per-session split. Post-007 sessions resolve the
 *  orchestrator workspace via `computeSessionPaths(...).orchestratorWorkspace`. */
export function orchestratorWorkspaceDir(): string {
  return path.join(config.dataDir, 'orchestrator');
}

/**
 * Bundle of every per-session path a runtime helper might need. Computed
 * once at session start (and on resume from the persisted
 * `session_folder` column), then threaded through `writeInboxMessage`,
 * `archiveAgentHop`, `prepareIterationDir`, `appendBusLogEvent`, and the
 * orchestrator workspace generator.
 *
 * The fields are functions (not pre-baked strings) for the path helpers
 * that take an agent slug — saves the caller from threading both the
 * agent name and a SessionPaths object through multiple layers.
 */
export type SessionPaths = {
  /** Absolute path to the session folder. Also stored on the DB row's
   *  `session_folder` column so resume can rebuild this object. */
  folder: string;
  /** `<folder>/orchestrator/` — where the orchestrator's CLAUDE.md +
   *  `.claude/settings.json` live for THIS session. */
  orchestratorWorkspace: string;
  /** `<folder>/inboxes/<agent>/` — where Cebab and the bus scripts
   *  drop `.msg` files for the named agent. */
  busInbox: (agent: string) => string;
  /** `<folder>/archive/<agent>/` — where `bus-check-inbox.sh` moves
   *  consumed messages. */
  busArchive: (agent: string) => string;
  /** `<folder>/bus.log` — append-only JSONL the tailer watches. */
  busLog: string;
  /** `<folder>/iterations/<NNN>/[<agent>]` — iteration artifact dir
   *  (chain hops, orchestrator transcripts, final.md). */
  iterationDir: (iterationId: string, agentName?: string) => string;
};

/**
 * Compute the SessionPaths bundle for a given session id + workspace root.
 * The workspace root is the operator-configured directory under which
 * their agent projects (and now their multi-agent session folders) live.
 *
 * Naming: dot-prefixed (`.cebab-session-<id>`) so it's hidden from Finder
 * by default and skipped by `syncWorkspaceProjects` when scanning for
 * project subdirectories.
 *
 * No filesystem I/O — pure path math. Callers create the directories
 * with `mkdirSync({ recursive: true })` as needed.
 */
export function computeSessionPaths(sessionId: string, workspaceRoot: string): SessionPaths {
  const folder = path.join(workspaceRoot, `.cebab-session-${sessionId}`);
  return {
    folder,
    orchestratorWorkspace: path.join(folder, 'orchestrator'),
    busInbox: (agent: string) => path.join(folder, 'inboxes', agent),
    busArchive: (agent: string) => path.join(folder, 'archive', agent),
    busLog: path.join(folder, 'bus.log'),
    iterationDir: (iterationId: string, agentName?: string) =>
      agentName
        ? path.join(folder, 'iterations', iterationId, agentName)
        : path.join(folder, 'iterations', iterationId),
  };
}

/**
 * Rebuild a SessionPaths from a previously-persisted `session_folder`
 * absolute path. Used by resume — the DB row's `session_folder` is the
 * source of truth, not a re-computed workspaceRoot (which could have
 * changed since the session started).
 */
export function sessionPathsFromFolder(folder: string): SessionPaths {
  return {
    folder,
    orchestratorWorkspace: path.join(folder, 'orchestrator'),
    busInbox: (agent: string) => path.join(folder, 'inboxes', agent),
    busArchive: (agent: string) => path.join(folder, 'archive', agent),
    busLog: path.join(folder, 'bus.log'),
    iterationDir: (iterationId: string, agentName?: string) =>
      agentName
        ? path.join(folder, 'iterations', iterationId, agentName)
        : path.join(folder, 'iterations', iterationId),
  };
}

/**
 * Legacy fallback SessionPaths pointing at the pre-007 global layout
 * (`~/.cebab/bus/`). Used when resuming a session whose DB row has
 * `session_folder=NULL` — its inboxes/archive/bus.log/iterations all
 * still live under `~/.cebab/bus/`, so we synthesize a SessionPaths
 * that points there.
 */
export function legacyGlobalSessionPaths(): SessionPaths {
  return {
    folder: busRoot(),
    orchestratorWorkspace: orchestratorWorkspaceDir(),
    busInbox: (agent: string) => busInboxDir(agent),
    busArchive: (agent: string) => busArchiveDir(agent),
    busLog: busLogPath(),
    iterationDir: (iterationId: string, agentName?: string) =>
      busIterationDir(iterationId, agentName),
  };
}

/**
 * Slugify a project name into a bus-safe agent identifier.
 *
 *   - lowercase
 *   - non-alphanumeric runs collapse to a single `-`
 *   - leading/trailing `-` stripped
 *   - empty result is invalid — caller must fall back (e.g. `agent-<id>`)
 *
 * This is the on-disk name the operator will see in `bus.log`, in inbox file
 * names, and when the orchestrator addresses workers (`bus-send-msg reviewer`).
 * Keep it human-readable.
 */
export function slugifyAgentName(rawName: string): string {
  return rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * True iff `s` is a valid agent slug — non-empty, lowercase alphanumerics
 * plus internal hyphens. Used to validate WS input before touching the
 * filesystem with caller-supplied names.
 */
export function isValidAgentName(s: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}

/**
 * True iff `s` is a valid bus message recipient — either an agent slug
 * (per `isValidAgentName`) or one of the two protocol sentinels (`user`
 * for orchestrator → operator finals, `_sink` for chain terminations).
 *
 * Used by `writeInboxMessage` and the bus shell scripts to reject path-
 * traversal payloads (`../../../tmp/pwn`) before they reach `mkdir`/`mv`.
 * Sentinels are hardcoded here rather than imported from `runtime.ts`
 * to keep this file free of cycles — `runtime.ts` imports from us.
 */
export function isValidBusRecipient(s: string): boolean {
  return s === 'user' || s === '_sink' || isValidAgentName(s);
}

/**
 * Slugs reserved for system roles in the bus protocol. A project whose name
 * happens to slugify to one of these gets bumped to a `<slug>-<id>` fallback
 * by `chooseAgentName` — otherwise the project would shadow the system
 * sentinel and the orchestrator's routing logic would get confused.
 *
 * The `_sink` sentinel is intentionally absent: its leading underscore is
 * disallowed by `isValidAgentName`, so it can never be reached from a
 * project name regardless.
 */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  'orchestrator', // Cebab's own routing agent
  'user', // operator-facing terminal recipient
  'cebab', // Cebab itself as a bus source
]);
