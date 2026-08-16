import { describe, expect, test } from 'vitest';
import type { ContentBlock } from '@cebab/shared/protocol';
import {
  formatElapsed,
  formatResultDuration,
  messageCopyText,
  timeAgo,
  timeAgoCompact,
} from './format';
import type { MessageView } from './store';

// Cluster H B5 — pins both formatters' contracts. `formatElapsed` is the
// live `M:SS` ticker for the thinking indicator; `formatResultDuration` is
// the past-tense per-turn footer formatter with three bands.

/**
 * Register N14. `timeAgo` / `timeAgoCompact` replaced SEVEN implementations
 * across six files. Every case below is a rule one of those seven broke — the
 * point is not coverage for its own sake but that each of the three axes they
 * disagreed on (rounding, sub-minute, clock skew) now has exactly one answer,
 * pinned.
 *
 * `NOW` is a fixed instant and every call passes it. These functions default
 * `now` to `Date.now()`, and a test that let them do so would be pinning the
 * wall clock: the 59s→60s boundary cases would flake by a millisecond.
 */
const NOW = 1_700_000_000_000;
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('timeAgo / timeAgoCompact (register N14)', () => {
  test('THE defect: 90 seconds is 1m, not 2m', () => {
    // The case that proves the whole finding. Three of the seven rounded, so
    // 90s elapsed rendered as `1m` in the sidebar and `2m ago` in the
    // multi-agent tab — at the same moment, about the same timestamp. Floor is
    // the answer because rounding OVERSTATES elapsed time.
    expect(timeAgo(NOW - 90 * SEC, NOW)).toBe('1m ago');
    expect(timeAgoCompact(NOW - 90 * SEC, NOW)).toBe('1m');
  });

  test('floors within every band, never rounds up', () => {
    // Each offset is deliberately NOT a whole unit — a fixture on a band
    // boundary makes floor and round agree, and the revert-check caught
    // exactly that: with only whole-second offsets, swapping the seconds
    // `Math.floor` for `Math.round` reddened nothing. The fractional-second
    // case below is the one that separates them.
    expect(timeAgo(NOW - 1_500, NOW)).toBe('1s ago'); // not "2s ago"
    expect(timeAgo(NOW - 59_900, NOW)).toBe('59s ago'); // not "1m ago"
    expect(timeAgo(NOW - 31 * SEC, NOW)).toBe('31s ago');
    expect(timeAgo(NOW - 59 * MIN - 59 * SEC, NOW)).toBe('59m ago');
    expect(timeAgo(NOW - 23 * HOUR - 59 * MIN, NOW)).toBe('23h ago');
    expect(timeAgoCompact(NOW - 1_500, NOW)).toBe('1s');
  });

  test('band boundaries land on the larger unit exactly at the threshold', () => {
    expect(timeAgo(NOW - 60 * SEC, NOW)).toBe('1m ago');
    expect(timeAgo(NOW - 60 * MIN, NOW)).toBe('1h ago');
    expect(timeAgo(NOW - 24 * HOUR, NOW)).toBe('1d ago');
    expect(timeAgo(NOW - 400 * DAY, NOW)).toBe('400d ago'); // no year band, by design
  });

  test('keeps a seconds band rather than collapsing to "just now"', () => {
    // Two of the seven said "just now" under a minute. Collapsing them all
    // would discard information on the auth banner, where how stale the
    // session is IS the message.
    expect(timeAgo(NOW - 3 * SEC, NOW)).toBe('3s ago');
    expect(timeAgo(NOW, NOW)).toBe('0s ago');
  });

  test('clamps clock skew instead of rendering a negative age', () => {
    // Three of the seven leaked `-5s` / `-0m ago` when a timestamp arrived
    // from a server running ahead. `format.ts` already states this rule twice
    // for its duration formatters; it now holds here too.
    expect(timeAgo(NOW + 10 * SEC, NOW)).toBe('0s ago');
    expect(timeAgoCompact(NOW + 10 * SEC, NOW)).toBe('0s');
  });

  test('clamps non-finite inputs rather than rendering NaN', () => {
    expect(timeAgo(Number.NaN, NOW)).toBe('0s ago');
    expect(timeAgoCompact(Number.NaN, NOW)).toBe('0s');
    expect(timeAgo(NOW - MIN, Number.NaN)).toBe('0s ago');
  });

  test('the two exports differ ONLY by suffix, at the same instant', () => {
    // The compact/prose split is the one contextual difference that survived.
    // If the two ever disagree on magnitude, they have stopped sharing a core
    // and the duplication is back.
    for (const ago of [0, 45 * SEC, 90 * SEC, 5 * HOUR, 3 * DAY]) {
      expect(timeAgo(NOW - ago, NOW)).toBe(`${timeAgoCompact(NOW - ago, NOW)} ago`);
    }
  });

  test('honours an injected now instead of the wall clock', () => {
    // `buildAuthExpiredBannerItem` threads its own `now` for testability, and
    // that has to keep working — otherwise its four banner assertions start
    // measuring real time.
    expect(timeAgo(NOW - 5 * MIN, NOW)).toBe('5m ago');
    expect(timeAgo(NOW - 5 * MIN, NOW + HOUR)).toBe('1h ago');
  });
});

