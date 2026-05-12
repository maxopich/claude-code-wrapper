/**
 * Bus integration installer.
 *
 * Two responsibilities:
 *
 * 1. **Bootstrap**: lazily create the bus directory layout at
 *    `~/.cebab/bus/` and copy our three shell scripts into `bin/`. Done
 *    on first install (idempotent on subsequent calls).
 *
 * 2. **Per-agent install / uninstall** (idempotent, non-destructive):
 *      - Generates `agents/<slug>/comm.md` from template.
 *      - Appends one `@import <path>` line to the project's CLAUDE.md.
 *      - Merges three entries into the project's `.claude/settings.json`:
 *          • `env.BUS_AGENT_NAME` so scripts know who's invoking them.
 *          • `permissions.allow` entries for each bus binary (narrow:
 *            only the bus scripts get auto-approved).
 *          • A single `hooks.Stop` entry running `bus-check-inbox.sh <slug>`.
 *      - Records `bus_installed` + `bus_agent_name` on the project row.
 *
 * Trust note: this is the one part of Cebab that writes into a project's
 * `.claude/settings.json`. The added permissions are scoped to specific
 * bus script paths only (not blanket bash), and the Stop hook only runs
 * `bus-check-inbox.sh`. Operator existing content (env vars, other
 * permissions, other Stop hooks) is preserved exactly across install and
 * uninstall — see `mergeSettings` / `unmergeSettings` for the merge rules.
 */
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProject } from '../repo/projects.js';
import {
  getProjectBusState,
  isAgentNameTaken,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import {
  busBinDir,
  busRoot,
  isValidAgentName,
  PROJECT_COMM_MD_REL,
  projectCebabDir,
  projectCommMdPath,
  RESERVED_AGENT_NAMES,
  slugifyAgentName,
} from './paths.js';
import { renderCommMd } from './comm.js';

/**
 * Legacy (pre-fix) location of the per-agent comm.md, under the global
 * `~/.cebab/bus/agents/<slug>/`. Used ONLY to detect and clean up old
 * installs — new installs write to `projectCommMdPath(...)` so the
 * `@import` line in CLAUDE.md is project-relative and doesn't trigger
 * claude-code's external-import trust modal. See `paths.ts` header.
 */
function legacyBusCommMdPath(agentName: string): string {
  return path.join(busRoot(), 'agents', agentName, 'comm.md');
}

/** Legacy absolute `@import` line for an agent — what an install before
 *  the trust-modal fix wrote into CLAUDE.md. */
function legacyImportLineFor(agentName: string): string {
  return `@${legacyBusCommMdPath(agentName)}`;
}

/** New project-relative `@import` line. Same for every agent (the line
 *  itself doesn't encode the slug; the project's identity does). */
function importLineForProject(): string {
  return `@${PROJECT_COMM_MD_REL}`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCRIPT_FILES = ['bus-send-msg.sh', 'bus-check-inbox.sh', 'bus-status.sh'] as const;

/**
 * Find the source scripts directory. `tsx` runs from src/, `tsc` output is
 * mirrored to dist/ but assets may not be copied — fall back to src in that
 * case. (Same pattern as `db.ts` uses for migrations.)
 */
function scriptsSourceDir(): string {
  const candidates = [
    path.join(__dirname, 'scripts'),
    path.join(__dirname, '..', '..', 'src', 'bus', 'scripts'),
  ];
  for (const d of candidates) {
    if (fs.existsSync(path.join(d, 'bus-send-msg.sh'))) return d;
  }
  throw new Error(`bus scripts source dir not found; tried: ${candidates.join(', ')}`);
}

/**
 * Lazily prepare the stable bus root: `~/.cebab/bus/bin/` with the three
 * scripts. Idempotent — safe to call on every install.
 *
 * Post-fix: this bootstrap creates ONLY the bin dir. comm.md now lives
 * per-project (`<projectPath>/.cebab/comm.md`) so the `@import` line in
 * CLAUDE.md is project-relative; the global `agents/` dir is no longer
 * needed for new installs. (Legacy installs that wrote to
 * `~/.cebab/bus/agents/<slug>/comm.md` are migrated on re-install via
 * `installBusForProject` — and the legacy global comm.md is unlinked
 * there if present. The empty `agents/` dir is left alone since
 * `rmdir`ing it would race with concurrent migrations.)
 *
 * Per-session traffic (`inboxes/`, `archive/`, `bus.log`, `iterations/`)
 * lives inside `<workspace>/.cebab-session-<id>/` and is created by
 * `chain.ts` / `orchestrator.ts` at session start. Pre-007 sessions
 * resume against the legacy global layout via the fallback in `paths.ts`.
 */
export function ensureBusBootstrap(): void {
  const root = busRoot();
  fs.mkdirSync(root, { recursive: true });
  const bin = busBinDir();
  fs.mkdirSync(bin, { recursive: true });

  // Copy (or refresh) each script. Always overwrite so a Cebab upgrade rolls
  // out script fixes; operators are not expected to edit these files in place.
  const src = scriptsSourceDir();
  for (const name of SCRIPT_FILES) {
    const from = path.join(src, name);
    const to = path.join(bin, name);
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o755);
  }
}

// ---- per-agent install ----

export type InstallResult = {
  agentName: string;
  changes: {
    commMd: 'created' | 'updated';
    claudeMd: 'appended' | 'already-present';
    settingsJson: 'created' | 'updated' | 'already-present';
    busRow: 'inserted' | 'updated' | 'unchanged';
  };
};

export class InstallError extends Error {
  constructor(
    public readonly code:
      | 'project_not_found'
      | 'agent_name_empty'
      | 'agent_name_taken'
      | 'project_path_missing',
    message: string,
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

/**
 * Install bus integration for a project. Idempotent: a second call returns
 * `'already-present'` markers and makes no changes.
 *
 * Throws `InstallError` on:
 *   - missing project row
 *   - project directory has disappeared from disk
 *   - the derived agent slug is empty (project name had no alphanumerics)
 *   - the derived agent slug collides with another already-installed project
 */
export async function installBusForProject(projectId: number): Promise<InstallResult> {
  const project = getProject(projectId);
  if (!project) {
    throw new InstallError('project_not_found', `project ${projectId} not found`);
  }
  if (!fs.existsSync(project.path)) {
    throw new InstallError(
      'project_path_missing',
      `project path no longer exists: ${project.path}`,
    );
  }

  // Choose or reuse the agent name.
  const existingState = getProjectBusState(projectId);
  let agentName: string;
  if (existingState.installed && existingState.agentName) {
    agentName = existingState.agentName;
  } else {
    agentName = chooseAgentName(project.name, project.id, projectId);
  }

  ensureBusBootstrap();

  const changes: InstallResult['changes'] = {
    commMd: 'created',
    claudeMd: 'appended',
    settingsJson: 'created',
    busRow: 'inserted',
  };

  // 1. <project>/.cebab/comm.md — per-project so the CLAUDE.md @import
  //    line below is project-relative (not external).
  const cebabDir = projectCebabDir(project.path);
  fs.mkdirSync(cebabDir, { recursive: true });
  const commPath = projectCommMdPath(project.path);
  const commContent = renderCommMd(agentName);
  if (fs.existsSync(commPath)) {
    changes.commMd = 'updated';
    // (Always rewrite — content is fully derived from the slug.)
  } else {
    changes.commMd = 'created';
  }
  await fsp.writeFile(commPath, commContent, 'utf8');

  // Migrate any legacy global comm.md left behind by a pre-fix install.
  // Leaving it would mean two copies on disk; the @import we write below
  // points at the project-local one, so the global one is just dead state.
  const legacyComm = legacyBusCommMdPath(agentName);
  if (fs.existsSync(legacyComm)) {
    try {
      fs.unlinkSync(legacyComm);
    } catch {
      // Best-effort — a leftover file is harmless beyond clutter.
    }
  }

  // Note: inbox/archive dirs are NOT pre-created here — they live
  // per-session under `<workspace>/.cebab-session-<id>/inboxes/<agent>/`
  // and are created on demand by `writeInboxMessage` and the bus scripts
  // (which `mkdir -p` before writing).

  // 3. CLAUDE.md @import line. Pass the legacy absolute @import as a
  //    stale-line to strip on the way in, so re-installing over a pre-fix
  //    install migrates the line in place.
  const claudeMdPath = path.join(project.path, 'CLAUDE.md');
  changes.claudeMd = await ensureClaudeMdImport(claudeMdPath, importLineForProject(), [
    legacyImportLineFor(agentName),
  ]);

  // 4. .claude/settings.json.
  const settingsPath = path.join(project.path, '.claude', 'settings.json');
  changes.settingsJson = await mergeSettings(settingsPath, agentName);

  // 5. DB.
  changes.busRow =
    existingState.installed && existingState.agentName === agentName
      ? 'unchanged'
      : existingState.installed
        ? 'updated'
        : 'inserted';
  setProjectBusInstalled(projectId, true, agentName);

  return { agentName, changes };
}

export type UninstallResult = {
  agentName: string | null;
  changes: {
    claudeMd: 'removed' | 'absent';
    settingsJson: 'cleaned' | 'absent' | 'no-bus-entries';
    busRow: 'cleared' | 'unchanged';
  };
};

/**
 * Uninstall bus integration. Removes our `@import` line from CLAUDE.md and
 * unmerges our entries from `.claude/settings.json` (preserving operator
 * additions). Leaves bus directory state on disk (inboxes, archives, comm.md)
 * for debugging — uninstall is logical, not destructive.
 *
 * Safe to call when the project was never installed (everything is a no-op).
 */
export async function uninstallBusForProject(projectId: number): Promise<UninstallResult> {
  const project = getProject(projectId);
  if (!project) {
    throw new InstallError('project_not_found', `project ${projectId} not found`);
  }
  const state = getProjectBusState(projectId);
  const agentName = state.agentName;

  const result: UninstallResult = {
    agentName,
    changes: {
      claudeMd: 'absent',
      settingsJson: 'absent',
      busRow: 'unchanged',
    },
  };

  if (agentName) {
    const claudeMdPath = path.join(project.path, 'CLAUDE.md');
    // Strip both the new project-relative @import and the legacy absolute
    // one, so partial migrations clean up cleanly. Either alone counts
    // as a `removed` for the result.
    result.changes.claudeMd = await removeClaudeMdImport(claudeMdPath, [
      importLineForProject(),
      legacyImportLineFor(agentName),
    ]);

    // Remove the project-local comm.md and `.cebab/` dir (if empty).
    const projectComm = projectCommMdPath(project.path);
    if (fs.existsSync(projectComm)) {
      try {
        fs.unlinkSync(projectComm);
      } catch {
        // Best-effort.
      }
    }
    const cebabDir = projectCebabDir(project.path);
    if (fs.existsSync(cebabDir)) {
      try {
        if (fs.readdirSync(cebabDir).length === 0) fs.rmdirSync(cebabDir);
      } catch {
        // Best-effort; leaving a non-empty .cebab/ is the operator's call.
      }
    }

    // Clean up the legacy global comm.md too if it still exists, so
    // uninstalling fully closes out a pre-fix install.
    const legacyComm = legacyBusCommMdPath(agentName);
    if (fs.existsSync(legacyComm)) {
      try {
        fs.unlinkSync(legacyComm);
      } catch {
        // Best-effort.
      }
    }

    const settingsPath = path.join(project.path, '.claude', 'settings.json');
    result.changes.settingsJson = await unmergeSettings(settingsPath, agentName);
  }

  if (state.installed) {
    setProjectBusInstalled(projectId, false, null);
    result.changes.busRow = 'cleared';
  }
  return result;
}

// ---- helpers ----

export function chooseAgentName(
  projectName: string,
  projectId: number,
  excludingProjectId?: number,
): string {
  const slug = slugifyAgentName(projectName);
  if (!slug) {
    // Fall back to `agent-<id>` for projects whose names have no usable
    // characters (e.g. all-emoji folder names). Still must be valid.
    const fallback = `agent-${projectId}`;
    if (!isValidAgentName(fallback)) {
      throw new InstallError('agent_name_empty', `cannot derive agent name from "${projectName}"`);
    }
    return fallback;
  }
  // System sentinels (orchestrator, user, cebab) take precedence — a project
  // named "Orchestrator" gets bumped to `orchestrator-<id>` so it can't
  // shadow the routing agent. Same fallback shape as the collision path
  // below, so the operator's experience is consistent.
  if (RESERVED_AGENT_NAMES.has(slug)) {
    const candidate = `${slug}-${projectId}`;
    if (isAgentNameTaken(candidate, excludingProjectId)) {
      throw new InstallError(
        'agent_name_taken',
        `agent name "${slug}" is reserved and fallback "${candidate}" already in use`,
      );
    }
    return candidate;
  }
  if (isAgentNameTaken(slug, excludingProjectId)) {
    // Suffix with project id for uniqueness — operator can rename the
    // project later if they want a cleaner name (uninstall + reinstall).
    const candidate = `${slug}-${projectId}`;
    if (isAgentNameTaken(candidate, excludingProjectId)) {
      throw new InstallError(
        'agent_name_taken',
        `agent name "${slug}" (and fallback "${candidate}") already in use`,
      );
    }
    return candidate;
  }
  return slug;
}

/**
 * Append `importLine` to CLAUDE.md if not already present, and strip any
 * `staleLines` while we're at it. The stale-line list is how re-installing
 * over a pre-fix install migrates the @import: pass the legacy absolute
 * line in `staleLines`, the new project-relative line as `importLine`,
 * and one call swaps them in place.
 *
 * Return values:
 *   'already-present' — the new `importLine` was already there (whether
 *     or not stale lines were also stripped). Operator sees a clean no-op.
 *   'appended' — the new line was added (this is also what we return when
 *     a stale line was migrated to the new one).
 *
 * Match is exact-line on trimmed content: an `@<path>` line that exactly
 * equals one of ours (after trimming) is recognized; near-misses are left
 * alone for the operator to clean up.
 */
async function ensureClaudeMdImport(
  claudeMdPath: string,
  importLine: string,
  staleLines: readonly string[] = [],
): Promise<'appended' | 'already-present'> {
  let body = '';
  let existed = true;
  try {
    body = await fsp.readFile(claudeMdPath, 'utf8');
  } catch {
    existed = false;
  }
  const staleSet = new Set(staleLines.map((s) => s.trim()));
  const origLines = body.split('\n');
  const filteredLines =
    staleSet.size > 0 ? origLines.filter((l) => !staleSet.has(l.trim())) : origLines;
  const strippedStale = filteredLines.length !== origLines.length;
  const alreadyHas = filteredLines.some((l) => l.trim() === importLine);

  if (alreadyHas && !strippedStale) {
    return 'already-present';
  }

  let newBody = filteredLines.join('\n');
  if (!alreadyHas) {
    // Ensure a blank line before our import for readability when the file
    // has prior content; tolerate already-trailing newlines.
    let suffix = '';
    if (existed && newBody.length > 0 && !newBody.endsWith('\n')) suffix += '\n';
    if (existed && !/\n\n$/.test(newBody + suffix)) suffix += '\n';
    suffix += importLine + '\n';
    newBody += suffix;
  }

  await fsp.mkdir(path.dirname(claudeMdPath), { recursive: true });
  await fsp.writeFile(claudeMdPath, newBody, 'utf8');
  return alreadyHas ? 'already-present' : 'appended';
}

/**
 * Remove any of `importLines` from CLAUDE.md. Uninstall passes both the
 * new project-relative line and the legacy absolute line so partial
 * migrations (legacy line removed but new line never installed) clean
 * up cleanly.
 */
async function removeClaudeMdImport(
  claudeMdPath: string,
  importLines: readonly string[],
): Promise<'removed' | 'absent'> {
  let body: string;
  try {
    body = await fsp.readFile(claudeMdPath, 'utf8');
  } catch {
    return 'absent';
  }
  const removeSet = new Set(importLines.map((s) => s.trim()));
  const lines = body.split('\n');
  const filtered = lines.filter((l) => !removeSet.has(l.trim()));
  if (filtered.length === lines.length) return 'absent';
  await fsp.writeFile(claudeMdPath, filtered.join('\n'), 'utf8');
  return 'removed';
}

type SettingsShape = {
  env?: Record<string, string>;
  permissions?: { allow?: string[]; deny?: string[]; [k: string]: unknown };
  hooks?: { Stop?: HookEntry[]; [k: string]: unknown };
  [k: string]: unknown;
};
type HookEntry = {
  matcher?: string;
  hooks?: Array<{ type: string; command: string }>;
};

function bashAllowPatternFor(scriptPath: string): string {
  // Claude Code's permission pattern: Bash(<command-prefix>:*)
  return `Bash(${scriptPath}:*)`;
}

function ourStopHookFor(agentName: string): HookEntry {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `${path.join(busBinDir(), 'bus-check-inbox.sh')} ${agentName}`,
      },
    ],
  };
}

