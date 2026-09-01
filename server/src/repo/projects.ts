import type Database from 'better-sqlite3';
import { isSessionPermissionMode, type SessionPermissionMode } from '@cebab/shared/protocol';
import { getDb } from '../db.js';

export type ProjectRow = {
  id: number;
  name: string;
  path: string;
  trusted: number;
  missing: number;
  created_at: number;
  last_used_at: number | null;
  /** 1 if this project has had bus integration installed (PR 1). */
  bus_installed: number;
  /** Filesystem-safe agent slug captured at install time. NULL if not installed. */
  bus_agent_name: string | null;
  /**
   * Cluster G Phase 4 (D6/D11): one-shot TOFU decision for the bus
   * install. NULL means "never asked" (first-seen path emits
   * `bus_auto_install_pending` and blocks). 'trusted' / 'denied' are
   * persistent; revocation back to NULL is operator action through the
   * Authority Panel (parallel to mcp_trust revocation). Migration 024
   * backfills 'trusted' for any project that was already
   * `bus_installed=1` at the time the gate was added, so pre-gate users
   * aren't re-prompted for a bus that has been running for them.
   */
  bus_trust_decision: BusTrustDecision | null;
  /**
   * Cebab-ws0.3: the model this project's runs ask for, verbatim as the CLI
   * names it. NULL = no choice, and Cebab then omits `Options.model` entirely
   * rather than substituting a default string.
   */
  model: string | null;
  /**
   * Cebab-ws0.4: the permission mode this project's NEW sessions start in.
   * NULL = no choice, so the mode is derived from Trust exactly as it was
   * before this column existed.
   *
   * Typed `string | null` rather than `SessionPermissionMode | null` on
   * purpose: this is the raw column, and the DB has no CHECK constraint. The
   * narrowing happens at the read site (`resolveStartPermissionMode`), so a
   * hand-edited row is filtered rather than trusted into a spawn.
   */
  start_permission_mode: string | null;
  /**
   * Cebab-ws0.9: the project this one was copied FROM, for a managed agent.
   * NULL for every ordinary workspace project.
   *
   * PROVENANCE, NOT THE FLAG. "Is this managed?" is answered by
   * `isManagedProjectPath(row.path)` — structurally, from where the directory
   * sits — and never from this column. The missing-sweep exemption depends on
   * that answer, and a column can be hand-edited into granting one project
   * permanent immunity or stripping it from another. What this carries is what
   * the path cannot say: which project it came from, and (with `managed_copied_at`)
   * which of several copies of the same source this is.
   */
  managed_source_path: string | null;
  /** Epoch millis of the copy. NULL for every ordinary workspace project. */
  managed_copied_at: number | null;
  /**
   * Cebab-8x8.1.1: the fail-closed discriminator. 'workspace' for every
   * ordinary and managed project (the DEFAULT, backfilled onto every existing
   * row); 'assistant' for the single Cebab-owned help-assistant row. Read
   * POSITIVELY at every call site (`WHERE kind = 'workspace'`) so a non-workspace
   * row is excluded by default rather than by a path comparison that could
   * normalise wrong. `projects_kind_singleton` makes a second non-workspace row
   * impossible. `isAssistantProject` in `assistant/identity.ts` is the reader.
   */
  kind: string;
};

/**
 * The two decisions the operator can persist for the bus install gate.
 * 'deny_once' is in-memory only (cleared on WS disconnect), so it never
 * appears as a column value.
 */
export type BusTrustDecision = 'trusted' | 'denied';

/**
 * How many `name (n)` variants to try before giving up (register D16). Two
 * same-named folders is the realistic case; twenty is well past the point
 * where the operator has a naming problem rather than Cebab having a bug.
 */
const MAX_NAME_DISAMBIGUATION_TRIES = 20;

