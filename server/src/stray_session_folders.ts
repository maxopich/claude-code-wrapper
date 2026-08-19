/**
 * Cebab-ws0.13 — find and remove the session folders ws0.8 left behind.
 *
 * Until Cebab-ws0.8, every multi-agent session wrote its artifact tree to
 * `<workspaceRoot>/.cebab-session-<id>/`. That move relocated NEW sessions to
 * `<dataDir>/sessions/<id>/` and deliberately did not migrate existing folders:
 * `<folder>/orchestrator` is a live agent cwd and the CLI keys its transcript
 * store on the absolute cwd, so relocating one orphans that session's resume
 * lineage. The consequence is that whatever accumulated before the move is
 * still sitting in the operator's projects directory.
 *
 * This module is the operator-driven cleanup for exactly those leftovers.
 *
 * WHY NOT IN `storage_stats.ts`, whose header says "Surface-ONLY". Half of this
 * IS a surface and would fit there — but the scan and the delete share the name
 * derivation, the stray/referenced classification, and the running-session
 * guard, and splitting them across two modules would mean the delete re-derives
 * what the scan already decided. Two derivations of one rule is how they drift.
 * The listing half stays read-only; the executor is explicitly the other thing.
 *
 * WHAT IT WILL NOT DELETE, and why that shrinks the problem. A folder still
 * referenced by a `multi_agent_sessions` row is listed — so its disk cost is
 * visible — but never deletable here. Removing a live session's artifacts is
 * what `archive_session { removeArtifacts: true }` already does, through a path
 * that also flips the row; doing it here would leave a row pointing at nothing.
 * So the blast radius is folders no database row knows about.
 */

import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ServerMsg, StraySessionFolder, StrayDeleteRefusal } from '@cebab/shared';
import { getDb } from './db.js';
import { appendSafetyAudit } from './notifications/safety_audit.js';
import { snapshotInFlight } from './runner/lifecycle.js';
import { resolveSessionFolderInside } from './safe_fs.js';
import { resolveWorkspaceRoot } from './workspace.js';

/**
 * The directory-name shape Cebab produced before ws0.8. Nothing creates this
 * any more — it is here so the leftovers can be found and removed, and it must
 * keep matching the historical spelling exactly.
 */
export const LEGACY_WORKSPACE_SESSION_PREFIX = '.cebab-session-';

/**
 * Caps on the walk. A workspace is the operator's own directory and can hold
 * anything, so an unbounded recursive size walk on a single-threaded server is
 * not acceptable — and the reply carries `truncated` rather than silently
 * reporting a short total, per the no-silent-caps rule.
 */
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_DEPTH = 12;

/**
 * `session_folder` values a row still points at, keyed for lookup by status.
 *
 * EVERY ROW CONTRIBUTES TWO KEYS: the stored path as written, and its realpath
 * when that resolves. Found by a test, and worth stating because the failure was
 * silent: the scan classifies by `path.join(workspaceRoot, name)` while the
 * delete classifies by the REALPATH the containment check returns, and on macOS
 * `/var` is a symlink to `/private/var`. The two derivations disagreed, so a
 * folder the scan correctly showed as referenced was deletable — the exact
 * "two derivations of one rule drift apart" failure this module's header says
 * it exists to avoid. Indexing both forms makes one lookup answer for both
 * callers regardless of which spelling they arrive with.
 */
function referencedFolders(): Map<string, string> {
  const rows = getDb()
    .prepare<[], { session_folder: string; status: string }>(
      'SELECT session_folder, status FROM multi_agent_sessions WHERE session_folder IS NOT NULL',
    )
    .all();
  const out = new Map<string, string>();
  for (const r of rows) {
    out.set(normalizeForCompare(r.session_folder), r.status);
    try {
      out.set(normalizeForCompare(fs.realpathSync(r.session_folder)), r.status);
    } catch {
      // The folder is gone, so the stored spelling is the only key there is.
    }
  }
  return out;
}

