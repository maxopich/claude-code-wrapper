// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Project, SessionSummary } from '@cebab/shared/protocol';
import { ProjectList } from './ProjectList';

// Cluster I Phase C5 UI — pins the sidebar's bulk-select behavior:
//
//   1. The [Select…] toggle is gated on the project being expanded AND
//      having ≥1 session.
//   2. Entering select mode swaps each row's marker for a checkbox, hides
//      the "new chat" row, and shows the bulk action bar.
//   3. Clicking a row toggles its selection + updates the live count.
//   4. Archive/Export dispatch in a single step; Delete is gated behind a
//      typed-confirmation (type the count) — Cancel is the default.
//   5. Selection exits after an action and on Escape (Escape backs out of
//      the delete-confirm substate first).

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const PID = 1;

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: PID,
    name: 'demo',
    path: '/tmp/demo',
    trusted: false,
    lastUsedAt: null,
    hasClaudeMd: true,
    busInstalled: false,
    busAgentName: null,
    ...overrides,
  };
}

function summary(id: string): SessionSummary {
  return { id, title: null, createdAt: 1000, lastEventAt: 2000, totalCostUsd: 0 };
}

type Handlers = {
  onBulkSessionOp: ReturnType<
    typeof vi.fn<(op: 'archive' | 'delete', sessionIds: string[]) => void>
  >;
  onBulkExportSessions: ReturnType<typeof vi.fn<(sessionIds: string[]) => Promise<void>>>;
};

