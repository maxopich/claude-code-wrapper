import { describe, expect, test } from 'vitest';
import type { TemplateLastRun } from '@cebab/shared/protocol';
import { deriveLastRunLabel } from './MultiAgentTab';

/**
 * PR-7 (round-2 plan): the "Last run" rail's label is derived at render
 * time from `(status, hopsUsed === hopBudget)`. The mapping is the
 * decision-log table U2 — these tests pin the canonical mapping so a
 * future change to either axis can't silently regress the chip color.
 */

function row(overrides: Partial<TemplateLastRun>): TemplateLastRun {
  return {
    sessionId: 's1',
    startedAt: 1_000_000,
    endedAt: 2_000_000,
    status: 'completed',
    hopsUsed: 5,
    hopBudget: 12,
    ...overrides,
  };
}

describe('deriveLastRunLabel — PR-7 status mapping', () => {
  test('completed AND hops_used < hop_budget → ok (green)', () => {
    expect(deriveLastRunLabel(row({ status: 'completed', hopsUsed: 5, hopBudget: 12 }))).toEqual({
      kind: 'ok',
      text: 'ok',
    });
  });

  test('completed AND hops_used === hop_budget → at cap (yellow)', () => {
    expect(deriveLastRunLabel(row({ status: 'completed', hopsUsed: 12, hopBudget: 12 }))).toEqual({
      kind: 'at-cap',
      text: 'at cap',
    });
  });

  test('completed AND hops_used > hop_budget → at cap (defensive ≥)', () => {
    // A trailing synthetic budget event could push hops_used past the cap
    // in pathological cases. Treat as "at cap", not "ok".
    expect(deriveLastRunLabel(row({ status: 'completed', hopsUsed: 13, hopBudget: 12 }))).toEqual({
      kind: 'at-cap',
      text: 'at cap',
    });
  });

  test('crashed → failed (red), regardless of hops', () => {
    expect(deriveLastRunLabel(row({ status: 'crashed', hopsUsed: 1, hopBudget: 12 }))).toEqual({
      kind: 'failed',
      text: 'failed',
    });
    expect(deriveLastRunLabel(row({ status: 'crashed', hopsUsed: 12, hopBudget: 12 }))).toEqual({
      kind: 'failed',
      text: 'failed',
    });
  });

  test('stopped well under cap → interrupted (gray)', () => {
    // Operator pulled the cord before the budget tripped.
    expect(deriveLastRunLabel(row({ status: 'stopped', hopsUsed: 4, hopBudget: 12 }))).toEqual({
      kind: 'interrupted',
      text: 'interrupted',
    });
  });

  test('stopped AT cap → at cap (router auto-stopped on budget exhaust)', () => {
    // The router's budget-exhausted path teardowns with reason='stopped'.
    // That row is "at cap" — meaningfully different from a hand-Stop.
    expect(deriveLastRunLabel(row({ status: 'stopped', hopsUsed: 12, hopBudget: 12 }))).toEqual({
      kind: 'at-cap',
      text: 'at cap',
    });
  });

  test('running → running (rare; rail typically hides while live)', () => {
    expect(deriveLastRunLabel(row({ status: 'running', hopsUsed: null, hopBudget: 12 }))).toEqual({
      kind: 'running',
      text: 'running',
    });
  });

  test('null hopsUsed never trips at-cap (clean completed → ok)', () => {
    // Teardown failed to write hops_used; the row should still render as
    // "ok" if it completed cleanly — better than misleading "at cap".
    expect(deriveLastRunLabel(row({ status: 'completed', hopsUsed: null, hopBudget: 12 }))).toEqual(
      {
        kind: 'ok',
        text: 'ok',
      },
    );
  });

  test('null hopBudget never trips at-cap (pre-013 rows)', () => {
    // Pre-013 rows have hop_budget = NULL. Render as "ok" on completed,
    // not "at cap" — we have no axis to compare against.
    expect(deriveLastRunLabel(row({ status: 'completed', hopsUsed: 7, hopBudget: null }))).toEqual({
      kind: 'ok',
      text: 'ok',
    });
  });
});