export function upsertProject(name: string, path: string): ProjectRow {
  const db = getDb();
  const existing = findProjectByPath(path);
  if (existing) {
    if (existing.missing === 1) {
      db.prepare('UPDATE projects SET missing = 0 WHERE id = ?').run(existing.id);
      return { ...existing, missing: 0 };
    }
    return existing;
  }
  const now = Date.now();
  const insert = db.prepare(
    'INSERT INTO projects (name, path, trusted, missing, created_at, last_used_at) VALUES (?, ?, 0, 0, ?, NULL)',
  );

  // Register D16: lookup is by `path`, but `projects.name` is UNIQUE
  // (001_init.sql). Two directories sharing a basename under DIFFERENT roots
  // therefore collide on INSERT. That is not exotic — repointing the workspace
  // root is a supported Settings action, and the old root's rows keep their
  // names. Within one scan a collision is impossible (`readdir` returns
  // siblings), so this is purely the cross-root case.
  //
  // The unguarded throw was not a one-time abort. `syncWorkspaceProjects` runs
  // on EVERY `list_projects`, so it re-hit the same row on every sidebar
  // refresh and the operator got a permanently empty sidebar plus a repeating
  // `process_crashed` — recoverable only by hand-editing SQLite. It also took
  // `markProjectsMissingByPaths` down with it, so the soft-delete bookkeeping
  // silently stopped.
  //
  // WHY NOT DROP THE UNIQUE. A table-level UNIQUE mints an implicit index
  // SQLite won't let us drop (the D09 lesson), so relaxing the constraint
  // means recreating `projects` — and `sessions.project_id REFERENCES
  // projects(id) ON DELETE CASCADE` makes that a real risk to an operator's
  // sessions. Nothing looks a project up by name; the column is display-only,
  // and a disambiguated name is arguably better than a duplicate — the
  // operator can tell the two folders apart in the sidebar.
  //
  // This is the mirror of D09 rather than a contradiction with it: there the
  // constraint was MISSING and belonged in the schema; here it exists and the
  // WRITER is what has to honour it. `upsertProject` is the only writer, so
  // the rule still has exactly one home.
  //
  // The suffix is stable across rescans: the path lookup above runs first, so
  // the next scan finds this row by path and never re-derives its name.
  for (let attempt = 1; attempt <= MAX_NAME_DISAMBIGUATION_TRIES; attempt++) {
    const candidate = attempt === 1 ? name : `${name} (${attempt})`;
    try {
      const result = insert.run(candidate, path, now);
      return getProject(Number(result.lastInsertRowid))!;
    } catch (err) {
      // Only the NAME collision is recoverable by renaming. A `path` collision
      // can't happen (we just looked it up) and anything else — a disk error,
      // a schema problem — is a real failure the caller must see.
      if (!isNameUniqueViolation(err)) throw err;
    }
  }
  throw new Error(
    `upsertProject: could not find a free name for ${JSON.stringify(path)} after ` +
      `${MAX_NAME_DISAMBIGUATION_TRIES} attempts starting from ${JSON.stringify(name)}`,
  );
}

/**
 * True for the specific `UNIQUE constraint failed: projects.name` error.
 * Matched on the message rather than on `err.code` because better-sqlite3
 * reports every uniqueness failure as `SQLITE_CONSTRAINT_UNIQUE` — including
 * a `projects.path` collision, which renaming would NOT fix and which would
 * spin this loop 20 times before surfacing the real problem.
 */
function isNameUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed:\s*projects\.name/i.test(err.message);
}

export function getProject(id: number): ProjectRow | undefined {
  return getDb().prepare<[number], ProjectRow>('SELECT * FROM projects WHERE id = ?').get(id);
}

export function findProjectByPath(path: string): ProjectRow | undefined {
  return getDb().prepare<[string], ProjectRow>('SELECT * FROM projects WHERE path = ?').get(path);
}

/**
 * Lists only the operator's workspace projects whose directories are still
 * present on disk.
 *
 * Cebab-8x8.1.3: `kind = 'workspace'` keeps the Cebab-owned help assistant
 * (`kind = 'assistant'`) out of every sidebar list — all six `type:'projects'`
 * emissions funnel through `syncWorkspaceProjects`, whose only exits return
 * this. Read POSITIVELY so a future non-workspace kind is excluded by default.
 * The assistant is reached by `getProject(id)` (the run path, replay and
 * interrupt), never by this list.
 */
export function listProjects(): ProjectRow[] {
  return getDb()
    .prepare<[], ProjectRow>(
      "SELECT * FROM projects WHERE missing = 0 AND kind = 'workspace' " +
        'ORDER BY last_used_at DESC NULLS LAST, name ASC',
    )
    .all();
}

export function markProjectsMissingByPaths(paths: string[]): void {
  if (paths.length === 0) return;
  const db = getDb();
  const stmt = db.prepare('UPDATE projects SET missing = 1 WHERE path = ?');
  db.transaction(() => {
    for (const p of paths) stmt.run(p);
  })();
}

