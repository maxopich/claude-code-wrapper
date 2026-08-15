// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MultiAgentMutationView } from '@cebab/shared';
import type { MultiAgentRun } from './store';
import { ArtifactsView } from './components/ArtifactsView';
import { ModeToggle } from './components/ModeToggle';
import { ParticipantControlMenu } from './components/agentControl/ParticipantControlMenu';
import { ForensicViewerProvider } from './components/agentControl/ForensicViewerContext';

/**
 * What the composite roles actually DO when you press a key (registers U17,
 * U18, U26, U30).
 *
 * `widgetRoles.test.ts` is the structural half — it holds the rule that a
 * composite role must come with *a* keyboard model, over every component in the
 * repo including ones not written yet. It cannot tell whether that model is
 * right. This file does the opposite: a small number of components, driven
 * through real focus movement in jsdom.
 *
 * The two are complementary on purpose. Deleting `nextIndex(` from a component
 * fails the structural gate; wiring it up backwards fails this one.
 *
 * Convention: raw `createRoot` + `act`, no testing-library — matches every
 * other component spec in this repo.
 *
 * `SessionSearchModal`'s combobox is exercised in its own spec
 * (`SessionSearchModal.test.tsx`) rather than here, because it needs the
 * search-hook plumbing — WS send, a subscribed reply, fake timers — that the
 * spec already sets up.
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

function key(el: Element, k: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

/**
 * Which element roles a container role may contain, per the ARIA spec's
 * required-owned-elements. Only the containers this repo declares.
 *
 * The check below is about *element* children: text nodes and anything
 * `aria-hidden` are out of the accessibility tree already and are not the
 * defect. The defect is a real, announced child that the role forbids — which
 * both U26 (a `<p>` inside `role="menu"`) and U18 (two `<p>`s inside
 * `role="listbox"`) had, and which no linting in this repo would have caught.
 */
const ALLOWED_CHILDREN: Record<string, string[]> = {
  menu: ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group', 'separator', 'presentation'],
  listbox: ['option', 'group', 'presentation'],
  radiogroup: ['radio', 'presentation'],
};

/** Every illegal element child of every widget container in `root`. */
function illegalChildren(scope: ParentNode): string[] {
  const bad: string[] = [];
  for (const [role, allowed] of Object.entries(ALLOWED_CHILDREN)) {
    for (const widget of Array.from(scope.querySelectorAll(`[role="${role}"]`))) {
      for (const child of Array.from(widget.children)) {
        if (child.getAttribute('aria-hidden') === 'true') continue;
        const childRole = child.getAttribute('role');
        if (childRole !== null && allowed.includes(childRole)) continue;
        bad.push(`${role} > ${child.tagName.toLowerCase()}[role=${childRole ?? 'none'}]`);
      }
    }
  }
  return bad;
}

// ---------------------------------------------------------------- U26: menu

function renderMenu(over: Partial<Parameters<typeof ParticipantControlMenu>[0]> = {}) {
  // Cebab-u0s: the control verbs report whether they went out; `true` keeps
  // these keyboard cases on the pre-existing (delivered) path. It replaced the
  // `noop` that used to stand in for all five.
  const sent = () => true;
  act(() => {
    root.render(
      <ForensicViewerProvider send={(() => {}) as never}>
        <ParticipantControlMenu
          projectId={7}
          sessionId="s1"
          agentLabel="worker-a"
          sessionMode="orchestrator"
          control={undefined}
          onMute={sent}
          onUnmute={sent}
          onPause={sent}
          onResume={sent}
          onKick={sent}
          {...over}
        />
      </ForensicViewerProvider>,
    );
  });
}
const trigger = () => container.querySelector('.ma-control-menu-trigger') as HTMLButtonElement;
const items = () => Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'));

