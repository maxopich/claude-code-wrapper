import { describe, expect, test } from 'vitest';
import { parseAutoReclaimDays } from './config.js';

// P0-C part 2b: CEBAB_AUTO_RECLAIM_DAYS parsing. The feature is destructive
// (soft-delete), so anything that isn't a clear positive integer resolves to
// null = OFF.
describe('parseAutoReclaimDays', () => {
  test('unset / blank → null (feature off)', () => {
    expect(parseAutoReclaimDays(undefined)).toBeNull();
    expect(parseAutoReclaimDays('')).toBeNull();
    expect(parseAutoReclaimDays('   ')).toBeNull();
  });

  test('non-numeric / non-positive → null', () => {
    expect(parseAutoReclaimDays('abc')).toBeNull();
    expect(parseAutoReclaimDays('0')).toBeNull();
    expect(parseAutoReclaimDays('-5')).toBeNull();
    expect(parseAutoReclaimDays('NaN')).toBeNull();
  });

  test('positive integer → that number', () => {
    expect(parseAutoReclaimDays('30')).toBe(30);
    expect(parseAutoReclaimDays('1')).toBe(1);
  });

  test('fractional values floor', () => {
    expect(parseAutoReclaimDays('30.7')).toBe(30);
  });
});