/**
 * Merge our entries into `.claude/settings.json`. Preserves all operator
 * content; only adds the bits we own (identified by paths under `busBinDir()`).
 * Returns 'created' on new file, 'updated' on additive merge, 'already-present'
 * if every entry was already there.
 */
async function mergeSettings(
  settingsPath: string,
  agentName: string,
): Promise<'created' | 'updated' | 'already-present'> {
  let raw = '';
  let existed = true;
  try {
    raw = await fsp.readFile(settingsPath, 'utf8');
  } catch {
    existed = false;
  }
  let settings: SettingsShape = {};
  if (existed && raw.trim().length > 0) {
    try {
      settings = JSON.parse(raw) as SettingsShape;
    } catch {
      // Corrupted JSON: refuse rather than clobber. The caller will see the
      // throw and can surface a wrapper_error to the UI.
      throw new Error(`refusing to overwrite invalid JSON at ${settingsPath}`);
    }
  }

  let changed = false;

  // env.BUS_AGENT_NAME
  settings.env = settings.env ?? {};
  if (settings.env.BUS_AGENT_NAME !== agentName) {
    settings.env.BUS_AGENT_NAME = agentName;
    changed = true;
  }

  // permissions.allow: add three Bash(...) patterns for the bus scripts.
  settings.permissions = settings.permissions ?? {};
  settings.permissions.allow = settings.permissions.allow ?? [];
  const wanted = SCRIPT_FILES.map((s) => bashAllowPatternFor(path.join(busBinDir(), s)));
  for (const w of wanted) {
    if (!settings.permissions.allow.includes(w)) {
      settings.permissions.allow.push(w);
      changed = true;
    }
  }

  // hooks.Stop: one entry that runs bus-check-inbox.sh <agent>.
  settings.hooks = settings.hooks ?? {};
  settings.hooks.Stop = settings.hooks.Stop ?? [];
  const ourCmd = ourStopHookFor(agentName).hooks![0]!.command;
  const hasOurHook = settings.hooks.Stop.some((e) =>
    (e.hooks ?? []).some((h) => h.command === ourCmd),
  );
  if (!hasOurHook) {
    settings.hooks.Stop.push(ourStopHookFor(agentName));
    changed = true;
  }

  if (!existed) {
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    return 'created';
  }
  if (!changed) return 'already-present';
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return 'updated';
}

