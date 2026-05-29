/**
 * DB helpers for the multi-agent / bus runtime.
 *
 * These tables (multi_agent_sessions / _participants / _events) are completely
 * separate from the SDK-mode `sessions` table — they describe long-lived bus
 * sessions where each agent is its own in-process SDK `query()` exchanging
 * messages via the `bus_send` tool.
 *
 * Project-level bus state (`bus_installed`, `bus_agent_name`) also lives here
 * to keep all multi-agent-runtime concerns in one repo module.
 */
import type { RecoveryAgentEntry, RecoveryContextView } from '@cebab/shared/protocol';
import type { BashClassifierReason } from '@cebab/shared';
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
  /** 1 iff this session was reconstructed after a Cebab server restart and
   *  is re-attached READ-ONLY, waiting for the operator to explicitly
   *  continue (R-B conservative recovery). 0 for normal/pre-009 rows.
   *  Narrowed to boolean at the boundary; SQLite has no bool. */
  awaiting_continue: number;
  /** Pending-retry slot (Item #4, migration 010). All five are NULL together
   *  when no pending retry, all non-NULL together when a worker turn failed
   *  and the operator hasn't yet retried or abandoned. Narrowed to a
   *  `PendingRetry` value at the boundary via `getPendingRetry`. */
  pending_retry_agent: string | null;
  pending_retry_prompt: string | null;
  pending_retry_reason: string | null;
  pending_retry_ts: number | null;
  pending_retry_error_event_id: number | null;
  /** Item #5 (migration 011): opt-in pause-on-first-mutation flag. 1 if the
   *  operator enabled the setup-screen checkbox at session start. Narrowed
   *  to boolean at the boundary. */
  pause_on_mutation: number;
  /** Item #5: 1 once the operator has clicked Continue on a pause-on-mutation
   *  banner at least once during this session. Subsequent mutations
   *  auto-allow when this is 1. */
  mutations_acknowledged: number;
  /** Item #5: soft FK to `multi_agent_mutations.id` — the mutation row that
   *  caused the current pause. NULL when no pause active. Read by the WS
   *  `continue_through_mutation` handler to find which agent to re-deliver. */
  pending_mutation_id: number | null;
  /** PR-7 (migration 013): soft FK to the saved template id this run was
   *  started FROM. NULL for ad-hoc runs and for every pre-013 row (those
   *  sessions never recorded which template they came from). Used by the
   *  templates UI's "Last run" rail. */
  template_id: string | null;
  /** PR-7 (migration 013): the EFFECTIVE hop budget at session start
   *  (post-resolution). The rail renders `hops_used / hop_budget`; the
   *  router enforced this value during the run. NULL on pre-013 rows. */
  hop_budget: number | null;
  /** PR-7 (migration 013): final persisted hop count at teardown. NULL
   *  while the session is still running AND on pre-013 rows. The rail
   *  uses `hops_used === hop_budget` to derive the "at cap" yellow chip. */
  hops_used: number | null;
  /** PR-7 (migration 013): first operator-facing error text observed
   *  during the run, truncated to ~200 chars at write time. NULL when the
   *  run ended cleanly and on pre-013 rows. Surfaced as the
   *  "failed · <excerpt>" tail in the rail's red chip. */
  first_error: string | null;
  /** Cluster D Phase 1 (migration 017): 1 iff the operator has archived
   *  this session ("set aside, don't show in the default picker"). 0 for
   *  every pre-017 row and every freshly-created session. The Phase 5
   *  SweptSessionBanner's `[Archive]` action flips this to 1 via
   *  `archiveMultiAgentSession`; `list_archived_iterations` (later phase
   *  ClientMsg) is the only path that includes archived rows. */
  archived: number;
};

/**
 * Pending-retry descriptor: which worker's last turn failed, the bytes we
 * last delivered to it (post-briefing), the operator-facing reason, and a
 * pointer to the synthetic error event in the trail. See migration 010 for
 * column-level docs. Single slot per session — newest failure overwrites
 * the prior one if multiple workers fail in quick succession.
 */
export type PendingRetry = {
  agentName: string;
  prompt: string;
  reason: string;
  ts: number;
  errorEventId: number;
};