function render(opts: { expanded: boolean; sessions: SessionSummary[] }): Handlers {
  const handlers: Handlers = {
    onBulkSessionOp: vi.fn<(op: 'archive' | 'delete', sessionIds: string[]) => void>(),
    onBulkExportSessions: vi.fn<(sessionIds: string[]) => Promise<void>>(() => Promise.resolve()),
  };
  act(() => {
    root.render(
      <ProjectList
        projects={[project()]}
        activeProjectId={opts.expanded ? PID : null}
        activeSessionByProject={{}}
        knownSessions={{ [PID]: opts.sessions }}
        liveSessions={{}}
        onSelectProject={() => {}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onToggleTrust={() => {}}
        onRenameSession={() => {}}
        onDownloadSession={() => Promise.resolve()}
        onBulkSessionOp={handlers.onBulkSessionOp}
        onBulkExportSessions={handlers.onBulkExportSessions}
      />,
    );
  });
  return handlers;
}

function click(el: Element | null) {
  if (!el) throw new Error('click target missing');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** React tracks controlled-input values via a private setter; bypass it so
 *  a programmatic value change fires the synthetic onChange. */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function toggleBtn(): HTMLButtonElement | null {
  return container.querySelector('.session-select-toggle');
}
function actionBar(): HTMLElement | null {
  return container.querySelector('.bulk-action-bar');
}
function sessionRows(): HTMLElement[] {
  // Exclude the "new chat" row (which carries .new).
  return Array.from(container.querySelectorAll('.session-row:not(.new)'));
}
function actionButton(label: string): HTMLButtonElement | null {
  return (Array.from(container.querySelectorAll('.bulk-action-btn')).find((b) =>
    b.textContent?.trim().startsWith(label),
  ) ?? null) as HTMLButtonElement | null;
}

describe('ProjectList — Select mode gating', () => {
  test('toggle hidden when the project is collapsed', () => {
    render({ expanded: false, sessions: [summary('a')] });
    expect(toggleBtn()).toBeNull();
  });

  test('toggle hidden when the expanded project has no sessions', () => {
    render({ expanded: true, sessions: [] });
    expect(toggleBtn()).toBeNull();
  });

  test('toggle present when expanded with ≥1 session', () => {
    render({ expanded: true, sessions: [summary('a')] });
    expect(toggleBtn()).not.toBeNull();
    expect(toggleBtn()?.textContent).toContain('Select');
  });
});

describe('ProjectList — entering select mode', () => {
  test('shows checkboxes, the action bar, and hides the new-chat row', () => {
    render({ expanded: true, sessions: [summary('a'), summary('b')] });
    // Before: new-chat row present, no action bar, no checkboxes.
    expect(container.querySelector('.session-row.new')).not.toBeNull();
    expect(actionBar()).toBeNull();
    expect(container.querySelector('.session-select-checkbox')).toBeNull();

    click(toggleBtn());

    expect(actionBar()).not.toBeNull();
    expect(container.querySelectorAll('.session-select-checkbox')).toHaveLength(2);
    expect(container.querySelector('.session-row.new')).toBeNull();
    // Toggle now reads "Done".
    expect(toggleBtn()?.textContent).toContain('Done');
  });

  test('count starts at 0 and is announced via aria-live', () => {
    render({ expanded: true, sessions: [summary('a')] });
    click(toggleBtn());
    const count = container.querySelector('.bulk-action-count');
    expect(count?.getAttribute('aria-live')).toBe('polite');
    expect(count?.textContent).toBe('0 selected');
  });

  test('op buttons are disabled with nothing selected', () => {
    render({ expanded: true, sessions: [summary('a')] });
    click(toggleBtn());
    expect(actionButton('Archive')?.disabled).toBe(true);
    expect(actionButton('Export')?.disabled).toBe(true);
    expect(actionButton('Delete')?.disabled).toBe(true);
  });
});

describe('ProjectList — selecting rows', () => {
  test('clicking a row selects it + updates the count + enables ops', () => {
    render({ expanded: true, sessions: [summary('a'), summary('b')] });
    click(toggleBtn());

    click(sessionRows()[0]);
    expect(container.querySelector('.bulk-action-count')?.textContent).toBe('1 selected');
    expect(sessionRows()[0]?.classList.contains('selected')).toBe(true);
    expect(actionButton('Archive')?.disabled).toBe(false);

    // Select the second too.
    click(sessionRows()[1]);
    expect(container.querySelector('.bulk-action-count')?.textContent).toBe('2 selected');

    // Click the first again → deselect.
    click(sessionRows()[0]);
    expect(container.querySelector('.bulk-action-count')?.textContent).toBe('1 selected');
    expect(sessionRows()[0]?.classList.contains('selected')).toBe(false);
  });
});

describe('ProjectList — Archive / Export (single-step)', () => {
  test('Archive dispatches onBulkSessionOp(archive, ids) + exits select mode', () => {
    const h = render({ expanded: true, sessions: [summary('a'), summary('b')] });
    click(toggleBtn());
    click(sessionRows()[0]);
    click(sessionRows()[1]);

    click(actionButton('Archive'));

    expect(h.onBulkSessionOp).toHaveBeenCalledTimes(1);
    expect(h.onBulkSessionOp).toHaveBeenCalledWith('archive', ['a', 'b']);
    // Exited: action bar gone, toggle back to "Select…".
    expect(actionBar()).toBeNull();
    expect(toggleBtn()?.textContent).toContain('Select');
  });

  test('Export dispatches onBulkExportSessions(ids) + exits', () => {
    const h = render({ expanded: true, sessions: [summary('a')] });
    click(toggleBtn());
    click(sessionRows()[0]);

    click(actionButton('Export'));

    expect(h.onBulkExportSessions).toHaveBeenCalledWith(['a']);
    expect(actionBar()).toBeNull();
  });
});

describe('ProjectList — Delete typed-confirmation (C5-2)', () => {
  test('Delete opens a confirm substate; the Delete button is disabled until the count is typed', () => {
    const h = render({ expanded: true, sessions: [summary('a'), summary('b')] });
    click(toggleBtn());
    click(sessionRows()[0]);
    click(sessionRows()[1]);

    click(actionButton('Delete'));

    // Confirm substate.
    expect(container.querySelector('.bulk-action-bar.confirming')).not.toBeNull();
    const confirmInput = container.querySelector('.bulk-action-confirm-input') as HTMLInputElement;
    expect(confirmInput).not.toBeNull();
    const confirmBtn = actionButton('Delete 2');
    expect(confirmBtn?.disabled).toBe(true);

    // Wrong value keeps it disabled.
    setInputValue(confirmInput, '5');
    expect(actionButton('Delete 2')?.disabled).toBe(true);

    // Correct count arms it.
    setInputValue(confirmInput, '2');
    expect(actionButton('Delete 2')?.disabled).toBe(false);

    click(actionButton('Delete 2'));
    expect(h.onBulkSessionOp).toHaveBeenCalledWith('delete', ['a', 'b']);
    expect(actionBar()).toBeNull();
  });

  test('Cancel in the confirm substate returns to the action bar without deleting', () => {
    const h = render({ expanded: true, sessions: [summary('a')] });
    click(toggleBtn());
    click(sessionRows()[0]);
    click(actionButton('Delete'));
    expect(container.querySelector('.bulk-action-bar.confirming')).not.toBeNull();

    click(actionButton('Cancel'));
    // Back to the normal bar, still in select mode, nothing deleted.
    expect(container.querySelector('.bulk-action-bar.confirming')).toBeNull();
    expect(actionBar()).not.toBeNull();
    expect(h.onBulkSessionOp).not.toHaveBeenCalled();
  });
});

describe('ProjectList — Escape handling (C5-4)', () => {
  function pressEscape() {
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
  }

  test('Escape exits select mode', () => {
    render({ expanded: true, sessions: [summary('a')] });
    click(toggleBtn());
    expect(actionBar()).not.toBeNull();

    pressEscape();
    expect(actionBar()).toBeNull();
    expect(toggleBtn()?.textContent).toContain('Select');
  });

  test('Escape in confirm substate backs out to the bar first, then exits', () => {
    render({ expanded: true, sessions: [summary('a')] });
    click(toggleBtn());
    click(sessionRows()[0]);
    click(actionButton('Delete'));
    expect(container.querySelector('.bulk-action-bar.confirming')).not.toBeNull();

    // First Escape: out of confirm, still selecting.
    pressEscape();
    expect(container.querySelector('.bulk-action-bar.confirming')).toBeNull();
    expect(actionBar()).not.toBeNull();

    // Second Escape: exit select mode entirely.
    pressEscape();
    expect(actionBar()).toBeNull();
  });
});
