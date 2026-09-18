/**
 * Cebab-vie.21: record the execute-mode GRANT, and make it fail closed.
 *
 * Execute mode is the per-session opt-in that flips a bus session's prompt
 * renderers from the consultant clause ("read, analyse, advise; do not mutate
 * unless the operator explicitly asked") to permission for each participant to
 * write inside its own project folder. It is the operator's BROADEST
 * multi-agent permission grant — and until this module it was the one such
 * grant with no tamper-evident record: `setExecuteMode` is a raw column write,
 * and its two call sites (`startOrchestratorSession`, `startChainSession`) each
 * caught a persist failure, logged it, and let the session PROCEED IN EXECUTE
 * MODE with the row reading 0 — the privilege live and the record denying it.
 *
 * The narrower siblings already show the shape: `project.start_mode_decided`
 * (`project_start_mode.ts`) and the trust flip both write a hash-chained
 * `safety_audit` row BEFORE the state change and refuse the change if the
 * append fails (spec BE-1). This gives the grant the same treatment.
 *
 * WHAT "REFUSE THE GRANT" MEANS HERE: downgrade the session to consultant, do
 * NOT abort the session start. The callers are `start*Session` functions that
 * have already created the session row, added participants and prepared the
 * iteration directory; letting a throw escape would leave that half-created
 * state behind AND register a live session. Returning `granted: false` instead
 * leaves the column at its DEFAULT 0, `handle.executeMode` false, and every
 * renderer emitting the consultant clause — so the record and the privilege
 * agree on the safe side. (One asymmetry is deliberate and cannot be avoided:
 * `emit` appends the audit row before it sends/persists the WS envelope, and
 * those later steps sit outside its try — so a failure THERE yields
 * `granted: false` with a row already reading `to: true`. The record may
 * OVER-state the grant; it can never under-state it.)
 *
 * WHY A MODULE AND NOT TWO INLINE COPIES: the orchestrator and chain grant
 * sites were byte-equivalent `if (opts.executeMode) { try {…} catch {…} }`
 * blocks that had already drifted (the chain copy was added a release later).
 * One decision, one place a spy can make the append throw and then read the
 * column.
 */
import type { ServerMsg } from '@cebab/shared/protocol';
import { emit } from '../notifications/dispatcher.js';
import { setExecuteMode } from '../repo/multi_agent.js';

export type ExecuteModeGrantMode = 'orchestrator' | 'chain';

export type ExecuteModeGrantInput = {
  sessionId: string;
  mode: ExecuteModeGrantMode;
  /**
   * The projects whose files agents in this session may now write. This is the
   * blast radius, and it belongs in the audit payload — the sibling it copies
   * (`project.start_mode_decided`) records its target project + path, so a grant
   * row that named only the session id would be strictly weaker than the
   * narrower decision whose asymmetry is this bead's whole argument.
   */
  projects: Array<{ projectId: number; agentName: string }>;
};

export type ExecuteModeGrantResult = { granted: boolean; error?: string };

/**
 * Audit, then write. Returns `{ granted: false }` — WITHOUT flipping the
 * column — whenever the grant cannot be recorded, which downgrades the session
 * to consultant. `setExecuteMode` is wrapped too: a throw from that UPDATE must
 * not escape into the caller's session-start path.
 */
export function applyExecuteModeGrant(
  input: ExecuteModeGrantInput,
  send: (msg: ServerMsg) => void,
): ExecuteModeGrantResult {
  let audit: ReturnType<typeof emit>;
  try {
    // [security] AUDITED, like the narrower `project.start_mode_decided`. This
    // grant widens what agents may do to the operator's files; a model choice
    // (`set_project_model`) cannot, and is not audited. Audit-before-write:
    // the column is not touched unless this row lands.
    audit = emit(
      {
        class: 'safety',
        severity: 'warn',
        dedupeKey: `execute_mode_decided:${input.sessionId}`,
        title:
          input.mode === 'orchestrator'
            ? 'Execute mode granted (orchestrator session)'
            : 'Execute mode granted (chain session)',
        message:
          `Agents may now create, modify and delete files within their own ` +
          `project folder for this ${input.mode} session.`,
        sessionId: input.sessionId,
        reasonCode: 'execute_mode_granted',
        auditKind: 'bus.execute_mode_decided',
        auditPayload: {
          sessionId: input.sessionId,
          mode: input.mode,
          from: false,
          to: true,
          projects: input.projects,
        },
        // The audit row is the record; a sticky toast per grant is noise.
        sticky: false,
      },
      send,
    );
  } catch (err) {
    // `emit` persists/sends the envelope OUTSIDE its own audit try, so a broken
    // notifications table throws rather than returning `{ ok: false }`. Treat
    // any escape the same as a refusal: downgrade, never let it reach the
    // caller's session start.
    console.error('[execute-mode] grant emit threw', err);
    return { granted: false, error: 'emit_threw' };
  }
  if (!audit.ok) return { granted: false, error: audit.error };

  try {
    setExecuteMode(input.sessionId, true);
  } catch (err) {
    // The column write itself failed. The row now over-states the grant, which
    // is the safe direction; the session runs consultant.
    console.error('[execute-mode] persist execute_mode failed', err);
    return { granted: false, error: 'persist_failed' };
  }
  return { granted: true };
}
