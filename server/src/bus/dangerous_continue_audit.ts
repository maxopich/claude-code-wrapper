/**
 * `Cebab-vie.29`: record the operator's approval of a halted dangerous command,
 * and refuse the approval if it cannot be recorded.
 *
 * WHAT WAS MISSING. The pause-on-dangerous gate is the one place in the whole
 * bus where a human is put in the loop: a dangerous command is halted, a banner
 * appears, and the operator clicks Continue. That click is the single human
 * authorisation in a subsystem whose every other tool call is auto-allowed —
 * and it wrote nothing to the hash chain. The only related row is
 * `mutation.dangerous`, written by `maybeDispatchDangerousMutation` for EVERY
 * dangerous-category mutation whether or not the toggle is even on, and
 * dispatched from the WS sink rather than from the gate.
 *
 * So the chain recorded that a dangerous command was SEEN, and never recorded
 * whether it was stopped and approved or simply ran. Those are the two cases a
 * tamper-evident safety log exists to tell apart, and it could not tell them
 * apart. `docs/safety-and-security.md` meanwhile listed the pause among the
 * things that DO write rows.
 *
 * SCOPE, deliberately narrower than the bead: this covers the CONTINUE — the
 * human decision. The bead also names the toggle flip and the pause itself;
 * both remain open and are noted there. The continue is the half that makes the
 * chain able to distinguish the two outcomes, which is the consequence the bead
 * leads with.
 *
 * FAIL CLOSED, and here that means the dangerous command STAYS BLOCKED. If the
 * approval cannot be recorded the grant is not burnt, the pending row is left
 * pending, and no replay happens — so the banner stays up and the operator can
 * click again. That is the same direction `releasePauseForMutation` already
 * takes when its own persist fails ("refuse to replay rather than hand the
 * operator a loop"), and the safe one: an unrecorded approval that still runs
 * the command is precisely the state this bead exists to make impossible.
 *
 * Modelled on `execute_mode_grant.ts` (`Cebab-vie.21`), including why it is a
 * module: there are TWO call sites, `orchestrator.ts` and `chain.ts`, and the
 * pair has drifted before.
 */
import type { ServerMsg } from '@cebab/shared/protocol';
import { emit } from '../notifications/dispatcher.js';
import type { MutationRecord } from '../repo/multi_agent.js';

export type DangerousContinueMode = 'orchestrator' | 'chain';

export type DangerousContinueAuditResult = { recorded: boolean; error?: string };

/**
 * Agent-authored free text reaches this row (`summary` carries the model's own
 * description of the command). It is stored as JSON in the audit payload and
 * never re-injected into a prompt, so the quoting rules that govern the system
 * prompt do not apply — but it is still unbounded, and an audit row is a poor
 * place to discover that. Capped rather than trusted.
 */
const SUMMARY_CAP = 600;

export function auditDangerousContinue(
  input: { mode: DangerousContinueMode; sessionId: string; held: MutationRecord },
  send: (msg: ServerMsg) => void,
): DangerousContinueAuditResult {
  const { mode, sessionId, held } = input;
  let audit: ReturnType<typeof emit>;
  try {
    // [security] AUDIT BEFORE THE GRANT IS BURNT (BE-1). The caller must not
    // call `releasePauseForMutation` unless this returns `recorded: true`.
    audit = emit(
      {
        class: 'safety',
        severity: 'warn',
        // Per MUTATION, not per session: each halted command is its own
        // decision, and collapsing them would hide the second approval.
        dedupeKey: `dangerous_continue:${sessionId}:${held.id}`,
        title: 'Dangerous command approved by the operator',
        message:
          `${held.agentName} was halted before ${held.toolName} and the operator ` +
          `approved it. The command runs when the turn is replayed.`,
        sessionId,
        reasonCode: 'dangerous_continue_approved',
        auditKind: 'bus.dangerous_continue',
        auditPayload: {
          sessionId,
          mode,
          mutationId: held.id,
          agentName: held.agentName,
          toolName: held.toolName,
          category: held.category,
          summary: String(held.summary ?? '').slice(0, SUMMARY_CAP),
          filePath: held.filePath,
          cwd: held.cwd,
        },
        // The chain is the record. A sticky toast would sit on screen after the
        // operator has already acted, which is the moment they need it least.
        sticky: false,
      },
      send,
    );
  } catch (err) {
    // `emit` sends and persists the envelope OUTSIDE its own audit try, so a
    // broken notifications table throws rather than returning `{ ok: false }`.
    // Any escape is treated as a refusal.
    console.error(`[${mode}] dangerous-continue audit threw`, err);
    return { recorded: false, error: 'emit_threw' };
  }
  if (!audit.ok) {
    console.error(`[${mode}] dangerous-continue audit refused`, audit.error);
    return { recorded: false, error: audit.error };
  }
  return { recorded: true };
}
