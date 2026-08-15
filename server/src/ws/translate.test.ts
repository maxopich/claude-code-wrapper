import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test } from 'vitest';
import { translate } from './translate.js';

const SID = 'sess-1';
const PID = 42;

function fake<T extends Record<string, unknown>>(payload: T): SDKMessage {
  return { session_id: SID, ...payload } as unknown as SDKMessage;
}

describe('translate', () => {
  test('result.subtype: passes through known values', () => {
    const out = translate(
      fake({
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        total_cost_usd: 0.01,
        result: 'hi',
      }),
      PID,
    );
    expect(out).toMatchObject({ type: 'result', subtype: 'success' });
  });

  test('result.subtype: coerces unknown subtypes to error_during_execution', () => {
    const out = translate(
      fake({
        type: 'result',
        subtype: 'something_brand_new_in_a_future_sdk',
        duration_ms: 100,
        total_cost_usd: 0.01,
      }),
      PID,
    );
    expect(out).toMatchObject({ type: 'result', subtype: 'error_during_execution' });
  });

  // Cluster F Phase A1b (UI-A1): translate.ts forwards the SDK's
  // `num_turns` so the client's turn-counter chip + MaxTurnsResultCard
  // have ground truth without re-parsing the raw SDKMessage.
  test('result.numTurns: forwards SDK num_turns when present', () => {
    const out = translate(
      fake({
        type: 'result',
        subtype: 'error_max_turns',
        duration_ms: 100,
        total_cost_usd: 0.01,
        num_turns: 42,
      }),
      PID,
    );
    expect(out).toMatchObject({
      type: 'result',
      subtype: 'error_max_turns',
      numTurns: 42,
    });
  });

  test('result.numTurns: omits when SDK did not ship num_turns', () => {
    const out = translate(
      fake({
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        total_cost_usd: 0.01,
        // num_turns intentionally absent
      }),
      PID,
    );
    expect(out).toBeTruthy();
    if (!out || out.type !== 'result') throw new Error('expected result');
    expect(out.numTurns).toBeUndefined();
  });

  // Register S15. The zero-turn drop exists for slash commands, which close
  // out `success` with no turns. It used to be checked before the subtype, and
  // the SDK declares `num_turns` REQUIRED on `SDKResultError` too — so a turn
  // that failed before completing its first turn was dropped identically, and
  // the operator got no envelope at all: no completion, no failure, just a
  // session that stopped saying anything.
  //
  // Both directions are asserted, and they have to be: a fix that simply
  // deleted the short-circuit would satisfy the error case while re-adding the
  // "$0.0000 success" noise the drop exists to remove.
  const ERROR_SUBTYPES = [
    'error_during_execution',
    'error_max_turns',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
  ] as const;

  for (const subtype of ERROR_SUBTYPES) {
    test(`result: a zero-turn ${subtype} still reaches the operator`, () => {
      const out = translate(
        fake({
          type: 'result',
          subtype,
          duration_ms: 12,
          total_cost_usd: 0,
          num_turns: 0,
          errors: ['boom'],
        }),
        PID,
      );
      expect(out).toMatchObject({ type: 'result', subtype, numTurns: 0 });
    });
  }

  test('result.numTurns === 0 short-circuits the envelope (synthetic /command)', () => {
    // Pre-existing contract: slash commands close out with num_turns=0,
    // total_cost_usd=0; the translator drops these to avoid a noisy
    // "success · $0.0000" card after the command_output card. The A1b
    // numTurns forwarding does NOT change that — verify the drop still
    // fires.
    const out = translate(
      fake({
        type: 'result',
        subtype: 'success',
        duration_ms: 0,
        total_cost_usd: 0,
        num_turns: 0,
      }),
      PID,
    );
    expect(out).toBeNull();
  });

  test('wrapper:permission_request maps back to a permission_request ServerMsg on replay', () => {
    const out = translate(
      fake({
        type: 'wrapper',
        subtype: 'permission_request',
        uuid: 'u',
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'echo hi' },
      }),
      PID,
    );
    expect(out).toEqual({
      type: 'permission_request',
      requestId: 'req-1',
      sessionId: SID,
      toolName: 'Bash',
      input: { command: 'echo hi' },
    });
  });

  test('wrapper:permission_decided maps back to a permission_decided ServerMsg', () => {
    const out = translate(
      fake({
        type: 'wrapper',
        subtype: 'permission_decided',
        uuid: 'u',
        requestId: 'req-1',
        decision: 'allow',
      }),
      PID,
    );
    expect(out).toEqual({
      type: 'permission_decided',
      sessionId: SID,
      requestId: 'req-1',
      decision: 'allow',
    });
  });

  test('wrapper events with an unknown subtype are dropped (returns null)', () => {
    const out = translate(
      fake({
        type: 'wrapper',
        subtype: 'process_crashed',
        uuid: 'u',
        message: 'boom',
      }),
      PID,
    );
    expect(out).toBeNull();
  });

  test('unknown SDK message type degrades to a system_event', () => {
    const out = translate(fake({ type: 'something_new' }), PID);
    expect(out).toMatchObject({ type: 'system_event', subtype: 'unknown:something_new' });
  });

  test('synthetic assistant (slash command output) becomes a command_output ServerMsg', () => {
    const out = translate(
      fake({
        type: 'assistant',
        uuid: 'u',
        message: {
          model: '<synthetic>',
          role: 'assistant',
          content: [{ type: 'text', text: '## Context Usage\n\nFree space: 95%' }],
        },
      }),
      PID,
    );
    expect(out).toEqual({
      type: 'command_output',
      sessionId: SID,
      uuid: 'u',
      text: '## Context Usage\n\nFree space: 95%',
    });
  });

  test('real assistant (non-synthetic model) still becomes an assistant_message', () => {
    const out = translate(
      fake({
        type: 'assistant',
        uuid: 'u',
        message: {
          model: 'claude-opus-4-7',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      }),
      PID,
    );
    expect(out).toMatchObject({
      type: 'assistant_message',
      sessionId: SID,
      uuid: 'u',
      blocks: [{ type: 'text', text: 'Hello' }],
    });
  });

  test('result with num_turns: 0 is dropped (slash-command no-op)', () => {
    const out = translate(
      fake({
        type: 'result',
        subtype: 'success',
        duration_ms: 5,
        total_cost_usd: 0,
        num_turns: 0,
        result: '',
      }),
      PID,
    );
    expect(out).toBeNull();
  });

  test('text_delta stream events become text StreamDeltas', () => {
    const out = translate(
      fake({
        type: 'stream_event',
        uuid: 'u',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      }),
      PID,
    );
    expect(out).toMatchObject({
      type: 'stream_delta',
      delta: { kind: 'text', text: 'Hi', blockIndex: 0 },
    });
  });
});