/**
 * One classified mutation observed on the bus (Item #5, migration 011). Rows
 * are appended by the bus runner's stream tap whenever it sees a `tool_use`
 * block on an assistant message whose classification is `'mutate'` or
 * `'dangerous'`. Read-only tool calls are NOT recorded — the table is
 * specifically the mutation inventory the operator asks for.
 */
export type MutationRecord = {
  id: number;
  sessionId: string;
  ts: number;
  agentName: string;
  toolName: string;
  category: 'mutate' | 'dangerous';
  summary: string;
  /** Migration 012: target file for Write/Edit/MultiEdit/NotebookEdit. NULL
   *  for everything else and for pre-012 rows. */
  filePath: string | null;
  /** Migration 012: agent cwd at mutation time, denormalized so the artifact
   *  classifier resolves filePath without a JOIN. NULL for pre-012 rows. */
  cwd: string | null;
  /** Migration 012: SDK `tool_use.id` of the originating block, so the
   *  matching `tool_result` can flip `confirmedAt`. Internal to the repo
   *  layer — not surfaced on the wire view. */
  toolUseId: string | null;
  /** Migration 012: wall-clock ms when the matching `tool_result` arrived,
   *  or NULL until then. NULL → provisional (UI badge). */
  confirmedAt: number | null;
  /** Phase E (migration 012): flipped by `classifyArtifact` when the file
   *  passes promotion globs. */
  promoted: boolean;
  /** Cluster F Phase D5+ (migration 021): when the mutation's resolved
   *  target path falls outside the agent's project folder (the consultant-
   *  mode guardrail), this carries the absolute resolved path AND a
   *  reason code (`'path_outside_cwd'` today; open-ended TEXT in the DB
   *  for future sub-cases without a migration). When in-scope (the
   *  common case) OR the tool has no file path (Bash, Task), both
   *  fields are NULL — the presence of `guardrailViolationPath` is the
   *  signal the UI reducer + safety_audit dispatcher gate on. */
  guardrailViolationPath: string | null;
  guardrailReason: string | null;
  /** Cluster F Phase F3 (migration 022): for Bash mutations, the
   *  classifier rule that pinned the category + the matched fragment.
   *  NULL for non-Bash mutations (the tool name is the rationale) and
   *  for rows from pre-022 sessions. Surfaced through to the wire view
   *  so `MutationsDisclosure` can render the rationale tooltip. */
  classifierReason: BashClassifierReason | null;
};

export type MultiAgentMutationRow = {
  id: number;
  session_id: string;
  ts: number;
  agent_name: string;
  tool_name: string;
  category: string; // narrowed to 'mutate'|'dangerous' at the boundary
  summary: string;
  // Migration 012 — nullable so rows from 011 still project. SQLite has no
  // boolean; `promoted` is INTEGER DEFAULT 0 in the schema and narrowed here.
  file_path: string | null;
  cwd: string | null;
  tool_use_id: string | null;
  confirmed_at: number | null;
  promoted: number;
  // Migration 021 — nullable; pre-021 rows project both as NULL.
  guardrail_violation_path: string | null;
  guardrail_reason: string | null;
  // Migration 022 — JSON-encoded BashClassifierReason; NULL for non-Bash
  // mutations and pre-022 rows.
  classifier_reason_json: string | null;
};

export type MultiAgentAgentSessionRow = {
  session_id: string;
  /** Bus slug (or 'orchestrator') — NOT a project id. */
  agent_name: string;
  /** Last completed claude CLI session id for `--resume` on reconstruction. */
  cli_session_id: string;
  updated_at: number;
};

