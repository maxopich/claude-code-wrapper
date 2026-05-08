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
