/**
 * One definition of "persisted pending-retry row → wire descriptor".
 *
 * The mapping is trivial (`prompt` → `lastPrompt`) and was written out by hand
 * in three places: `orchestrator.ts`'s module-local helper, `chain.ts`'s inline
 * descriptor literals, and `ws/server.ts`'s R-A/R-B hydration. Same reasoning
 * as `shared/src/mcp_status.ts` — the copies agree today, and a fourth reader
 * is how they stop agreeing.
 *
 * Which row to map is a separate question and deliberately not answered here:
 * the wire carries ONE descriptor, so every caller passes the FRONT of the
 * per-agent queue (`getPendingRetry`, migration 041), never the row it happens
 * to hold. `Cebab-6c1m` was chain emitting the just-failed agent while the
 * front was someone else.
 */
import type { PendingRetry } from '../repo/multi_agent.js';
import type { PendingRetryDescriptor } from '@cebab/shared/protocol';

export function pendingRetryToDescriptor(p: PendingRetry): PendingRetryDescriptor {
  return {
    agentName: p.agentName,
    reason: p.reason,
    lastPrompt: p.prompt,
    ts: p.ts,
    errorEventId: p.errorEventId,
  };
}