/**
 * Remove our additions from `.claude/settings.json`, preserving everything
 * else. If the file no longer has any of our entries, returns 'no-bus-entries'.
 * If the file was missing, returns 'absent'.
 */
async function unmergeSettings(
  settingsPath: string,
  agentName: string,
): Promise<'cleaned' | 'absent' | 'no-bus-entries'> {
  let raw: string;
  try {
    raw = await fsp.readFile(settingsPath, 'utf8');
  } catch {
    return 'absent';
  }
  let settings: SettingsShape;
  try {
    settings = JSON.parse(raw) as SettingsShape;
  } catch {
    // Don't touch corrupted JSON on uninstall either.
    throw new Error(`refusing to edit invalid JSON at ${settingsPath}`);
  }

  let changed = false;

  // env.BUS_AGENT_NAME (only if it matches our agent — don't yank an
  // operator-set value).
  if (settings.env && settings.env.BUS_AGENT_NAME === agentName) {
    delete settings.env.BUS_AGENT_NAME;
    if (Object.keys(settings.env).length === 0) delete settings.env;
    changed = true;
  }

  // permissions.allow: drop entries pointing into our bin dir.
  const binPrefix = busBinDir() + path.sep;
  if (settings.permissions?.allow) {
    const before = settings.permissions.allow.length;
    settings.permissions.allow = settings.permissions.allow.filter(
      (p) => !p.includes(binPrefix) && !p.includes(busBinDir() + '/'),
    );
    if (settings.permissions.allow.length !== before) {
      changed = true;
    }
    if (settings.permissions.allow.length === 0) delete settings.permissions.allow;
    if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
  }

  // hooks.Stop: drop hook entries that reference our bus-check-inbox path.
  if (settings.hooks?.Stop) {
    const ourCmdPrefix = path.join(busBinDir(), 'bus-check-inbox.sh');
    const before = settings.hooks.Stop.length;
    settings.hooks.Stop = settings.hooks.Stop.map((entry) => {
      const hooks = (entry.hooks ?? []).filter((h) => !h.command.startsWith(ourCmdPrefix));
      return { ...entry, hooks };
    }).filter((entry) => (entry.hooks ?? []).length > 0);
    if (settings.hooks.Stop.length !== before) changed = true;
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  if (!changed) return 'no-bus-entries';
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return 'cleaned';
}