describe('formatElapsed', () => {
  test('renders 0:00 for zero / sub-second', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(500)).toBe('0:00');
  });

  test('renders M:SS under an hour', () => {
    expect(formatElapsed(1_000)).toBe('0:01');
    expect(formatElapsed(59_000)).toBe('0:59');
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(125_000)).toBe('2:05');
  });

  test('renders H:MM:SS at and above one hour', () => {
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });

  test('clamps negative / NaN to 0:00', () => {
    expect(formatElapsed(-1_000)).toBe('0:00');
    expect(formatElapsed(Number.NaN)).toBe('0:00');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('formatResultDuration', () => {
  describe('band 1: sub-second → "Nms"', () => {
    test('zero renders as 0ms', () => {
      expect(formatResultDuration(0)).toBe('0ms');
    });

    test('sub-millisecond rounds to whole ms', () => {
      expect(formatResultDuration(0.4)).toBe('0ms');
      expect(formatResultDuration(0.6)).toBe('1ms');
    });

    test('typical values inside the band', () => {
      expect(formatResultDuration(42)).toBe('42ms');
      expect(formatResultDuration(500)).toBe('500ms');
      expect(formatResultDuration(999)).toBe('999ms');
    });
  });

  describe('band 2: 1s..<60s → "N.Ns"', () => {
    test('exactly 1000ms crosses into the seconds band', () => {
      expect(formatResultDuration(1_000)).toBe('1.0s');
    });

    test('decimal seconds rendered with one fractional digit', () => {
      expect(formatResultDuration(2_400)).toBe('2.4s');
      expect(formatResultDuration(2_450)).toBe('2.5s'); // rounding
      expect(formatResultDuration(12_345)).toBe('12.3s');
    });

    test('59.9s stays in the seconds band', () => {
      expect(formatResultDuration(59_900)).toBe('59.9s');
    });
  });

  describe('band 3: >=60s → "Nm Ns"', () => {
    test('exactly 60s crosses into minutes', () => {
      expect(formatResultDuration(60_000)).toBe('1m 0s');
    });

    test('typical multi-minute durations', () => {
      expect(formatResultDuration(72_000)).toBe('1m 12s');
      expect(formatResultDuration(125_000)).toBe('2m 5s');
      expect(formatResultDuration(3_725_000)).toBe('62m 5s'); // no hours band
    });

    test('rounding into the next minute carries through to seconds', () => {
      // 59.6s -> rounds to 60s -> "1m 0s".
      expect(formatResultDuration(59_600)).toBe('59.6s'); // still sub-60s
      // But >= 60_000 deliberately goes to the rounded minute form.
      expect(formatResultDuration(60_500)).toBe('1m 1s'); // 60.5s rounds to 61s
    });
  });

  describe('input guards', () => {
    test('negative inputs clamp to 0ms', () => {
      expect(formatResultDuration(-1)).toBe('0ms');
      expect(formatResultDuration(-1_000_000)).toBe('0ms');
    });

    test('NaN / +Infinity clamp to 0ms', () => {
      expect(formatResultDuration(Number.NaN)).toBe('0ms');
      expect(formatResultDuration(Number.POSITIVE_INFINITY)).toBe('0ms');
    });
  });
});

// messageCopyText backs the per-message hover copy button in MessageBlock:
// which kinds are copyable and what text they yield.
describe('messageCopyText', () => {
  test('user / command_output / error return their raw text', () => {
    const user: MessageView = { kind: 'user', id: 'u', text: 'hi there' };
    const cmd: MessageView = { kind: 'command_output', id: 'c', text: 'cli out' };
    const err: MessageView = { kind: 'error', id: 'e', errorKind: 'auth_expired', message: 'boom' };
    expect(messageCopyText(user)).toBe('hi there');
    expect(messageCopyText(cmd)).toBe('cli out');
    expect(messageCopyText(err)).toBe('boom');
  });

  test('empty text yields null (no copy button)', () => {
    const user: MessageView = { kind: 'user', id: 'u', text: '' };
    expect(messageCopyText(user)).toBeNull();
  });

  test('assistant joins its text blocks with blank lines', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ];
    const a: MessageView = { kind: 'assistant', id: 'a', blocks };
    expect(messageCopyText(a)).toBe('line one\n\nline two');
  });

  test('assistant drops non-text blocks, keeping only the prose', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'keep me' },
      { type: 'tool_use', id: 't', name: 'Read', input: {} },
      { type: 'thinking', text: 'private reasoning' },
    ];
    const a: MessageView = { kind: 'assistant', id: 'a', blocks };
    expect(messageCopyText(a)).toBe('keep me');
  });

  test('assistant with no prose (tool-only / empty / whitespace) yields null', () => {
    const toolOnly: MessageView = {
      kind: 'assistant',
      id: 'a',
      blocks: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }],
    };
    const empty: MessageView = { kind: 'assistant', id: 'a', blocks: [] };
    const blank: MessageView = {
      kind: 'assistant',
      id: 'a',
      blocks: [{ type: 'text', text: '   ' }],
    };
    expect(messageCopyText(toolOnly)).toBeNull();
    expect(messageCopyText(empty)).toBeNull();
    expect(messageCopyText(blank)).toBeNull();
  });

  test('result / system / permission_request have no copy text', () => {
    const result: MessageView = { kind: 'result', id: 'r', subtype: 'success', cost: 0 };
    const system: MessageView = { kind: 'system', id: 's', subtype: 'x', text: 'noise' };
    const perm: MessageView = {
      kind: 'permission_request',
      id: 'p',
      requestId: 'r1',
      toolName: 'Bash',
      input: {},
    };
    expect(messageCopyText(result)).toBeNull();
    expect(messageCopyText(system)).toBeNull();
    expect(messageCopyText(perm)).toBeNull();
  });
});
