/**
 * DB helpers for the multi-agent / bus runtime.
 *
 * These tables (multi_agent_sessions / _participants / _events) are completely
 * separate from the SDK-mode `sessions` table — they describe long-lived bus
 * sessions where persistent TUI agents talk via filesystem inboxes + tmux.
 *
 * Project-level bus state (`bus_installed`, `bus_agent_name`) also lives here
 * to keep all multi-agent-runtime concerns in one repo module.
 */
import { getDb } from '../db.js';

export type MultiAgentMode = 'chain' | 'orchestrator';
export type MultiAgentStatus = 'running' | 'completed' | 'stopped' | 'crashed';
export type ParticipantRole = 'orchestrator' | 'worker';
export type EventKind = 'intro' | 'prompt' | 'reply' | 'final' | 'error';

/**
 * Lifecycle mode for a multi-agent session.
 *
 *   - 'persistent' (default): the session folder under
 *     `<workspace>/.cebab-session-<id>/` survives End so the operator
 *     can resume later. Bus installs on participants stay in place.
 *   - 'temp': on End, the session folder is `rm -rf`'d AND bus
 *     installs are removed from each participant via
 *     `uninstallBusForProject`. Lets the operator run a one-off
 *     multi-agent task without leaving residue.
 */
export type MultiAgentLifecycle = 'persistent' | 'temp';

export type MultiAgentSessionRow = {
  id: string;
  mode: string; // narrowed to MultiAgentMode at the boundary; SQLite has no enums
  started_at: number;
  ended_at: number | null;
  status: string; // narrowed to MultiAgentStatus at the boundary
  tmux_session: string | null;
  /** Iteration directory id (e.g. `'042'`) for sessions started post-006.
   *  NULL for pre-006 rows that predate the column. */
  iteration_id: string | null;
  /** Absolute path to the per-session folder
   *  (`<workspace>/.cebab-session-<id>/`). NULL for pre-007 sessions that
   *  predate per-session folders — those used the global `~/.cebab/bus/`
   *  layout and resume falls back accordingly. */
  session_folder: string | null;
  /** 'persistent' or 'temp' — see `MultiAgentLifecycle`. Defaults
   *  to 'persistent' at the SQL layer for pre-007 rows. */
  lifecycle: string;
};

export type MultiAgentParticipantRow = {
  session_id: string;
  project_id: number;
  role: string; // ParticipantRole
  chain_order: number | null;
};

export type MultiAgentEventRow = {
  id: number;
  session_id: string;
  ts: number;
  source: string;
  destination: string;
  kind: string; // EventKind
  text: string;
};

// ---- sessions ----

