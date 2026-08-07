import { describe, expect, test } from 'vitest';
import { stripComments } from './sourceScan';

/**
 * One clipboard implementation, and it is the one with the fallback
 * (register U42).
 *
 * `clipboard.ts` has said since it was written that it exists "so message copy
 * buttons (and any future caller) share one implementation". That was never
 * true. The helper was lifted out of `authority/McpServersList.tsx` and the
 * original was never deleted, so the very file it came from kept its own copy;
 * five other sites called `navigator.clipboard` directly, none of them with
 * the `execCommand` fallback, most of them reporting neither success nor
 * failure to the operator.
 *
 * A comment cannot hold a convergence together. This can: `clipboard.ts` is
 * the only file in `web/src` allowed to name `navigator.clipboard`. Everything
 * else goes through `copyToClipboard`, or through `useCopyFeedback` when there
 * is a visible affordance to flip.
 *
 * Tests are excluded — a spec stubbing `navigator.clipboard` to observe a call
 * is doing the opposite of hand-rolling one, and forcing them through the
 * helper would make them assert on the helper instead of the component.
 */

const ALLOWED_FILE = './clipboard.ts';

const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob(['./**/*.ts', './**/*.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).filter(([file]) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx')),
);

/** Files naming the raw API in code (not in prose — comments are stripped). */
function callers(): string[] {
  return Object.entries(SOURCES)
    .filter(([, src]) => stripComments(src).includes('navigator.clipboard'))
    .map(([file]) => file)
    .sort();
}

describe('clipboard convergence', () => {
  // Anti-vacuity in both directions: the glob found the app, AND the one file
  // that is supposed to contain the call really does. Without the second
  // assertion this gate would pass just as well if `clipboard.ts` were deleted
  // and every caller left hand-rolling — the "zero matches" reading of a rule
  // written as "at most one".
  test('the scan reads the app and finds the shared helper', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(60);
    expect(stripComments(SOURCES[ALLOWED_FILE] ?? '')).toContain('navigator.clipboard');
  });

  test('only clipboard.ts touches navigator.clipboard directly', () => {
    expect(callers(), 'route clipboard writes through copyToClipboard').toEqual([ALLOWED_FILE]);
  });
});