export type MultiAgentParticipantRow = {
  session_id: string;
  project_id: number;
  role: string; // ParticipantRole
  chain_order: number | null;
  // Cluster C Phase 4a (Part 2 backend foundation): per-agent control state.
  // Added in migration 020. All fields default to "no control state ever
  // applied" so legacy rows + freshly-inserted participants both come out
  // active + unmuted + unpaused + not-kicked.
  muted: number; // 0 | 1
  paused_until: number | null; // epoch ms; NULL when not paused
  pause_expiry_action: string | null; // 'auto_resume' | 'auto_kick'
  kicked_at: number | null; // epoch ms; NULL when not kicked
  kicked_mode: string | null; // 'drain' | 'hard'
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
  iterationId: string | null = null,
  sessionFolder: string | null = null,
  lifecycle: MultiAgentLifecycle = 'persistent',
  /** PR-7: optional template provenance + effective hop budget at session
   *  start. Both are nullable in the row so callers that don't pass them
   *  (ad-hoc runs, the pre-PR-7 chain/orchestrator call sites that
   *  haven't been updated yet) keep working — the rail simply doesn't
   *  attribute those rows to any template. */
  opts: { templateId?: string | null; hopBudget?: number | null } = {},
): MultiAgentSessionRow {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO multi_agent_sessions
         (id, mode, started_at, ended_at, status, iteration_id, session_folder, lifecycle,
          template_id, hop_budget)
       VALUES (?, ?, ?, NULL, 'running', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      mode,
      now,
      iterationId,
      sessionFolder,
      lifecycle,
      opts.templateId ?? null,
      opts.hopBudget ?? null,
    );
  return getMultiAgentSession(id)!;
}

/**
 * PR-7: record final hops_used + (optional) first_error onto a row at
 * teardown time. Idempotent: a second call (e.g. on a doubled teardown
 * path) overwrites the prior values with the new ones, which is fine
 * because the teardown sequence is once-per-session-guarded upstream.
 *
 * `firstError` is truncated to 200 chars defensively even though the
 * caller is expected to truncate too — defence in depth keeps a
 * pathological "first error" string from bloating the row.
 */
export function recordSessionTeardown(
  id: string,
  opts: { hopsUsed: number; firstError?: string | null },
): void {
  const trimmedError =
    typeof opts.firstError === 'string' && opts.firstError.length > 0
      ? opts.firstError.slice(0, 200)
      : null;
  getDb()
    .prepare(
      `UPDATE multi_agent_sessions
          SET hops_used = ?, first_error = ?
        WHERE id = ?`,
    )
    .run(opts.hopsUsed, trimmedError, id);
}

/**
 * PR-7: SELECT the most-recent session row started from the given template
 * id, or `undefined` when no such row exists. Used by the templates UI's
 * "Last run" rail; the iteration directory + status enum are derived from
 * the row at the WS handler boundary.
 *
 * Sort by `started_at DESC` — the rail is "most recent attempt for this
 * template", not "most recent successful run". A failed run is still
 * informative.
 */
