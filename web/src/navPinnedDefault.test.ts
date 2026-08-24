// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { initialNavPinned } from './App';

/**
 * A fresh install opens with the project list on screen (Cebab-vl5) — and an
 * operator who closed it stays closed.
 *
 * Both halves matter, and they pull in opposite directions. The fallback is
 * what rescues a first-time operator from the collapsed 66px rail; the stored
 * value is what stops this change from re-opening the sidebar under everyone
 * who deliberately unpinned it. The effect beside `navPinned` in App.tsx
 * writes the key on mount, so "has ever loaded Cebab" and "has the key" are
 * the same set of people — which is precisely why flipping the fallback is
 * safe, and why the second test here is the one that would catch it not being.
 *
 * `localStorage` is stubbed via `vi.stubGlobal`, the house pattern (see
 * `muteStore.test.ts`, `theme.test.ts`): this jsdom environment exposes no
 * real Storage, and a test that leaned on one would read every case as the
 * fallback — i.e. it would agree with itself and prove nothing.
 */

const stubStorage = (() => {
  const map = new Map<string, string>();
  return {
    backing: map,
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
  };
})();

beforeEach(() => {
  stubStorage.backing.clear();
  vi.stubGlobal('localStorage', stubStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('initialNavPinned — Cebab-vl5', () => {
  test('the stub is wired, so the cases below read a real value', () => {
    // Anti-vacuity. Without this, a stub that never took effect makes every
    // case fall through to the fallback — and three of the four would still
    // look like they passed for the right reason.
    stubStorage.backing.set('cebab.navPinned', 'false');
    expect(localStorage.getItem('cebab.navPinned')).toBe('false');
  });

  test('a fresh install starts pinned', () => {
    expect(initialNavPinned()).toBe(true);
  });

  test("an operator's stored 'false' still wins", () => {
    localStorage.setItem('cebab.navPinned', 'false');
    expect(initialNavPinned()).toBe(false);
  });

  test("a stored 'true' is honoured", () => {
    localStorage.setItem('cebab.navPinned', 'true');
    expect(initialNavPinned()).toBe(true);
  });

  test('a value that is neither reads as unpinned, not as a crash', () => {
    // The parse is `r === 'true'`; a hand-edited or truncated value must land
    // somewhere defined rather than throwing during the first render.
    localStorage.setItem('cebab.navPinned', 'yes');
    expect(initialNavPinned()).toBe(false);
  });

  test('a throwing localStorage falls back to pinned', () => {
    // Private mode / full quota. `readStored` swallows; the point is which
    // side of the fallback the operator lands on when it does.
    vi.stubGlobal('localStorage', {
      ...stubStorage,
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(initialNavPinned()).toBe(true);
  });
});