export function createMultiAgentSession(
  id: string,
  mode: MultiAgentMode,
  tmuxSession: string | null = null,
  iterationId: string | null = null,
  sessionFolder: string | null = null,
  lifecycle: MultiAgentLifecycle = 'persistent',
): MultiAgentSessionRow {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO multi_agent_sessions
         (id, mode, started_at, ended_at, status, tmux_session, iteration_id, session_folder, lifecycle)
       VALUES (?, ?, ?, NULL, 'running', ?, ?, ?, ?)`,
    )
    .run(id, mode, now, tmuxSession, iterationId, sessionFolder, lifecycle);
  return getMultiAgentSession(id)!;
}

export function endMultiAgentSession(id: string, status: MultiAgentStatus): void {
  getDb()
    .prepare(`UPDATE multi_agent_sessions SET status = ?, ended_at = ? WHERE id = ?`)
    .run(status, Date.now(), id);
}

/**
 * Mutate the lifecycle of an existing multi-agent session row. Used by
 * the `set_multi_agent_lifecycle` WS handler so the operator can flip
 * persistent ↔ temp mid-run after seeing how a session is going. The
 * router holds an in-memory mirror that decides teardown behavior; this
 * row update is what lets a `resumeOrchestratorSession` after Cebab
 * restart pick up the latest value.
 */
export function setMultiAgentSessionLifecycle(id: string, lifecycle: MultiAgentLifecycle): void {
  getDb().prepare(`UPDATE multi_agent_sessions SET lifecycle = ? WHERE id = ?`).run(lifecycle, id);
}

export function getMultiAgentSession(id: string): MultiAgentSessionRow | undefined {
  return getDb()
    .prepare<[string], MultiAgentSessionRow>('SELECT * FROM multi_agent_sessions WHERE id = ?')
    .get(id);
}

/**
 * Returns the currently-running multi-agent session, if any. Per v1 design
 * there is at most one — we enforce this at the WS handler layer rather than
 * with a partial unique index (which SQLite supports but adds complexity).
 */
export function getActiveMultiAgentSession(): MultiAgentSessionRow | undefined {
  return getDb()
    .prepare<
      [],
      MultiAgentSessionRow
    >(`SELECT * FROM multi_agent_sessions WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`)
    .get();
}

export function listMultiAgentSessions(): MultiAgentSessionRow[] {
  return getDb()
    .prepare<
      [],
      MultiAgentSessionRow
    >('SELECT * FROM multi_agent_sessions ORDER BY started_at DESC')
    .all();
}

/**
 * Variant of `listMultiAgentSessions` that filters to rows with an
 * `iteration_id` — i.e. sessions started post-migration-006 — so the
 * iteration browser UI doesn't have to render "(no iteration recorded)"
 * placeholders for pre-006 rows. Callers that need every row regardless
 * can fall back to `listMultiAgentSessions`.
 */
export function listMultiAgentSessionsWithIteration(): MultiAgentSessionRow[] {
  return getDb()
    .prepare<[], MultiAgentSessionRow>(
      `SELECT * FROM multi_agent_sessions
        WHERE iteration_id IS NOT NULL
        ORDER BY started_at DESC`,
    )
    .all();
}

/**
 * Return the tmux session names of every currently-running multi-agent
 * row, filtering out any null entries (older rows that predate the
 * `tmux_session` column or were inserted without one).
 *
 * Used by the WS `clear_iterations` handler to compute the "protected" set
 * of tmux session names: anything matching `cebab-bus-*` that isn't in
 * this list is an orphan and gets killed when Clear runs.
 */
export function listRunningTmuxSessionNames(): string[] {
  return getDb()
    .prepare<[], { tmux_session: string | null }>(
      `SELECT tmux_session FROM multi_agent_sessions WHERE status = 'running'`,
    )
    .all()
    .map((r) => r.tmux_session)
    .filter((s): s is string => s !== null);
}

/**
 * Delete every multi-agent session whose status is NOT `'running'`, along
 * with all rows in `multi_agent_events` and `multi_agent_participants` that
 * reference them. Returns the number of session rows actually removed.
 *
 * Used by the WS `clear_iterations` handler to wipe the iterations browser
 * — the active session (if any) is preserved so a click on "Clear" can't
 * orphan a live run.
 *
 * The three deletes run inside a single SQLite transaction so we don't
 * end up with dangling events/participants on a partial failure. SQLite
 * has no FK ON DELETE CASCADE here (the original schema doesn't declare
 * foreign keys on these tables), so the deletes have to be explicit and
 * the order matters only insofar as we delete children before parents.
 *
 * Does NOT touch on-disk artifacts (`~/.cebab/bus/iterations/`, per-session
 * folders). Those are useful for post-mortem inspection and recreating them
 * isn't Cebab's job; the operator can wipe them manually.
 */
export function clearFinishedMultiAgentSessions(): number {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM multi_agent_events
        WHERE session_id IN (
          SELECT id FROM multi_agent_sessions WHERE status != 'running'
        )`,
    ).run();
    db.prepare(
      `DELETE FROM multi_agent_participants
        WHERE session_id IN (
          SELECT id FROM multi_agent_sessions WHERE status != 'running'
        )`,
    ).run();
    const info = db.prepare(`DELETE FROM multi_agent_sessions WHERE status != 'running'`).run();
    return info.changes;
  });
  return tx() as number;
}

// ---- participants ----

export function addParticipant(
  sessionId: string,
  projectId: number,
  role: ParticipantRole,
  chainOrder: number | null = null,
): void {
  getDb()
    .prepare(
      `INSERT INTO multi_agent_participants (session_id, project_id, role, chain_order)
       VALUES (?, ?, ?, ?)`,
    )
    .run(sessionId, projectId, role, chainOrder);
}

export function listParticipants(sessionId: string): MultiAgentParticipantRow[] {
  return getDb()
    .prepare<[string], MultiAgentParticipantRow>(
      `SELECT * FROM multi_agent_participants WHERE session_id = ?
        ORDER BY (chain_order IS NULL) ASC, chain_order ASC, project_id ASC`,
    )
    .all(sessionId);
}

