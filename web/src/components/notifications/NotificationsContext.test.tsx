// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { NotificationEnvelope } from '@cebab/shared/protocol';
import {
  NotificationsProvider,
  useNotificationsActions,
  useNotificationsState,
} from './NotificationsContext';
import { _clearAllMutes, addMute } from './muteStore';

/**
 * Cluster A Phase 5: confirms the display-side mute gate fires inside
 * `NotificationsContext.push`. The spec contract:
 *   - Muted envelope → push is a no-op (toast suppressed).
 *   - Server still persisted the row (this layer doesn't touch the DB
 *     — inbox snapshots show it).
 *   - error/danger envelopes IGNORE mutes (`isMuted` returns false even
 *     if a row exists), so the operator never miss-by-mute a real
 *     safety event.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

// Stub localStorage so muteStore reads/writes through a Map. Avoids
// coupling to jsdom's Storage implementation.
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
  _clearAllMutes();
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
    id: `env-${Math.random().toString(36).slice(2, 8)}`,
    ts: 1_700_000_000_000,
    severity: 'warn',
    class: 'operational',
    dedupeKey: 'wrap:global',
    title: 'Hi',
    sticky: false,
    ...overrides,
  };
}

describe('NotificationsContext push — mute gate', () => {
  test('non-muted envelope reaches state.visible', () => {
    const holder: {
      state?: ReturnType<typeof useNotificationsState>;
      push?: (n: NotificationEnvelope) => void;
    } = {};
    function Probe() {
      holder.state = useNotificationsState();
      holder.push = useNotificationsActions().push;
      return null;
    }

    act(() => {
      root.render(
        <NotificationsProvider>
          <Probe />
        </NotificationsProvider>,
      );
    });

    act(() => {
      holder.push!(makeEnvelope({ id: 'a' }));
    });

    expect(holder.state?.visible).toHaveLength(1);
    expect(holder.state?.visible[0]?.id).toBe('a');
  });

  test('muted envelope is silently suppressed', () => {
    addMute({ dedupeKey: 'wrap:any', severity: 'warn' }, 'forever');

    const holder: {
      state?: ReturnType<typeof useNotificationsState>;
      push?: (n: NotificationEnvelope) => void;
    } = {};
    function Probe() {
      holder.state = useNotificationsState();
      holder.push = useNotificationsActions().push;
      return null;
    }

    act(() => {
      root.render(
        <NotificationsProvider>
          <Probe />
        </NotificationsProvider>,
      );
    });

    act(() => {
      holder.push!(makeEnvelope({ id: 'muted', dedupeKey: 'wrap:variant' }));
    });

    expect(holder.state?.visible).toHaveLength(0);
    expect(holder.state?.queued).toHaveLength(0);
  });

  test('error envelope ignores existing mute (defense in depth)', () => {
    addMute({ dedupeKey: 'wrap:any', severity: 'warn' }, 'forever');

    const holder: {
      state?: ReturnType<typeof useNotificationsState>;
      push?: (n: NotificationEnvelope) => void;
    } = {};
    function Probe() {
      holder.state = useNotificationsState();
      holder.push = useNotificationsActions().push;
      return null;
    }

    act(() => {
      root.render(
        <NotificationsProvider>
          <Probe />
        </NotificationsProvider>,
      );
    });

    act(() => {
      holder.push!(makeEnvelope({ id: 'err', dedupeKey: 'wrap:err', severity: 'error' }));
    });

    expect(holder.state?.visible).toHaveLength(1);
    expect(holder.state?.visible[0]?.severity).toBe('error');
  });
});
