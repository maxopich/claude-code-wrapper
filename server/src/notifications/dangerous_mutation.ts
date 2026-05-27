import type { ServerMsg } from '@cebab/shared';
import type { MutationRecord } from '../repo/multi_agent.js';
import { emit as emitNotification, type DispatcherEmitResult } from './dispatcher.js';

/**
 * Cluster A Phase 4 (UI-15, spec §3): fan a sticky safety notification on a
 * `dangerous`-category mutation. Returns the dispatcher result so the WS
 * layer can log on audit-write failure without owning the dispatcher contract
 * shape.
 *
 * Invariants:
 *  - BE-1: the dispatcher's safety path writes the audit row BEFORE the
 *    envelope ships. If the write fails, the envelope is suppressed and the
 *    caller receives `{ ok: false }`.
 *  - BE-2: no recording-layer coalesce — every dangerous mutation is its own
 *    `safety_audit` row and its own envelope. The UI may dedupe by
 *    `dedupeKey` for `×N` badge display, but the audit + wire layer never do.
 *  - NR-2: this notification is ADDITIVE — the `LogsButton` cumulative
 *    dangerous-count chip is unchanged. The chip's signal is cross-session;
 *    the toast is point-in-time for the current operator view.
 *
 * Returns `null` for non-dangerous mutations so call sites can pass through
 * every classification without branching.
 *
 * @see {@link maybeDispatchDangerousMutation.test.ts} for behavior tests.
 */
export function maybeDispatchDangerousMutation(
  sessionId: string,
  mutation: MutationRecord,
  send: (msg: ServerMsg) => void,
): DispatcherEmitResult | null {
  if (mutation.category !== 'dangerous') return null;
  return emitNotification(
    {
      class: 'safety',
      severity: 'danger',
      // Per-row dedupeKey — bursts of dangerous mutations stay as distinct
      // toasts so the operator sees every one (vs warn-tier operational
      // where dedupeKey would collapse a burst). The id is the
      // `multi_agent_mutations.id` row id.
      dedupeKey: `dangerous_mutation:${sessionId}:${mutation.id}`,
      title: 'Dangerous mutation observed',
      message: mutation.summary,
      sessionId,
      action: {
        kind: 'open_logs',
        sessionId,
        rowAnchor: `mutation:${mutation.id}`,
      },
      reasonCode: 'classifier_dangerous',
      auditKind: 'mutation.dangerous',
      auditAgentId: mutation.agentName,
      auditPayload: {
        mutationId: mutation.id,
        toolName: mutation.toolName,
        summary: mutation.summary,
        filePath: mutation.filePath,
        cwd: mutation.cwd,
        toolUseId: mutation.toolUseId,
      },
    },
    send,
  );
}
