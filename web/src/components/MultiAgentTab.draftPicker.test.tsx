// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Project } from '@cebab/shared/protocol';
import type { MultiAgentState } from '../store';
import { DraftView } from './MultiAgentTab';
import { ReopenProvider } from './reopen/ReopenContext';

/**
 * Composing a multi-agent run does not require a mouse (register U03).
 *
 * The draft view's only path into the participant list was a drop zone whose
 * placeholder read "Drag a project here to add it as a participant". HTML5
 * drag-and-drop is reachable by neither keyboard nor touch, so those operators
 * could not compose a run at all — while the *active-run* view, two screens
 * later, already had a perfectly good button picker.
 *
 * The fix reuses that picker rather than writing a second one, in a `draft`
 * voice: in a live session an Add installs bus metadata and notifies the
 * orchestrator, in a draft it only appends to `draftParticipants`. Same
 * component, two strings different, so the two paths cannot drift.
 *
 * What this file pins: the picker exists in the draft, offers exactly the
 * projects that are not already participants, dispatches the same handler the
 * drop path dispatches, and has NOT replaced drag-and-drop.
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
    ...over,
  };
}

const PROJECTS = [project(1, 'alpha'), project(2, 'beta'), project(3, 'gamma')];

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

function render(draftParticipants: number[]): { onAddParticipant: ReturnType<typeof vi.fn> } {
  const onAddParticipant = vi.fn();
  act(() => {
    root.render(
      <ReopenProvider send={vi.fn()}>
        <DraftView
          mode="orchestrator"
          projects={PROJECTS}
          lastBusInstallAt={{}}
          multiAgent={multiAgent(draftParticipants)}
          onSetLifecycle={vi.fn()}
          onAddParticipant={onAddParticipant}
          onRemoveParticipant={vi.fn()}
          onReorderParticipant={vi.fn()}
          onInstallBus={vi.fn()}
          onUninstallBus={vi.fn()}
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
  return { onAddParticipant };
}

function pickButtons(): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>('.ma-draft-add .add-participant-pick-btn'),
  ];
}

describe('[a11y] the draft view offers a non-drag path to add a participant', () => {
  test('every project gets a real, named, focusable Add button', () => {
    render([]);
    const buttons = pickButtons();
    expect(buttons).toHaveLength(PROJECTS.length);
    for (const btn of buttons) {
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.disabled).toBe(false);
      expect(btn.tabIndex).toBe(0);
      // "Add" alone would be announced three times with no object.
      expect(btn.getAttribute('aria-label')).toMatch(/^Add \w+ as a participant$/);
    }
  });

  test('clicking Add dispatches the same handler the drop path uses', () => {
    const { onAddParticipant } = render([]);
    const beta = pickButtons().find(
      (b) => b.getAttribute('aria-label') === 'Add beta as a participant',
    );
    expect(beta).toBeDefined();
    act(() => {
      beta!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onAddParticipant).toHaveBeenCalledWith(2);
  });

  test('projects already in the draft are not offered again', () => {
    render([1, 3]);
    const labels = pickButtons().map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Add beta as a participant']);
  });

  test('an exhausted list says so instead of rendering an empty picker', () => {
    render([1, 2, 3]);
    expect(pickButtons()).toHaveLength(0);
    expect(container.querySelector('.add-participant-empty')?.textContent).toContain(
      'No projects left to add',
    );
  });

  test('drag-and-drop is not regressed', () => {
    // The picker is an additional path. The drop zone must still be mounted,
    // and its placeholder must stop advertising drag as the only one.
    render([]);
    expect(container.querySelector('.drop-zone')).not.toBeNull();
    const placeholder = container.querySelector('.drop-zone-placeholder')?.textContent ?? '';
    expect(placeholder).toContain('Drag a project here');
    expect(placeholder).toContain('add one from the list below');
  });

  test('the picker starts open while the draft is empty and collapses once it is not', () => {
    render([]);
    expect(container.querySelector<HTMLDetailsElement>('.ma-draft-add')?.open).toBe(true);
    render([1]);
    expect(container.querySelector<HTMLDetailsElement>('.ma-draft-add')?.open).toBe(false);
  });
});
