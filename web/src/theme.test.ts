// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { applyTheme, DEFAULT_THEME, isTheme, readStoredTheme, THEME_META, THEMES } from './theme';

const KEY = 'cebab.theme';

// This jsdom env doesn't ship a real localStorage, so install a minimal
// in-memory shim — the module reads/writes through the global, and we want to
// exercise real persistence rather than lean on prefs.ts's swallow-on-failure
// guard (which would mask read-back assertions).
beforeEach(() => {
  const store = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: mock,
    configurable: true,
    writable: true,
  });
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('isTheme', () => {
  test('accepts every declared gamma', () => {
    for (const t of THEMES) expect(isTheme(t)).toBe(true);
  });
  test('rejects junk', () => {
    for (const x of ['', 'dark', 'light', 'AURORA', null, undefined, 42]) {
      expect(isTheme(x)).toBe(false);
    }
  });
});

describe('readStoredTheme', () => {
  test('falls back to the default when unset', () => {
    expect(readStoredTheme()).toBe(DEFAULT_THEME);
  });
  test('returns a valid persisted gamma', () => {
    localStorage.setItem(KEY, 'phosphor');
    expect(readStoredTheme()).toBe('phosphor');
  });
  test('falls back to the default when the stored value is invalid', () => {
    localStorage.setItem(KEY, 'neon');
    expect(readStoredTheme()).toBe(DEFAULT_THEME);
  });
  test('default is daylight (user decision, 2026-07-07)', () => {
    expect(DEFAULT_THEME).toBe('daylight');
  });
});

describe('applyTheme', () => {
  test('projects onto the document root and persists', () => {
    applyTheme('slate');
    expect(document.documentElement.dataset.theme).toBe('slate');
    expect(readStoredTheme()).toBe('slate');
  });
  test('is idempotent and overwrites a prior gamma', () => {
    applyTheme('aurora');
    applyTheme('daylight');
    expect(document.documentElement.dataset.theme).toBe('daylight');
    expect(readStoredTheme()).toBe('daylight');
  });
});

describe('THEME_META', () => {
  test('covers exactly the declared gammas, no dupes', () => {
    const ids = THEME_META.map((m) => m.id);
    expect(new Set(ids)).toEqual(new Set(THEMES));
    expect(ids).toHaveLength(THEMES.length);
  });
  test('every card has a label, description, and three swatch colors', () => {
    for (const m of THEME_META) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.swatch.bg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(m.swatch.panel).toMatch(/^#[0-9a-f]{6}$/i);
      expect(m.swatch.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
