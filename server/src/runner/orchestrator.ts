import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { setSessionCost, bumpSession } from '../repo/sessions.js';
import { insertEvent, nextSeq } from '../repo/events.js';
import { logEvent, type LogFailureReason } from './logger.js';

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

  // The events table skips stream_event: those are high-volume partials that
  // would balloon the DB and slow down replaySession() with no payoff (the
  // following 'assistant' message carries the final text anyway).
  if (type === 'stream_event') return null;

  const seq = nextSeq(sessionId);
  const raw = JSON.stringify(msg);
  insertEvent(sessionId, seq, type, subtype, raw);

  // bumpSession only on terminal events; stream_event already returned above.
  // Other high-volume types in the future should also be excluded here so
  // last_event_at stays semantically meaningful.
  if (type === 'result') {
    const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
    if (typeof cost === 'number') {
      setSessionCost(sessionId, cost);
    } else {
      bumpSession(sessionId);
    }
  } else if (type === 'assistant' || type === 'user' || type === 'system') {
    bumpSession(sessionId);
  }

  return seq;
}
