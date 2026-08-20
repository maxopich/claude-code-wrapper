// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Project } from '@cebab/shared/protocol';
import type { MultiAgentState } from '../store';
import { DraftView } from './MultiAgentTab';
import { ReopenProvider } from './reopen/ReopenContext';

/**
 * Bus install and bus uninstall ask the same way (registers U15, U16).
 *
 * Install opened a six-line `window.confirm`. Uninstall — the button that
 * replaces it in the same row slot, one click away — fired straight through.
 *
 * The register calls uninstall "the more consequential half". It is the
 * opposite: install GRANTS the capability (that project's agent then runs
 * headless with every tool call auto-approved, its own hooks auto-executing on
 * every bus hop and no human in the loop), and uninstall revokes it. Gating
 * the grant and not the revoke points the right way.
 *
 * The real case for gating uninstall is narrower, and it is what the copy
 * says: two adjacent buttons in one slot, and pulling a project mid-draft
 * breaks the draft. `install.ts` re-derives the same agent slug
 * deterministically, so reinstalling restores the name — the dialog says so
 * rather than implying the action is grave. A gate that overstates
 * consequence is how operators learn to click through the ones that matter.
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

function project(id: number, name: string, over: Partial<Project> = {}): Project {
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
    managed: null,
    ...over,
  };
}

function multiAgent(draftParticipants: number[]): MultiAgentState {
  return {
    view: 'multi-agent',
    draftLifecycle: 'persistent',
    draftParticipants,
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
  } as MultiAgentState;
}

function render(projects: Project[]) {
  const onInstallBus = vi.fn();
  const onUninstallBus = vi.fn();
  act(() => {
    root.render(
      <ReopenProvider send={vi.fn()}>
        <DraftView
          mode="orchestrator"
          projects={projects}
          lastBusInstallAt={{}}
          multiAgent={multiAgent(projects.map((p) => p.id))}
          onSetLifecycle={vi.fn()}
          onAddParticipant={vi.fn()}
          onRemoveParticipant={vi.fn()}
          onReorderParticipant={vi.fn()}
          onInstallBus={onInstallBus}
          onUninstallBus={onUninstallBus}
          onSetDraftPrompt={vi.fn()}
          onSetDraftPauseOnDangerous={vi.fn()}
          onSetDraftExecuteMode={vi.fn()}
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
  return { onInstallBus, onUninstallBus };
}

const rowButton = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.participant-row button')).find(
    (b) => b.textContent?.trim() === label,
  ) ?? null;

const gate = () => document.querySelector('.gate-modal-overlay');
const gateButton = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.gate-modal-btn')).find(
    (b) => b.textContent?.trim() === label,
  ) ?? null;

const click = (el: Element | null) => {
  if (!el) throw new Error('click target missing');
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const INSTALLED = [project(1, 'alpha', { busInstalled: true, busAgentName: 'alpha' })];
const NOT_INSTALLED = [project(1, 'alpha')];

describe('bus uninstall is gated (U15)', () => {
  test('clicking Uninstall opens a dialog and does NOT uninstall yet', () => {
    const h = render(INSTALLED);
    expect(gate()).toBeNull();

    click(rowButton('Uninstall'));

    expect(gate()).not.toBeNull();
    expect(h.onUninstallBus).not.toHaveBeenCalled();
  });

  test('confirming uninstalls exactly once, with the project id', () => {
    const h = render(INSTALLED);
    click(rowButton('Uninstall'));
    click(gateButton('Uninstall'));
    expect(h.onUninstallBus).toHaveBeenCalledTimes(1);
    expect(h.onUninstallBus).toHaveBeenCalledWith(1);
    // ...and the dialog closes behind it.
    expect(gate()).toBeNull();
  });

  test('cancelling leaves the project installed', () => {
    const h = render(INSTALLED);
    click(rowButton('Uninstall'));
    click(gateButton('Cancel'));
    expect(h.onUninstallBus).not.toHaveBeenCalled();
    expect(gate()).toBeNull();
  });

  test('the dialog says the action is cheap, not grave', () => {
    // The copy is the fix here as much as the gate is. If it read like a
    // warning, it would train the operator to dismiss the ones that matter.
    render(INSTALLED);
    click(rowButton('Uninstall'));
    const text = document.querySelector('.gate-modal')?.textContent ?? '';
    expect(text).toContain('alpha');
    expect(text).toMatch(/reversible|restores the same agent name/i);
    expect(text).toMatch(/[Nn]othing inside it is touched/);
  });
});

describe('bus install keeps its gate, now in-app (U16)', () => {
  test('clicking Install bus opens a dialog and does NOT install yet', () => {
    const h = render(NOT_INSTALLED);
    click(rowButton('Install bus'));
    expect(gate()).not.toBeNull();
    expect(h.onInstallBus).not.toHaveBeenCalled();
  });

  test('confirming installs; the dialog still names the auto-approve posture', () => {
    const h = render(NOT_INSTALLED);
    click(rowButton('Install bus'));
    // The one fact the old native dialog existed to deliver must survive the
    // move — this is a grant of headless, auto-approved tool execution.
    //
    // This used to assert the literal `bypassPermissions`, which pinned a
    // false mechanism in place: both routers wire the ask-gate hook, so bus
    // turns run `permissionMode: 'default'` with a live `canUseTool` and the
    // bypass branch is reached only by tests (`bus/guardrail.ts`). The grant
    // being made is unchanged; the words for it are now true.
    const text = document.querySelector('.gate-modal')?.textContent ?? '';
    expect(text).toContain('auto-approved');
    expect(text).toContain('no human in the loop');
    expect(text).not.toContain('bypassPermissions');
    click(gateButton('Install bus'));
    expect(h.onInstallBus).toHaveBeenCalledWith(1);
  });
});
