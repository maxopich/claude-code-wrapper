/**
 * Filesystem layout for the local agent bus (pure-SDK runtime).
 *
 * There is no on-disk message transport anymore: agents exchange messages
 * via the in-process `bus_send` tool (see runner.ts), so there are no
 * inboxes, no archive, no `bus.log`, and no shared shell scripts. What
 * remains on disk is just the artifact/transcript tree and the
 * Cebab-generated orchestrator workspace.
 *
 *   1. **Per-session state** under `<dataDir>/sessions/<id>/`, computed via
 *      `computeSessionPaths`:
 *      ```
 *      <dataDir>/sessions/<sessionId>/
 *        orchestrator/                              # empty Cebab-owned cwd
 *        iterations/NNN/<agent>/{prompt.md, reply.md, transcript.log,
 *                                final.md}
 *      ```
 *      This used to live at `<workspaceRoot>/.cebab-session-<id>/`, dot-prefixed
 *      so Finder hid it and `syncWorkspaceProjects` skipped it. Both were
 *      mitigations for squatting in a directory that belongs to the operator,
 *      and neither stopped the folders showing up in `ls -a`, in repo-wide
 *      tooling, or in every backup of their projects tree (Cebab-ws0.8). They
 *      are Cebab's state, so they now live in Cebab's data dir, where the same
 *      0700 + gitignore policy that covers the database and the logs covers
 *      them too.
 *
 *   2. **Legacy global iteration root** under `~/.cebab/bus/` — only the
 *      `iterations/` subtree (`busIterationDir`) and the legacy
 *      `orchestratorWorkspaceDir()` survive, used by pre-007 rows whose
 *      `session_folder` column is NULL and by unit tests that don't need
 *      the per-session split.
 *
 * The orchestrator workspace is a directory and nothing else — register X16.
 * This header used to draw `CLAUDE.md` and `.cebab/comm.md` into that tree and
 * describe `comm.md` as a live `@.cebab/comm.md` import. Neither file is
 * written: the orchestrator runs `settingSources: ['user']`, under which a
 * workspace `CLAUDE.md` / `comm.md` / `settings.json` would never be loaded, so
 * both were removed as dead (see `ensureOrchestratorWorkspace` in
 * `orchestrator.ts`, and the test named "creates the workspace dir and writes
 * NO files"). Every agent's protocol arrives via the per-turn briefing —
 * `renderRosterPrompt` for the orchestrator, `renderWorkerBriefing` /
 * `renderChainBriefing` for the rest. A layout diagram is the first thing
 * anyone reads to learn the on-disk contract, so it drew two files that a test
 * asserts are absent.
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
 * Root for every session folder Cebab creates: `<dataDir>/sessions/`.
 *
 * Reads `config.dataDir` on EVERY call and never captures it at module init —
 * the property is deliberately mutable so per-test isolation can redirect it
 * (`config.ts` says so), and a captured value would write to whatever directory
 * happened to be configured at import time.
 *
 * Not to be confused with `orchestratorWorkspaceDir()` = `<dataDir>/orchestrator`
 * below, which is the legacy SHARED scratch dir. The per-session
 * `<folder>/orchestrator` is a different thing that happens to share a name.
 */
export function sessionsRoot(): string {
  return path.join(config.dataDir, 'sessions');
}

