// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, NotificationEnvelope, ServerMsg } from '@cebab/shared/protocol';
import { InboxProvider } from './InboxContext';
import { NotificationBell } from './NotificationBell';

// Cluster A Phase 5 (UI surface):
//   - Bell renders with no badge when unackedGlobal === 0.
//   - Badge appears + shows the count when > 0; caps at "99+".
//   - Click opens the popover and fires a fresh request_inbox_snapshot
//     (`includeAcked: true`) so a long-running tab sees recent activity
//     even after acks landed.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

// Stub localStorage so muteStore (read by the popover's mute panel) has
// a working backing store.
const stubStorage = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
    backing: map,
  };
})();

beforeEach(() => {
  stubStorage.backing.clear();
  vi.stubGlobal('localStorage', stubStorage);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

function makeEnvelope(overrides: Partial<NotificationEnvelope> = {}): NotificationEnvelope {
  return {
    id: 'env',
    ts: 1_700_000_000_000,
    severity: 'warn',
    class: 'operational',
    dedupeKey: 'wrap:1',
    title: 'A notification',
    sticky: true,
    ...overrides,
  };
}

function pushSnapshot(
  handler: ((m: ServerMsg) => void) | null,
  rows: NotificationEnvelope[],
  total: number,
) {
  if (!handler) return;
  handler({
    type: 'inbox_snapshot',
    rows,
    unackedCountBySession: { '': total },
    unackedGlobal: total,
  });
}

describe('NotificationBell — badge', () => {
  test('no badge when unackedGlobal === 0', () => {
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    act(() => {
      root.render(
        <InboxProvider send={() => {}} handlerRef={handlerRef}>
          <NotificationBell />
        </InboxProvider>,
      );
    });

    act(() => {
      pushSnapshot(handlerRef.current, [], 0);
    });

    const badge = container.querySelector('.notif-bell-badge');
    expect(badge).toBeNull();
    const bell = container.querySelector('.notif-bell');
    expect(bell?.getAttribute('data-has-unread')).toBe('false');
  });

  test('badge shows the count and data-has-unread flips', () => {
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    act(() => {
      root.render(
        <InboxProvider send={() => {}} handlerRef={handlerRef}>
          <NotificationBell />
        </InboxProvider>,
      );
    });

    act(() => {
      pushSnapshot(handlerRef.current, [makeEnvelope()], 7);
    });

    const badge = container.querySelector('.notif-bell-badge');
    expect(badge?.textContent).toBe('7');
    expect(container.querySelector('.notif-bell')?.getAttribute('data-has-unread')).toBe('true');
  });

  test('badge caps at 99+ when over 99', () => {
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    act(() => {
      root.render(
        <InboxProvider send={() => {}} handlerRef={handlerRef}>
          <NotificationBell />
        </InboxProvider>,
      );
    });

    act(() => {
      pushSnapshot(handlerRef.current, [makeEnvelope()], 250);
    });

    expect(container.querySelector('.notif-bell-badge')?.textContent).toBe('99+');
  });
});

describe('NotificationBell — click opens panel + requests fresh snapshot', () => {
  test('click sends request_inbox_snapshot with includeAcked=true', () => {
    const sent: ClientMsg[] = [];
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    act(() => {
      root.render(
        <InboxProvider send={(m) => sent.push(m)} handlerRef={handlerRef}>
          <NotificationBell />
        </InboxProvider>,
      );
    });

    // Pre-load some state so the bell is hot, not in `loading…` mode.
    act(() => {
      pushSnapshot(handlerRef.current, [makeEnvelope()], 1);
    });

    sent.length = 0;
    const bellBtn = container.querySelector<HTMLButtonElement>('.notif-bell');
    expect(bellBtn).not.toBeNull();
    act(() => {
      bellBtn!.click();
    });

    // Panel is visible.
    expect(container.querySelector('.notif-inbox-popover')).not.toBeNull();
    // Click sends a fresh snapshot request. The panel ALSO sends one on
    // mount via its filter useEffect — both carry `includeAcked: true`
    // (panel default + bell's explicit). What we care about: the bell's
    // openPanel request was first and shaped correctly.
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]).toEqual({
      type: 'request_inbox_snapshot',
      filters: { includeAcked: true },
    });
  });

  test('second click closes the panel', () => {
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    act(() => {
      root.render(
        <InboxProvider send={() => {}} handlerRef={handlerRef}>
          <NotificationBell />
        </InboxProvider>,
      );
    });

    act(() => {
      pushSnapshot(handlerRef.current, [], 0);
    });

    const bellBtn = container.querySelector<HTMLButtonElement>('.notif-bell')!;
    act(() => {
      bellBtn.click();
    });
    expect(container.querySelector('.notif-inbox-popover')).not.toBeNull();

    act(() => {
      bellBtn.click();
    });
    expect(container.querySelector('.notif-inbox-popover')).toBeNull();
  });
});
