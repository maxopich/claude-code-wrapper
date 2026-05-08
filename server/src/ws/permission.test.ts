import { describe, expect, test } from 'vitest';
import { FILE_EDIT_TOOLS, shouldAutoAllow } from './permission.js';

describe('shouldAutoAllow', () => {
  test('trusted projects auto-allow every tool, regardless of mode', () => {
    expect(shouldAutoAllow(true, 'default', 'Edit')).toBe(true);
    expect(shouldAutoAllow(true, 'default', 'Bash')).toBe(true);
    expect(shouldAutoAllow(true, 'acceptEdits', 'WebFetch')).toBe(true);
  });

  test('untrusted + default always asks (Edit included)', () => {
    expect(shouldAutoAllow(false, 'default', 'Edit')).toBe(false);
    expect(shouldAutoAllow(false, 'default', 'Write')).toBe(false);
    expect(shouldAutoAllow(false, 'default', 'Bash')).toBe(false);
  });

  test('untrusted + acceptEdits auto-allows file-edit tools', () => {
    expect(shouldAutoAllow(false, 'acceptEdits', 'Edit')).toBe(true);
    expect(shouldAutoAllow(false, 'acceptEdits', 'Write')).toBe(true);
    expect(shouldAutoAllow(false, 'acceptEdits', 'NotebookEdit')).toBe(true);
  });

  test('untrusted + acceptEdits still asks for non-edit tools', () => {
    // The whole point of "acceptEdits" vs "bypassPermissions" is that shell &
    // network tools keep asking. Regression-guard the boundary.
    expect(shouldAutoAllow(false, 'acceptEdits', 'Bash')).toBe(false);
    expect(shouldAutoAllow(false, 'acceptEdits', 'WebFetch')).toBe(false);
    expect(shouldAutoAllow(false, 'acceptEdits', 'Read')).toBe(false);
  });

  test('FILE_EDIT_TOOLS is the canonical list, frozen via ReadonlySet', () => {
    expect([...FILE_EDIT_TOOLS].sort()).toEqual(['Edit', 'NotebookEdit', 'Write']);
  });
});
