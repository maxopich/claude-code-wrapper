import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Mock the JSONL writer + the DB repos so persistMessage can be exercised
// without touching disk or SQLite — we only care about the onLogFailure wiring.
vi.mock('./logger.js', () => ({ logEvent: vi.fn() }));
vi.mock('../repo/events.js', () => ({ insertEvent: vi.fn(), nextSeq: vi.fn(() => 1) }));
vi.mock('../repo/sessions.js', () => ({ bumpSession: vi.fn() }));

import { logEvent } from './logger.js';
import { insertEvent } from '../repo/events.js';
import { bumpSession } from '../repo/sessions.js';
import { persistMessage } from './orchestrator.js';

const mockLogEvent = vi.mocked(logEvent);
const mockInsertEvent = vi.mocked(insertEvent);
const mockBumpSession = vi.mocked(bumpSession);

function resultMsg(totalCostUsd: unknown, numTurns = 1): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 's1',
    num_turns: numTurns,
    total_cost_usd: totalCostUsd,
  } as unknown as SDKMessage;
}

const assistantMsg = {
  type: 'assistant',
  uuid: 'u1',
  session_id: 's1',
  message: { content: [] },
} as unknown as SDKMessage;

beforeEach(() => {
  vi.clearAllMocks();
  mockLogEvent.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('persistMessage', () => {
  test('invokes onLogFailure with the reason when the JSONL write fails, and still writes the DB event', async () => {
    mockLogEvent.mockResolvedValue({ ok: false, reason: 'stream_error' });
    const onLogFailure = vi.fn();

    const seq = await persistMessage('s1', assistantMsg, onLogFailure);

    expect(onLogFailure).toHaveBeenCalledTimes(1);
    expect(onLogFailure).toHaveBeenCalledWith('stream_error');
    // The DB-event path is independent and MUST still run on a JSONL failure —
    // that asymmetry is exactly why the failure was invisible before.
    expect(mockInsertEvent).toHaveBeenCalledTimes(1);
    expect(seq).toBe(1);
  });

  test('does not invoke onLogFailure when the JSONL write succeeds', async () => {
    mockLogEvent.mockResolvedValue({ ok: true });
    const onLogFailure = vi.fn();

    await persistMessage('s1', assistantMsg, onLogFailure);

    expect(onLogFailure).not.toHaveBeenCalled();
    expect(mockInsertEvent).toHaveBeenCalledTimes(1);
  });

  test('tolerates a missing onLogFailure callback on failure', async () => {
    mockLogEvent.mockResolvedValue({ ok: false, reason: 'drain_timeout' });

    // No callback passed — the optional-chaining call must not throw.
    await expect(persistMessage('s1', assistantMsg)).resolves.toBe(1);
    expect(mockInsertEvent).toHaveBeenCalledTimes(1);
  });
});

describe('persistMessage — the per-turn cost handed to the repo', () => {
  // `result.total_cost_usd` is the cost of THAT invocation, not a running
  // session total: it equals `sum(modelUsage[*].costUSD)`, which are
  // per-invocation token counters. This used to call `setSessionCost`
  // (absolute assignment), so a multi-turn session's recorded cost was
  // whatever its LAST turn happened to cost. Migration 029 backfills the
  // sessions that were mis-recorded.
  //
  // SCOPE, because this block used to overstate it (register C05). `bumpSession`
  // is MOCKED here, so the accumulation itself — `total_cost_usd + ?`, the thing
  // 029 exists for — does not execute in this file at all. It is asserted
  // against real SQLite in `repo/sessions.test.ts`; reverting the accumulator
  // fails four tests there and none here.
  //
  // What these DO pin, and what nothing else does: that persistMessage forwards
  // each turn's figure VERBATIM and never pre-sums. A caller that helpfully
  // accumulated before calling would double-count against the additive repo.

  test('each result forwards its own cost, unaccumulated', async () => {
    await persistMessage('s1', resultMsg(0.42052775));
    await persistMessage('s1', resultMsg(0.057099));

    // The second call carries 0.057099, NOT the 0.47762675 running total.
    expect(mockBumpSession.mock.calls).toEqual([
      ['s1', 0.42052775],
      ['s1', 0.057099],
    ]);
  });

  test('a zero-cost slash-command result is forwarded as 0, not skipped', async () => {
    await persistMessage('s1', resultMsg(0.03987175));
    // Slash commands close out with `num_turns: 0, total_cost_usd: 0`. Under
    // absolute assignment this set the session to exactly $0.00 — a real
    // observed case in captured transcripts. That the TOTAL survives it is
    // `repo/sessions.test.ts`'s assertion; this one only pins that the zero
    // still reaches the repo rather than being filtered out here.
    await persistMessage('s1', resultMsg(0, 0));

    expect(mockBumpSession.mock.calls).toEqual([
      ['s1', 0.03987175],
      ['s1', 0],
    ]);
  });

  test('a result with no usable cost still bumps last_event_at, adding 0', async () => {
    await persistMessage('s1', resultMsg(undefined));
    await persistMessage('s1', resultMsg(Number.NaN));

    expect(mockBumpSession.mock.calls).toEqual([
      ['s1', 0],
      ['s1', 0],
    ]);
  });
});
