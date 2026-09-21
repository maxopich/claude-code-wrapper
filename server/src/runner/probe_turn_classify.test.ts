/**
 * [security-adjacent] The scoring guard PR #594 lacked (`Cebab-6fax.40.1`).
 *
 * The live smoke `probe_no_model_turn_smoke.ts` cannot run in CI — it spends a
 * real model turn and needs the operator's credentials. So the part of it that
 * can be wrong on paper — the SCORING — lives in a pure function here and is
 * pinned with fixture JSONL. Each case NAMES the verdict it must produce;
 * reverting a branch of `classifyProbeTurn` (or the vacuity guard in
 * particular) reddens the case that describes it. The first draft treated
 * "user entry present, no assistant entry" as a confirmed pass; that is the
 * `user-only, no stream signal` case below, and it must be INCONCLUSIVE.
 */
import { describe, expect, test } from 'vitest';

import {
  classifyProbeTurn,
  parseTranscript,
  type ProbeStreamSignals,
  type TranscriptCounts,
} from './probe_turn_classify.js';

/** A transcript line for a real, billed model reply. */
const REAL_REPLY = JSON.stringify({
  type: 'assistant',
  message: { usage: { output_tokens: 16 } },
});
/** The `user` prompt the CLI writes at session start (before init). */
const USER_ENTRY = JSON.stringify({ type: 'user', message: { role: 'user' } });
/** An assistant entry the CLI fabricated for an API failure — 0 tokens. */
const API_ERROR = JSON.stringify({
  type: 'assistant',
  isApiErrorMessage: true,
  message: { content: [{ type: 'text', text: 'Please run /login' }], usage: { output_tokens: 0 } },
});
/** An assistant entry with no output tokens and no error flag. */
const EMPTY_ASSISTANT = JSON.stringify({
  type: 'assistant',
  message: { usage: { output_tokens: 0 } },
});

/** A control transcript that DID capture a real turn, so `control-failed` never
 *  fires for the probe-side cases below. */
const GOOD_CONTROL: TranscriptCounts = parseTranscript(`${USER_ENTRY}\n${REAL_REPLY}`);

/** Default: init arrived, and we did NOT read past init and saw nothing. */
function stream(overrides: Partial<ProbeStreamSignals> = {}): ProbeStreamSignals {
  return { initArrived: true, requestingObserved: false, streamReadPastInit: false, ...overrides };
}

describe('parseTranscript', () => {
  test('missing file → present:false and all zero', () => {
    const c = parseTranscript(null);
    expect(c.present).toBe(false);
    expect(c.userEntries).toBe(0);
    expect(c.realAssistant).toBe(0);
  });

  test('a real reply counts as realAssistant with its tokens', () => {
    const c = parseTranscript(`${USER_ENTRY}\n${REAL_REPLY}`);
    expect(c.present).toBe(true);
    expect(c.userEntries).toBe(1);
    expect(c.realAssistant).toBe(1);
    expect(c.outputTokens).toBe(16);
    expect(c.errorAssistant).toBe(0);
  });

  test('an API-error entry is errorAssistant, never realAssistant', () => {
    const c = parseTranscript(API_ERROR);
    expect(c.errorAssistant).toBe(1);
    expect(c.realAssistant).toBe(0);
  });

  test('a 0-token assistant entry is emptyAssistant, never realAssistant', () => {
    const c = parseTranscript(EMPTY_ASSISTANT);
    expect(c.emptyAssistant).toBe(1);
    expect(c.realAssistant).toBe(0);
  });

  test('malformed lines are skipped, not thrown on', () => {
    const c = parseTranscript(`not json\n${REAL_REPLY}\n{`);
    expect(c.realAssistant).toBe(1);
  });
});

describe('classifyProbeTurn', () => {
  test('control failed (no real assistant) → exit 2, control-failed', () => {
    const badControl = parseTranscript(`${USER_ENTRY}\n${API_ERROR}`);
    const r = classifyProbeTurn({
      control: badControl,
      probe: parseTranscript(`${USER_ENTRY}\n${REAL_REPLY}`),
      stream: stream(),
    });
    expect(r.verdict).toBe('control-failed');
    expect(r.exitCode).toBe(2);
  });

  test('probe never reached init → exit 2, probe-no-init', () => {
    const r = classifyProbeTurn({
      control: GOOD_CONTROL,
      probe: parseTranscript(null),
      stream: stream({ initArrived: false }),
    });
    expect(r.verdict).toBe('probe-no-init');
    expect(r.exitCode).toBe(2);
  });

  test('real reply recorded → the FINDING, exit 1', () => {
    const r = classifyProbeTurn({
      control: GOOD_CONTROL,
      probe: parseTranscript(`${USER_ENTRY}\n${REAL_REPLY}`),
      stream: stream(),
    });
    expect(r.verdict).toBe('reply-recorded');
    expect(r.replyRecorded).toBe(true);
    expect(r.requestSent).toBe(true);
    expect(r.exitCode).toBe(1);
  });

  test('requesting observed, no recorded reply → the FINDING, exit 1', () => {
    const r = classifyProbeTurn({
      control: GOOD_CONTROL,
      probe: parseTranscript(USER_ENTRY),
      stream: stream({ requestingObserved: true }),
    });
    expect(r.verdict).toBe('request-sent');
    expect(r.requestSent).toBe(true);
    expect(r.replyRecorded).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  // THE VACUITY GUARD. This is what PR #594 scored as a pass. "user present, no
  // assistant" with no positive stream signal is a lower bound only.
  test('user-only, no stream signal → INCONCLUSIVE, never a pass (exit 2)', () => {
    const r = classifyProbeTurn({
      control: GOOD_CONTROL,
      probe: parseTranscript(USER_ENTRY),
      stream: stream(),
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.requestSent).toBeNull();
    expect(r.exitCode).toBe(2);
  });

  test('missing probe transcript, no stream signal → INCONCLUSIVE (exit 2)', () => {
    const r = classifyProbeTurn({
      control: GOOD_CONTROL,
      probe: parseTranscript(null),
      stream: stream(),
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.exitCode).toBe(2);
  });

  test('a 0-token assistant entry, no stream signal → INCONCLUSIVE (exit 2)', () => {
    const r = classifyProbeTurn({
      control: GOOD_CONTROL,
      probe: parseTranscript(`${USER_ENTRY}\n${EMPTY_ASSISTANT}`),
      stream: stream(),
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.exitCode).toBe(2);
  });

  test('an API-error entry is INCONCLUSIVE even when the stream was read clean', () => {
    // streamReadPastInit + no requesting would otherwise be `no-request`; the
    // error entry blocks that — a fabricated failure is not proof nothing sent.
    const r = classifyProbeTurn({
      control: GOOD_CONTROL,
      probe: parseTranscript(`${USER_ENTRY}\n${API_ERROR}`),
      stream: stream({ streamReadPastInit: true }),
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.exitCode).toBe(2);
  });

  test('stream read past init with no requesting and no error → no-request, exit 0', () => {
    const r = classifyProbeTurn({
      control: GOOD_CONTROL,
      probe: parseTranscript(USER_ENTRY),
      stream: stream({ streamReadPastInit: true }),
    });
    expect(r.verdict).toBe('no-request');
    expect(r.requestSent).toBe(false);
    expect(r.exitCode).toBe(0);
  });
});
