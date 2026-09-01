/**
 * Cebab-m1f — remove a managed agent, the exit `Cebab-ws0.9` did not ship.
 *
 * A managed agent is a full snapshot at `<dataDir>/agents/<slug>/`, and a
 * second copy of a project is (by operator decision) a SECOND managed agent, so
 * without this the trees and their sidebar rows only ever accumulate. This is
 * the counterpart to `managed_copy.ts`, and a module for the same reason: the
 * BE-1 contract — append the hash-chained audit row BEFORE the consequential
 * act, and refuse the act if the append fails — is only a contract if a test
 * can make the append throw and then look at the filesystem, which a `case`
 * body inside `handleClientMsg` cannot offer.
 *
 * WHAT THE CONSEQUENTIAL ACT IS, AND WHY IT IS AUDITED HARDER THAN THE COPY.
 * The copy duplicates operator data; this DESTROYS it — the agent's tree, its
 * sessions, its events, and its per-session JSONL logs, none of which come
 * back. So the same audit-before-act gate the copy uses is if anything more
 * load-bearing here, and the same refusal applies: a failed append aborts with
 * NOTHING removed.
 *
 * THE THREE QUESTIONS `Cebab-m1f` LEFT OPEN, AND THE ANSWERS TAKEN.
 *
 *   - Sessions and events. A managed agent is an ordinary `projects` row and
 *     `sessions.project_id REFERENCES projects(id) ON DELETE CASCADE`, so the
 *     row's removal already destroys its conversations. "Mark it missing"
 *     leaves a row pointing at a directory that is gone — the sidebar shows a
 *     dead agent forever. An explicit operator delete is not that ambiguous
 *     case (a directory that vanished from under Cebab); it is the operator
 *     saying they are done with this agent, exactly as a session delete is. So
 *     the sessions and events go.
 *
 *   - The per-session JSONL logs. They live under `<dataDir>/logs/<id>.jsonl`,
 *     keyed by SESSION id rather than by project, so no cascade reaches them —
 *     they have to be removed by enumerating the project's sessions first,
 *     while the rows still exist to name them. Best-effort, exactly as the
 *     session purge treats them: a stray unlink failure must not strand the
 *     database delete that is the real state.
 *
 *   - The audit. Yes, and before the act — see above.
 *
 * WHY THE TREE COMES OUT FIRST. `removeManagedDir` is idempotent (`force:true`)
 * and by far the most likely step to fail — a recursive delete of a
 * gigabyte-scale tree can hit `EBUSY`/`EACCES` where a single `DELETE` cannot.
 * Doing it first and gating on its success means a failure leaves the DATABASE
 * fully intact and the operation retryable: the sidebar row is still there, and
 * a retry re-enters here and finishes the (partially) removed tree off. The
 * reverse order would risk the one outcome `Cebab-m1f` names as bad — a row
 * left pointing at nothing.
 *
 * WHY ONLY A MANAGED AGENT. `isManagedProjectPath` is the structural gate:
 * Cebab owns every byte under `managedAgentsRoot()` and nothing outside it, so
 * an ordinary workspace project is refused outright — its directory is the
 * operator's, and its row would reappear on the next scan regardless.
 * `removeManagedDir` re-checks containment itself, so the destructive step is
 * guarded twice by independent code.
 */

import type { ServerMsg } from '@cebab/shared/protocol';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { emit } from './notifications/dispatcher.js';
import { isManagedProjectPath, removeManagedDir } from './managed_agent.js';
import { deleteProject, getProject } from './repo/projects.js';
import { hardDeleteSession, listAllSessionIdsForProject } from './repo/sessions.js';
import { snapshotInFlight } from './runner/lifecycle.js';

export type ManagedDeleteResult = { removed: boolean };

/** The per-session JSONL log path — same shape `bulk_session_op.ts` uses. */
function jsonlPathFor(sessionId: string): string {
  return path.join(config.logsDir, `${sessionId}.jsonl`);
}

/**
 * Delete a managed agent: its tree, its sessions and events, and its logs.
 *
 * Returns `{ removed }` so the WS layer knows whether to re-emit the project
 * list (mirrors `runManagedCopy`'s `{ registered }`).
 */
export async function runManagedDelete(
  projectId: number,
  send: (msg: ServerMsg) => void,
): Promise<ManagedDeleteResult> {
  const fail = (error: string): ManagedDeleteResult => {
    send({ type: 'managed_delete_result', projectId, result: { ok: false, error } });
    return { removed: false };
  };

  const project = getProject(projectId);
  if (!project) return fail('that project no longer exists');

  // [security] STRUCTURAL GATE. Only a directory inside `managedAgentsRoot()`
  // can be torn down here; an ordinary workspace project is the operator's own
  // and is never touched. Path-based, so it cannot be fooled by a hand-edited
  // provenance column.
  if (!isManagedProjectPath(project.path)) {
    return fail('only a managed agent can be deleted — this is an ordinary workspace project');
  }

  const sessionIds = listAllSessionIdsForProject(projectId);

  // Refuse while anything is still running against this project — deleting the
  // tree and rows out from under a live turn would leave the run writing into
  // freed state. Matches `executeBulkSessionOp`'s running guard, and covers bus
  // runs too (their `agent_activity` carries `projectId`).
  const sessionSet = new Set(sessionIds);
  const running = snapshotInFlight().some(
    (m) => m.projectId === projectId || sessionSet.has(m.sessionId),
  );
  if (running) {
    return fail('this agent has a running session — Stop or End it first, then retry the delete');
  }

  // [security] AUDIT BEFORE THE ACT (BE-1). A failed append aborts with nothing
  // destroyed, exactly as the copy's does.
  const audit = emit(
    {
      class: 'safety',
      severity: 'warn',
      dedupeKey: `project.managed_delete_started:${projectId}:${project.path}`,
      title: 'Deleting a Cebab-managed agent',
      message: `${project.name} (${project.path})`,
      projectId,
      reasonCode: 'managed_delete_started',
      auditKind: 'project.managed_delete_started',
      auditPayload: {
        projectId,
        path: project.path,
        sourcePath: project.managed_source_path,
        sessions: sessionIds.length,
      },
      sticky: false,
    },
    send,
  );
  if (!audit.ok) {
    return fail(
      `could not record the delete in the audit log (${audit.error}); nothing was removed.`,
    );
  }

  // The tree first, gated on success — the most failure-prone step, and doing
  // it before any DB write keeps a failure fully recoverable (see header).
  try {
    await removeManagedDir(project.path);
  } catch (err: unknown) {
    return fail(
      `could not remove the agent's files (${String(err)}); nothing was removed from Cebab.`,
    );
  }

  // Now the database + the logs. `hardDeleteSession` clears each session's
  // events and its soft-FK dependents (notifications / forensics / recovery
  // log) that no cascade reaches; the JSONL log is a filesystem concern removed
  // best-effort, like the purge cron does.
  for (const sid of sessionIds) {
    try {
      await fsp.rm(jsonlPathFor(sid), { force: true });
    } catch (err) {
      console.error(`[managed_delete] rm log for ${sid} failed`, err);
    }
    try {
      hardDeleteSession(sid);
    } catch (err) {
      console.error(`[managed_delete] hardDeleteSession ${sid} failed`, err);
    }
  }

  // Drop the project row. The remaining cascades (multi_agent_sessions,
  // hook_trust) go with it.
  deleteProject(projectId);

  send({
    type: 'managed_delete_result',
    projectId,
    result: { ok: true, name: project.name, sessionsRemoved: sessionIds.length },
  });
  return { removed: true };
}
