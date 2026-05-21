import { describe, expect, it } from 'vitest';
import type { LogRow } from '@cebab/shared/protocol';
import { applyLogFilters } from './useLogFilters';

function row(over: Partial<LogRow>): LogRow {
  return {
    id: 'event:1',
    ts: 1000,
    agent: 'reviewer',
    kind: 'bus',
    summary: 'reviewer → planner please review',
    status: 'prompt',
    ...over,
  };
}

describe('applyLogFilters', () => {
  it('returns all rows when no filters are set', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    expect(applyLogFilters(rows, { search: '', agents: new Set(), kinds: new Set() })).toHaveLength(
      2,
    );
  });

  it('filters by agent membership (multi-select OR within the field)', () => {
    const rows = [row({ agent: 'a' }), row({ agent: 'b' }), row({ agent: 'c' })];
    const out = applyLogFilters(rows, {
      search: '',
      agents: new Set(['a', 'c']),
      kinds: new Set(),
    });
    expect(out.map((r) => r.agent)).toEqual(['a', 'c']);
  });

  it('filters by kind membership (multi-select OR within the field)', () => {
    const rows = [
      row({ id: 'a', kind: 'bus' }),
      row({ id: 'b', kind: 'tool' }),
      row({ id: 'c', kind: 'error' }),
    ];
    const out = applyLogFilters(rows, {
      search: '',
      agents: new Set(),
      kinds: new Set(['tool', 'error']),
    });
    expect(out.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('composes agent + kind + search with AND', () => {
    const rows = [
      row({ id: 'a', agent: 'rev', kind: 'bus', summary: 'foo' }),
      row({ id: 'b', agent: 'rev', kind: 'tool', summary: 'foo' }),
      row({ id: 'c', agent: 'oth', kind: 'tool', summary: 'foo' }),
      row({ id: 'd', agent: 'rev', kind: 'tool', summary: 'bar' }),
    ];
    const out = applyLogFilters(rows, {
      search: 'foo',
      agents: new Set(['rev']),
      kinds: new Set(['tool']),
    });
    expect(out.map((r) => r.id)).toEqual(['b']);
  });

  it('search matches summary case-insensitively', () => {
    const rows = [row({ summary: 'Update PLAN.md' })];
    expect(
      applyLogFilters(rows, { search: 'plan.md', agents: new Set(), kinds: new Set() }),
    ).toHaveLength(1);
  });

  it('search matches raw blob via JSON.stringify', () => {
    const rows = [row({ raw: { toolName: 'Write', filePath: '/p/PLAN.md' } })];
    const out = applyLogFilters(rows, {
      search: 'plan.md',
      agents: new Set(),
      kinds: new Set(),
    });
    expect(out).toHaveLength(1);
  });

  it('search misses when no field contains the substring', () => {
    const rows = [row({ summary: 'hello', agent: 'a', raw: { x: 1 } })];
    expect(applyLogFilters(rows, { search: 'nope', agents: new Set(), kinds: new Set() })).toEqual(
      [],
    );
  });
});