/**
 * The inverse of `markProjectsMissingByPaths`: clear `missing` on any of these
 * paths whose row is currently marked missing (Cebab-ygu.12).
 *
 * An ordinary workspace project un-misses for free: a present directory is
 * re-seen by the scan and sent back through `upsertProject`, whose existing-row
 * branch runs the only other `SET missing = 0` (above). A managed agent never
 * reaches `upsertProject` on a plain sidebar refresh — the workspace scan
 * cannot see its path, so `syncWorkspaceProjects` exempts it from the sweep
 * instead — which left nothing to clear a managed row a *previous* scan had
 * marked missing. A managed directory that vanished for one scan (moved aside
 * by hand, or on an unmounted volume) therefore stayed filtered out of
 * `listProjects()` even after it was restored. This is what the exemption loop
 * now calls so both kinds recover symmetrically.
 *
 * The `AND missing = 1` guard keeps the common case (nothing was missing) from
 * writing to every present managed row on every scan.
 */
export function clearProjectsMissingByPaths(paths: string[]): void {
  if (paths.length === 0) return;
  const db = getDb();
  const stmt = db.prepare('UPDATE projects SET missing = 0 WHERE path = ? AND missing = 1');
  db.transaction(() => {
    for (const p of paths) stmt.run(p);
  })();
}

/**
 * The paths of the operator's workspace projects — the sole input to the
 * missing sweep in `syncWorkspaceProjects`.
 *
 * Cebab-8x8.1.3: `kind = 'workspace'` MUST match `listProjects`' filter. The
 * assistant's path is never in the workspace scan, so leaving it in this list
 * would let the sweep mark it `missing = 1` — a SILENT regression, since
 * `listProjects` already hides non-workspace rows, so nothing would look wrong
 * until the assistant button vanished on the next reload.
 */
export function listProjectPaths(): string[] {
  return getDb()
    .prepare<[], { path: string }>("SELECT path FROM projects WHERE kind = 'workspace'")
    .all()
    .map((r) => r.path);
}

/**
 * Cebab-ws0.3: which model a turn should ask for, or `undefined` for "don't ask".
 *
 * `undefined` — not a string — is the whole point. It is what makes `runClaude`
 * leave `Options.model` off the options object, which is what makes a project
 * nobody has configured spawn exactly as it did before this feature existed.
 * Returning a placeholder like `'default'` here would look equivalent and would
 * instead send the CLI a model id on every single turn.
 *
 * The catalogue's own "Default (recommended)" row also carries the literal
 * value `'default'`; the UI stores `null` when the operator picks it, so that
 * row and "never chose" converge here rather than diverging at the SDK.
 *
 * Deliberately NOT validated against the cached catalogue. That cache is one
 * CLI's answer at one moment; rejecting a value missing from it would break a
 * working project the moment it went stale, and the SDK is the authority on
 * whether a model exists.
 */
