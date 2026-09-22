// @vitest-environment jsdom
//
// Cebab-0dv9: the delete modal must not tell the operator that deleting the
// agent removes "its conversations" — the CLI keeps its own unredacted
// transcripts under ~/.claude/projects/, and runManagedDelete never touches
// that tree. Two failure modes are in scope and each has its own case: the
// honest note being MISSING, and the overclaim being LEFT ON SCREEN two lines
// above the honest note (a presence-only assertion on the added sentence would
// pass while the modal still contradicts itself).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ManagedDeleteModal, type ManagedDeleteState } from './ManagedDeleteModal';

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
});

function state(overrides: Partial<ManagedDeleteState> = {}): ManagedDeleteState {
  return {
    projectId: 1,
    name: 'ledger-agent',
    status: 'confirming',
    result: null,
    ...overrides,
  };
}

function render(s: ManagedDeleteState): void {
  act(() => {
    root.render(<ManagedDeleteModal state={s} onConfirm={() => {}} onClose={() => {}} />);
  });
}

describe('ManagedDeleteModal — what survives the delete', () => {
  test('names the CLI transcript directory Cebab does not delete', () => {
    render(state({ status: 'confirming' }));
    const text = container.textContent ?? '';
    expect(text).toContain('~/.claude/projects/');
    expect(text).toContain('unredacted');
    expect(text).toContain('does not delete');
  });

  test('does not promise the conversations themselves are gone', () => {
    // The overclaim this bead removes. This case reddens on a revert of the
    // first paragraph's edit ALONE — case 1 would still pass, because the
    // honest note can sit under an unchanged overclaim.
    render(state({ status: 'confirming' }));
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/its files, its conversations and its logs/);
    expect(text).not.toMatch(/\bits conversations\b/);
  });

  test('the note is present in every status, not only while confirming', () => {
    // The success line reads "Deleted <name> and its N conversations" — the
    // moment the operator is most likely to believe the conversations are gone,
    // so the transcript note has to be on screen there too.
    render(state({ status: 'deleting' }));
    expect(container.textContent ?? '').toContain('~/.claude/projects/');

    render(
      state({
        status: 'done',
        result: { ok: true, name: 'ledger-agent', sessionsRemoved: 3 },
      }),
    );
    expect(container.textContent ?? '').toContain('~/.claude/projects/');
  });
});
