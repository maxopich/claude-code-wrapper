import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, resolvePath } from './config.js';
import { isManagedProjectPath } from './managed_agent.js';
import { canonical, isInside } from './path_containment.js';
import { ensureDataDir } from './data_perms.js';
import { getSetting, setSetting } from './repo/settings.js';
import {
  listProjectPaths,
  listProjects,
  markProjectsMissingByPaths,
  resolveStartPermissionMode,
  upsertProject,
  type ProjectRow,
} from './repo/projects.js';

/**
 * Re-exported so every existing caller and test keeps importing containment
 * from here; the definitions moved to `path_containment.js` when
 * `managed_agent.ts` needed them too and importing them back would have made a
 * cycle.
 */
export { isInside } from './path_containment.js';

const SETTING_KEY = 'workspace_root';

/** DB-stored workspace root wins over the env-var default. */
export function resolveWorkspaceRoot(): string {
  const stored = getSetting<string>(SETTING_KEY);
  if (typeof stored === 'string' && stored.length > 0) return resolvePath(stored);
  return config.workspaceRootDefault;
}

/** True iff the resolved workspace root exists and is a directory. */
export function workspaceRootValid(): boolean {
  try {
    const root = resolveWorkspaceRoot();
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Persist a new workspace root. Validates that the path resolves to an
 * existing directory; throws otherwise so the WS layer can return an error.
 *
 * Register H12: this used to be a bare `resolvePath` + `statSync`, so
 *
 *   - a non-string reached `expandHome`, where `p.startsWith('~')` threw a
 *     `TypeError` that surfaced to the operator as "the claude process
 *     crashed"; and
 *   - ANY existing directory was accepted, including `/` and `~`.
 *
 * The second one is the one that bites. The stored root drives
 * `syncWorkspaceProjects`, which `upsertProject`s every non-dot subdirectory —
 * so `/` turns `/System`, `/Library` and friends into agent projects, and `~`
 * does the same to `Documents`, `Downloads` and `Library`, each becoming a
 * `cwd` an agent can be pointed at. `~/agents` is the documented shape; a
 * container of projects, not a place that happens to contain some.
 *
 * NOT doing the register's "confirm with the operator" half: that is a new
 * modal round-trip, and these two refusals need no judgement call. Anything
 * broad-but-deliberate (`~/code`, `/opt/agents`) still goes through.
 */
export function setWorkspaceRoot(input: string): string {
  // Belt and braces with `ws/validate_client_msg.ts`, which now rejects a
  // non-string `set_workspace_root.path` at the wire. This function is
  // exported and callable without going through that boundary.
  if (typeof input !== 'string') throw new Error('workspace root must be a string');
  if (input.trim() === '') throw new Error('workspace root must not be empty');

  const resolved = resolvePath(input);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`directory not found: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`not a directory: ${resolved}`);

  const real = canonical(resolved);
  if (path.parse(real).root === real) {
    // Covers `/` on POSIX and `C:\` on Windows.
    throw new Error(`refusing the filesystem root as a workspace: ${resolved}`);
  }
  if (real === canonical(os.homedir())) {
    throw new Error(
      `refusing your home directory as a workspace: ${resolved} — every folder in it would become an agent project. Use a subdirectory such as ~/agents.`,
    );
  }
  // Cebab-ws0.8. `~/.cebab` holds the database, the logs, the bus dirs and —
  // since this change — every per-session folder. Pointing the workspace at it
  // would make Cebab scan its own state for the operator's projects.
  //
  // `ensureDataDir()` first, and the ordering is load-bearing: `canonical()`
  // falls back to its input when realpath fails. For the two refusals above
  // that fallback only makes the comparison stricter, but for a CONTAINMENT
  // check it makes it looser — an unresolved `/tmp/x/.cebab` compared against a
  // resolved `/private/tmp/x/.cebab/sessions` reads as "not inside" and would
  // be waved through. Making the directory exist removes that gap.
  ensureDataDir();
  const dataReal = canonical(config.dataDir);
  if (real === dataReal || isInside(dataReal, real)) {
    throw new Error(
      `refusing Cebab's own data directory as a workspace: ${resolved} — ${dataReal} holds the database, the logs and your session folders, so Cebab would scan its own state for your projects and every one of those would become an agent project. Point the workspace at where your projects live, such as ~/agents.`,
    );
  }

  setSetting(SETTING_KEY, resolved);
  return resolved;
}

