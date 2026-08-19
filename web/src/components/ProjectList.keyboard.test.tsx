// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Project, SessionSummary } from '@cebab/shared/protocol';
import { ProjectList } from './ProjectList';

/**
 * The sidebar has a keyboard path (register U01).
 *
 * All three interactive rows — the project header, the "new chat" row and each
 * session row — were bare `<div>`/`<li>` elements with an `onClick` and no
 * role, no `tabIndex` and no key handler. Every *focusable* thing inside them
 * (Select…, trust, ⓘ, ✎, ⤓) calls `stopPropagation` and does something else,
 * so a keyboard user could reach five buttons per row and open nothing. Worse,
 * the session list only renders once the project is expanded, and expanding
 * needed a mouse click on the header, so those five were unreachable too.
 *
 * The fix is the standard shape for "a row with a primary action plus
 * secondary actions": the row stays a listitem and the label becomes a real
 * `<button>`. The row keeps its click as a mouse convenience for its dead
 * space. Note what is NOT possible here and why the register's phrasing ("make
 * rows real buttons") could not be taken literally: `<button>` and
 * `role="button"` both forbid interactive descendants, and these rows contain
 * two or three real buttons each.
 *
 * What this file pins is the *behaviour*, not the markup: a real button is in
 * tab order and activates on Enter and Space without any handler of ours, so
 * asserting the element type is asserting the keyboard contract. The tests
 * dispatch a real click (what Enter/Space produce on a button) against the
 * handler the row would have called.
 *
 * NOT covered: focus order across rows, the rename double-click (the ✎ button
 * is the keyboard path and predates this), or the rail's collapse behaviour —
 * that is `railFocus.test.ts` (U02).
 */

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
    model: null,
    startPermissionMode: null,
    ...overrides,
  };
}

function summary(id: string): SessionSummary {
  return { id, title: null, createdAt: 1000, lastEventAt: 2000, totalCostUsd: 0 };
}

type Spies = {
  onSelectProject: ReturnType<typeof vi.fn<(projectId: number) => void>>;
  onSelectSession: ReturnType<typeof vi.fn<(projectId: number, sessionId: string) => void>>;
  onNewSession: ReturnType<typeof vi.fn<(projectId: number) => void>>;
};

function render(opts: { expanded: boolean; sessions: SessionSummary[] }): Spies {
  const spies: Spies = {
    onSelectProject: vi.fn<(projectId: number) => void>(),
    onSelectSession: vi.fn<(projectId: number, sessionId: string) => void>(),
    onNewSession: vi.fn<(projectId: number) => void>(),
  };
  act(() => {
    root.render(
      <ProjectList
        projects={[project()]}
        activeProjectId={opts.expanded ? PID : null}
        activeSessionByProject={{}}
        knownSessions={{ [PID]: opts.sessions }}
        liveSessions={{}}
        onSelectProject={spies.onSelectProject}
        onSelectSession={spies.onSelectSession}
        onNewSession={spies.onNewSession}
        onToggleTrust={() => {}}
        modelCatalogue={null}
        modelRefreshingFor={null}
        onSetProjectModel={() => {}}
        onRefreshModelCatalogue={() => {}}
        onSetProjectStartPermissionMode={() => {}}
        onRenameSession={() => {}}
        onDownloadSession={() => Promise.resolve()}
        onBulkSessionOp={() => {}}
        onBulkExportSessions={() => Promise.resolve()}
      />,
    );
  });
  return spies;
}

function only(selector: string): HTMLElement {
  const found = container.querySelectorAll<HTMLElement>(selector);
  if (found.length !== 1) throw new Error(`expected exactly 1 ${selector}, found ${found.length}`);
  return found[0]!;
}

