// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MultiAgentTemplate, Project, ServerMsg } from '@cebab/shared/protocol';
import { TemplatePreview, TemplatesPanel } from './MultiAgentTab';

/**
 * W11 + W10 — the templates browser must not treat a new object as news.
 *
 * `case 'templates'` replaces the whole array with freshly parsed rows, and
 * the server sends that reply for `list_templates`, `save_template` AND
 * `delete_template`. So every one of these tests hands over a template whose
 * `roles` map is a NEW object with the SAME contents — which is exactly what
 * the reducer really produces, and what the old identity-keyed effect read as
 * "the saved value changed".
 *
 * The role edits below go through the real DOM path (click a diagram tile →
 * type in the overlay textarea → blur commits), not a synthetic prop poke, so
 * a passing test says something about the call site and not just the effect.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  // jsdom doesn't ship matchMedia; AgentDiagram reads it for the
  // reduced-motion check. Same stub as AgentDiagram.test.tsx.
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
    configurable: true,
  });
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

const projects = [
  { id: 1, name: 'alpha', path: '/a', trusted: 0 },
  { id: 2, name: 'beta', path: '/b', trusted: 0 },
] as unknown as Project[];

/** A fresh template object every call — the reducer never reuses one. */
function tpl(roles?: Record<string, string>): MultiAgentTemplate {
  return {
    id: 't1',
    name: 'Review',
    mode: 'orchestrator',
    lifecycle: 'persistent',
    participants: [1, 2],
    ...(roles === undefined ? {} : { roles: { ...roles } }),
  };
}

function renderPreview(
  template: MultiAgentTemplate,
  onUpdateRoles: (t: MultiAgentTemplate, roles: Record<string, string>) => void = () => {},
) {
  act(() => {
    root.render(
      <TemplatePreview
        template={template}
        projects={projects}
        onApply={() => {}}
        onUpdateRoles={onUpdateRoles}
        onReadProjectFacts={() => {}}
        subscribeServerMsg={() => () => {}}
        onReadLastRunForTemplate={() => {}}
        lastRun={undefined}
      />,
    );
  });
}

function saveBtn(): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) =>
    /^(Save roles|Saved)$/.test(b.textContent ?? ''),
  );
  if (!btn) throw new Error('Save-roles button not found');
  return btn as HTMLButtonElement;
}

/** True when the pane holds unsaved role text (the `rolesDirty` surface). */
function isDirty(): boolean {
  return saveBtn().textContent === 'Save roles' && !saveBtn().disabled;
}

