import { describe, expect, test } from 'vitest';
import type { ManagedFileKind } from '@cebab/shared/protocol';
import {
  canSaveManagedEdit,
  initialState,
  managedEditorMode,
  reduce,
  type AppState,
} from './store';

/**
 * Cebab-ws0.10: the managed-config editor's state.
 *
 * The decisions here are all ones that are SILENT when wrong, which is why they
 * live in the reducer rather than in `App.tsx` (which has no test file):
 *
 *   - an answer for a tab the operator has left must not repaint the tab they
 *     are on with another file's bytes;
 *   - a successful save has to advance the concurrency token, or the second
 *     save of a sitting is refused as stale — a check that fires on correct
 *     use is worse than no check;
 *   - a failed save must keep the operator's text.
 */

const PID = 7;

function open(kind: ManagedFileKind = 'settings', state: AppState = initialState): AppState {
  return reduce(state, {
    type: 'managed_edit_open',
    projectId: PID,
    projectName: 'ledger-agent',
    kind,
  });
}

function fileMsg(
  kind: ManagedFileKind,
  over: Partial<{
    relPath: string;
    content: string;
    exists: boolean;
    mtimeMs: number;
    sensitive: boolean;
  }> = {},
  projectId = PID,
) {
  return {
    type: 'server' as const,
    msg: {
      type: 'managed_file' as const,
      projectId,
      kind,
      result: {
        ok: true as const,
        relPath: over.relPath ?? '.claude/settings.json',
        content: over.content ?? '{"a":1}',
        exists: over.exists ?? true,
        mtimeMs: over.mtimeMs ?? 111,
        sensitive: over.sensitive ?? true,
      },
    },
  };
}

const edit = (s: AppState) => s.managedEdit!;

describe('opening', () => {
  test('opens in loading with no draft — an empty box would invite typing into it', () => {
    const s = open();
    expect(edit(s).status).toBe('loading');
    expect(edit(s).draft).toBe(null);
    expect(managedEditorMode(edit(s))).toEqual({ mode: 'loading' });
  });

  test('the file lands and becomes editable', () => {
    const s = reduce(open(), fileMsg('settings', { content: '{"x":2}' }));
    expect(managedEditorMode(edit(s))).toEqual({
      mode: 'editing',
      content: '{"x":2}',
      creating: false,
    });
  });

  test('an absent file is EDITABLE and says it will be created', () => {
    // The case that must not be collapsed with the refusals: it looks like an
    // empty textarea and is the one of the three that is safe to type into.
    const s = reduce(open('mcp'), fileMsg('mcp', { content: '', exists: false, mtimeMs: 0 }));
    expect(managedEditorMode(edit(s))).toEqual({ mode: 'editing', content: '', creating: true });
  });

  test('a refusal renders instead of an editor', () => {
    const s = reduce(open('claude_md'), {
      type: 'server',
      msg: {
        type: 'managed_file',
        projectId: PID,
        kind: 'claude_md',
        result: { ok: false, refusal: 'too_large' },
      },
    });
    expect(managedEditorMode(edit(s))).toEqual({ mode: 'refused', refusal: 'too_large' });
  });
});

describe('late and foreign answers', () => {
  test('an answer for a tab the operator LEFT is ignored', () => {
    // The operator can switch tabs faster than a read completes. Without the
    // kind check the settings answer would repaint the .mcp.json tab with
    // settings bytes — and the operator would then save them there.
    let s = open('settings');
    s = reduce(s, { type: 'managed_edit_kind', kind: 'mcp' });
    s = reduce(s, fileMsg('settings', { content: 'SETTINGS BYTES' }));
    expect(edit(s).kind).toBe('mcp');
    expect(managedEditorMode(edit(s))).toEqual({ mode: 'loading' });
  });

  test('an answer for another project is ignored', () => {
    const s = reduce(open(), fileMsg('settings', { content: 'OTHER' }, PID + 1));
    expect(managedEditorMode(edit(s))).toEqual({ mode: 'loading' });
  });

  test('an answer with the modal closed is dropped rather than reopening it', () => {
    const s = reduce(reduce(open(), { type: 'managed_edit_close' }), fileMsg('settings'));
    expect(s.managedEdit).toBe(null);
  });
});

