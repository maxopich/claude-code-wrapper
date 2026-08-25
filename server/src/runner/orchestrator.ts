import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { bumpSession } from '../repo/sessions.js';
import { insertEvent, nextSeq } from '../repo/events.js';
import { logEvent, type LogFailureReason } from './logger.js';
import { isStreamPartial } from './message_classes.js';

/**
 * Persist one SDK message. Stream deltas go only to the per-session JSONL
 * (which feeds the mock fixtures). Everything else also lands in the events
 * table so we can replay sessions on demand.
 *
 * Returns the seq we used (or null if we skipped the events table).
 */
export async function persistMessage(
  sessionId: string,
  msg: SDKMessage,
  onLogFailure?: (reason: LogFailureReason) => void,
): Promise<number | null> {
  const m = msg as { type: string; subtype?: string };
  const type = m.type ?? 'unknown';
  const subtype = typeof m.subtype === 'string' ? m.subtype : null;

  // JSONL is a full trace including deltas — useful for fixture capture.
  // logEvent is fail-silent on disk; surface a write failure to the caller
  // (which emits one coalesced operator notification) so the on-disk gap
  // isn't invisible. The DB-event path below runs regardless.
  const logResult = await logEvent(sessionId, msg);
  if (!logResult.ok) onLogFailure?.(logResult.reason);

  // The events table skips streaming partials: they are high-volume, they would
  // balloon the DB and slow down replaySession(), and the 'assistant' message
  // that follows carries the final text anyway.
  //
  // `Cebab-ygu.47`: the rule moved to `message_classes.ts` because the redacted
  // session-log export needs the SAME answer. It did not have it, and the gap
  // was the leak — the export shipped deltas the DB had never held, so a secret
  // chopped across two of them survived a redaction pass that no per-line rule
  // could ever have caught. A future high-volume type goes in that module, not
  // here, so both consumers move together.
  if (isStreamPartial(type)) return null;

  const seq = nextSeq(sessionId);
  const raw = JSON.stringify(msg);
  insertEvent(sessionId, seq, type, subtype, raw);

  // bumpSession only on terminal events; partials already returned above.
  if (type === 'result') {
    // `total_cost_usd` is this INVOCATION's cost, not a running session total:
    // it equals `sum(modelUsage[*].costUSD)`, and those are per-invocation
    // token counters. Observed sequences confirm it — a two-turn session
    // reports $0.4205 then $0.0571, which no cumulative counter could do. So
    // the session total is a SUM, and this must add rather than assign.
    //
    // It used to call `setSessionCost` (absolute assignment), which recorded
    // only the final turn — and recorded $0.00 outright whenever a session
    // ended on a `num_turns: 0` slash-command result.
    //
    // Historical rows are deliberately NOT rewritten. Existing
    // `sessions.total_cost_usd` values in a real install were found to hold
    // correct SUMS, which the assigning code could not have produced; that
    // discrepancy is unexplained, and rewriting records on the strength of a
    // model that does not predict the data would be the wrong trade. Fixing
    // forward costs nothing and risks nothing.
    const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
    bumpSession(sessionId, typeof cost === 'number' && Number.isFinite(cost) ? cost : 0);
  } else if (type === 'assistant' || type === 'user' || type === 'system') {
    bumpSession(sessionId);
  }

  return seq;
}
