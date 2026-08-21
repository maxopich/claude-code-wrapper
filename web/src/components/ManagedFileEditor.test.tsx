// @vitest-environment jsdom
//
// Cebab-ws0.10. Two things carry this component and neither is the textarea:
// that the three empty-looking states are told apart (only one is safe to type
// into), and that a file which can hold live credentials says so before the
// operator screenshares it.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ManagedFileKind } from '@cebab/shared/protocol';
import {
  ManagedFileEditor,
  refusalMessage,
  type ManagedFileEditorProps,
} from './ManagedFileEditor';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

function render(over: Partial<ManagedFileEditorProps> = {}): ManagedFileEditorProps {
  const props: ManagedFileEditorProps = {
    projectName: 'ledger-agent',
    kind: 'settings',
    relPath: '.claude/settings.json',
    sensitive: true,
    view: { mode: 'editing', content: '{"a":1}', creating: false },
    canSave: true,
    saving: false,
    savedAt: null,
    saveRefusal: null,
    onKind: vi.fn(),
    onDraft: vi.fn(),
    onSave: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  act(() => {
    root.render(<ManagedFileEditor {...props} />);
  });
  return props;
}

const text = () => container.textContent ?? '';
const textarea = () => container.querySelector('textarea');
const saveBtn = () =>
  [...container.querySelectorAll('button')].find((b) => /^Save/.test(b.textContent ?? ''));

describe('the three empty-looking states are told apart', () => {
  test('loading shows no editor', () => {
    render({ view: { mode: 'loading' } });
    expect(textarea()).toBe(null);
    expect(text()).toContain('Reading the file');
  });

  test('a refusal shows the reason and no editor', () => {
    render({ view: { mode: 'refused', refusal: 'too_large' } });
    expect(textarea()).toBe(null);
    // Specifically NOT a generic error: the operator's next step differs per
    // refusal, and this one is "use another editor".
    expect(text()).toContain('too large to edit here');
  });

  test('an ABSENT file is editable and says saving will create it', () => {
    render({ view: { mode: 'editing', content: '', creating: true } });
    expect(textarea()).not.toBe(null);
    expect(textarea()!.value).toBe('');
    expect(text()).toContain('does not exist yet');
  });
});

describe('the live-secret warning', () => {
  test('shows for a credential-bearing file', () => {
    render({ sensitive: true });
    const warn = container.querySelector('[data-testid="managed-file-secret"]');
    expect(warn).not.toBe(null);
    // The point ws0.11 could not make anywhere: these bytes are live NOW, as
    // opposed to the copy dialog's "about to be duplicated".
    expect(warn!.textContent).toContain('not masked');
  });

  test('does not show for CLAUDE.md', () => {
    render({ kind: 'claude_md', relPath: 'CLAUDE.md', sensitive: false });
    expect(container.querySelector('[data-testid="managed-file-secret"]')).toBe(null);
  });

  test('the warning does not depend on colour alone', () => {
    // Three signals: a glyph in the markup, a border and a tint in CSS. This
    // asserts the one that lives here.
    render({ sensitive: true });
    expect(container.querySelector('.managed-file-glyph')?.textContent).toBe('⚠');
  });
});

describe('saving', () => {
  test('Save is disabled when there is nothing to save', () => {
    render({ canSave: false });
    expect(saveBtn()!.disabled).toBe(true);
  });

  test('a failed save keeps the text on screen and explains itself', () => {
    render({
      view: { mode: 'editing', content: '{"broken":', creating: false },
      saveRefusal: { refusal: 'invalid_json', detail: 'Unexpected end of JSON input' },
    });
    expect(textarea()!.value).toBe('{"broken":');
    const err = container.querySelector('[data-testid="managed-file-save-error"]');
    expect(err!.textContent).toContain('Unexpected end of JSON input');
  });

  test('a successful save says when it takes effect', () => {
    render({ savedAt: 123, canSave: false });
    // "Saved" alone would leave open whether the running session picked it up.
    expect(text()).toContain('next session');
  });

  test('Enter inserts a newline rather than saving', () => {
    // The composer's GrowTextarea submits on Enter by default. In a FILE that
    // would write to disk on a line break.
    const props = render();
    const ta = textarea()!;
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(props.onSave).not.toHaveBeenCalled();
  });
});

describe('refusalMessage', () => {
  test('every refusal has its own sentence', () => {
    const all = [
      'unknown_project',
      'not_managed',
      'unknown_kind',
      'too_large',
      'unreadable',
      'invalid_json',
      'stale',
      'write_failed',
      'audit_failed',
    ] as const;
    const messages = all.map((r) => refusalMessage(r));
    expect(new Set(messages).size).toBe(all.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(20);
  });

  test('stale says nothing was overwritten, which is the operator’s first question', () => {
    expect(refusalMessage('stale')).toContain('nothing has been overwritten');
  });

  test('audit_failed explains the refusal rather than reading as a bug', () => {
    // "Could not save" would send the operator looking for a disk problem. The
    // save was refused on purpose.
    expect(refusalMessage('audit_failed')).toContain('did not make it');
  });
});

describe('[a11y] the tab strip', () => {
  test('exactly one tab is in the tab order', () => {
    render({ kind: 'mcp' });
    const tabs = [...container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(tabs).toHaveLength(3);
    expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    expect(tabs.find((t) => t.tabIndex === 0)!.getAttribute('aria-selected')).toBe('true');
  });

  test('each tab points at the panel, and the panel back at the active tab', () => {
    render({ kind: 'claude_md' });
    const panel = container.querySelector('[role="tabpanel"]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe('managed-file-tab-claude_md');
    for (const t of container.querySelectorAll('[role="tab"]')) {
      expect(t.getAttribute('aria-controls')).toBe(panel.id);
    }
  });

  test.each([
    ['ArrowRight', 'settings', 'mcp'],
    ['ArrowLeft', 'settings', 'claude_md'],
    ['End', 'settings', 'claude_md'],
    ['Home', 'claude_md', 'settings'],
  ])('%s from %s selects %s', (key, from, want) => {
    const props = render({ kind: from as ManagedFileKind });
    const list = container.querySelector('[role="tablist"]')!;
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
    expect(props.onKind).toHaveBeenCalledWith(want);
  });

  test('a key another handler already claimed is left alone', () => {
    // The trap the session-search combobox hit when it adopted `nextIndex`.
    const props = render();
    const list = container.querySelector('[role="tablist"]')!;
    const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    e.preventDefault();
    act(() => {
      list.dispatchEvent(e);
    });
    expect(props.onKind).not.toHaveBeenCalled();
  });

  test('a key with no navigation meaning is ignored', () => {
    const props = render();
    const list = container.querySelector('[role="tablist"]')!;
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    expect(props.onKind).not.toHaveBeenCalled();
  });
});