export function resolveModel(projectModel: string | null | undefined): string | undefined {
  if (typeof projectModel !== 'string') return undefined;
  const trimmed = projectModel.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Cebab-ws0.3. `null` clears the choice, which restores "whatever the CLI
 * picks" — not a model literally named `default`.
 *
 * No validation against the catalogue on purpose. The catalogue is a cache of
 * what one CLI reported at one moment; rejecting a value it does not currently
 * list would break a project the moment the cache went stale, and the SDK is
 * the authority on whether a model id is real.
 */
export function setProjectModel(id: number, model: string | null): void {
  getDb().prepare('UPDATE projects SET model = ? WHERE id = ?').run(model, id);
}

/**
 * Cebab-ws0.4. `null` clears the choice, restoring "derive from Trust".
 *
 * Callers are expected to have validated; this deliberately does not re-check,
 * because the guard that matters is on the READ (`resolveStartPermissionMode`).
 * A write-side check would protect the DB from Cebab, which is not the threat —
 * the threat is a value in the DB reaching a spawn unfiltered.
 */
export function setProjectStartPermissionMode(
  id: number,
  mode: SessionPermissionMode | null,
): void {
  getDb().prepare('UPDATE projects SET start_permission_mode = ? WHERE id = ?').run(mode, id);
}

/**
 * The starting mode a project asks for, or `undefined` for "derive from Trust".
 *
 * `undefined` — not a placeholder string — is what lets `seedPermissionMode`
 * fall through to its existing trust-derived branch untouched, which is the
 * "nothing changes for a project nobody configured" guarantee.
 *
 * FILTERS RATHER THAN TRUSTS. `projects.start_permission_mode` is plain TEXT
 * with no CHECK constraint (matching 004's column), so the value could be
 * anything a hand-edited database contains. `isSessionPermissionMode` is what
 * stops `'bypassPermissions'` — a real SDK mode Cebab deliberately never
 * exposes — from reaching a spawn through this path. An unrecognised value is
 * treated as no choice, not as an error: refusing to start a session because a
 * preference column is malformed would turn a cosmetic problem into an outage.
 */
export function resolveStartPermissionMode(
  raw: string | null | undefined,
): SessionPermissionMode | undefined {
  return isSessionPermissionMode(raw) ? raw : undefined;
}

/**
 * Register a completed managed copy (Cebab-ws0.9).
 *
 * `upsertProject` first, so a managed agent is an ORDINARY project row in every
 * respect — it inherits the name disambiguation, the path-uniqueness lookup and
 * the missing/unmissing behaviour that every other project has. Only then is
 * the provenance attached. Nothing downstream needs to know a project is
 * managed to work on it, which is the property the whole bead rests on.
 */
export function registerManagedProject(
  name: string,
  projectPath: string,
  sourcePath: string,
  copiedAt: number,
): ProjectRow {
  const row = upsertProject(name, projectPath);
  getDb()
    .prepare('UPDATE projects SET managed_source_path = ?, managed_copied_at = ? WHERE id = ?')
    .run(sourcePath, copiedAt, row.id);
  return getProject(row.id)!;
}

/**
 * Delete a project row outright (Cebab-m1f) and report whether a row went.
 *
 * The FK cascades do the dependent work: `sessions.project_id`,
 * `multi_agent_sessions.project_id` and `hook_trust.project_id` all carry
 * `ON DELETE CASCADE`, so their rows (and, through `sessions`, the `events`
 * that hang off them) go with the project in one statement.
 *
 * Only the managed-delete path calls this. The caller (`runManagedDelete`)
 * FIRST hard-deletes each single-agent session so the soft-FK dependents that
 * carry a bare `session_id` with no cascade — `notifications`,
 * `controllability_forensics`, `recovery_log` — are cleaned up too; a raw
 * project delete alone would leave those orphaned. `safety_audit` is append-only
 * and deliberately survives, exactly as it does across the session purge.
 */
export function deleteProject(id: number): number {
  return getDb().prepare('DELETE FROM projects WHERE id = ?').run(id).changes as number;
}

export function setProjectTrusted(id: number, trusted: boolean): void {
  getDb()
    .prepare('UPDATE projects SET trusted = ? WHERE id = ?')
    .run(trusted ? 1 : 0, id);
}

export function touchProject(id: number, db: Database.Database = getDb()): void {
  db.prepare('UPDATE projects SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * Cluster G Phase 4 (D6/D11): read the persisted bus-install trust decision.
 * Returns `null` for unknown projects (so callers don't need a second
 * existence check; a missing project will fail at the install step
 * anyway) and for projects that have never been asked.
 */
export function getProjectBusTrust(id: number): BusTrustDecision | null {
  const row = getDb()
    .prepare<[number], { bus_trust_decision: string | null }>(
      'SELECT bus_trust_decision FROM projects WHERE id = ?',
    )
    .get(id);
  if (!row) return null;
  if (row.bus_trust_decision === 'trusted' || row.bus_trust_decision === 'denied') {
    return row.bus_trust_decision;
  }
  return null;
}

/**
 * Cluster G Phase 4 (D6/D11): write the persisted bus-install trust decision.
 * Pass `null` to clear (operator revocation via the Authority Panel).
 * No-op for missing projects — the UPDATE silently matches 0 rows.
 */
export function setProjectBusTrust(id: number, decision: BusTrustDecision | null): void {
  getDb().prepare('UPDATE projects SET bus_trust_decision = ? WHERE id = ?').run(decision, id);
}

/**
 * The `AgentSpec` fragment carrying a bus participant's model (Cebab-ws0.3).
 *
 * Returns a SPREADABLE OBJECT rather than a `string | undefined`, so all three
 * `runner.register` sites — chain participants, the orchestrator's initial
 * workers, and a worker added mid-run — spread one identical expression. Three
 * hand-written `...(x ? {model: x} : {})` copies is three chances to write
 * `model: x` instead, and that mistake sends `undefined` to the SDK on every
 * bus turn while looking correct at each site.
 */
export function projectModelSpec(projectId: number): { model?: string } {
  const model = resolveModel(getProject(projectId)?.model);
  return model !== undefined ? { model } : {};
}
