import { describe, expect, test } from 'vitest';
import { sanitizeForPrompt } from './sanitize.js';

describe('sanitizeForPrompt', () => {
  test('passes through plain text unchanged', () => {
    expect(sanitizeForPrompt('Reviewer')).toBe('Reviewer');
    expect(sanitizeForPrompt('hello world 42')).toBe('hello world 42');
  });

  test('strips all C0/C1 control chars including newline, tab, and NUL', () => {
    // F6: renderers inline values into single-line structured layouts
    // (`- <participant>x</participant> — projectName`), so raw newlines
    // would let an attacker break out and inject top-level instructions.
    // Strip the whole C0/C1 range; the values that flow through here
    // (agent slugs, project names) carry no legitimate control chars.
    const raw = 'a\nb\tc\rd\x00e';
    expect(sanitizeForPrompt(raw)).toBe('abcde');
  });

  test('strips < > & so the <participant> wrap stays well-formed', () => {
    expect(sanitizeForPrompt('Reviewer<script>alert(1)</script>')).toBe(
      'Reviewerscriptalert(1)/script',
    );
    expect(sanitizeForPrompt('A & B')).toBe('A  B');
  });

  test('truncates input longer than maxLen with an ellipsis', () => {
    const long = 'x'.repeat(100);
    const out = sanitizeForPrompt(long, 10);
    expect(out).toBe('xxxxxxxxxx…');
  });

  test('does not truncate input at exactly maxLen', () => {
    const exact = 'x'.repeat(10);
    expect(sanitizeForPrompt(exact, 10)).toBe(exact);
  });
});
