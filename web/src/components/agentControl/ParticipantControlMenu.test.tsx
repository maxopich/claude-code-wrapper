// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ParticipantControlView } from '../../store';
import { ParticipantControlMenu } from './ParticipantControlMenu';
import { ForensicViewerProvider } from './ForensicViewerContext';

// Cluster C Phase 4g2 → 4g5 — ParticipantControlMenu contract:
//   - Trigger ⋮ button opens/closes the panel; aria-expanded reflects state.
//   - When closed: no menuitem rendered.
//   - When open: items rendered conditionally on the control state:
//       * undefined / clear → Mute…, Pause…
//       * muted=true        → Unmute…, Pause…
//       * paused (alive)    → Resume… (only)
//       * kicked            → trigger stays enabled; menu shows only
//                             "View forensics…" (C4g4 affordance)
//   - Chain mode hides Mute/Unmute (replaced by a hint line).
//   - Clicking any non-kicked item opens the corresponding reason modal
//     (C4g5 — direct dispatch was removed in favor of a reason picker).
//   - Submitting the modal invokes the right callback with the right shape
//     and closes the modal.
//   - Escape closes the menu.

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

function noop() {}
/**
 * Cebab-u0s: the control-verb props now return "did it go out". `true` is the
 * default for every existing case because it reproduces the old behaviour —
 * which makes those cases the CONTROL for the new ones that pass `false`.
 */
function sent(): boolean {
  return true;
}

function render(
  over: Partial<React.ComponentProps<typeof ParticipantControlMenu>> = {},
  send: (msg: unknown) => void = noop,
) {
  const props: React.ComponentProps<typeof ParticipantControlMenu> = {
    projectId: 7,
    sessionId: 'bus-1',
    agentLabel: 'worker-a',
    sessionMode: 'orchestrator',
    control: undefined,
    onMute: sent,
    onUnmute: sent,
    onPause: sent,
    onResume: sent,
    onKick: sent,
    ...over,
  };
  act(() => {
    root.render(
      <ForensicViewerProvider send={send as never}>
        <ParticipantControlMenu {...props} />
      </ForensicViewerProvider>,
    );
  });
  return props;
}

function openMenu() {
  const trigger = container.querySelector('.ma-control-menu-trigger') as HTMLButtonElement;
  act(() => {
    trigger.click();
  });
}

function clickItemContaining(text: string) {
  const item = Array.from(
    container.querySelectorAll<HTMLButtonElement>('.ma-control-menu-item'),
  ).find((b) => b.textContent?.includes(text));
  expect(item, `menu item matching "${text}"`).toBeDefined();
  act(() => {
    item!.click();
  });
}

