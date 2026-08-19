/**
 * Cebab-ws0.4: set the permission mode a project's NEW sessions start in.
 *
 * WHY THIS IS A MODULE AND NOT A `case` BODY. The BE-1 dual-write contract —
 * append the hash-chained audit row BEFORE the state change, and refuse the
 * change if the append fails — is only a contract if something checks it. Its
 * closest sibling, `set_trusted`, lives inline in `handleClientMsg`'s switch,
 * which is module-private; the ordering there is asserted by nobody, and the
 * repo has exactly one behavioural test of this shape (`repo/mcp_trust.test.ts`
 * — "safety_audit failure leaves mcp_trust untouched"). Pulling the decision
 * out gives this one the same treatment: a spy can make the append throw and
 * then read the column.
 *
 * The WS layer keeps what belongs to it — replying with `wrapper_error` and
 * re-emitting the project list. What lives here is the part with an ordering
 * requirement.
 */
import type { ServerMsg, SessionPermissionMode } from '@cebab/shared/protocol';
import { emit } from './notifications/dispatcher.js';
import {
  getProject,
  resolveStartPermissionMode,
  setProjectStartPermissionMode,
} from './repo/projects.js';

export type ApplyStartModeResult =
  | { ok: true; from: SessionPermissionMode | null; to: SessionPermissionMode | null }
  | { ok: false; error: string };

/**
 * Audit, then write. Returns `{ ok: false }` without touching the column when
 * the audit append fails — the caller surfaces that and the operator's choice
 * does not silently half-land.
 */
export function applyProjectStartPermissionMode(
  projectId: number,
  mode: SessionPermissionMode | null,
  send: (msg: ServerMsg) => void,
): ApplyStartModeResult {
  const before = getProject(projectId);
  const from = resolveStartPermissionMode(before?.start_permission_mode) ?? null;

  // [security] AUDITED, unlike the neighbouring `set_project_model`. A model
  // choice cannot widen privilege; this sets the permission posture the next
  // session STARTS in, which is the first of the two reasons `set_trusted`'s
  // own comment gives for auditing a trust flip.
  //
  // Like `set_trusted`, this DETECTS rather than prevents: anything holding
  // the auth token can send the verb. A durable record is what is achievable.
  const audit = emit(
    {
      class: 'safety',
      severity: 'warn',
      dedupeKey: `project.start_mode_decided:${projectId}`,
      title:
        mode === null
          ? 'Project starting permission mode cleared'
          : `Project starts in ${mode === 'acceptEdits' ? 'auto-allow' : 'ask'} mode`,
      message: before ? `${before.name} (${before.path})` : `project ${projectId}`,
      projectId,
      reasonCode: 'project_start_mode_set',
      auditKind: 'project.start_mode_decided',
      auditPayload: { projectId, path: before?.path ?? null, from, to: mode },
      // The audit row is the record. A sticky toast per preference change is
      // noise the operator dismisses without reading.
      sticky: false,
    },
    send,
  );
  if (!audit.ok) return { ok: false, error: audit.error };

  setProjectStartPermissionMode(projectId, mode);
  return { ok: true, from, to: mode };
}