export function getLastRunForTemplate(templateId: string): MultiAgentSessionRow | undefined {
  return getDb()
    .prepare<[string], MultiAgentSessionRow>(
      `SELECT * FROM multi_agent_sessions
        WHERE template_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get(templateId);
}

export function endMultiAgentSession(id: string, status: MultiAgentStatus): void {
  getDb()
    .prepare(`UPDATE multi_agent_sessions SET status = ?, ended_at = ? WHERE id = ?`)
    .run(status, Date.now(), id);
}

/**
 * Flip a terminal row back to `running` for a manual re-attach. Inverse of
 * `endMultiAgentSession`. The caller MUST have already verified the session
 * is still live in the in-process registry; on a failed re-attach the caller
 * restores the prior terminal status so the `resumeOnConnect` sweep stays
 * consistent.
 */
export function reactivateMultiAgentSession(id: string): void {
  getDb()
    .prepare(`UPDATE multi_agent_sessions SET status = 'running', ended_at = NULL WHERE id = ?`)
    .run(id);
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

/**
 * Flip the conservative post-restart recovery flag. Set true when a session
 * is reconstructed after a Cebab server restart (R-B): the run is re-attached
 * read-only and stays paused until the operator continues. Set false the
 * moment the operator continues (or whenever a fresh turn is delivered), so
 * the iterations UI / a second reconnect see it as a normal live session.
 */
export function setAwaitingContinue(id: string, awaiting: boolean): void {
  getDb()
    .prepare(`UPDATE multi_agent_sessions SET awaiting_continue = ? WHERE id = ?`)
    .run(awaiting ? 1 : 0, id);
}

/**
 * Write (or clear) the pending-retry slot for a session in a single statement
 * — the five columns always move together. Pass `null` to clear. Used by:
 *   - `router.onWorkerFailed` when a worker's deliverTurn rejects, to persist
 *     enough state that the operator can come back later (even after a Cebab
 *     restart) and click Retry.
 *   - `handle.retry()` BEFORE re-delivering, so a racing second click sees
 *     the empty slot and no-ops.
 *   - `handle.stop` / `abandon_session` to keep the row clean on teardown.
 */
export function setPendingRetry(id: string, p: PendingRetry | null): void {
  if (p === null) {
    getDb()
      .prepare(
        `UPDATE multi_agent_sessions
            SET pending_retry_agent          = NULL,
                pending_retry_prompt         = NULL,
                pending_retry_reason         = NULL,
                pending_retry_ts             = NULL,
                pending_retry_error_event_id = NULL
          WHERE id = ?`,
      )
      .run(id);
    return;
  }
  getDb()
    .prepare(
      `UPDATE multi_agent_sessions
          SET pending_retry_agent          = ?,
              pending_retry_prompt         = ?,
              pending_retry_reason         = ?,
              pending_retry_ts             = ?,
              pending_retry_error_event_id = ?
        WHERE id = ?`,
    )
    .run(p.agentName, p.prompt, p.reason, p.ts, p.errorEventId, id);
}

/**
 * Read the pending-retry slot. Returns `null` when no failure is pending,
 * or a fully-populated `PendingRetry` when one is. Used by the WS
 * `retry_worker` handler (single source of truth — the client never sends
 * the agent name, the server reads it here) and by `emitResumedSession` to
 * hydrate the banner on R-A re-attach / R-B reconstruct.
 *
 * The five-columns invariant (all NULL or all non-NULL) is asserted in
 * principle by `setPendingRetry`; this getter treats any NULL as "no slot"
 * to be defensive about pre-010 rows that lack the columns entirely.
 */
export function getPendingRetry(id: string): PendingRetry | null {
  const row = getDb()
    .prepare<
      [string],
      {
        pending_retry_agent: string | null;
        pending_retry_prompt: string | null;
        pending_retry_reason: string | null;
        pending_retry_ts: number | null;
        pending_retry_error_event_id: number | null;
      }
    >(
      `SELECT pending_retry_agent, pending_retry_prompt, pending_retry_reason,
              pending_retry_ts, pending_retry_error_event_id
         FROM multi_agent_sessions WHERE id = ?`,
    )
    .get(id);
  if (!row) return null;
  if (
    row.pending_retry_agent === null ||
    row.pending_retry_prompt === null ||
    row.pending_retry_reason === null ||
    row.pending_retry_ts === null ||
    row.pending_retry_error_event_id === null
  ) {
    return null;
  }
  return {
    agentName: row.pending_retry_agent,
    prompt: row.pending_retry_prompt,
    reason: row.pending_retry_reason,
    ts: row.pending_retry_ts,
    errorEventId: row.pending_retry_error_event_id,
  };
}

// ---- Item #5: pause-on-mutation + mutation log helpers ----

function rowToMutation(row: MultiAgentMutationRow): MutationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ts: row.ts,
    agentName: row.agent_name,
    toolName: row.tool_name,
    category: row.category === 'dangerous' ? 'dangerous' : 'mutate',
    summary: row.summary,
    filePath: row.file_path,
    cwd: row.cwd,
    toolUseId: row.tool_use_id,
    confirmedAt: row.confirmed_at,
    promoted: row.promoted === 1,
    // Migration 021 — both NULL for in-scope mutations and for rows
    // appended before the runner wiring landed. Defensive `?? null` so
    // a project against an older DB (column missing entirely) doesn't
    // surface `undefined` to the projector callers.
    guardrailViolationPath: row.guardrail_violation_path ?? null,
    guardrailReason: row.guardrail_reason ?? null,
    // Migration 022 — JSON.parse the classifier reason if present; NULL
    // for non-Bash mutations and pre-022 rows. Parse failures (corrupt
    // value, schema drift) are swallowed → NULL: the rationale tooltip
    // is informational, never a correctness-critical signal.
    classifierReason: parseClassifierReason(row.classifier_reason_json),
  };
}

/**
 * Tolerant JSON.parse for the `classifier_reason_json` column. The shape
 * is enforced at write time, but a row written by an older binary OR a
 * row touched by `sqlite3` CLI edits could be malformed. Falling back to
 * `null` keeps the projector total — the worst the UI sees is "no
 * rationale", which is exactly the pre-022 fallback path.
 */
function parseClassifierReason(json: string | null): BashClassifierReason | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      if (typeof o.rule === 'string' && typeof o.detail === 'string' && typeof o.matched === 'string') {
        // Cast: BashClassifierRule is a string union, and the projector
        // doesn't need to validate the rule against the live enum —
        // protocol carries it as plain `string` deliberately.
        return { rule: o.rule as BashClassifierReason['rule'], detail: o.detail, matched: o.matched };
      }
    }
  } catch {
    // fall through to NULL
  }
  return null;
}

/**
 * Append a classified non-`read` tool call to `multi_agent_mutations`. Called
 * from the bus runner's stream tap (every assistant `tool_use` block whose
 * classifier output is `'mutate'` or `'dangerous'`). Returns the persisted
 * row so callers can wire `sink.onMutation` with the same shape they'd see
 * on R-A/R-B replay.
 *
 * `extra` carries the migration-012 fields. `filePath` is the target the
 * tool will write/edit (NULL for tools without one); `cwd` is the agent's
 * working directory at mutation time (so the artifact classifier in Phase E
 * can resolve `filePath` relative to the worktree root); `toolUseId` is the
 * SDK's `tool_use.id` so the matching `tool_result` can flip `confirmed_at`
 * later via `confirmMutationByToolUseId`.
 */
export function appendMultiAgentMutation(
  sessionId: string,
  agentName: string,
  toolName: string,
  category: 'mutate' | 'dangerous',
  summary: string,
  extra: {
    filePath: string | null;
    cwd: string | null;
    toolUseId: string | null;
    /** Cluster F Phase D5+ (migration 021): set when the bus runner's
     *  per-mutation scope classifier flagged this mutation as targeting
     *  a path outside the agent's project folder. Both fields are
     *  written together — never one without the other. */
    guardrailViolationPath?: string | null;
    guardrailReason?: string | null;
    /** Cluster F Phase F3 (migration 022): for Bash mutations, the
     *  rule that pinned the category + the matched fragment. Surfaced
     *  in the MutationsDisclosure badge tooltip. NULL for non-Bash
     *  mutations (the tool name is the rationale). JSON-encoded at the
     *  storage boundary; the projector parses it back. */
    classifierReason?: BashClassifierReason | null;
  },
): MutationRecord {
  const ts = Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO multi_agent_mutations
         (session_id, ts, agent_name, tool_name, category, summary,
          file_path, cwd, tool_use_id,
          guardrail_violation_path, guardrail_reason,
          classifier_reason_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      ts,
      agentName,
      toolName,
      category,
      summary,
      extra.filePath,
      extra.cwd,
      extra.toolUseId,
      extra.guardrailViolationPath ?? null,
      extra.guardrailReason ?? null,
      extra.classifierReason ? JSON.stringify(extra.classifierReason) : null,
    );
  const row = getDb()
    .prepare<[number], MultiAgentMutationRow>('SELECT * FROM multi_agent_mutations WHERE id = ?')
    .get(Number(info.lastInsertRowid))!;
  return rowToMutation(row);
}

/**
 * Flip a provisional mutation to confirmed: sets `confirmed_at = now()` on
 * the row whose `tool_use_id` matches the just-arrived `tool_result.tool_use_id`.
 * Returns the updated row (so the bus hook can re-emit `multi_agent_mutation`
 * — the wire reducer dedupes by `id` and the client sees the confirmation),
 * or NULL if no matching row exists (the result is for a tool we didn't
 * classify as a mutation, e.g. a `Read`, or for a pre-012 mutation that has
 * no `tool_use_id`). Idempotent: re-confirming an already-confirmed row
 * leaves `confirmed_at` unchanged (UPDATE WHERE confirmed_at IS NULL).
 */
export function confirmMutationByToolUseId(
  sessionId: string,
  toolUseId: string,
): MutationRecord | null {
  const now = Date.now();
  const info = getDb()
    .prepare(
      `UPDATE multi_agent_mutations
          SET confirmed_at = ?
        WHERE session_id = ? AND tool_use_id = ? AND confirmed_at IS NULL`,
    )
    .run(now, sessionId, toolUseId);
  if (info.changes === 0) {
    // Either no row (not a classified mutation, or pre-012) or already
    // confirmed. Fetch any matching row so an already-confirmed row still
    // round-trips its current state to the caller for a sanity re-emit.
    const row = getDb()
      .prepare<
        [string, string],
        MultiAgentMutationRow
      >('SELECT * FROM multi_agent_mutations WHERE session_id = ? AND tool_use_id = ?')
      .get(sessionId, toolUseId);
    return row ? rowToMutation(row) : null;
  }
  const row = getDb()
    .prepare<
      [string, string],
      MultiAgentMutationRow
    >('SELECT * FROM multi_agent_mutations WHERE session_id = ? AND tool_use_id = ?')
    .get(sessionId, toolUseId);
  return row ? rowToMutation(row) : null;
}

/**
 * Phase E: flip a row's `promoted` flag. Returns the updated row, or null
 * when the id doesn't exist. Idempotent — re-promoting an already-promoted
 * row is a no-op SQL-wise. The orchestrator/chain hook runs the artifact
 * classifier after confirmation and calls this when the row passes the
 * promotion globs.
 */
export function setMutationPromoted(id: number, value: boolean): MutationRecord | null {
  getDb()
    .prepare(`UPDATE multi_agent_mutations SET promoted = ? WHERE id = ?`)
    .run(value ? 1 : 0, id);
  return getMultiAgentMutation(id);
}

/**
 * List every mutation for a session, ordered by `ts` ascending. Used by:
 *   - `emitResumedSession` to populate `multi_agent_started.mutations` on
 *     R-A re-attach and R-B reconstruct.
 *   - The WS handler for clients that need a one-shot fetch.
 */
export function listMultiAgentMutations(sessionId: string): MutationRecord[] {
  return getDb()
    .prepare<
      [string],
      MultiAgentMutationRow
    >(`SELECT * FROM multi_agent_mutations WHERE session_id = ? ORDER BY ts ASC, id ASC`)
    .all(sessionId)
    .map(rowToMutation);
}

/** Resolve a single mutation row by id; returns `null` if missing. */
export function getMultiAgentMutation(id: number): MutationRecord | null {
  const row = getDb()
    .prepare<[number], MultiAgentMutationRow>('SELECT * FROM multi_agent_mutations WHERE id = ?')
    .get(id);
  return row ? rowToMutation(row) : null;
}

/** Persist the operator's setup-screen pause-on-mutation choice. Idempotent. */
export function setPauseOnMutation(sessionId: string, value: boolean): void {
  getDb()
    .prepare(`UPDATE multi_agent_sessions SET pause_on_mutation = ? WHERE id = ?`)
    .run(value ? 1 : 0, sessionId);
}

/** Flip `mutations_acknowledged`. Idempotent. Called from the WS
 *  `continue_through_mutation` handler when the operator clicks Continue. */
export function setMutationsAcknowledged(sessionId: string, value: boolean): void {
  getDb()
    .prepare(`UPDATE multi_agent_sessions SET mutations_acknowledged = ? WHERE id = ?`)
    .run(value ? 1 : 0, sessionId);
}

/**
 * Set or clear the pending-mutation slot. Pass `null` to clear. Mirrors
 * `setPendingRetry`'s API (PR #71). The mutation row referenced by `id`
 * must already be persisted (the bus tap calls `appendMultiAgentMutation`
 * first, then this) so the soft FK always resolves.
 */
export function setPendingMutation(sessionId: string, mutationId: number | null): void {
  getDb()
    .prepare(`UPDATE multi_agent_sessions SET pending_mutation_id = ? WHERE id = ?`)
    .run(mutationId, sessionId);
}

/**
 * Read the pending-mutation slot, resolving the soft FK to a full
 * `MutationRecord`. Returns `null` when no pause is active OR when the
 * referenced row is missing (defensive — e.g. after a manual `clear_iterations`
 * race; treat as "no pause" rather than throwing).
 */
export function getPendingMutation(sessionId: string): MutationRecord | null {
  const row = getDb()
    .prepare<
      [string],
      { pending_mutation_id: number | null }
    >('SELECT pending_mutation_id FROM multi_agent_sessions WHERE id = ?')
    .get(sessionId);
  if (!row || row.pending_mutation_id === null) return null;
  return getMultiAgentMutation(row.pending_mutation_id);
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
 *
 * Cluster D Phase 1 (migration 017): excludes archived rows by default
 * — the iteration browser is the operator's everyday picker and swept-
 * then-archived sessions are visible noise there. The
 * `list_archived_iterations` ClientMsg (later phase) calls
 * `listMultiAgentSessionsWithIteration({ includeArchived: true })` to
 * surface them on demand.
 */
export function listMultiAgentSessionsWithIteration(opts?: {
  includeArchived?: boolean;
}): MultiAgentSessionRow[] {
  const includeArchived = opts?.includeArchived === true;
  if (includeArchived) {
    return getDb()
      .prepare<[], MultiAgentSessionRow>(
        `SELECT * FROM multi_agent_sessions
          WHERE iteration_id IS NOT NULL
          ORDER BY started_at DESC`,
      )
      .all();
  }
  return getDb()
    .prepare<[], MultiAgentSessionRow>(
      `SELECT * FROM multi_agent_sessions
        WHERE iteration_id IS NOT NULL AND archived = 0
        ORDER BY started_at DESC`,
    )
    .all();
}

/**
 * Cluster D Phase 1 (spec §6.4 / BE-D22): flip a multi-agent session's
 * `archived` column to 1. Used by the Phase 5 `archive_session`
 * ClientMsg handler; idempotent (UPDATE-by-id on a row that's already
 * archived is a 0-row UPDATE, returns false).
 *
 * Does NOT touch on-disk artifacts (per BE-D23, the `removeArtifacts`
 * flag is set at the handler level, not in this helper). The handler
 * deletes the per-session folder after this row update succeeds, and
 * only when the operator explicitly opted in.
 *
 * Returns true if the update flipped a 0→1; false when the row was
 * already archived or doesn't exist.
 */
export function archiveMultiAgentSession(id: string): boolean {
  const result = getDb()
    .prepare<
      [string],
      unknown
    >('UPDATE multi_agent_sessions SET archived = 1 WHERE id = ? AND archived = 0')
    .run(id);
  return result.changes > 0;
}

/**
 * Inverse of `archiveMultiAgentSession`. Mostly for tests + a future
 * "unarchive" affordance (not in v1 scope; the spec ships archive as
 * one-way for simplicity, but the data model supports reversal).
 */
export function unarchiveMultiAgentSession(id: string): boolean {
  const result = getDb()
    .prepare<
      [string],
      unknown
    >('UPDATE multi_agent_sessions SET archived = 0 WHERE id = ? AND archived = 1')
    .run(id);
  return result.changes > 0;
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
 * The four deletes run inside a single SQLite transaction so we don't
 * end up with dangling events/participants/agent-sessions on a partial
 * failure. The original tables (005) declare no foreign keys, so their
 * deletes must be explicit; `multi_agent_agent_sessions` (009) does declare
 * ON DELETE CASCADE, but it's deleted explicitly too for symmetry. Order
 * matters only insofar as we delete children before parents.
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
    db.prepare(
      `DELETE FROM multi_agent_agent_sessions
        WHERE session_id IN (
          SELECT id FROM multi_agent_sessions WHERE status != 'running'
        )`,
    ).run();
    db.prepare(
      `DELETE FROM multi_agent_mutations
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

// ---- per-agent CLI sessions (R-B reconstruction) ----

/**
 * Record an agent's latest completed claude CLI session id. Upsert on the
 * composite PK so each agent has exactly one row per bus session, always the
 * most recent. Called from `AgentRunner` (via the injected `onSessionId`
 * dep) the instant the in-memory map is mutated, so the persisted value is
 * always the checkpoint a post-restart `--resume` would rewind to.
 */
export function upsertAgentSession(
  sessionId: string,
  agentName: string,
  cliSessionId: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO multi_agent_agent_sessions
         (session_id, agent_name, cli_session_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, agent_name)
       DO UPDATE SET cli_session_id = excluded.cli_session_id,
                     updated_at     = excluded.updated_at`,
    )
    .run(sessionId, agentName, cliSessionId, Date.now());
}

/** Every persisted (agent_name → cli_session_id) for a session, used to
 *  seed `AgentRunner.sessions` on reconstruction. */
export function listAgentSessions(sessionId: string): MultiAgentAgentSessionRow[] {
  return getDb()
    .prepare<
      [string],
      MultiAgentAgentSessionRow
    >('SELECT * FROM multi_agent_agent_sessions WHERE session_id = ?')
    .all(sessionId);
}

/**
 * Item #7: compute per-agent recovery state from existing rows. Returns null
 * when the session has no persisted events (degenerate; should not occur on a
 * real awaiting-continue session).
 *
 * Heuristic: an agent X is "possibly interrupted" iff
 *   max(multi_agent_events.ts WHERE source=X) > (multi_agent_agent_sessions.updated_at WHERE agent_name=X ?? 0)
 * Because `upsertAgentSession` is called the instant the SDK emits a successful
 * `result` (server/src/bus/runner.ts), any post-checkpoint event by definition
 * belongs to a turn that hadn't yet reached `result` when Cebab died. False
 * negatives are not possible by construction; rare false positives (a clean
 * turn whose checkpoint write lost the race) are tolerable — the disclosure's
 * "may have unfinished turns" framing carries the uncertainty.
 *
 * Excludes synthetic sources 'cebab' (Foundation's `forwardCebabEvent` +
 * bypassed F3 writes from the routers) and '_sink' (chain terminal). They
 * are not SDK-driven agents and have no checkpoint row. If a future synthetic
 * source is added, it must be appended to SYNTHETIC.
 */
const RECOVERY_SYNTHETIC_SOURCES: ReadonlySet<string> = new Set(['cebab', '_sink']);

export function computeRecoveryContext(sessionId: string): RecoveryContextView | null {
  const events = listMultiAgentEvents(sessionId);
  if (events.length === 0) return null;
  const checkpoints = listAgentSessions(sessionId);
  const checkpointBy = new Map<string, number>(
    checkpoints.map((c) => [c.agent_name, c.updated_at]),
  );
  const lastEventBy = new Map<string, number>();
  // `staleSinceTs` is max(ts) across ALL events (including synthetic) — it
  // anchors "last persisted activity" in the disclosure regardless of who
  // emitted it. `listMultiAgentEvents` returns rows in id-ascending order
  // (insertion order), which equals ts order in production but not in tests
  // where rows can be back-dated, so we compute the max explicitly.
  let staleSinceTs = 0;
  for (const ev of events) {
    if (ev.ts > staleSinceTs) staleSinceTs = ev.ts;
    if (RECOVERY_SYNTHETIC_SOURCES.has(ev.source)) continue;
    const prev = lastEventBy.get(ev.source);
    if (prev === undefined || ev.ts > prev) lastEventBy.set(ev.source, ev.ts);
  }
  const reconstructedAtTs = Date.now();
  const interruptedAgents: RecoveryAgentEntry[] = [];
  for (const [agentName, lastEventTs] of lastEventBy) {
    const lastCheckpointTs = checkpointBy.get(agentName) ?? null;
    if (lastEventTs > (lastCheckpointTs ?? 0)) {
      interruptedAgents.push({ agentName, lastEventTs, lastCheckpointTs });
    }
  }
  interruptedAgents.sort((a, b) => b.lastEventTs - a.lastEventTs);
  return { staleSinceTs, reconstructedAtTs, interruptedAgents };
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
