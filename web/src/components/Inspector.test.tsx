// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { Inspector } from './Inspector';

// Redesign Phases 2–4: the inspector frame + per-view body switching.
//
// What this pins:
//   - chat view renders the passed `children` (the relocated session
//     stats + AuthorityPanel), or a neutral placeholder when none.
//   - multi-agent / chained-chat views render the `#inspector-multi-slot`
//     portal target that MultiAgentTab's SessionSettingsPanel portals into.
//   - the pin button reflects `pinned` and fires `onTogglePin`.
//
// createRoot + act, no @testing-library (project convention).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Inspector', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('chat view renders passed children', () => {
    act(() =>
      root.render(
        <Inspector view="chat" pinned={false} onTogglePin={() => {}}>
          <div className="probe">session body</div>
        </Inspector>,
      ),
    );
    expect(container.querySelector('.probe')?.textContent).toBe('session body');
    // No multi slot on the chat variant.
    expect(container.querySelector('#inspector-multi-slot')).toBeNull();
  });

  test('chat view with no children shows the neutral placeholder', () => {
    act(() => root.render(<Inspector view="chat" pinned={false} onTogglePin={() => {}} />));
    expect(container.querySelector('.insp-empty')).not.toBeNull();
    expect(container.querySelector('#inspector-multi-slot')).toBeNull();
  });

  test('multi-agent view renders the portal slot (not the chat placeholder)', () => {
    act(() => root.render(<Inspector view="multi-agent" pinned={false} onTogglePin={() => {}} />));
    const slot = container.querySelector('#inspector-multi-slot');
    expect(slot).not.toBeNull();
    expect(slot?.classList.contains('insp-multi-slot')).toBe(true);
    expect(container.querySelector('.insp-empty')).toBeNull();
  });

  test('chained-chat view also renders the portal slot', () => {
    act(() => root.render(<Inspector view="chained-chat" pinned={false} onTogglePin={() => {}} />));
    expect(container.querySelector('#inspector-multi-slot')).not.toBeNull();
  });

  test('header title tracks the view', () => {
    act(() => root.render(<Inspector view="multi-agent" pinned={false} onTogglePin={() => {}} />));
    expect(container.querySelector('.insp-title')?.textContent).toBe('Session');
  });

  test('pin button reflects state and fires onTogglePin', () => {
    const onTogglePin = vi.fn();
    act(() => root.render(<Inspector view="chat" pinned={true} onTogglePin={onTogglePin} />));
    const pin = container.querySelector('.pin-btn') as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    act(() => pin.click());
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });
});
