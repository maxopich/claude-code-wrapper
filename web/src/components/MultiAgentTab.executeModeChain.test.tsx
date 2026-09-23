// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Project } from '@cebab/shared/protocol';
import type { MultiAgentState } from '../store';
import { DraftView } from './MultiAgentTab';
import { ReopenProvider } from './reopen/ReopenContext';

/**
 * Chain runs get the same execute-mode switch as orchestrator runs (Cebab-3wt3).
 *
 * `Cebab-6fax.4` gave chain participants the same consultant clause the
 * orchestrator's workers carry, and wired `executeMode` end-to-end on the
 * server for chain starts — but the setup screen only rendered the toggle for
 * orchestrator (`isOrch &&`), so the new execute branch was unreachable from
 * the chain UI and chain participants stayed consultant-only.
 *
 * What this file pins: the execute-mode toggle renders in a CHAIN draft, and
 * enabling it also arms pause-on-dangerous — the same safety pairing the
 * orchestrator uses, reused rather than re-invented. The control is the
 * off/consultant case, which must leave pause-on-dangerous untouched.
 */

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

function project(id: number, name: string): Project {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    trusted: false,
    lastUsedAt: null,
    hasClaudeMd: true,
    busInstalled: false,
    busAgentName: null,
    model: null,
    startPermissionMode: null,
    isManaged: false,
    managed: null,
  };
}

const PROJECTS = [project(1, 'alpha'), project(2, 'beta')];

function multiAgent(over: Partial<MultiAgentState> = {}): MultiAgentState {
  return {
    view: 'multi-agent',
    draftLifecycle: 'persistent',
    draftParticipants: [1, 2],
    draftPrompt: '',
    draftPauseOnDangerous: false,
    draftExecuteMode: false,
    active: null,
    iterations: [],
    templates: [],
    lastAppliedDropped: 0,
    draftTemplateId: null,
    draftHopBudget: null,
    draftHopBudgetSource: null,
    draftRoles: {},
    ...over,
  } as MultiAgentState;
}

function render(
  mode: 'chain' | 'orchestrator',
  draft: Partial<MultiAgentState> = {},
): {
  onSetDraftExecuteMode: ReturnType<typeof vi.fn>;
  onSetDraftPauseOnDangerous: ReturnType<typeof vi.fn>;
} {
  const onSetDraftExecuteMode = vi.fn();
  const onSetDraftPauseOnDangerous = vi.fn();
  act(() => {
    root.render(
      <ReopenProvider send={vi.fn()}>
        <DraftView
          mode={mode}
          projects={PROJECTS}
          lastBusInstallAt={{}}
          multiAgent={multiAgent(draft)}
          onSetLifecycle={vi.fn()}
          onAddParticipant={vi.fn()}
          onRemoveParticipant={vi.fn()}
          onReorderParticipant={vi.fn()}
          onInstallBus={vi.fn()}
          onUninstallBus={vi.fn()}
          onSetDraftPrompt={vi.fn()}
          onSetDraftPauseOnDangerous={onSetDraftPauseOnDangerous}
          onSetDraftExecuteMode={onSetDraftExecuteMode}
          onSetDraftHopBudget={vi.fn()}
          defaultHopBudget={30}
          onStart={vi.fn()}
          onResumeSession={vi.fn()}
          failureSeq={0}
          onRefreshIterations={vi.fn()}
          onClearIterations={vi.fn()}
          onSaveTemplate={vi.fn()}
          onUpdateTemplateRoles={vi.fn()}
          onDeleteTemplate={vi.fn()}
          onApplyTemplate={vi.fn()}
          onReadProjectFacts={vi.fn()}
          subscribeServerMsg={() => () => {}}
          onReadLastRunForTemplate={vi.fn()}
        />
      </ReopenProvider>,
    );
  });
  return { onSetDraftExecuteMode, onSetDraftPauseOnDangerous };
}

/** The checkbox inside the label whose text names "execute mode". */
function executeCheckbox(): HTMLInputElement | null {
  const label = Array.from(container.querySelectorAll<HTMLLabelElement>('label')).find((l) =>
    /execute mode/i.test(l.textContent ?? ''),
  );
  return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
}

const click = (el: Element | null) => {
  if (!el) throw new Error('click target missing');
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('chain draft exposes the execute-mode toggle (Cebab-3wt3)', () => {
  test('the toggle renders for a chain draft', () => {
    render('chain');
    // Before the fix the toggle was guarded behind `isOrch`, so a chain draft
    // had no affordance to leave consultant mode at all.
    expect(executeCheckbox()).not.toBeNull();
  });

  test('enabling execute mode for a chain arms pause-on-dangerous', () => {
    const { onSetDraftExecuteMode, onSetDraftPauseOnDangerous } = render('chain');
    click(executeCheckbox());
    expect(onSetDraftExecuteMode).toHaveBeenCalledWith(true);
    // Safety pairing, reused from the orchestrator onChange rather than a second
    // mechanism: turning execute on also turns pause-on-dangerous on.
    expect(onSetDraftPauseOnDangerous).toHaveBeenCalledWith(true);
  });

  test('a chain draft shows the posture banner, and it follows the switch (Cebab-02e9)', () => {
    // The banner was orchestrator-only from when chain participants had no
    // consultant clause. They have one now, and the switch relaxes it, so a
    // chain draft must say which posture the run will start in.
    render('chain');
    const banner = () => container.querySelector('#consultant-mode-banner')?.textContent ?? '';
    expect(banner()).toMatch(/Consultant mode/);
    expect(banner()).not.toMatch(/orchestrator/i);
    act(() => {
      root.unmount();
      root = createRoot(container);
    });
    render('chain', { draftExecuteMode: true });
    expect(banner()).toMatch(/Execute mode/);
  });

  test('control: turning execute OFF leaves pause-on-dangerous as it was', () => {
    const { onSetDraftExecuteMode, onSetDraftPauseOnDangerous } = render('chain', {
      draftExecuteMode: true,
      draftPauseOnDangerous: true,
    });
    click(executeCheckbox());
    // Off -> consultant: the operator's execute choice is cleared...
    expect(onSetDraftExecuteMode).toHaveBeenCalledWith(false);
    // ...but the pairing only fires on enable, so pause-on-dangerous is not
    // touched here — it stays whatever the operator had set.
    expect(onSetDraftPauseOnDangerous).not.toHaveBeenCalled();
  });
});
