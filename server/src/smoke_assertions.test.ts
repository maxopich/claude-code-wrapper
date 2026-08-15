import { describe, expect, test } from 'vitest';
import {
  formatVerdict,
  judgeSmokeRun,
  MOCK_EXPECTED_TEXT,
  sawNonce,
  type SmokeObservation,
} from './smoke_assertions.js';

// The CI-gating smoke (`ci_smoke` → `ws_smoke`) used to exit 0 on ANY result
// message. These cases pin the failures it now catches — and, just as
// importantly, the control that proves it still passes a healthy run. Without
// that control every assertion here would also pass on a judge that always
// returned a failure.

/** A healthy MOCK run, matching what `fixtures/hello.jsonl` produces. */
function healthyMock(over: Partial<SmokeObservation> = {}): SmokeObservation {
  return {
    sessionId: 'sess-1',
    streamedText: MOCK_EXPECTED_TEXT,
    resultSubtype: 'success',
    resultText: MOCK_EXPECTED_TEXT,
    errors: undefined,
    mock: true,
    ...over,
  };
}

describe('judgeSmokeRun — the control', () => {
  test('a healthy mock run passes', () => {
    expect(judgeSmokeRun(healthyMock())).toEqual({ ok: true });
  });

  test('a healthy real (non-mock) run passes with arbitrary text', () => {
    // The always-on tier must not require the fixture text, or the documented
    // manual real-claude run would fail every time.
    expect(
      judgeSmokeRun(healthyMock({ mock: false, streamedText: 'anything at all', resultText: 'x' })),
    ).toEqual({ ok: true });
  });
});

describe('judgeSmokeRun — the failures the old smoke exited 0 on', () => {
  test('a non-success result subtype fails', () => {
    const v = judgeSmokeRun(healthyMock({ resultSubtype: 'error_during_execution' }));
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ expected: 'success', actual: 'error_during_execution' });
  });

  test('a non-success subtype carries its errors into the message', () => {
    const v = judgeSmokeRun(
      healthyMock({ resultSubtype: 'error_during_execution', errors: ['boom', 'again'] }),
    );
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.actual).toBe('error_during_execution (boom; again)');
  });

  test('a success result with no streamed text fails', () => {
    const v = judgeSmokeRun(healthyMock({ mock: false, streamedText: '   ' }));
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.reason).toMatch(/no assistant text/);
  });

  test('a run with no session_started fails, and says so first', () => {
    // Reported ahead of the empty-text failure: a turn that never started will
    // also have no text, and naming the later symptom would bury the cause.
    const v = judgeSmokeRun(healthyMock({ sessionId: undefined, streamedText: '' }));
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.reason).toMatch(/no session_started/);
  });

  test('a run with no result at all fails', () => {
    const v = judgeSmokeRun(healthyMock({ resultSubtype: undefined }));
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.reason).toMatch(/no result message/);
  });
});

describe('judgeSmokeRun — the strict tier is mock-only', () => {
  const nearMiss = 'Hi there, friend';

  test('under MOCK a truncated text fails', () => {
    const v = judgeSmokeRun(healthyMock({ streamedText: nearMiss }));
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ expected: MOCK_EXPECTED_TEXT, actual: nearMiss });
  });

  test('under MOCK the fixture text PLUS extra content fails', () => {
    // This is the case that distinguishes equality from `.includes` — and the
    // only one that does. A truncated stream fails under both, so testing
    // only truncation would leave the choice of operator unmeasured.
    // A doubled replay or a leaked banner looks exactly like this.
    const doubled = `${MOCK_EXPECTED_TEXT}${MOCK_EXPECTED_TEXT}`;
    const v = judgeSmokeRun(healthyMock({ streamedText: doubled }));
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ expected: MOCK_EXPECTED_TEXT, actual: doubled });
  });

  test('the SAME near-miss passes when not in mock mode', () => {
    // This pair is the whole reason the tier exists — same input, different
    // verdict, decided only by `mock`.
    expect(judgeSmokeRun(healthyMock({ mock: false, streamedText: nearMiss })).ok).toBe(true);
  });

  test('under MOCK a mismatched result text fails even when the stream matched', () => {
    const v = judgeSmokeRun(healthyMock({ resultText: 'something else' }));
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.reason).toMatch(/result's own text/);
  });

  test('under MOCK an absent result text is reported as absent, not as empty', () => {
    const v = judgeSmokeRun(healthyMock({ resultText: undefined }));
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.actual).toBe('(absent)');
  });
});

describe('formatVerdict', () => {
  test('a pass is one line', () => {
    expect(formatVerdict({ ok: true })).toMatch(/^\[smoke\] PASS/);
  });

  test('a failure with a diff prints expected and actual', () => {
    const out = formatVerdict({ ok: false, reason: 'nope', expected: 'a', actual: 'b' });
    expect(out).toContain('[smoke] FAIL — nope');
    expect(out).toContain('expected: "a"');
    expect(out).toContain('actual:   "b"');
  });

  test('a failure without a diff omits both lines', () => {
    const out = formatVerdict({ ok: false, reason: 'nope' });
    expect(out).not.toContain('expected:');
    expect(out).not.toContain('actual:');
  });
});

describe('sawNonce — the live smoke resume check (S11)', () => {
  const NONCE = 'cebab-live-482913';

  test('accepts the nonce wrapped in a sentence', () => {
    // A live model answers in prose; the question is whether the second
    // subprocess saw the first one's context, not how it phrased it.
    expect(sawNonce(`The command printed ${NONCE}.`, NONCE)).toBe(true);
    expect(sawNonce(NONCE, NONCE)).toBe(true);
  });

  test('rejects a DIFFERENT number — the case the old /\\d+/ accepted', () => {
    // This is the whole finding. The old check fell back to "any digit
    // anywhere" against a prompt that asks for a number, so this passed.
    expect(sawNonce('The command printed 42.', NONCE)).toBe(false);
    expect(sawNonce('cebab-live-999999', NONCE)).toBe(false);
  });

  test('rejects an answer with no nonce at all', () => {
    expect(sawNonce("I don't have that context.", NONCE)).toBe(false);
    expect(sawNonce('', NONCE)).toBe(false);
  });

  test('rejects a truncated nonce', () => {
    expect(sawNonce('cebab-live-4829', NONCE)).toBe(false);
  });
});
