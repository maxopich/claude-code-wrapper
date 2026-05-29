import type { ServerMsg } from '@cebab/shared';
import type { MutationRecord } from '../repo/multi_agent.js';
import { emit as emitNotification, type DispatcherEmitResult } from './dispatcher.js';

/**
 * Cluster F Phase D5+ (UI-D5+): fan a sticky safety notification when a
 * bus worker's mutation targets a path outside its project folder
 * (consultant-mode guardrail violation). Mirrors the
 * `maybeDispatchDangerousMutation` helper in shape — same dispatcher
 * call, same per-row dedupeKey, same null-return-on-no-signal contract.
 *
 * Why a separate helper from `maybeDispatchDangerousMutation`:
 *   - Dangerous mutations are about *what the tool does* (rm -rf, npm
 *     publish): a category derived from the tool input alone, regardless
 *     of where the agent lives.
 *   - Guardrail violations are about *where the tool targets*: an
 *     orthogonal axis (a `Write` to /tmp/scratch is `mutate` + violation;
 *     a `Bash rm -rf .` in cwd is `dangerous` + in-scope). Both signals
 *     can fire on the same mutation; they live in separate audit
 *     buckets (`mutation.dangerous` vs `guardrail.violation`).
 *
 * Severity: `warn`, not `danger`. The violation is informational —
 * the worker may have legitimately been instructed to mutate outside its
 * folder by the operator's prompt (the constraint is "unless the user
 * explicitly directs", which Cebab can't parse). `danger` is reserved
 * for things like `rm -rf /` where the verb itself is destructive.
 *
 * Invariants:
 *   - BE-1: dispatcher's safety path writes the `safety_audit` row
 *     BEFORE the envelope ships. If the audit write fails, the envelope
 *     is suppressed and the caller receives `{ ok: false }`.
 *   - BE-2: no recording-layer coalesce — every violation is its own
 *     audit row + envelope. The UI may dedupe by `dedupeKey` for `×N`
 *     badge display, but the audit + wire layer never do.
 *   - NR-2: this notification is ADDITIVE — the mutation row itself
 *     also carries the violation flag (persisted on
 *     `multi_agent_mutations.guardrail_violation_path` per migration
 *     021), so the badge in `MutationsDisclosure` survives R-A/R-B
 *     replay. The notification fires in addition for the operator-
 *     attention surface.
 *
 * Returns `null` for in-scope mutations (the common case) so call sites
 * can pass through every mutation without branching on the verdict.
 */
export function maybeDispatchGuardrailViolation(
  sessionId: string,
  mutation: MutationRecord,
  send: (msg: ServerMsg) => void,
): DispatcherEmitResult | null {
  if (mutation.guardrailViolationPath === null) return null;
  const violatedPath = mutation.guardrailViolationPath;
  const reason = mutation.guardrailReason ?? 'path_outside_cwd';
  return emitNotification(
    {
      class: 'safety',
      severity: 'warn',
      // Per-row dedupeKey — bursts of violations stay as distinct
      // toasts so the operator sees every one. The id is the
      // `multi_agent_mutations.id` row id; uniqueness is per-row by
      // construction.
      dedupeKey: `guardrail_violation:${sessionId}:${mutation.id}`,
      title: 'Out-of-scope mutation observed',
      message: `${mutation.agentName} ${mutation.toolName}: ${violatedPath}`,
      sessionId,
      action: {
        kind: 'open_logs',
        sessionId,
        rowAnchor: `mutation:${mutation.id}`,
      },
      reasonCode: `guardrail.${reason}`,
      auditKind: 'guardrail.violation',
      auditAgentId: mutation.agentName,
      auditPayload: {
        mutationId: mutation.id,
        toolName: mutation.toolName,
        summary: mutation.summary,
        // The verdict — what was targeted, what the agent's allowed
        // scope was at the time, and which reason-code keyword the
        // classifier returned.
        violatedPath,
        agentCwd: mutation.cwd,
        reasonCode: reason,
        filePath: mutation.filePath,
        toolUseId: mutation.toolUseId,
      },
    },
    send,
  );
}