describe('ParticipantControlMenu — trigger', () => {
  test('renders the ⋮ trigger', () => {
    render();
    const trigger = container.querySelector('.ma-control-menu-trigger');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toBe('⋮');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  test('clicking toggles open/closed', () => {
    render();
    const trigger = container.querySelector('.ma-control-menu-trigger') as HTMLButtonElement;
    act(() => {
      trigger.click();
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.ma-control-menu-panel')).not.toBeNull();
    act(() => {
      trigger.click();
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.ma-control-menu-panel')).toBeNull();
  });

  test('trigger stays enabled when kicked (C4g4 forensic viewer access)', () => {
    render({ control: ctrl({ kickedAt: Date.now() }) });
    const trigger = container.querySelector('.ma-control-menu-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-label')).toMatch(/forensics/i);
  });
});

describe('ParticipantControlMenu — items by state', () => {
  function itemTexts(): string[] {
    return Array.from(container.querySelectorAll('.ma-control-menu-item')).map(
      (i) => i.textContent?.trim() ?? '',
    );
  }

  test('undefined control: Mute… + Pause…', () => {
    render();
    openMenu();
    const texts = itemTexts();
    expect(texts.some((t) => t.includes('Mute…'))).toBe(true);
    expect(texts.some((t) => t.includes('Pause…'))).toBe(true);
    expect(texts.some((t) => t.includes('Unmute'))).toBe(false);
    expect(texts.some((t) => t.includes('Resume'))).toBe(false);
  });

  test('muted=true: Unmute… replaces Mute…', () => {
    render({ control: ctrl({ muted: true }) });
    openMenu();
    const texts = itemTexts();
    expect(texts.some((t) => t.includes('Unmute…'))).toBe(true);
    expect(texts.some((t) => t.includes('Mute…') && !t.includes('Unmute'))).toBe(false);
    // Pause… still available (muted + paused are independent verbs).
    expect(texts.some((t) => t.includes('Pause…'))).toBe(true);
  });

  test('paused alive: only Resume… rendered (no Pause… variant)', () => {
    render({ control: ctrl({ pausedUntil: Date.now() + 60_000 }) });
    openMenu();
    const texts = itemTexts();
    expect(texts.some((t) => t.includes('Resume…'))).toBe(true);
    expect(texts.some((t) => t.includes('Pause…'))).toBe(false);
  });

  test('expired pause: Pause… reappears (deadline in past)', () => {
    render({ control: ctrl({ pausedUntil: Date.now() - 5000 }) });
    openMenu();
    const texts = itemTexts();
    expect(texts.some((t) => t.includes('Pause…'))).toBe(true);
    expect(texts.some((t) => t.includes('Resume…'))).toBe(false);
  });
});

describe('ParticipantControlMenu — chain mode hides Mute/Unmute', () => {
  test('chain mode renders a disabled Mute item instead of an actionable one', () => {
    // U26 changed the SHAPE of this explanation, not its presence. It used to
    // be a `<p class="ma-control-menu-hint">` sitting inside `role="menu"` — a
    // child that role forbids, and one a screen reader in menu-browsing mode
    // never reached. It is now a disabled menu item: same sentence, in the
    // accessibility tree, reachable by the arrow keys.
    render({ sessionMode: 'chain' });
    openMenu();
    const unavailable = container.querySelector('.ma-control-menu-item[aria-disabled="true"]');
    expect(unavailable).not.toBeNull();
    expect(unavailable?.textContent).toContain('Mute');
    expect(unavailable?.textContent).toMatch(/chain mode/i);

    // What must NOT be there is an *actionable* Mute/Unmute.
    const actionable = Array.from(
      container.querySelectorAll('.ma-control-menu-item:not([aria-disabled="true"])'),
    ).map((i) => i.textContent?.trim() ?? '');
    expect(actionable.some((t) => t.includes('Mute') || t.includes('Unmute'))).toBe(false);
    // Pause… is still available in chain mode.
    expect(actionable.some((t) => t.includes('Pause…'))).toBe(true);
  });
});

describe('ParticipantControlMenu — modal open + dispatch (C4g5)', () => {
  test('Mute… click opens MuteReasonModal (action=mute)', () => {
    render();
    openMenu();
    expect(document.querySelector('.mute-reason-modal')).toBeNull();
    clickItemContaining('Mute…');
    const modal = document.querySelector('.mute-reason-modal');
    expect(modal).not.toBeNull();
    expect(modal?.classList.contains('mute-reason-modal-mute')).toBe(true);
    // Dropdown closes the moment a modal takes over.
    expect(container.querySelector('.ma-control-menu-panel')).toBeNull();
  });

  test('submitting the Mute modal calls onMute(projectId, reasonCode, reasonText|undefined)', () => {
    const onMute = vi.fn(() => true);
    render({ onMute });
    openMenu();
    clickItemContaining('Mute…');
    const submit = document.querySelector(
      '.mute-reason-modal .gate-modal-btn-primary',
    ) as HTMLButtonElement;
    act(() => {
      submit.click();
    });
    expect(onMute).toHaveBeenCalledWith(7, 'topology_repair', undefined);
    expect(document.querySelector('.mute-reason-modal')).toBeNull();
  });

  test('an undelivered mute leaves the modal open (Cebab-u0s)', () => {
    // The control for the case above, with the one thing changed that matters.
    //
    // Worth stating why this lives HERE as well as in MuteReasonModal.test:
    // there were TWO closers. This component called `closeModal()` and the
    // modal called its own `onClose()` — the comment above `handleMuteSubmit`
    // even described the second one as the real closer. Gating either alone
    // leaves the modal closing, so both need a case.
    const onMute = vi.fn(() => false);
    render({ onMute });
    openMenu();
    clickItemContaining('Mute…');
    const submit = document.querySelector(
      '.mute-reason-modal .gate-modal-btn-primary',
    ) as HTMLButtonElement;
    act(() => {
      submit.click();
    });
    expect(onMute).toHaveBeenCalledWith(7, 'topology_repair', undefined);
    expect(document.querySelector('.mute-reason-modal')).not.toBeNull();
  });

  test('Unmute… click opens MuteReasonModal (action=unmute)', () => {
    render({ control: ctrl({ muted: true }) });
    openMenu();
    clickItemContaining('Unmute…');
    const modal = document.querySelector('.mute-reason-modal');
    expect(modal?.classList.contains('mute-reason-modal-unmute')).toBe(true);
  });

  test('submitting the Unmute modal calls onUnmute', () => {
    const onUnmute = vi.fn(() => true);
    render({ control: ctrl({ muted: true }), onUnmute });
    openMenu();
    clickItemContaining('Unmute…');
    const submit = document.querySelector(
      '.mute-reason-modal .gate-modal-btn-primary',
    ) as HTMLButtonElement;
    act(() => {
      submit.click();
    });
    expect(onUnmute).toHaveBeenCalledWith(7, 'topology_repair', undefined);
  });

  test('Pause… click opens PauseReasonModal', () => {
    render();
    openMenu();
    expect(document.querySelector('.pause-reason-modal')).toBeNull();
    clickItemContaining('Pause…');
    expect(document.querySelector('.pause-reason-modal')).not.toBeNull();
  });

  test('submitting the Pause modal calls onPause with default 15m / auto_resume', () => {
    const onPause = vi.fn(() => true);
    render({ onPause });
    openMenu();
    clickItemContaining('Pause…');
    const submit = document.querySelector(
      '.pause-reason-modal .gate-modal-btn-primary',
    ) as HTMLButtonElement;
    act(() => {
      submit.click();
    });
    expect(onPause).toHaveBeenCalledWith(
      7,
      'topology_repair',
      undefined,
      15 * 60 * 1000,
      'auto_resume',
    );
  });

  test('Resume… click opens MuteReasonModal (action=resume)', () => {
    render({ control: ctrl({ pausedUntil: Date.now() + 60_000 }) });
    openMenu();
    clickItemContaining('Resume…');
    const modal = document.querySelector('.mute-reason-modal');
    expect(modal?.classList.contains('mute-reason-modal-resume')).toBe(true);
  });

  test('submitting the Resume modal calls onResume', () => {
    const onResume = vi.fn(() => true);
    render({ control: ctrl({ pausedUntil: Date.now() + 60_000 }), onResume });
    openMenu();
    clickItemContaining('Resume…');
    const submit = document.querySelector(
      '.mute-reason-modal .gate-modal-btn-primary',
    ) as HTMLButtonElement;
    act(() => {
      submit.click();
    });
    expect(onResume).toHaveBeenCalledWith(7, 'topology_repair', undefined);
  });
});

describe('ParticipantControlMenu — dismissal', () => {
  test('Escape closes the menu', () => {
    render();
    openMenu();
    expect(container.querySelector('.ma-control-menu-panel')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.ma-control-menu-panel')).toBeNull();
  });

  test('click outside closes the menu', () => {
    render();
    openMenu();
    expect(container.querySelector('.ma-control-menu-panel')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector('.ma-control-menu-panel')).toBeNull();
  });

  test('click INSIDE the panel does not close it', () => {
    render();
    openMenu();
    const panel = container.querySelector('.ma-control-menu-panel') as HTMLElement;
    expect(panel).not.toBeNull();
    act(() => {
      panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector('.ma-control-menu-panel')).not.toBeNull();
  });
});

describe('ParticipantControlMenu — Kick item (C4g3)', () => {
  test('Kick… item shown in orchestrator mode', () => {
    render({ sessionMode: 'orchestrator' });
    openMenu();
    const items = Array.from(container.querySelectorAll('.ma-control-menu-item')).map(
      (i) => i.textContent?.trim() ?? '',
    );
    expect(items.some((t) => t.includes('Kick'))).toBe(true);
  });

  test('Kick… item hidden in chain mode', () => {
    render({ sessionMode: 'chain' });
    openMenu();
    const items = Array.from(container.querySelectorAll('.ma-control-menu-item')).map(
      (i) => i.textContent?.trim() ?? '',
    );
    expect(items.some((t) => t.includes('Kick'))).toBe(false);
  });

  test('Kick… click opens KickModal', () => {
    render();
    openMenu();
    expect(document.querySelector('.kick-modal')).toBeNull();
    clickItemContaining('Kick');
    expect(document.querySelector('.kick-modal')).not.toBeNull();
    expect(container.querySelector('.ma-control-menu-panel')).toBeNull();
  });

  test('submitting the Kick modal calls onKick + closes the modal', () => {
    const onKick = vi.fn(() => true);
    render({ onKick });
    openMenu();
    clickItemContaining('Kick');
    const submit = document.querySelector(
      '.kick-modal .gate-modal-btn-danger',
    ) as HTMLButtonElement;
    act(() => {
      submit.click();
    });
    expect(onKick).toHaveBeenCalledWith(7, 'topology_repair', undefined, 'drain');
    expect(document.querySelector('.kick-modal')).toBeNull();
  });

  test('kicked participant menu shows ONLY View forensics… item', () => {
    render({ control: { projectId: 7, muted: false, pausedUntil: null, kickedAt: Date.now() } });
    openMenu();
    const items = Array.from(container.querySelectorAll('.ma-control-menu-item')).map(
      (i) => i.textContent?.trim() ?? '',
    );
    expect(items.some((t) => t.includes('View forensics'))).toBe(true);
    // C4g4: no mute/pause/kick affordances on a kicked participant.
    expect(items.some((t) => t.includes('Mute'))).toBe(false);
    expect(items.some((t) => t.includes('Pause'))).toBe(false);
    expect(items.some((t) => t.includes('Resume'))).toBe(false);
    expect(items.some((t) => t.startsWith('⨯'))).toBe(false);
  });
});
