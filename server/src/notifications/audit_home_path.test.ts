import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { collapseHomePath, collapseHomePathsInPayload } from './audit_home_path.js';

const home = os.homedir();
const under = path.join(home, 'agents', 'foo');
const collapsedUnder = '~' + under.slice(home.length);

describe('collapseHomePath', () => {
  test('a path under home has its prefix replaced by ~', () => {
    expect(collapseHomePath(under)).toBe(collapsedUnder);
    expect(collapseHomePath(under)).not.toContain(home);
  });

  test('the home directory itself becomes ~', () => {
    expect(collapseHomePath(home)).toBe('~');
  });

  test('a sibling whose name merely starts with home is unchanged', () => {
    // The boundary after the prefix must be a separator; here it is `X`.
    const sibling = home + 'X' + path.sep + 'agents';
    expect(collapseHomePath(sibling)).toBe(sibling);
  });

  test('the home string appearing mid-value is unchanged', () => {
    const mid = path.sep + 'backup' + home + path.sep + 'x';
    expect(collapseHomePath(mid)).toBe(mid);
  });

  test('a path outside home is returned verbatim', () => {
    const outside = path.sep + path.join('var', 'tmp', 'foo');
    expect(collapseHomePath(outside)).toBe(outside);
  });
});

describe('collapseHomePathsInPayload', () => {
  test('collapses strings nested in objects and arrays', () => {
    const out = collapseHomePathsInPayload({
      path: under,
      names: [under, 'literal'],
      nested: { dest: under },
      count: 3,
    }) as {
      path: string;
      names: string[];
      nested: { dest: string };
      count: number;
    };
    expect(out.path).toBe(collapsedUnder);
    expect(out.names).toEqual([collapsedUnder, 'literal']);
    expect(out.nested.dest).toBe(collapsedUnder);
    expect(out.count).toBe(3);
  });

  test('object keys are not rewritten, only values', () => {
    const out = collapseHomePathsInPayload({ [under]: 'v' }) as Record<string, string>;
    expect(Object.keys(out)).toEqual([under]);
  });

  test('null and primitive leaves pass through', () => {
    expect(collapseHomePathsInPayload(null)).toBe(null);
    expect(collapseHomePathsInPayload(42)).toBe(42);
    expect(collapseHomePathsInPayload(true)).toBe(true);
    expect(collapseHomePathsInPayload(home)).toBe('~');
  });
});
