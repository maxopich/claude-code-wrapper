import { describe, expect, test } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { translate } from './translate.js';

// Cluster A Phase 3 (B2) + Cluster D Phase 4a (spec §4.1, BE-D3):
// the SDK's `rate_limit_event` was previously flattened into a generic
// `system_event { subtype: 'rate_limit' }`. Phase 3 lifted it into its
// own discriminant; Phase 4a:
//
//   - converts SDK's raw seconds (`resetsAt`) to ms (`resetsAtMs`) at
//     the boundary so every consumer can compare against `Date.now()`
//     without re-discovering the unit per call site;
//   - captures the overage-pool fields (`overageStatus`,
//     `overageResetsAtMs`, `isUsingOverage`) so the RateLimitBanner
//     (Phase 4c) can distinguish "hard limit but overage available"
//     from "fully exhausted";
//   - preserves the legacy `resetsAt` field for forward-compat (any
//     pre-Phase-4 consumer reading it just sees raw-from-SDK seconds —
//     not great but stable until they migrate).

function rl(info: Record<string, unknown>): SDKMessage {
  return {
    type: 'rate_limit_event',
    session_id: 'sess-1',
    rate_limit_info: info,
  } as unknown as SDKMessage;
}

describe('translate(rate_limit_event) — Cluster A Phase 3', () => {
  test('emits typed rate_limit_event with extracted status/rateLimitType', () => {
    const out = translate(
      rl({
        status: 'limited',
        // SDK's resetsAt is SECONDS since epoch — `2023-11-14T22:13:20Z`-ish.
        resetsAt: 1_700_000_000,
        rateLimitType: 'subscription',
      }),
      42,
    );
    expect(out).toMatchObject({
      type: 'rate_limit_event',
      sessionId: 'sess-1',
      status: 'limited',
      rateLimitType: 'subscription',
    });
  });

  test('handles partial rate_limit_info (only status present)', () => {
    const out = translate(rl({ status: 'allowed_warning' }), 42);
    expect(out).toMatchObject({
      type: 'rate_limit_event',
      sessionId: 'sess-1',
      status: 'allowed_warning',
      resetsAt: undefined,
      resetsAtMs: undefined,
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
      resetsAtMs: undefined,
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
      resetsAtMs: undefined,
    });
  });
});

describe('translate(rate_limit_event) — Cluster D Phase 4a (resetsAtMs + overage)', () => {
  test('BE-D3: SDK resetsAt (seconds) → resetsAtMs (ms) at server boundary', () => {
    // 1_700_000_000 seconds = 2023-11-14T22:13:20Z → ×1000 = 1_700_000_000_000 ms.
    const out = translate(rl({ status: 'hard', resetsAt: 1_700_000_000 }), 42);
    expect(out).toMatchObject({
      type: 'rate_limit_event',
      resetsAt: 1_700_000_000, // raw from SDK (seconds)
      resetsAtMs: 1_700_000_000_000, // converted (ms)
    });
  });

  test('captures overageStatus / overageResetsAtMs / isUsingOverage', () => {
    const out = translate(
      rl({
        status: 'hard',
        resetsAt: 1_700_000_000,
        overageStatus: 'allowed',
        overageResetsAt: 1_700_010_000,
        isUsingOverage: false,
      }),
      42,
    );
    expect(out).toMatchObject({
      type: 'rate_limit_event',
      overageStatus: 'allowed',
      overageResetsAtMs: 1_700_010_000_000,
      isUsingOverage: false,
    });
  });

  test('omits resetsAtMs / overageResetsAtMs when SDK numeric fields missing', () => {
    const out = translate(
      rl({
        status: 'approaching',
        overageStatus: 'allowed',
        // no resetsAt, no overageResetsAt, no isUsingOverage
      }),
      42,
    );
    expect(out).toMatchObject({
      type: 'rate_limit_event',
      status: 'approaching',
      resetsAtMs: undefined,
      overageStatus: 'allowed',
      overageResetsAtMs: undefined,
      isUsingOverage: undefined,
    });
  });

  test('coerces non-number resetsAt + non-boolean isUsingOverage to undefined', () => {
    const out = translate(
      rl({
        status: 'hard',
        resetsAt: 'not-a-number',
        overageResetsAt: { nested: 'bad' },
        isUsingOverage: 1, // not boolean
      }),
      42,
    );
    expect(out).toMatchObject({
      type: 'rate_limit_event',
      resetsAt: undefined,
      resetsAtMs: undefined,
      overageResetsAtMs: undefined,
      isUsingOverage: undefined,
    });
  });

  test('rateLimitType passed through (spec §4.1 enum: five_hour | weekly | subscription)', () => {
    const out = translate(
      rl({ status: 'approaching', resetsAt: 1_700_000_000, rateLimitType: 'five_hour' }),
      42,
    );
    expect(out).toMatchObject({
      rateLimitType: 'five_hour',
    });
  });

  test('isUsingOverage=true preserved verbatim (not coerced)', () => {
    const out = translate(rl({ status: 'hard', isUsingOverage: true }), 42);
    expect(out).toMatchObject({ isUsingOverage: true });
  });
});