/**
 * Scan the active workspace root for project subdirectories. Soft-deletes
 * (marks `missing = 1`) any DB rows whose directory has vanished. Returns the
 * post-scan list of present projects.
 */
export async function syncWorkspaceProjects(): Promise<ProjectRow[]> {
  const root = resolveWorkspaceRoot();
  // Cebab-ws0.8: the sidebar shows the operator's agents and nothing of Cebab's.
  // `setWorkspaceRoot` refuses the data dir outright, but it cannot catch a data
  // dir NESTED in the workspace under a non-dot name (`CEBAB_DATA_DIR=~/agents/
  // cebab-data`): the data dir is fixed at process start and the workspace can be
  // re-pointed at any time afterwards, so the refusal can be sequenced around.
  // The dot filter below misses it too, by construction. This is the check that
  // cannot be.
  const dataReal = canonical(config.dataDir);
  let entries: string[];
  try {
    const dirents = await fsp.readdir(root, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .filter((d) => {
        const full = canonical(path.join(root, d.name));
        return full !== dataReal && !isInside(dataReal, full);
      })
      .map((d) => d.name);
  } catch {
    // Root doesn't exist yet — nothing to scan, but don't crash either.
    return listProjects();
  }

  const seen = new Set<string>();
  for (const name of entries) {
    const full = path.join(root, name);
    upsertProject(name, full);
    seen.add(full);
  }
  // Cebab-ws0.9: a MANAGED agent lives in Cebab's data dir, so its path is never
  // in the scan above and the sweep below would soft-delete it on the very next
  // `list_projects` — which fires on every sidebar refresh. Silently, and for
  // every managed agent at once.
  //
  // The fix is not "skip managed rows". A managed agent whose directory the
  // operator deleted by hand SHOULD go missing, exactly as a workspace project
  // does; the sweep is right about it, it just has no scan to learn it from. So
  // each managed row answers for itself, and the two directions are separately
  // tested because getting either wrong looks like the feature working.
  for (const p of listProjectPaths()) {
    if (!isManagedProjectPath(p)) continue;
    if (fs.existsSync(p)) seen.add(p);
  }
  // Mark any DB rows whose directory has vanished.
  const missing = listProjectPaths().filter((p) => !seen.has(p));
  markProjectsMissingByPaths(missing);

  return listProjects();
}

export function rowToProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    trusted: row.trusted === 1,
    lastUsedAt: row.last_used_at,
    hasClaudeMd: hasClaudeMdAt(row.path),
    busInstalled: row.bus_installed === 1,
    busAgentName: row.bus_agent_name,
    model: row.model,
    startPermissionMode: resolveStartPermissionMode(row.start_permission_mode) ?? null,
    // The structural answer, which is what any gate must use. `managed` below
    // is provenance and additionally requires the columns — see the protocol's
    // note on why the two are not interchangeable.
    isManaged: isManagedProjectPath(row.path),
    managed: managedProvenance(row),
  };
}

/**
 * The provenance half of a managed agent, or null (Cebab-ws0.9).
 *
 * Gated on the STRUCTURAL predicate rather than on the columns, so a row that
 * carries a hand-written `managed_source_path` while sitting in the operator's
 * workspace does not get a badge claiming Cebab copied it. The columns are then
 * read for what the path cannot say.
 */
function managedProvenance(row: ProjectRow): { sourcePath: string; copiedAt: number } | null {
  if (!isManagedProjectPath(row.path)) return null;
  if (row.managed_source_path === null || row.managed_copied_at === null) return null;
  return { sourcePath: row.managed_source_path, copiedAt: row.managed_copied_at };
}

/**
 * True iff `<projectPath>/CLAUDE.md` exists. Synchronous `fs.existsSync` is
 * fine here — a single stat call, called once per project at projects-list
 * render time. On macOS APFS this is case-insensitive, so `Claude.md` and
 * `claude.md` match too without a separate check.
 */
function hasClaudeMdAt(projectPath: string): boolean {
  try {
    return fs.statSync(path.join(projectPath, 'CLAUDE.md')).isFile();
  } catch {
    return false;
  }
}