/**
 * Rebuild a SessionPaths from a `session_folder` absolute path.
 *
 * The DB row's `session_folder` is the source of truth on resume — NOT a
 * recomputed root, which could have moved since the session started. That is
 * what makes ws0.8's cutover safe: rows written before the move keep resolving
 * to the folder their artifacts are actually in, forever.
 *
 * Also the single definition of the sub-layout: `computeSessionPaths` composes
 * with this rather than repeating it, so the writer and the resume-time reader
 * cannot drift apart.
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
 * Compute the SessionPaths bundle for a session id.
 *
 * Takes no workspace root — the location is Cebab's data dir, and it stopped
 * being any of the workspace's business in Cebab-ws0.8. The parameter was
 * deleted rather than kept-and-ignored on purpose: ~20 call sites would have
 * gone on passing a workspace root, and an argument that no longer influences
 * the result is a claim in executable position that it does. Deleting it also
 * made the compiler enumerate every call site instead of leaving that to grep.
 *
 * EXISTING FOLDERS ARE NOT MIGRATED, DELIBERATELY. `<folder>/orchestrator` is a
 * live agent cwd (`orchestrator.ts` registers it as one, and `runner.ts` passes
 * `resume:` alongside it), and the CLI keys its transcript store on the ABSOLUTE
 * cwd. Relocating an existing folder would orphan that lineage — the session
 * would survive and lose its history. Old rows keep their stored absolute
 * `session_folder` and resolve through `sessionPathsFromFolder` forever.
 *
 * No filesystem I/O — pure path math. Callers create the directories with
 * `secureMkdir` as needed.
 */
export function computeSessionPaths(sessionId: string): SessionPaths {
  return sessionPathsFromFolder(path.join(sessionsRoot(), sessionId));
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
 * `bus_send(destination="reviewer", ...)`. Keep it human-readable.
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
 * True iff `s` is a valid bus message destination — either an agent slug
 * (per `isValidAgentName`) or one of the two protocol sentinels (`user`
 * for orchestrator → operator finals, `_sink` for chain terminations).
 *
 * `destination` is the one word this value goes by everywhere (the tool
 * schema, the `BusEvent` field, the router comparisons, the DB column, the
 * WS protocol) since register N20 — this validator used to be the `recipient`
 * half of that split.
 *
 * Used by the `bus_send` tool handler (runner.ts) to reject a bogus
 * destination before the event is routed. Sentinels are hardcoded here
 * rather than imported from `runtime.ts` to keep this file free of
 * cycles — `runtime.ts` imports from us.
 */
export function isValidBusDestination(s: string): boolean {
  return s === 'user' || s === '_sink' || isValidAgentName(s);
}

/**
 * Windows reserved device names (register H17). A slug becomes a DIRECTORY —
 * `SessionPaths.iterationDir` joins it straight into the artifact path — and
 * on Windows these names address a device, not a file, so `mkdir con` fails.
 * A project named "Con" or "Aux" would therefore have every hop archive fail
 * on a first-class supported platform (CI runs a Windows leg) and nowhere else.
 *
 * `slugifyAgentName` lowercases and strips non-alphanumerics, so only the
 * bare lowercase forms can ever be produced: no `CON`, and no `con.txt`
 * (a slug cannot contain a dot).
 */
const WINDOWS_DEVICE_NAMES: readonly string[] = [
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
];

/**
 * Slugs a project may not take, for two unrelated reasons.
 *
 *   1. **Bus protocol sentinels** — a project whose name slugifies to one of
 *      these would shadow the sentinel and confuse the orchestrator's routing.
 *   2. **Windows device names** — see `WINDOWS_DEVICE_NAMES` above; the slug
 *      is used as a directory name.
 *
 * Either way `chooseAgentName` bumps the project to a `<slug>-<id>` fallback,
 * so this list is data, not a new code path.
 *
 * The `_sink` sentinel is intentionally absent: its leading underscore is
 * disallowed by `isValidAgentName`, so it can never be reached from a
 * project name regardless.
 *
 * Applied at ASSIGNMENT time only. A project already installed under a device
 * name keeps it: renaming a live agent would orphan its `--resume` checkpoint
 * and its existing iteration directories, which is a worse trade than leaving
 * one pre-existing install broken on one platform.
 */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  'orchestrator', // Cebab's own routing agent
  'user', // operator-facing terminal recipient
  'cebab', // Cebab itself as a bus source
  ...WINDOWS_DEVICE_NAMES,
]);
