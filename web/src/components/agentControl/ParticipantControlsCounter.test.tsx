// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MultiAgentRun, ParticipantControlView } from '../../store';
import { ParticipantControlsCounter } from './ParticipantControlsCounter';

// Cluster C Phase 4g1 — ParticipantControlsCounter contract:
//   - hidden when count = 0 (no row OR all rows clear)
//   - shows "N controlled" with the right N (muted + paused-alive + kicked)
//   - upgrades to has-kicked tint when any participant is kicked
//   - aria-label includes the breakdown
//   - tooltip mentions kick when applicable

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
  vi.useRealTimers();
});

function ctrl(over: Partial<ParticipantControlView>): ParticipantControlView {
  return {
    projectId: 1,
    muted: false,
    pausedUntil: null,
    kickedAt: null,
    ...over,
  };
}

function mkRun(participantControls: Record<number, ParticipantControlView>): MultiAgentRun {
  return {
    sessionId: 'bus-1',
    mode: 'orchestrator',
    participantAgentNames: ['orchestrator', 'worker-a'],
    status: 'running',
    events: [],
    iterationId: null,
    lifecycle: 'persistent',
    sessionFolder: '/tmp/.cebab/bus-1',
    awaitingContinue: false,
    activity: null,
    hopBudget: 30,
    pendingRetry: null,
    pauseOnDangerous: false,
    mutationsAcknowledged: false,
    mutations: [],
    pendingMutation: null,
    pendingQuestion: null,
    recoveryContext: null,
    routerDrops: [],
    participantControls,
    modelsByProject: {},
  };
}

describe('ParticipantControlsCounter — visibility', () => {
  test('renders nothing when participantControls is empty', () => {
    act(() => {
      root.render(<ParticipantControlsCounter run={mkRun({})} />);
    });
    expect(container.querySelector('.ma-participant-controls-chip')).toBeNull();
  });

  test('renders nothing when all rows are clear (post-resume / post-unmute)', () => {
    const run = mkRun({
      1: ctrl({ projectId: 1, muted: false, pausedUntil: null, kickedAt: null }),
    });
    act(() => {
      root.render(<ParticipantControlsCounter run={run} />);
    });
    expect(container.querySelector('.ma-participant-controls-chip')).toBeNull();
  });

  test('renders nothing when paused deadline has passed', () => {
    const run = mkRun({
      1: ctrl({ projectId: 1, pausedUntil: Date.now() - 5000 }),
    });
    act(() => {
      root.render(<ParticipantControlsCounter run={run} />);
    });
    expect(container.querySelector('.ma-participant-controls-chip')).toBeNull();
  });
});

describe('ParticipantControlsCounter — count and labels', () => {
  test('shows "1 controlled" when one participant muted', () => {
    const run = mkRun({
      1: ctrl({ projectId: 1, muted: true }),
    });
    act(() => {
      root.render(<ParticipantControlsCounter run={run} />);
    });
    const chip = container.querySelector('.ma-participant-controls-chip');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('1 controlled');
    expect(chip!.getAttribute('aria-label')).toContain('muted 1');
  });

  test('pluralizes correctly with multiple controlled', () => {
    const run = mkRun({
      1: ctrl({ projectId: 1, muted: true }),
      2: ctrl({ projectId: 2, pausedUntil: Date.now() + 60_000 }),
      3: ctrl({ projectId: 3, kickedAt: Date.now() }),
    });
    act(() => {
      root.render(<ParticipantControlsCounter run={run} />);
    });
    const chip = container.querySelector('.ma-participant-controls-chip')!;
    expect(chip.textContent).toContain('3 controlled');
    const aria = chip.getAttribute('aria-label')!;
    expect(aria).toContain('muted 1');
    expect(aria).toContain('paused 1');
    expect(aria).toContain('kicked 1');
  });

  test('upgrades to has-kicked tint when any participant is kicked', () => {
    const run = mkRun({
      1: ctrl({ projectId: 1, kickedAt: Date.now() }),
    });
    act(() => {
      root.render(<ParticipantControlsCounter run={run} />);
    });
    const chip = container.querySelector('.ma-participant-controls-chip')!;
    expect(chip.classList.contains('has-kicked')).toBe(true);
    expect(chip.getAttribute('title')).toMatch(/kicked/i);
  });

  test('no has-kicked when only muted/paused, even with multiple', () => {
    const run = mkRun({
      1: ctrl({ projectId: 1, muted: true }),
      2: ctrl({ projectId: 2, pausedUntil: Date.now() + 60_000 }),
    });
    act(() => {
      root.render(<ParticipantControlsCounter run={run} />);
    });
    const chip = container.querySelector('.ma-participant-controls-chip')!;
    expect(chip.classList.contains('has-kicked')).toBe(false);
  });
});
