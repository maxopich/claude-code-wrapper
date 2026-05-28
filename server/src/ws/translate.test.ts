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