/**
 * Register S07. `SDKUserMessage.message` is a `MessageParam`, whose `content`
 * is `string | ContentBlockParam[]`. This case used to cast the array arm
 * unconditionally and forward it, and `store.ts` does `msg.blocks.map(...)` on
 * what arrives — so the string arm is a reducer TypeError that takes the whole
 * session's render with it.
 */
describe('user messages always arrive as blocks', () => {
  const userMsg = (content: unknown) => fake({ type: 'user', uuid: 'u', message: { content } });

  test('a block array passes through untouched', () => {
    const blocks = [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }];
    expect(translate(userMsg(blocks), PID)).toMatchObject({ type: 'user_message', blocks });
  });

  test('a bare string becomes a single text block', () => {
    expect(translate(userMsg('just text'), PID)).toMatchObject({
      type: 'user_message',
      blocks: [{ type: 'text', text: 'just text' }],
    });
  });

  test('an empty string is still a block array, not a dropped message', () => {
    expect(translate(userMsg(''), PID)).toMatchObject({
      type: 'user_message',
      blocks: [{ type: 'text', text: '' }],
    });
  });

  test('anything else degrades to an empty array rather than crashing the reducer', () => {
    for (const content of [null, undefined, 7, { text: 'no' }]) {
      expect(translate(userMsg(content), PID), String(content)).toMatchObject({
        type: 'user_message',
        blocks: [],
      });
    }
    // …including a `message` that is missing entirely.
    expect(translate(fake({ type: 'user', uuid: 'u' }), PID)).toMatchObject({
      type: 'user_message',
      blocks: [],
    });
  });

  test('every shape yields something the client reducer can map over', () => {
    // The property that actually matters — `store.ts` calls `.map` on this.
    for (const content of ['s', [], [{ type: 'text', text: 'x' }], null, 7]) {
      const out = translate(userMsg(content), PID) as { blocks: unknown[] };
      expect(Array.isArray(out.blocks), String(content)).toBe(true);
      expect(() => out.blocks.map((b) => b)).not.toThrow();
    }
  });
});

