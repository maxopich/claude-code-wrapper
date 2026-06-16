import { describe, expect, test } from 'vitest';
import type { ContentBlock } from '@cebab/shared/protocol';
import { formatElapsed, formatResultDuration, messageCopyText } from './format';
import type { MessageView } from './store';

// Cluster H B5 — pins both formatters' contracts. `formatElapsed` is the
// live `M:SS` ticker for the thinking indicator; `formatResultDuration` is
// the past-tense per-turn footer formatter with three bands.

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
