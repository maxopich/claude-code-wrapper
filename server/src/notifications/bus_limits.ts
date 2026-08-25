import type { ServerMsg } from '@cebab/shared';
import type { MaxTurnsReachedError } from '../bus/errors.js';
import { hopBudgetExhaustedText } from '../bus/turn_guard.js';
import { emit as emitNotification, type DispatcherEmitResult } from './dispatcher.js';

/**
 * `Cebab-vie.17` — the two runaway brakes on the multi-agent bus, and the rows
 * they write to the hash chain.
 *
 * Both used to be invisible to the audit log. The **hop budget** force-stopped a
 * whole session with nothing but a `multi_agent_events` row and a `stopped`
 * status to show for it, while its single-agent twin — the max-turns cap hit at
 * `ws/server.ts` — wrote an audited, sticky safety notification. The **per-hop
 * turn cap** did not exist at all: a hop was an unbounded agent turn.
 *
 * One module, two exports, because both answer the same question — *a ceiling
 * Cebab chose stopped the bus, and here is which one* — and because the two
 * routers are byte-identical twins that have already drifted once. A helper
 * they both call cannot drift; two inline copies eventually will.
 *
 * Neither kind joins `HIGHEST_AUDIT_KINDS`: that set is the tamper escalation,
 * and acknowledging "your run hit its limit" needs no typed justification.
 */

/**
 * The hop budget stopped a session.
 *
 * `severity: 'warn'`, not `'danger'`. `router.drop`'s `danger` is for *something
 * got past a control*; this is a control doing exactly what it exists to do.
 *
 * One per session by construction — `checkBudgetExhausted` short-circuits on
 * `ended`, which `teardown` sets synchronously before any `await` — so the
 * session-scoped `dedupeKey` can never collapse two distinct stops.
 *
 * `mode` is a parameter rather than a constant precisely because it is the one
 * thing the two callers disagree about; a copy-pasted `'orchestrator'` inside
 * `chain.ts` is the failure this module exists to make testable.
 */
export function dispatchHopBudgetExhausted(params: {
  sessionId: string;
  hopsCount: number;
  hopBudget: number;
  mode: 'orchestrator' | 'chain';
  send: (msg: ServerMsg) => void;
}): DispatcherEmitResult {
  return emitNotification(
    {
      class: 'safety',
      severity: 'warn',
      dedupeKey: `hop_budget.exhausted:${params.sessionId}`,
      title: `Hop budget exhausted (${params.hopsCount}/${params.hopBudget})`,
      // The same sentence the synthetic `cebab → _sink` row carries, from the
      // same function, so the audit log and the transcript cannot disagree
      // about why the session stopped.
      message: hopBudgetExhaustedText(params.hopsCount, params.hopBudget),
      sessionId: params.sessionId,
      reasonCode: 'hop_budget_exhausted',
      auditKind: 'hop_budget.exhausted',
      auditPayload: {
        hopsCount: params.hopsCount,
        hopBudget: params.hopBudget,
        mode: params.mode,
      },
    },
    params.send,
  );
}

/**
 * A bus hop hit the per-hop turn cap.
 *
 * `auditKind: 'max_turns.hit'` and `reasonCode: 'max_turns_exceeded'` are
 * deliberately the SAME pair the single-agent site writes, with
 * `payload.surface` splitting them. A separate kind would make one forensic
 * query into two and would quietly falsify the parity claim this change is
 * about; `surface` keeps "how often do turns hit the cap?" answerable across
 * both paths in one statement.
 *
 * `actor` is always `'system'` and `hadOverride` always `false`: the bus has no
 * per-turn override to choose, by decision. They are present anyway so the two
 * surfaces' payloads have one shape.
 *
 * The `dedupeKey` is per-AGENT, unlike the single-agent one — with N workers the
 * operator's first question is which participant is looping, and a session-wide
 * key would collapse exactly that.
 */
export function dispatchBusMaxTurnsReached(params: {
  sessionId: string;
  err: MaxTurnsReachedError;
  send: (msg: ServerMsg) => void;
}): DispatcherEmitResult {
  const { err } = params;
  return emitNotification(
    {
      class: 'safety',
      severity: 'warn',
      dedupeKey: `max_turns.hit:${params.sessionId}:${err.agentName}`,
      title: `${err.agentName} reached the turn cap (${err.maxTurns})`,
      // One wording, one place — the sentinel's own message is what the
      // operator already reads in the transcript row.
      message: err.message,
      sessionId: params.sessionId,
      reasonCode: 'max_turns_exceeded',
      auditKind: 'max_turns.hit',
      auditAgentId: err.agentName,
      auditPayload: {
        effectiveMaxTurns: err.maxTurns,
        actor: 'system',
        numTurns: err.numTurns,
        hadOverride: false,
        surface: 'bus',
      },
    },
    params.send,
  );
}