/**
 * Register S16. The sibling of the S07 block above, for the case that was left
 * behind when it was written: `assistant` dereferenced `message.content`
 * without the optional chain `user` had been given.
 *
 * The SDK types make `message` required, so the live stream never produces
 * this. Replay does: `replaySession` casts every persisted row with
 * `JSON.parse(row.raw) as SDKMessage`, which checks nothing, and a throw in
 * that loop used to cost the operator the rest of the session's history.
 */
describe('assistant messages survive a row the SDK types say cannot exist', () => {
  test('a missing `message` yields empty blocks instead of throwing', () => {
    expect(() => translate(fake({ type: 'assistant', uuid: 'a' }), PID)).not.toThrow();
    expect(translate(fake({ type: 'assistant', uuid: 'a' }), PID)).toMatchObject({
      type: 'assistant_message',
      uuid: 'a',
      blocks: [],
    });
  });

  test('a `message` with no content yields empty blocks', () => {
    expect(translate(fake({ type: 'assistant', uuid: 'a', message: {} }), PID)).toMatchObject({
      type: 'assistant_message',
      blocks: [],
    });
  });

  test('a well-formed assistant message is untouched', () => {
    // POSITIVE CONTROL. Every case above asserts a fallback fires; without
    // this one, a "fix" that always returned `[]` would pass them all.
    const blocks = [{ type: 'text', text: 'hello' }];
    expect(
      translate(fake({ type: 'assistant', uuid: 'a', message: { content: blocks } }), PID),
    ).toMatchObject({ type: 'assistant_message', uuid: 'a', blocks });
  });
});

/**
 * Register S06: a permission decided by a DRAIN — the socket closed, or the
 * turn was interrupted — carries why, so replay can say Cebab decided it
 * rather than implying the operator did.
 */
describe('permission_decided carries the drain reason on replay', () => {
  const decided = (extra: Record<string, unknown>) =>
    translate(
      fake({
        type: 'wrapper',
        subtype: 'permission_decided',
        uuid: 'u',
        requestId: 'req-1',
        decision: 'deny',
        ...extra,
      }),
      PID,
    );

  test('a drained row forwards its reason', () => {
    expect(decided({ reason: 'client_disconnected' })).toMatchObject({
      type: 'permission_decided',
      requestId: 'req-1',
      decision: 'deny',
      reason: 'client_disconnected',
    });
    expect(decided({ reason: 'interrupted' })).toMatchObject({ reason: 'interrupted' });
  });

  test("an operator's own decision has no reason, and that absence is the signal", () => {
    const out = decided({}) as Record<string, unknown>;
    expect(out).toMatchObject({ type: 'permission_decided', decision: 'deny' });
    expect('reason' in out).toBe(false);
  });

  test('an unrecognised reason is dropped rather than forwarded', () => {
    // The wire type is a closed union; a row written by a future build with a
    // reason this build does not know must not leak an unmodelled value into
    // the client's reducer.
    const out = decided({ reason: 'something_new' }) as Record<string, unknown>;
    expect('reason' in out).toBe(false);
  });
});
