/**
 * `Cebab-6fax.40`: audit the per-session permission-pill flip.
 *
 * WHY THIS IS A MODULE AND NOT A `case` BODY — the same argument
 * `project_start_mode.ts` makes for its own decision, and this is the closer
 * sibling of the two. The BE-1 dual-write contract (append the hash-chained
 * audit row BEFORE the state change, refuse the change if the append fails) is
 * only a contract if something checks it, and a decision living inline in
 * `handleClientMsg`'s module-private switch is asserted by nobody. Pulled out,
 * a spy can make the append throw and the test can then read what happened to
 * the runner and the column.
 *
 * WHY IT IS AUDITED AT ALL. Every other privilege-widening act in Cebab is
 * audit-before-write: `set_trusted`, `applyProjectStartPermissionMode`, the
 * managed-agent config edit. This one was not, and it is not the smallest of
 * them: flipping a live session to `acceptEdits` on an UNTRUSTED project is
 * precisely the posture change Trust exists to gate, applied mid-turn to a
 * process that is already running. `default binds on trusted projects too`
 * (CLAUDE.md) is the same fact read from the other side — the pill is a real
 * authority control, not a display preference.
 *
 * Like `set_trusted`, this DETECTS rather than prevents: anything holding the
 * auth token can send the verb. A durable record is what is achievable.
 *
 * The WS layer keeps what belongs to it — calling the runner, updating the
 * in-flight entry, replying. What lives here is the part with an ordering
 * requirement.
 */
import type { ServerMsg, SessionPermissionMode } from '@cebab/shared/protocol';
import { emit } from './notifications/dispatcher.js';
import { setSessionPermissionMode } from './repo/sessions.js';

export type ApplySessionModeResult = { ok: true } | { ok: false; error: string };

/**
 * Audit, then persist. Returns `{ ok: false }` without touching the column
 * when the append fails, so the operator's flip does not half-land.
 *
 * `from` is the mode the in-flight entry currently holds; the caller has it
 * and this module would otherwise have to re-read a row to learn something the
 * caller already knows.
 */
export function applySessionPermissionMode(args: {
  sessionId: string;
  projectId: number;
  from: SessionPermissionMode;
  to: SessionPermissionMode;
  send: (msg: ServerMsg) => void;
}): ApplySessionModeResult {
  const widening = args.to === 'acceptEdits' && args.from !== 'acceptEdits';
  const audit = emit(
    {
      class: 'safety',
      // `warn` in the widening direction only. Tightening back to `default` is
      // still recorded — the chain wants both edges of a flip, or a reader
      // cannot tell how long the wider posture was live — but it is not a
      // thing to raise an eyebrow at.
      severity: widening ? 'warn' : 'info',
      dedupeKey: `session.permission_mode_decided:${args.sessionId}`,
      title:
        args.to === 'acceptEdits'
          ? 'Session switched to auto-allow'
          : 'Session switched to ask-first',
      message: `session ${args.sessionId}`,
      sessionId: args.sessionId,
      projectId: args.projectId,
      reasonCode: widening ? 'session_mode_widened' : 'session_mode_narrowed',
      auditKind: 'session.permission_mode_decided',
      auditPayload: {
        sessionId: args.sessionId,
        projectId: args.projectId,
        from: args.from,
        to: args.to,
      },
      // The audit row is the record. A sticky toast per pill click is noise the
      // operator dismisses without reading — same call `project_start_mode`
      // makes for the same reason.
      sticky: false,
    },
    args.send,
  );
  if (!audit.ok) return { ok: false, error: audit.error };

  setSessionPermissionMode(args.sessionId, args.to);
  return { ok: true };
}
