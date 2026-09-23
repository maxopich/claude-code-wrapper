// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { IterationSummary, Project } from '@cebab/shared/protocol';
import type { MultiAgentState } from '../store';
import { DraftView } from './MultiAgentTab';
import { ReopenProvider } from './reopen/ReopenContext';

/**
 * Cebab-7vl4: a failed or cancelled multi-agent resume must clear the stuck
 * "Resuming…" spinner. The DraftView clears its `pendingResumeId` on a
 * `failureSeq` bump; the store's `wrapper_error` branch is what bumps it for a
 * known-iteration session (verified in store.wrapper_error.test.ts). This test
 * pins the client half: click Resume → the row shows "Resuming…"; a failureSeq
 * bump → the spinner clears back to "Resume".
 *
 * Before the store fix, a resume-failure wrapper_error whose sessionId was an
 * iteration (not `state.multiAgent.active`) never bumped failureSeq, so this
 * effect never fired and the button stayed on "Resuming…" indefinitely.
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

function iteration(sessionId: string): IterationSummary {
  return {
    iterationId: '001',
    sessionId,
    mode: 'orchestrator',
    status: 'running',
    startedAt: 1000,
    endedAt: null,
    participantAgentNames: ['alpha'],
    artifactsDir: `/tmp/${sessionId}`,
    // Resumable — a still-live run, which is exactly what Resume re-attaches to.
    resumable: true,
  };
}

function multiAgent(iterations: IterationSummary[]): MultiAgentState {
  return {
    view: 'multi-agent',
    draftLifecycle: 'persistent',
    draftParticipants: [1],
    draftPrompt: '',
    draftPauseOnDangerous: false,
    draftExecuteMode: false,
    active: null,
    iterations,
    templates: [],
    lastAppliedDropped: 0,
    draftTemplateId: null,
    draftHopBudget: null,
    draftHopBudgetSource: null,
    draftRoles: {},
  } as MultiAgentState;
}

function renderDraft(failureSeq: number, onResumeSession: (sid: string) => void) {
  act(() => {
    root.render(
      <ReopenProvider send={vi.fn()}>
        <DraftView
          mode="orchestrator"
          projects={[project(1, 'alpha')]}
          lastBusInstallAt={{}}
          multiAgent={multiAgent([iteration('bus-1')])}
          onSetLifecycle={vi.fn()}
          onAddParticipant={vi.fn()}
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
          onResumeSession={onResumeSession}
          failureSeq={failureSeq}
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
}

const byText = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.replace(/\s+/g, ' ').trim() === label,
  ) ?? null;

const click = (el: Element | null) => {
  if (!el) throw new Error('click target missing');
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('MultiAgentTab / a pending Resume clears on failureSeq (Cebab-7vl4)', () => {
  test('Resume shows the spinner, then a failureSeq bump clears it', () => {
    const onResumeSession = vi.fn();
    renderDraft(0, onResumeSession);

    // Open the Iterations panel, then Resume the live run.
    click(container.querySelector('.iterations-toggle'));
    const resumeBtn = byText('Resume');
    expect(resumeBtn).not.toBeNull();
    click(resumeBtn);

    // The row is now spinning — the request went out and the button is disabled.
    expect(onResumeSession).toHaveBeenCalledWith('bus-1');
    const spinning = container.querySelector<HTMLButtonElement>('.iteration-resume');
    expect(spinning?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Resuming…');
    expect(spinning?.disabled).toBe(true);

    // The resume failed: the store bumped failureSeq. Re-render with the new
    // value — the spinner must clear back to a fresh, clickable Resume button.
    renderDraft(1, onResumeSession);
    const cleared = container.querySelector<HTMLButtonElement>('.iteration-resume');
    expect(cleared?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Resume');
    expect(cleared?.disabled).toBe(false);
  });
});
