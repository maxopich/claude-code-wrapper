/**
 * Filesystem layout for the local agent bus (pure-SDK runtime).
 *
 * There is no on-disk message transport anymore: agents exchange messages
 * via the in-process `bus_send` tool (see runner.ts), so there are no
 * inboxes, no archive, no `bus.log`, and no shared shell scripts. What
 * remains on disk is just the artifact/transcript tree and the
 * Cebab-generated orchestrator workspace.
 *
 *   1. **Per-session state** under `<workspaceRoot>/.cebab-session-<id>/`,
 *      computed via `computeSessionPaths`:
 *      ```
 *      <workspaceRoot>/.cebab-session-<sessionId>/
 *        orchestrator/{CLAUDE.md, .cebab/comm.md}   # Cebab-owned workspace
 *        iterations/NNN/<agent>/{prompt.md, reply.md, transcript.log,
 *                                final.md}
 *      ```
 *
 *   2. **Legacy global iteration root** under `~/.cebab/bus/` — only the
 *      `iterations/` subtree (`busIterationDir`) and the legacy
 *      `orchestratorWorkspaceDir()` survive, used by pre-007 rows whose
 *      `session_folder` column is NULL and by unit tests that don't need
 *      the per-session split.
 *
 * `comm.md` is the orchestrator's bus-protocol doc, imported from its
 * workspace `CLAUDE.md` via the project-relative `@.cebab/comm.md` (an
 * external/absolute import would trip claude-code's startup trust modal).
 * Worker projects get no comm.md and no project-file mutation at all —
 * their protocol arrives via the per-turn briefing.
 */
import path from 'node:path';
import { config } from '../config.js';

/** Root of legacy global bus state (the `iterations/` subtree only). Tests
 *  can override `config.dataDir` to relocate. */
export function busRoot(): string {
  return path.join(config.dataDir, 'bus');
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
 * `session_folder` column), then threaded through `archiveAgentHop`,
 * `prepareIterationDir`, and the orchestrator workspace generator.
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
   *  `.cebab/comm.md` live for THIS session. */
  orchestratorWorkspace: string;
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
    iterationDir: (iterationId: string, agentName?: string) =>
      agentName
        ? path.join(folder, 'iterations', iterationId, agentName)
        : path.join(folder, 'iterations', iterationId),
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
 * This is the name the operator sees in the transcript UI and the iteration
 * artifact dirs, and what the orchestrator uses to address workers via
 * `bus_send(recipient="reviewer", ...)`. Keep it human-readable.
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
  // The alternation is anchored — each segment requires a literal `-` and
  // at least one alnum, so there's no catastrophic backtracking. Mirrors
  // the bash regex in bus-send-msg.sh (F6).
  // eslint-disable-next-line security/detect-unsafe-regex
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}

/**
 * True iff `s` is a valid bus message recipient — either an agent slug
 * (per `isValidAgentName`) or one of the two protocol sentinels (`user`
 * for orchestrator → operator finals, `_sink` for chain terminations).
 *
 * Used by the `bus_send` tool handler (runner.ts) to reject a bogus
 * recipient before the event is routed. Sentinels are hardcoded here
 * rather than imported from `runtime.ts` to keep this file free of
 * cycles — `runtime.ts` imports from us.
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