function activate(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** A control is keyboard-operable if the browser gives it activation for
 *  free — i.e. it is a real button that is in the tab order. */
function expectKeyboardOperable(el: HTMLElement): void {
  expect(el.tagName).toBe('BUTTON');
  expect((el as HTMLButtonElement).disabled).toBe(false);
  // `tabIndex` is -1 only if something explicitly removed it; a plain enabled
  // button reports 0.
  expect(el.tabIndex).toBe(0);
  const name = el.getAttribute('aria-label') ?? el.textContent ?? '';
  expect(name.trim().length).toBeGreaterThan(0);
}

describe('[a11y] the project header is operable from the keyboard', () => {
  test('the project name is a focusable button that selects the project', () => {
    const spies = render({ expanded: false, sessions: [] });
    const btn = only('.project-name');
    expectKeyboardOperable(btn);
    activate(btn);
    expect(spies.onSelectProject).toHaveBeenCalledWith(PID);
  });

  test('activating it once does not double-dispatch through the row', () => {
    // The header still carries an onClick for mouse users clicking its dead
    // space; the button stops propagation so one activation is one selection.
    const spies = render({ expanded: false, sessions: [] });
    activate(only('.project-name'));
    expect(spies.onSelectProject).toHaveBeenCalledTimes(1);
  });

  test('it reports the disclosure state it controls', () => {
    render({ expanded: false, sessions: [] });
    expect(only('.project-name').getAttribute('aria-expanded')).toBe('false');
    render({ expanded: true, sessions: [] });
    expect(only('.project-name').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('[a11y] session rows are operable from the keyboard', () => {
  test('the new-chat row exposes a named button', () => {
    const spies = render({ expanded: true, sessions: [] });
    const btn = only('.session-row.new .session-name');
    expectKeyboardOperable(btn);
    // The visible text is just "new chat"; the accessible name says which
    // project, because a screen-reader user hears it out of visual context.
    expect(btn.getAttribute('aria-label')).toBe('Start a new chat in demo');
    activate(btn);
    expect(spies.onNewSession).toHaveBeenCalledWith(PID);
  });

  test('a session row opens from its button', () => {
    const spies = render({ expanded: true, sessions: [summary('sess-aaaaaaa1')] });
    const btn = only('.session-row:not(.new) .session-name');
    expectKeyboardOperable(btn);
    expect(btn.getAttribute('aria-label')).toBe('Open session sess-aaa');
    activate(btn);
    expect(spies.onSelectSession).toHaveBeenCalledWith(PID, 'sess-aaaaaaa1');
  });

  test('the active row is marked with aria-current, not a bare class', () => {
    act(() => {
      root.render(
        <ProjectList
          projects={[project()]}
          activeProjectId={PID}
          activeSessionByProject={{ [PID]: 'sess-aaaaaaa1' }}
          knownSessions={{ [PID]: [summary('sess-aaaaaaa1')] }}
          liveSessions={{}}
          onSelectProject={() => {}}
          onSelectSession={() => {}}
          onNewSession={() => {}}
          onToggleTrust={() => {}}
          modelCatalogue={null}
          modelRefreshingFor={null}
          onSetProjectModel={() => {}}
          onRefreshModelCatalogue={() => {}}
          onSetProjectStartPermissionMode={() => {}}
          onRenameSession={() => {}}
          onDownloadSession={() => Promise.resolve()}
          onBulkSessionOp={() => {}}
          onBulkExportSessions={() => Promise.resolve()}
        />,
      );
    });
    expect(only('.session-row:not(.new) .session-name').getAttribute('aria-current')).toBe('true');
  });
});

describe('[a11y] select mode uses a valid toggle state', () => {
  function enterSelectMode(): void {
    activate(only('.session-select-toggle'));
  }

  test('the row button becomes a toggle and reports pressed state', () => {
    render({ expanded: true, sessions: [summary('sess-aaaaaaa1')] });
    enterSelectMode();
    const btn = only('.session-row:not(.new) .session-name');
    expectKeyboardOperable(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    activate(btn);
    expect(only('.session-row:not(.new) .session-name').getAttribute('aria-pressed')).toBe('true');
  });

  test('no list item carries aria-selected', () => {
    // `aria-selected` needs an option/row/tab role. On a bare <li> inside a
    // plain <ul> it is invalid and assistive tech drops it — so the selected
    // state used to be announced to nobody. It rides on the button's
    // `aria-pressed` now.
    render({ expanded: true, sessions: [summary('sess-aaaaaaa1')] });
    enterSelectMode();
    activate(only('.session-row:not(.new) .session-name'));
    expect(container.querySelectorAll('[aria-selected]')).toHaveLength(0);
  });

  test('the row still toggles from a mouse click on its dead space', () => {
    // The keyboard path is additive — clicking the row itself (not the label)
    // must keep working for mouse users.
    render({ expanded: true, sessions: [summary('sess-aaaaaaa1')] });
    enterSelectMode();
    activate(only('.session-row:not(.new)'));
    expect(only('.session-row:not(.new) .session-name').getAttribute('aria-pressed')).toBe('true');
  });
});
