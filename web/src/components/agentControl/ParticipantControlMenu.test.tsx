// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ParticipantControlView } from '../../store';
import { ParticipantControlMenu } from './ParticipantControlMenu';

// Cluster C Phase 4g2 — ParticipantControlMenu contract:
//   - Trigger button opens/closes the panel; aria-expanded reflects state.
//   - When closed: no menuitem rendered.
//   - When open: menu items render conditionally on the control state:
//       * undefined / clear → Mute, Pause 5m, Pause 15m
//       * muted=true        → Unmute (instead of Mute), Pause 5m/15m
//       * paused (alive)    → Resume (only)
//       * kicked            → trigger disabled, no menu
//   - Chain mode hides Mute/Unmute (replaced by a hint line).
//   - Clicking an item invokes the right callback with reasonCode 'topology_repair'
//     and closes the menu.
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

function render(over: Partial<React.ComponentProps<typeof ParticipantControlMenu>> = {}) {
  const props: React.ComponentProps<typeof ParticipantControlMenu> = {
    projectId: 7,
    agentLabel: 'worker-a',
    sessionMode: 'orchestrator',
    control: undefined,
    onMute: noop,
    onUnmute: noop,
    onPause: noop,
    onResume: noop,
    onKick: noop,
    ...over,
  };
  act(() => {
    root.render(<ParticipantControlMenu {...props} />);
  });
  return props;
}

