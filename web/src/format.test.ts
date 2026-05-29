import { describe, expect, test } from 'vitest';
import { formatElapsed, formatResultDuration } from './format';

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