/**
 * Same ordering as `listParticipants` but JOINs with `projects` so callers
 * who need resolved agent info (bus_agent_name, project name, path) don't
 * have to do two queries.
 *
 * Used by resume (to rebuild a `ResolvedAgent[]` from the DB after restart)
 * and by the iteration browser (to show participant slugs in the list).
 *
 * Filters out rows where the project has been deleted between session
 * start and now — resume can't operate on a missing project, and the
 * iteration browser would just show a dangling id. The session metadata
 * row is still listable; only the participant row is dropped from this
 * result.
 */
export type ResolvedParticipantRow = {
  session_id: string;
  project_id: number;
  role: string;
  chain_order: number | null;
  project_name: string;
  project_path: string;
  bus_agent_name: string | null;
};

export function listResolvedParticipants(sessionId: string): ResolvedParticipantRow[] {
  return getDb()
    .prepare<[string], ResolvedParticipantRow>(
      `SELECT
         p.session_id,
         p.project_id,
         p.role,
         p.chain_order,
         pr.name AS project_name,
         pr.path AS project_path,
         pr.bus_agent_name AS bus_agent_name
       FROM multi_agent_participants p
       JOIN projects pr ON pr.id = p.project_id
       WHERE p.session_id = ?
       ORDER BY (p.chain_order IS NULL) ASC, p.chain_order ASC, p.project_id ASC`,
    )
    .all(sessionId);
}

// ---- events ----

export function appendMultiAgentEvent(
  sessionId: string,
  source: string,
  destination: string,
  kind: EventKind,
  text: string,
): MultiAgentEventRow {
  const ts = Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO multi_agent_events (session_id, ts, source, destination, kind, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, ts, source, destination, kind, text);
  return getDb()
    .prepare<[number], MultiAgentEventRow>('SELECT * FROM multi_agent_events WHERE id = ?')
    .get(Number(info.lastInsertRowid))!;
}

export function listMultiAgentEvents(sessionId: string, sinceId = 0): MultiAgentEventRow[] {
  return getDb()
    .prepare<
      [string, number],
      MultiAgentEventRow
    >('SELECT * FROM multi_agent_events WHERE session_id = ? AND id > ? ORDER BY id ASC')
    .all(sessionId, sinceId);
}

// ---- project-level bus state ----

export type ProjectBusState = {
  installed: boolean;
  agentName: string | null;
};

export function getProjectBusState(projectId: number): ProjectBusState {
  const row = getDb()
    .prepare<
      [number],
      { bus_installed: number; bus_agent_name: string | null }
    >('SELECT bus_installed, bus_agent_name FROM projects WHERE id = ?')
    .get(projectId);
  if (!row) return { installed: false, agentName: null };
  return { installed: row.bus_installed === 1, agentName: row.bus_agent_name };
}

export function setProjectBusInstalled(
  projectId: number,
  installed: boolean,
  agentName: string | null,
): void {
  getDb()
    .prepare('UPDATE projects SET bus_installed = ?, bus_agent_name = ? WHERE id = ?')
    .run(installed ? 1 : 0, installed ? agentName : null, projectId);
}

/**
 * Reverse lookup: given a bus agent name, find the project. Used when the
 * bus log tailer sees `source: "<agent>"` and needs to attribute it back to
 * a project id for UI rendering.
 */
export function findProjectByBusAgentName(
  agentName: string,
): { id: number; name: string; path: string } | undefined {
  return getDb()
    .prepare<
      [string],
      { id: number; name: string; path: string }
    >('SELECT id, name, path FROM projects WHERE bus_agent_name = ? AND bus_installed = 1')
    .get(agentName);
}

/** True iff some project already claims this agent name. Used by install pre-check. */
export function isAgentNameTaken(agentName: string, excludingProjectId?: number): boolean {
  if (excludingProjectId === undefined) {
    const row = getDb()
      .prepare<
        [string],
        { c: number }
      >('SELECT COUNT(*) AS c FROM projects WHERE bus_agent_name = ?')
      .get(agentName);
    return (row?.c ?? 0) > 0;
  }
  const row = getDb()
    .prepare<
      [string, number],
      { c: number }
    >('SELECT COUNT(*) AS c FROM projects WHERE bus_agent_name = ? AND id != ?')
    .get(agentName, excludingProjectId);
  return (row?.c ?? 0) > 0;
}