function openMenu() {
  const trigger = container.querySelector('.ma-control-menu-trigger') as HTMLButtonElement;
  act(() => {
    trigger.click();
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

  test('trigger is disabled when kicked', () => {
    render({ control: ctrl({ kickedAt: Date.now() }) });
    const trigger = container.querySelector('.ma-control-menu-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });
});

describe('ParticipantControlMenu — items by state', () => {
  function itemTexts(): string[] {
    return Array.from(container.querySelectorAll('.ma-control-menu-item')).map(
      (i) => i.textContent?.trim() ?? '',
    );
  }

  test('undefined control: Mute + both Pause durations', () => {
    render();
    openMenu();
    const texts = itemTexts();
    expect(texts.some((t) => t.includes('Mute'))).toBe(true);
    expect(texts.some((t) => t.includes('Pause for 5m'))).toBe(true);
    expect(texts.some((t) => t.includes('Pause for 15m'))).toBe(true);
    expect(texts.some((t) => t.includes('Unmute'))).toBe(false);
    expect(texts.some((t) => t.includes('Resume'))).toBe(false);
  });

  test('muted=true: Unmute replaces Mute', () => {
    render({ control: ctrl({ muted: true }) });
    openMenu();
    const texts = itemTexts();
    expect(texts.some((t) => t.includes('Unmute'))).toBe(true);
    expect(texts.some((t) => t.includes('Mute') && !t.includes('Unmute'))).toBe(false);
    // Pause variants still available (muted + paused are independent verbs).
    expect(texts.some((t) => t.includes('Pause for 5m'))).toBe(true);
  });

  test('paused alive: only Resume rendered (no Pause variants)', () => {
    render({ control: ctrl({ pausedUntil: Date.now() + 60_000 }) });
    openMenu();
    const texts = itemTexts();
    expect(texts.some((t) => t.includes('Resume'))).toBe(true);
    expect(texts.some((t) => t.includes('Pause for 5m'))).toBe(false);
    expect(texts.some((t) => t.includes('Pause for 15m'))).toBe(false);
  });

  test('expired pause: Pause variants reappear (deadline in past)', () => {
    render({ control: ctrl({ pausedUntil: Date.now() - 5000 }) });
    openMenu();
    const texts = itemTexts();
    expect(texts.some((t) => t.includes('Pause for 5m'))).toBe(true);
    expect(texts.some((t) => t.includes('Resume'))).toBe(false);
  });
});

describe('ParticipantControlMenu — chain mode hides Mute/Unmute', () => {
  test('chain mode renders the hint instead of Mute', () => {
    render({ sessionMode: 'chain' });
    openMenu();
    expect(container.querySelector('.ma-control-menu-hint')).not.toBeNull();
    const texts = Array.from(container.querySelectorAll('.ma-control-menu-item')).map(
      (i) => i.textContent?.trim() ?? '',
    );
    expect(texts.some((t) => t.includes('Mute') || t.includes('Unmute'))).toBe(false);
    // Pause is still available in chain mode.
    expect(texts.some((t) => t.includes('Pause for 5m'))).toBe(true);
  });
});

describe('ParticipantControlMenu — dispatch', () => {
  test('Mute click calls onMute(projectId, "topology_repair") and closes', () => {
    const onMute = vi.fn();
    render({ onMute });
    openMenu();
    const item = Array.from(container.querySelectorAll<HTMLButtonElement>('.ma-control-menu-item'))
      .find((b) => b.textContent?.includes('Mute'));
    expect(item).toBeDefined();
    act(() => {
      item!.click();
    });
    expect(onMute).toHaveBeenCalledWith(7, 'topology_repair');
    expect(container.querySelector('.ma-control-menu-panel')).toBeNull();
  });

  test('Pause for 5m click calls onPause with 300000ms + auto_resume', () => {
    const onPause = vi.fn();
    render({ onPause });
    openMenu();
    const item = Array.from(container.querySelectorAll<HTMLButtonElement>('.ma-control-menu-item'))
      .find((b) => b.textContent?.includes('Pause for 5m'));
    act(() => {
      item!.click();
    });
    expect(onPause).toHaveBeenCalledWith(7, 'topology_repair', 5 * 60 * 1000, 'auto_resume');
  });

  test('Pause for 15m uses 900000ms', () => {
    const onPause = vi.fn();
    render({ onPause });
    openMenu();
    const item = Array.from(container.querySelectorAll<HTMLButtonElement>('.ma-control-menu-item'))
      .find((b) => b.textContent?.includes('Pause for 15m'));
    act(() => {
      item!.click();
    });
    expect(onPause).toHaveBeenCalledWith(7, 'topology_repair', 15 * 60 * 1000, 'auto_resume');
  });

  test('Resume click calls onResume + closes', () => {
    const onResume = vi.fn();
    render({ control: ctrl({ pausedUntil: Date.now() + 60_000 }), onResume });
    openMenu();
    const item = Array.from(container.querySelectorAll<HTMLButtonElement>('.ma-control-menu-item'))
      .find((b) => b.textContent?.includes('Resume'));
    act(() => {
      item!.click();
    });
    expect(onResume).toHaveBeenCalledWith(7, 'topology_repair');
  });

  test('Unmute click calls onUnmute', () => {
    const onUnmute = vi.fn();
    render({ control: ctrl({ muted: true }), onUnmute });
    openMenu();
    const item = Array.from(container.querySelectorAll<HTMLButtonElement>('.ma-control-menu-item'))
      .find((b) => b.textContent?.includes('Unmute'));
    act(() => {
      item!.click();
    });
    expect(onUnmute).toHaveBeenCalledWith(7, 'topology_repair');
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
    const kickItem = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.ma-control-menu-item'),
    ).find((b) => b.textContent?.includes('Kick'));
    expect(kickItem).toBeDefined();
    act(() => {
      kickItem!.click();
    });
    expect(document.querySelector('.kick-modal')).not.toBeNull();
    // Dropdown should close once the modal takes over.
    expect(container.querySelector('.ma-control-menu-panel')).toBeNull();
  });

  test('submitting the modal calls onKick + closes the modal', () => {
    const onKick = vi.fn();
    render({ onKick });
    openMenu();
    const kickItem = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.ma-control-menu-item'),
    ).find((b) => b.textContent?.includes('Kick'));
    act(() => {
      kickItem!.click();
    });
    const submit = document.querySelector('.kick-modal .gate-modal-btn-danger') as HTMLButtonElement;
    act(() => {
      submit.click();
    });
    // Default reason topology_repair + no notes → undefined reasonText, drain mode.
    expect(onKick).toHaveBeenCalledWith(7, 'topology_repair', undefined, 'drain');
    expect(document.querySelector('.kick-modal')).toBeNull();
  });

  test('Kick… item hidden when participant is already kicked', () => {
    render({ control: { projectId: 7, muted: false, pausedUntil: null, kickedAt: Date.now() } });
    // Trigger button is disabled in this case, so we can't openMenu(). Verify
    // trigger state directly + no Kick… item is even possible.
    const trigger = container.querySelector('.ma-control-menu-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });
});
