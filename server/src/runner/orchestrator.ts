import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { setSessionCost, bumpSession } from '../repo/sessions.js';
import { insertEvent, nextSeq } from '../repo/events.js';
import { logEvent } from './logger.js';

/**
 * Persist one SDK message to both the per-session JSONL log and the events table.
 * Returns the seq we used so callers can correlate.
 */
export function persistMessage(sessionId: string, msg: SDKMessage): number {
  const m = msg as { type: string; subtype?: string };
  const type = m.type ?? 'unknown';
  const subtype = typeof m.subtype === 'string' ? m.subtype : null;

  const seq = nextSeq(sessionId);
  const raw = JSON.stringify(msg);
  insertEvent(sessionId, seq, type, subtype, raw);
  logEvent(sessionId, msg);

  // Side-effects derived from message contents.
  if (type === 'result') {
    const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
    if (typeof cost === 'number') {
      setSessionCost(sessionId, cost);
    } else {
      bumpSession(sessionId);
    }
  } else {
    bumpSession(sessionId);
  }

  return seq;
}