describe('[a11y] the participant menu behaves like a menu (U26)', () => {
  test('opening moves focus to the first item', () => {
    renderMenu();
    act(() => trigger().click());
    expect(items().length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(items()[0]);
  });

  test('arrow keys move focus, and wrap at both ends', () => {
    renderMenu();
    act(() => trigger().click());
    const menu = container.querySelector('[role="menu"]')!;
    const all = items();

    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(all[1]);
    key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(all[0]);
    // Menus wrap (APG) — Up from the first item lands on the last.
    key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(all[all.length - 1]);
    key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(all[0]);
    key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(all[all.length - 1]);
    expect(menu).not.toBeNull();
  });

  test('Escape closes and hands focus back to the trigger', () => {
    // Without this, Escape left focus on a button that had just unmounted, so
    // the operator's next Tab started over from the top of the document.
    renderMenu();
    act(() => trigger().click());
    expect(document.activeElement).not.toBe(trigger());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  test('the kicked panel gets the same treatment, not just the live one', () => {
    // The register named the live-participant panel; the kicked branch is a
    // second role="menu" that would otherwise still be inert.
    renderMenu({ control: { kickedAt: Date.now() } as never });
    act(() => trigger().click());
    expect(items()).toHaveLength(1);
    expect(document.activeElement).toBe(items()[0]);
  });

  // `test.each` rather than a loop, so each mode gets a fresh root. A loop
  // shared one: the second `renderMenu` re-rendered the SAME component, which
  // kept `open: true` from the first pass, so clicking the trigger CLOSED the
  // menu and `illegalChildren` then found no menu to inspect and returned []
  // — a green that meant nothing. Caught by the revert-check, which is what it
  // is for. The two assertions before the check are the standing guard against
  // that shape of vacuous pass.
  test.each(['orchestrator', 'chain'] as const)(
    'nothing illegal lives inside the menu (%s mode)',
    (sessionMode) => {
      renderMenu({ sessionMode });
      act(() => trigger().click());
      const menu = container.querySelector('[role="menu"]');
      expect(menu, 'menu is open').not.toBeNull();
      expect(menu!.children.length).toBeGreaterThan(0);
      expect(illegalChildren(container)).toEqual([]);
    },
  );

  test('chain mode still explains itself, as a disabled item', () => {
    // The explanation must survive the fix — moving it out of the tree would
    // "pass" the check above by deleting the information.
    renderMenu({ sessionMode: 'chain' });
    act(() => trigger().click());
    const disabled = items().filter((i) => i.getAttribute('aria-disabled') === 'true');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.textContent).toMatch(/chain mode/i);
  });
});

// --------------------------------------------------------------- U30: grid

function mut(over: Partial<MultiAgentMutationView>): MultiAgentMutationView {
  return {
    id: 1,
    sessionId: 's1',
    ts: 1000,
    agentName: 'worker',
    toolName: 'Write',
    category: 'mutate',
    summary: 'wrote it',
    filePath: '/ws/a.md',
    cwd: '/ws',
    confirmedAt: 1000,
    promoted: true,
    ...over,
  };
}

function renderGrid(paths: string[]) {
  const run = {
    sessionId: 's1',
    mutations: paths.map((p, i) => mut({ id: i + 1, ts: 1000 - i, filePath: p })),
  } as unknown as MultiAgentRun;
  act(() => {
    root.render(<ArtifactsView run={run} send={() => {}} subscribeServerMsg={() => () => {}} />);
  });
}
const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.artifacts-row'));

describe('[a11y] the artifacts table behaves like a grid (U30)', () => {
  test('it declares grid semantics, so aria-selected has a model to live in', () => {
    renderGrid(['/ws/a.md', '/ws/b.md']);
    const table = container.querySelector('.artifacts-table')!;
    expect(table.getAttribute('role')).toBe('grid');
    expect(table.getAttribute('aria-label')).toBeTruthy();
  });

  test('exactly one row is a tab stop, however many rows there are', () => {
    // The finding's harm: fifty files were fifty tab stops between the table
    // and the preview pane.
    renderGrid(['/ws/a.md', '/ws/b.md', '/ws/c.md', '/ws/d.md']);
    expect(rows()).toHaveLength(4);
    const tabbable = rows().filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]!.getAttribute('aria-selected')).toBe('true');
  });

  test('arrows move selection and focus together, and clamp at the ends', () => {
    renderGrid(['/ws/a.md', '/ws/b.md', '/ws/c.md']);
    rows()[0]!.focus();

    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(rows()[0]!.getAttribute('aria-selected')).toBe('false');

    key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(rows()[2]);
    // A grid clamps — ArrowDown on the last row stays put rather than wrapping.
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(rows()[2]);

    key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(rows()[0]);
  });

  test('the roving index follows the selection, so Tab re-enters where you left', () => {
    renderGrid(['/ws/a.md', '/ws/b.md', '/ws/c.md']);
    rows()[0]!.focus();
    key(document.activeElement!, 'ArrowDown');
    expect(rows().map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });
});

// ------------------------------------------------------------ U17: toggle

describe('[a11y] the permission pills expose their state (U17)', () => {
  function renderToggle(mode: 'default' | 'acceptEdits', disabled = false) {
    act(() => {
      root.render(<ModeToggle mode={mode} disabled={disabled} onChange={() => {}} />);
    });
  }
  const pills = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.pill'));

  test('exactly one pill is pressed, and it is the active mode', () => {
    renderToggle('default');
    expect(pills().map((p) => p.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    renderToggle('acceptEdits');
    expect(pills().map((p) => p.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  test('the group is named, so the pair reads as one control', () => {
    renderToggle('default');
    const group = container.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    expect(group!.getAttribute('aria-label')).toBeTruthy();
  });

  test('both pills point at a description that resolves to real text', () => {
    renderToggle('default');
    for (const pill of pills()) {
      const id = pill.getAttribute('aria-describedby');
      expect(id, 'aria-describedby').toBeTruthy();
      expect(document.getElementById(id!)?.textContent?.trim()).toBeTruthy();
    }
  });

  test('a read-only toggle stays focusable, so its reason can be read', () => {
    // The whole point of aria-disabled over the native attribute: a disabled
    // button is out of the tab order, and an explanation nobody can reach is
    // the defect the register filed.
    renderToggle('default', true);
    for (const pill of pills()) {
      expect(pill.disabled).toBe(false);
      expect(pill.getAttribute('aria-disabled')).toBe('true');
    }
  });
});