/** Windows path comparison is case-insensitive; `db.ts` folds the same way. */
function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Recursive size, bounded. Returns `null` once a cap is hit. */
async function dirSizeBytes(dir: string, budget: { entries: number }, depth = 0): Promise<number> {
  if (depth > MAX_SCAN_DEPTH) return 0;
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const ent of entries) {
    if (budget.entries-- <= 0) return total;
    const full = path.join(dir, ent.name);
    // Symlinks are neither file nor directory under `withFileTypes`, so they
    // are skipped rather than followed — the same reasoning `data_perms.ts`
    // gives for its own walk: following one would wander out of the tree.
    if (ent.isDirectory()) {
      total += await dirSizeBytes(full, budget, depth + 1);
    } else if (ent.isFile()) {
      try {
        total += (await fsp.stat(full)).size;
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return total;
}

/** Session id encoded in a legacy folder name, or null if it is not one. */
export function sessionIdFromLegacyName(name: string): string | null {
  if (!name.startsWith(LEGACY_WORKSPACE_SESSION_PREFIX)) return null;
  const id = name.slice(LEGACY_WORKSPACE_SESSION_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Is a run currently in flight for this session? */
function isRunning(sessionId: string): boolean {
  return snapshotInFlight().some((m) => m.sessionId === sessionId);
}

/**
 * List every legacy session folder directly under the workspace root.
 *
 * Read-only. Never throws — a workspace that has moved or become unreadable
 * reports zero folders rather than failing the Settings modal.
 */
export async function scanStraySessionFolders(): Promise<{
  workspaceRoot: string;
  folders: StraySessionFolder[];
  truncated: boolean;
}> {
  const workspaceRoot = resolveWorkspaceRoot();
  const budget = { entries: MAX_SCAN_ENTRIES };
  const refs = referencedFolders();
  const folders: StraySessionFolder[] = [];

  let entries;
  try {
    entries = await fsp.readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return { workspaceRoot, folders, truncated: false };
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sessionId = sessionIdFromLegacyName(ent.name);
    if (sessionId === null) continue;
    const full = path.join(workspaceRoot, ent.name);
    folders.push({
      name: ent.name,
      sizeBytes: await dirSizeBytes(full, budget),
      sessionStatus: refs.get(normalizeForCompare(full)) ?? null,
      running: isRunning(sessionId),
    });
  }

  folders.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { workspaceRoot, folders, truncated: budget.entries <= 0 };
}

export async function executeScanStraySessionFolders(io: {
  send: (msg: ServerMsg) => void;
}): Promise<void> {
  const result = await scanStraySessionFolders();
  io.send({ type: 'stray_session_folders', ...result });
}

/**
 * Delete the named folders, one at a time, reporting per-name outcomes.
 *
 * THE CLIENT SENDS NAMES, NEVER PATHS, and the root is re-derived here from
 * `resolveWorkspaceRoot()`. That single decision removes an entire class of
 * problem: no operator-supplied path reaches the filesystem, so
 * `resolveSessionFolderInside` only has to answer "is this name a real,
 * non-symlink, direct child".
 *
 * ORDERING, contrasted with `executeArchiveSession`. That one flips the DB row
 * BEFORE its `rm`, so a filesystem failure leaves "row archived, folder on
 * disk" (recoverable) rather than "folder gone, row live" (a zombie). Here
 * there is no row to flip — a stray has none by definition — so the ordering
 * question moves to the audit: the row is appended only AFTER a successful
 * removal. An audit entry claiming a deletion that never happened poisons a
 * hash-chained forensic record; a missing entry for one that did is a gap.
 * Prefer the gap.
 */
export async function deleteStraySessionFolders(names: string[]): Promise<{
  deleted: string[];
  failed: { name: string; reason: StrayDeleteRefusal; message: string }[];
  freedBytes: number;
}> {
  const workspaceRoot = resolveWorkspaceRoot();
  const refs = referencedFolders();
  const deleted: string[] = [];
  const failed: { name: string; reason: StrayDeleteRefusal; message: string }[] = [];
  let freedBytes = 0;

  for (const name of names) {
    const sessionId = sessionIdFromLegacyName(name);
    if (sessionId === null) {
      failed.push({ name, reason: 'bad_name', message: 'not a session folder name' });
      continue;
    }
    // Running beats everything, and is decided by what is actually in flight —
    // not by the DB row and not by the stored path, either of which can be
    // stale or point somewhere else after a workspace move.
    if (isRunning(sessionId)) {
      failed.push({ name, reason: 'running', message: 'this session is running right now' });
      continue;
    }
    const resolved = resolveSessionFolderInside(workspaceRoot, name);
    if (!resolved.ok) {
      failed.push({ name, reason: resolved.refusal, message: `refused: ${resolved.refusal}` });
      continue;
    }
    const status = refs.get(normalizeForCompare(resolved.path));
    if (status !== undefined) {
      failed.push({
        name,
        reason: 'referenced',
        message: `still belongs to a ${status} session — archive it instead`,
      });
      continue;
    }

    const size = await dirSizeBytes(resolved.path, { entries: MAX_SCAN_ENTRIES });
    try {
      await fsp.rm(resolved.path, { recursive: true, force: true });
    } catch (err) {
      failed.push({ name, reason: 'rm_failed', message: String(err) });
      continue;
    }
    deleted.push(name);
    freedBytes += size;
  }

  if (deleted.length > 0) {
    // Names and counts only — an audit row is append-only and survives session
    // deletion, so it must not embed the operator's home directory.
    appendSafetyAudit({
      ts: Date.now(),
      sessionId: null,
      parentSessionId: null,
      agentId: null,
      kind: 'session.stray_folders_deleted',
      reasonCode: 'operator_cleanup',
      payload: { names: deleted, count: deleted.length, freedBytes },
    });
  }

  return { deleted, failed, freedBytes };
}

export async function executeDeleteStraySessionFolders(
  names: string[],
  io: { send: (msg: ServerMsg) => void },
): Promise<void> {
  const result = await deleteStraySessionFolders(names);
  io.send({ type: 'stray_session_folders_deleted', ...result });
}
