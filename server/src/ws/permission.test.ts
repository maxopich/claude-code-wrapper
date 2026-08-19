import { describe, expect, test } from 'vitest';
import { FILE_EDIT_TOOLS, shouldAutoAllow } from './permission.js';

describe('shouldAutoAllow', () => {
  // REWRITTEN, not deleted (Cebab-ws0.14). This block used to read:
  //
  //   test('trusted projects auto-allow every tool, regardless of mode', …)
  //     expect(shouldAutoAllow(true, 'default', 'Edit')).toBe(true);
  //     expect(shouldAutoAllow(true, 'default', 'Bash')).toBe(true);
  //
  // Those assertions were not wrong about the code — they pinned a deliberate
  // design, "Trust is the operator's blanket I-vouch-for-this-directory gate".
  // The design is what changed: `mode: 'default'` now binds on trusted projects
  // too, because a control that moves and changes nothing is worse than no
  // control. The pill was already offering that choice and silently dropping it.
  //
  // The full table lives in one test so a future edit has to look at every cell
  // rather than at the one row it means to change.
  test('the auto-allow table', () => {
    // Trusted + acceptEdits — the blanket vouch, and the DEFAULT posture for a
    // trusted project (seedPermissionMode seeds acceptEdits). Unchanged, and
    // this row is what makes the change safe: nobody who leaves the pill alone
    // sees any difference.
    expect(shouldAutoAllow(true, 'acceptEdits', 'Edit')).toBe(true);
    expect(shouldAutoAllow(true, 'acceptEdits', 'Bash')).toBe(true);
    expect(shouldAutoAllow(true, 'acceptEdits', 'WebFetch')).toBe(true);

    // Trusted + default — THE ROW THAT MOVED. Asking is a narrowing; this
    // direction can never widen privilege, which is the whole reason it is
    // safe to change at all.
    expect(shouldAutoAllow(true, 'default', 'Edit')).toBe(false);
    expect(shouldAutoAllow(true, 'default', 'Bash')).toBe(false);
    expect(shouldAutoAllow(true, 'default', 'Read')).toBe(false);

    // Untrusted — both rows unchanged.
    expect(shouldAutoAllow(false, 'acceptEdits', 'Edit')).toBe(true);
    expect(shouldAutoAllow(false, 'acceptEdits', 'Bash')).toBe(false);
    expect(shouldAutoAllow(false, 'default', 'Edit')).toBe(false);
    expect(shouldAutoAllow(false, 'default', 'Bash')).toBe(false);
  });

  test('[security] ask mode never auto-allows anything, on any project', () => {
    // The property, stated independently of the table so it survives a table
    // edit: 'default' means ask, and no other input can override that. If any
    // future flag re-introduces a trusted-wins short-circuit, this is what
    // catches it.
    for (const trusted of [true, false]) {
      for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'Read', 'Task']) {
        expect({ trusted, tool, allowed: shouldAutoAllow(trusted, 'default', tool) }).toEqual({
          trusted,
          tool,
          allowed: false,
        });
      }
    }
  });

  test('[security] trust still widens acceptEdits beyond file edits', () => {
    // The counterweight to the test above, and the mutation it exists to catch:
    // collapsing the trusted case into the untrusted one would make every
    // assertion about 'default' still pass while quietly revoking Trust.
    expect(shouldAutoAllow(true, 'acceptEdits', 'Bash')).toBe(true);
    expect(shouldAutoAllow(false, 'acceptEdits', 'Bash')).toBe(false);
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
