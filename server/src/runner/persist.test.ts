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
import { persistMessage, persistOperatorPrompt } from './persist.js';

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

/**
 * Cebab-4baz. Measured before the fix, on a real two-turn session: the events
 * table held `system/init, assistant, rate_limit_event, result` and the JSONL
 * held the same, and NEITHER contained the operator's prompt text. The CLI does
 * not echo it — an SDK `user` message carries tool results — so the operator's
 * half of the conversation existed only in browser memory, and a reopened
 * session rendered as a monologue.
 */
describe('persistOperatorPrompt (Cebab-4baz)', () => {
  test("writes the prompt as a 'user' row so replay needs no new code", async () => {
    await persistOperatorPrompt('s1', 'what does this module do?', 'uuid-1');

    expect(mockInsertEvent).toHaveBeenCalledTimes(1);
    const [sessionId, , type, subtype, raw] = mockInsertEvent.mock.calls[0];
    expect(sessionId).toBe('s1');
    // `user`, not a wrapper subtype: translate() already maps this to the
    // `user_message` ServerMsg and the web store already renders it. A bespoke
    // subtype would have needed its own case on both sides.
    expect(type).toBe('user');
    expect(subtype).toBeNull();

    const parsed = JSON.parse(raw as string);
    // The shape translate()'s `user` case reads — `message.content`, which it
    // accepts as a string or as blocks.
    expect(parsed.message.content).toBe('what does this module do?');
    expect(parsed.uuid).toBe('uuid-1');
  });

  test('also reaches the JSONL, so the two corpora do not diverge', async () => {
    // The JSONL is documented as a strict superset of the events table. Writing
    // the prompt to only one would invert that, and the raw session-log export
    // reads the JSONL.
    await persistOperatorPrompt('s1', 'hello', 'uuid-2');
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const logged = mockLogEvent.mock.calls[0][1] as unknown as { message: { content: string } };
    expect(logged.message.content).toBe('hello');
  });

  test('marks the row as Cebab-authored', async () => {
    // Nothing reads this today. It is here for the day the CLI starts echoing
    // prompts itself, when replay would show each message twice and the marker
    // is what lets the duplicate be identified rather than guessed at.
    await persistOperatorPrompt('s1', 'hello', 'uuid-3');
    const raw = mockInsertEvent.mock.calls[0][4] as string;
    expect(JSON.parse(raw).cebabOrigin).toBe('operator_prompt');
  });

  test('a log-write failure is reported, not swallowed', async () => {
    // Same contract as every other persist: the on-disk gap must not be
    // invisible. Without the wiring the prompt would silently stop reaching the
    // JSONL while the DB row kept being written.
    mockLogEvent.mockResolvedValue({ ok: false, reason: 'stream_error' });
    const onLogFailure = vi.fn();
    await persistOperatorPrompt('s1', 'hello', 'uuid-4', onLogFailure);
    expect(onLogFailure).toHaveBeenCalledWith('stream_error');
    // And the DB row is still written — a failed JSONL write must not lose the
    // prompt from the corpus replay actually reads.
    expect(mockInsertEvent).toHaveBeenCalledTimes(1);
  });

  test("it moves the session's recency but adds no cost", async () => {
    // Written first as "bumpSession is not called", on the strength of the
    // comment above the call in persist.ts, which says it fires "only on
    // terminal events". It fires for every non-partial; the comment is stale
    // and is corrected in the same commit.
    //
    // The behaviour is right and worth pinning in its own direction: a prompt
    // IS an event, so `last_event_at` should move — that is what orders the
    // sidebar. What it must not do is touch cost, and the no-argument call is
    // what guarantees that (`bumpSession` adds its delta, defaulting to 0).
    await persistOperatorPrompt('s1', 'hello', 'uuid-5');
    expect(mockBumpSession).toHaveBeenCalledTimes(1);
    expect(mockBumpSession).toHaveBeenCalledWith('s1');
  });
});
