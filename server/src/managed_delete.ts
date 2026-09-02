/**
 * Cebab-m1f — remove a managed agent: its tree, its sessions and events, and
 * its per-session JSONL logs.
 *
 * TWO RULES LIVE HERE because the code below depends on them directly. The
 * BE-1 contract: append the hash-chained audit row BEFORE the destructive act,
 * and refuse the act if the append fails. And the ORDER: the tree comes out
 * first, gated on success, so a failure leaves the database fully intact and
 * the operation retryable — the reverse order risks a row pointing at nothing,
 * which has no recovery.
 *
 * A module rather than a `case` body in `handleClientMsg` so a test can make
 * the audit append throw and then look at the filesystem.
 *
 * Why sessions and events go rather than being marked missing, why the JSONL
 * logs need enumerating first, and why containment is checked twice by
 * independent code: docs/managed-agents.md#deleting-a-managed-agent.
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