/** Open the overlay editor on the first tile that has one, type, and blur. */
function typeRole(text: string): void {
  const groups = [...container.querySelectorAll('g')];
  for (const g of groups) {
    act(() => {
      g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    if (container.querySelector('.tpl-role-edit')) break;
  }
  const ta = container.querySelector('.tpl-role-edit') as HTMLTextAreaElement | null;
  if (!ta) throw new Error('role editor did not open');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    if (setter) setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    // React's synthetic `onBlur` is delegated off the bubbling `focusout`,
    // not off `blur` — dispatching `blur` leaves the commit unfired and the
    // pane looking clean, which reads as a passing test for the wrong reason.
    ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

describe('TemplatePreview — role re-seeding keys on the value (W11)', () => {
  /**
   * A template that already HAS a stored roles map, for a participant other
   * than the one being edited.
   *
   * This detail is load-bearing and was got wrong first time round. With
   * `roles` absent, `template.roles` is `undefined` in every render, so the
   * old `[template.roles]` dependency never changed and the buggy effect
   * never fired — a test written that way passes on the reverted code and
   * measures nothing. A stored map is also the realistic case: the reducer
   * re-parses the whole list on every reply, so a template with any roles at
   * all gets a fresh object each time.
   */
  const stored = () => tpl({ '2': 'the other agent' });

  test('an unrelated templates refresh preserves unsaved role text', () => {
    renderPreview(stored());
    expect(isDirty()).toBe(false);
    typeRole('reviews the diff');
    expect(isDirty()).toBe(true);

    // Saving or deleting ANY other template re-sends the whole list. This
    // template's stored roles are unchanged; only the object is new.
    renderPreview(stored());
    expect(isDirty()).toBe(true);
  });

  test('repeated refreshes keep preserving it', () => {
    renderPreview(stored());
    typeRole('reviews the diff');
    for (let i = 0; i < 3; i++) renderPreview(stored());
    expect(isDirty()).toBe(true);
  });

  test('the other stored role is still there afterwards', () => {
    // Preserving the local edit must not cost the saved value it was typed
    // alongside — a "just never re-seed" fix would pass the two cases above.
    renderPreview(stored());
    typeRole('reviews the diff');
    renderPreview(stored());
    expect(container.textContent).toContain('the other agent');
  });

  test('CONTROL: our own save round-trips back and clears the dirty state', () => {
    const onUpdateRoles = vi.fn();
    renderPreview(tpl(), onUpdateRoles);
    typeRole('reviews the diff');
    act(() => saveBtn().click());
    expect(onUpdateRoles).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), {
      '1': 'reviews the diff',
    });
    // The server persists and replies with a fresh list carrying the new value.
    renderPreview(tpl({ '1': 'reviews the diff' }), onUpdateRoles);
    expect(isDirty()).toBe(false);
  });

  test('CONTROL: another window changing the saved value still re-seeds', () => {
    renderPreview(tpl({ '1': 'first' }));
    expect(isDirty()).toBe(false);
    // A genuinely different stored value — last writer wins, as documented.
    renderPreview(tpl({ '1': 'second' }));
    expect(isDirty()).toBe(false);
    expect(container.textContent).toContain('second');
  });

  test('CONTROL: a genuine remote edit wins over unsaved local text', () => {
    renderPreview(tpl());
    typeRole('mine');
    expect(isDirty()).toBe(true);
    renderPreview(tpl({ '1': 'theirs' }));
    expect(isDirty()).toBe(false);
    expect(container.textContent).toContain('theirs');
  });

  test('a blank-valued roles map compares equal to no roles at all', () => {
    // `normalizeRoles` drops empty entries, so these two are the same saved
    // value and must not trigger a re-seed that discards local edits. This is
    // also the one case that survives the absent-`roles` trap described above:
    // undefined -> {} IS an identity change, so it reddens on the revert even
    // when the tests around it do not.
    renderPreview(tpl());
    typeRole('kept');
    renderPreview(tpl({ '1': '   ' }));
    expect(isDirty()).toBe(true);
  });
});

type Sub = (msg: ServerMsg) => void;

function renderPanel(opts: {
  subs: Sub[];
  unsubCount: { n: number };
  onRead: (templateId: string) => void;
}) {
  const subscribeServerMsg = (cb: Sub) => {
    opts.subs.push(cb);
    return () => {
      opts.unsubCount.n += 1;
    };
  };
  const render = () => {
    act(() => {
      root.render(
        <TemplatesPanel
          items={[tpl()]}
          mode="orchestrator"
          projects={projects}
          onApply={() => {}}
          onDelete={() => {}}
          onUpdateRoles={() => {}}
          onReadProjectFacts={() => {}}
          subscribeServerMsg={subscribeServerMsg}
          onReadLastRunForTemplate={opts.onRead}
        />,
      );
    });
  };
  render();
  return render;
}

describe('TemplatesPanel — the last-run cache (W10)', () => {
  test('the subscription survives parent re-renders', () => {
    const subs: Sub[] = [];
    const unsubCount = { n: 0 };
    // Every render passes a NEW props object with the SAME callbacks — the
    // shape App.tsx produces once its seam functions are `useCallback`-wrapped.
    const rerender = renderPanel({ subs, unsubCount, onRead: () => {} });
    expect(subs).toHaveLength(1);
    for (let i = 0; i < 5; i++) rerender();
    expect(subs).toHaveLength(1);
    expect(unsubCount.n).toBe(0);
  });

  test('a request fires the moment the ended event arrives, not on the next render', () => {
    const subs: Sub[] = [];
    const unsubCount = { n: 0 };
    const onRead = vi.fn();
    renderPanel({ subs, unsubCount, onRead });
    // Populate the cache: the preview's mount effect asks once, and the
    // server replies.
    act(() => subs[0]!({ type: 'last_run_for_template', templateId: 't1', lastRun: null }));
    onRead.mockClear();

    // Deliver OUTSIDE act(). A send parked inside a `setLastRuns` updater
    // waits for React to render; a send in the callback happens now. This is
    // the observable difference between "the updater is pure" and "the
    // updater is where the side effect lives".
    subs[0]!({ type: 'multi_agent_ended', sessionId: 's1' } as ServerMsg);
    expect(onRead).toHaveBeenCalledWith('t1');
  });

  test('CONTROL: every cached template is refreshed, exactly once each', () => {
    const subs: Sub[] = [];
    const unsubCount = { n: 0 };
    const onRead = vi.fn();
    renderPanel({ subs, unsubCount, onRead });
    act(() => {
      subs[0]!({ type: 'last_run_for_template', templateId: 't1', lastRun: null });
      subs[0]!({ type: 'last_run_for_template', templateId: 't2', lastRun: null });
    });
    onRead.mockClear();
    act(() => subs[0]!({ type: 'multi_agent_ended', sessionId: 's1' } as ServerMsg));
    expect(onRead.mock.calls.map((c) => c[0]).sort()).toEqual(['t1', 't2']);
  });

  test('CONTROL: an empty cache asks for nothing', () => {
    const subs: Sub[] = [];
    const unsubCount = { n: 0 };
    const onRead = vi.fn();
    renderPanel({ subs, unsubCount, onRead });
    onRead.mockClear();
    act(() => subs[0]!({ type: 'multi_agent_ended', sessionId: 's1' } as ServerMsg));
    expect(onRead).not.toHaveBeenCalled();
  });
});

// The matching call-site gate — that App.tsx's seam functions are actually
// `useCallback`-wrapped, without which the dep narrowing above buys nothing —
// lives in `scripts/sideChannelSeamStability.test.mjs`. It cannot live here:
// `web/tsconfig.json` sets `"types": []` on purpose, and
// `web/src/nodeTypeIsolation.test.ts` fails typecheck if that stops being
// true, so a web-side test may not read source off the filesystem.
