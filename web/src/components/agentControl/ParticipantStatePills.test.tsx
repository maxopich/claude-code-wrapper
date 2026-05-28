// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ParticipantControlView } from '../../store';
import { ParticipantStatePills } from './ParticipantStatePills';

// Cluster C Phase 4g1 — ParticipantStatePills contract:
//   - returns null for undefined control and for all-clear controls
//   - muted -> "muted" pill with reason text in tooltip
//   - paused -> "paused" pill with countdown text (Xs left / Xm left)
//   - kicked supersedes muted/paused — only the kicked pill renders
//   - pills carry aria-labels including reason codes

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

describe('ParticipantStatePills — visibility', () => {
  test('returns null when control is undefined', () => {
    act(() => {
      root.render(<ParticipantStatePills control={undefined} />);
    });
    expect(container.querySelector('.ma-control-pills')).toBeNull();
  });

  test('returns null when all flags clear', () => {
    act(() => {
      root.render(<ParticipantStatePills control={ctrl({})} />);
    });
    expect(container.querySelector('.ma-control-pills')).toBeNull();
  });

  test('returns null when only pausedUntil is in the past', () => {
    act(() => {
      root.render(<ParticipantStatePills control={ctrl({ pausedUntil: Date.now() - 5000 })} />);
    });
    expect(container.querySelector('.ma-control-pills')).toBeNull();
  });
});

describe('ParticipantStatePills — muted', () => {
  test('renders the muted pill', () => {
    act(() => {
      root.render(<ParticipantStatePills control={ctrl({ muted: true })} />);
    });
    const pill = container.querySelector('.ma-control-pill.is-muted');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toMatch(/muted/);
  });

  test('aria-label includes reason text when provided', () => {
    act(() => {
      root.render(
        <ParticipantStatePills
          control={ctrl({
            muted: true,
            mutedReasonCode: 'forensics',
            mutedReasonText: 'pending operator review',
          })}
        />,
      );
    });
    const pill = container.querySelector('.ma-control-pill.is-muted')!;
    expect(pill.getAttribute('aria-label')).toContain('pending operator review');
  });

  test('aria-label falls back to reason code when no text', () => {
    act(() => {
      root.render(
        <ParticipantStatePills
          control={ctrl({ muted: true, mutedReasonCode: 'topology_repair' })}
        />,
      );
    });
    const pill = container.querySelector('.ma-control-pill.is-muted')!;
    expect(pill.getAttribute('aria-label')).toContain('topology_repair');
  });
});

describe('ParticipantStatePills — paused', () => {
  test('renders the paused pill with countdown', () => {
    const future = Date.now() + 90_000;
    act(() => {
      root.render(
        <ParticipantStatePills
          control={ctrl({
            pausedUntil: future,
            pauseExpiryAction: 'auto_resume',
            pauseReasonCode: 'forensics',
          })}
        />,
      );
    });
    const pill = container.querySelector('.ma-control-pill.is-paused');
    expect(pill).not.toBeNull();
    // Should round up — "90s left" → may show 90s or 2m depending on race.
    // Accept either "left" presence.
    expect(pill!.textContent).toMatch(/left/);
  });

  test('countdown text uses seconds when < 60s remain', () => {
    const future = Date.now() + 30_000;
    act(() => {
      root.render(
        <ParticipantStatePills
          control={ctrl({ pausedUntil: future, pauseExpiryAction: 'auto_resume' })}
        />,
      );
    });
    const pill = container.querySelector('.ma-control-pill.is-paused')!;
    expect(pill.textContent).toMatch(/\d+s left/);
  });

  test('aria-label mentions expiry action', () => {
    const future = Date.now() + 60_000;
    act(() => {
      root.render(
        <ParticipantStatePills
          control={ctrl({ pausedUntil: future, pauseExpiryAction: 'auto_kick' })}
        />,
      );
    });
    const pill = container.querySelector('.ma-control-pill.is-paused')!;
    expect(pill.getAttribute('aria-label')).toContain('auto-kick');
  });
});

describe('ParticipantStatePills — kicked supersedes', () => {
  test('renders only the kicked pill, even when prior muted/paused fields set', () => {
    act(() => {
      root.render(
        <ParticipantStatePills
          control={ctrl({
            muted: true,
            mutedReasonCode: 'forensics',
            pausedUntil: Date.now() + 60_000,
            kickedAt: Date.now(),
            kickMode: 'drain',
            kickReasonCode: 'tool_misuse',
          })}
        />,
      );
    });
    expect(container.querySelector('.ma-control-pill.is-kicked')).not.toBeNull();
    expect(container.querySelector('.ma-control-pill.is-muted')).toBeNull();
    expect(container.querySelector('.ma-control-pill.is-paused')).toBeNull();
  });

  test('kicked pill aria-label includes reason code', () => {
    act(() => {
      root.render(
        <ParticipantStatePills
          control={ctrl({
            kickedAt: Date.now(),
            kickMode: 'drain',
            kickReasonCode: 'tool_misuse',
          })}
        />,
      );
    });
    const pill = container.querySelector('.ma-control-pill.is-kicked')!;
    expect(pill.getAttribute('aria-label')).toContain('tool_misuse');
  });
});

describe('ParticipantStatePills — both muted and paused', () => {
  test('renders both pills when set and not kicked', () => {
    act(() => {
      root.render(
        <ParticipantStatePills
          control={ctrl({
            muted: true,
            pausedUntil: Date.now() + 60_000,
            pauseExpiryAction: 'auto_resume',
          })}
        />,
      );
    });
    expect(container.querySelector('.ma-control-pill.is-muted')).not.toBeNull();
    expect(container.querySelector('.ma-control-pill.is-paused')).not.toBeNull();
  });
});
