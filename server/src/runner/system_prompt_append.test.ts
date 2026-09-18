/**
 * `Cebab-0fgx`: the composer loses nothing.
 *
 * Its whole reason to exist is that `{ ...a, ...b }` over two specs writing the
 * same key silently keeps only `b`. So the case that matters is the one that
 * asserts BOTH contributions survive — a composer that returned only the last
 * section would pass a suite that checked the shape, the separator and the
 * empty cases, and would be the exact bug it was written to prevent.
 */
import { describe, expect, test } from 'vitest';

import { composeSystemPromptAppend } from './system_prompt_append.js';

describe('composeSystemPromptAppend', () => {
  test('THE POINT: two contributions both survive, in the order given', () => {
    const out = composeSystemPromptAppend(
      { systemPromptAppend: 'FIRST' },
      { systemPromptAppend: 'SECOND' },
    );
    expect(out.systemPromptAppend).toContain('FIRST');
    expect(out.systemPromptAppend).toContain('SECOND');
    expect(out.systemPromptAppend!.indexOf('FIRST')).toBeLessThan(
      out.systemPromptAppend!.indexOf('SECOND'),
    );
  });

  test('sections are separated by a blank line, not run together', () => {
    // A single newline would let the last line of one section and the first of
    // the next read as one paragraph — which is how a heading stops looking
    // like a heading.
    expect(
      composeSystemPromptAppend({ systemPromptAppend: 'a' }, { systemPromptAppend: 'b' })
        .systemPromptAppend,
    ).toBe('a\n\nb');
  });

  test('nothing to add produces NO key, not an empty string', () => {
    // Absent-vs-empty is the distinction the spreadable-spec idiom exists to
    // preserve: a turn with nothing to add must spawn byte-identically to one
    // from before any of this existed.
    expect(composeSystemPromptAppend()).toEqual({});
    expect(composeSystemPromptAppend({}, {})).toEqual({});
    expect(composeSystemPromptAppend({}, {}).systemPromptAppend).toBeUndefined();
  });

  test('an empty or whitespace-only section is dropped, not joined', () => {
    // A spec returning `''` means "nothing to say". Joining it would open the
    // appended text with a stray blank block.
    expect(
      composeSystemPromptAppend({ systemPromptAppend: '' }, { systemPromptAppend: 'real' })
        .systemPromptAppend,
    ).toBe('real');
    expect(
      composeSystemPromptAppend({ systemPromptAppend: '   \n  ' }, { systemPromptAppend: 'real' })
        .systemPromptAppend,
    ).toBe('real');
    expect(composeSystemPromptAppend({ systemPromptAppend: '  ' })).toEqual({});
  });

  test('a single contribution is passed through unchanged', () => {
    // No separator, no wrapper: the one-producer case must stay identical to
    // what that producer would have shipped on its own, or adopting the
    // composer would itself be a change to every existing turn.
    expect(composeSystemPromptAppend({ systemPromptAppend: 'solo' }).systemPromptAppend).toBe(
      'solo',
    );
  });
});