describe('saving', () => {
  function loaded(content = '{"a":1}'): AppState {
    return reduce(open(), fileMsg('settings', { content, mtimeMs: 111 }));
  }

  test('Save is off until the buffer differs from what was read', () => {
    // An always-enabled Save invites a no-op write, and every write here
    // appends an audit row.
    const s = loaded();
    expect(canSaveManagedEdit(edit(s))).toBe(false);
    const typed = reduce(s, { type: 'managed_edit_draft', text: '{"a":2}' });
    expect(canSaveManagedEdit(edit(typed))).toBe(true);
    // Typed back to the original — still nothing to save.
    const undone = reduce(typed, { type: 'managed_edit_draft', text: '{"a":1}' });
    expect(canSaveManagedEdit(edit(undone))).toBe(false);
  });

  test('Save is off while a save is in flight', () => {
    const s = reduce(reduce(loaded(), { type: 'managed_edit_draft', text: 'new' }), {
      type: 'managed_edit_saving',
    });
    expect(canSaveManagedEdit(edit(s))).toBe(false);
  });

  test('a successful save ADVANCES the token, so a second save is not stale', () => {
    // Without this the concurrency check would refuse every second save in a
    // sitting — a check that fires on correct use is worse than no check.
    let s = reduce(loaded(), { type: 'managed_edit_draft', text: 'new' });
    s = reduce(s, { type: 'managed_edit_saving' });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'managed_file_written',
        projectId: PID,
        kind: 'settings',
        result: { ok: true, mtimeMs: 222, created: false },
      },
    });
    expect(edit(s).mtimeMs).toBe(222);
    expect(edit(s).exists).toBe(true);
    // And the buffer is now what is on disk, so Save goes quiet again.
    expect(canSaveManagedEdit(edit(s))).toBe(false);
    expect(edit(s).savedAt).toBe(222);
  });

  test('the saved confirmation clears on the next keystroke', () => {
    let s = reduce(loaded(), { type: 'managed_edit_draft', text: 'new' });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'managed_file_written',
        projectId: PID,
        kind: 'settings',
        result: { ok: true, mtimeMs: 222, created: false },
      },
    });
    expect(edit(s).savedAt).not.toBe(null);
    // Leaving it set would show "saved" over a buffer that no longer matches
    // what was saved.
    s = reduce(s, { type: 'managed_edit_draft', text: 'newer' });
    expect(edit(s).savedAt).toBe(null);
  });

  test('a FAILED save keeps the operator’s text and reports why', () => {
    // Losing what they typed in order to explain why it did not save would be
    // worse than the failure itself.
    let s = reduce(loaded(), { type: 'managed_edit_draft', text: '{"broken":' });
    s = reduce(s, { type: 'managed_edit_saving' });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'managed_file_written',
        projectId: PID,
        kind: 'settings',
        result: { ok: false, refusal: 'invalid_json', detail: 'Unexpected end of JSON input' },
      },
    });
    expect(managedEditorMode(edit(s))).toEqual({
      mode: 'editing',
      content: '{"broken":',
      creating: false,
    });
    expect(edit(s).refusal).toEqual({
      refusal: 'invalid_json',
      detail: 'Unexpected end of JSON input',
    });
    expect(edit(s).status).toBe('ready');
  });

  test('a stale refusal does not advance anything', () => {
    let s = reduce(loaded(), { type: 'managed_edit_draft', text: 'new' });
    s = reduce(s, { type: 'managed_edit_saving' });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'managed_file_written',
        projectId: PID,
        kind: 'settings',
        result: { ok: false, refusal: 'stale' },
      },
    });
    expect(edit(s).mtimeMs).toBe(111);
    expect(edit(s).loaded).toBe('{"a":1}');
  });
});
