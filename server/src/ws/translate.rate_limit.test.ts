import { describe, expect, test } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { translate } from './translate.js';

// Cluster A Phase 3 (B2): the SDK's `rate_limit_event` was previously
// flattened into a generic `system_event { subtype: 'rate_limit' }`. The
// fall-through cost: the client had no shape to render a countdown, and the
// dispatcher couldn't fan out a typed toast. Phase 3 lifts it into its own
// discriminant.

function rl(info: Record<string, unknown>): SDKMessage {
  return {
    type: 'rate_limit_event',
    session_id: 'sess-1',
    rate_limit_info: info,
  } as unknown as SDKMessage;
}

describe('translate(rate_limit_event)', () => {
  test('emits typed rate_limit_event with extracted status/resetsAt/rateLimitType', () => {
    const out = translate(
      rl({
        status: 'limited',
        resetsAt: 1_700_000_000_000,
        rateLimitType: 'subscription',
      }),
      42,
    );
    expect(out).toEqual({
      type: 'rate_limit_event',
      sessionId: 'sess-1',
      status: 'limited',
      resetsAt: 1_700_000_000_000,
      rateLimitType: 'subscription',
      payload: {
        status: 'limited',
        resetsAt: 1_700_000_000_000,
        rateLimitType: 'subscription',
      },
    });
  });

  test('handles partial rate_limit_info (only status present)', () => {
    const out = translate(rl({ status: 'allowed_warning' }), 42);
    expect(out).toMatchObject({
      type: 'rate_limit_event',
      sessionId: 'sess-1',
      status: 'allowed_warning',
      resetsAt: undefined,
      rateLimitType: undefined,
    });
  });

  test('falls back gracefully when rate_limit_info is missing entirely', () => {
    const msg = {
      type: 'rate_limit_event',
      session_id: 'sess-1',
    } as unknown as SDKMessage;
    const out = translate(msg, 42);
    expect(out).toMatchObject({
      type: 'rate_limit_event',
      sessionId: 'sess-1',
      status: undefined,
      resetsAt: undefined,
      rateLimitType: undefined,
    });
    // Payload defaults to the whole SDK msg when `rate_limit_info` is absent.
    expect((out as { payload: unknown }).payload).toMatchObject({
      type: 'rate_limit_event',
      session_id: 'sess-1',
    });
  });

  test('coerces non-string status to undefined', () => {
    const out = translate(rl({ status: 42, resetsAt: 'not-a-number' }), 1);
    expect(out).toMatchObject({
      type: 'rate_limit_event',
      status: undefined,
      resetsAt: undefined,
    });
  });
});
