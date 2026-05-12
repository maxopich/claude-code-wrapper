import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config, resolvePath } from './config.js';
import { getSetting, setSetting } from './repo/settings.js';
import {
  listProjectPaths,
  listProjects,
  markProjectsMissingByPaths,
  upsertProject,
  type ProjectRow,
} from './repo/projects.js';

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
 */
export function setWorkspaceRoot(input: string): string {
  const resolved = resolvePath(input);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`directory not found: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`not a directory: ${resolved}`);
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
  let entries: string[];
  try {
    const dirents = await fsp.readdir(root, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
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
  };
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
