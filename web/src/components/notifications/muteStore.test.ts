import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  _clearAllMutes,
  addMute,
  isMuteAllowed,
  isMuted,
  muteKeyFor,
  readMutes,
  removeMute,
} from './muteStore';

// Cluster A Phase 5: mute-store unit tests.
//
// Pins (spec §3 + §5):
//   - localStorage round-trip (read/write/expiry)
//   - error + danger NEVER muteable (defense in depth: both at write
//     time via addMute and at lookup time via isMuted)
//   - prefix derivation: dedupeKey up to first `:` (so muting
//     `chain_not_reconstructed` silences EVERY session's variant)
//   - lazy expiration on `isMuted` so the manage-mutes UI stays clean
//
// localStorage is stubbed via `vi.stubGlobal` instead of pulling jsdom
// in — the mute-store contract is just `getItem/setItem` and a Map
// proves the read/write side without coupling tests to a particular DOM
// runtime's Storage implementation.

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
  _clearAllMutes();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('muteKeyFor', () => {
  test('returns prefix up to first colon', () => {
    expect(muteKeyFor({ dedupeKey: 'session_superseded:abc-123' })).toBe('session_superseded');
    expect(muteKeyFor({ dedupeKey: 'wrap:global' })).toBe('wrap');
  });

  test('returns the whole key when there is no colon', () => {
    expect(muteKeyFor({ dedupeKey: 'env_scrubbed_boot' })).toBe('env_scrubbed_boot');
  });

  test('handles repeated colons (only splits on the first)', () => {
    expect(muteKeyFor({ dedupeKey: 'dangerous_mutation:sid:42' })).toBe('dangerous_mutation');
  });
});

describe('isMuteAllowed — error/danger disallowed', () => {
  test('info, success, warn → allowed', () => {
    expect(isMuteAllowed('info')).toBe(true);
    expect(isMuteAllowed('success')).toBe(true);
    expect(isMuteAllowed('warn')).toBe(true);
  });

  test('error → disallowed', () => {
    expect(isMuteAllowed('error')).toBe(false);
  });

  test('danger → disallowed', () => {
    expect(isMuteAllowed('danger')).toBe(false);
  });
});

describe('addMute + isMuted round-trip', () => {
  test('mute for "hour" expires after 1h', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    addMute({ dedupeKey: 'wrap:x', severity: 'warn' }, 'hour');
    expect(isMuted({ dedupeKey: 'wrap:y', severity: 'warn' })).toBe(true); // same prefix

    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(isMuted({ dedupeKey: 'wrap:y', severity: 'warn' })).toBe(true);

    vi.advanceTimersByTime(2 * 60 * 1000); // now 61m past
    expect(isMuted({ dedupeKey: 'wrap:y', severity: 'warn' })).toBe(false);
  });

  test('mute for "forever" never expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    addMute({ dedupeKey: 'wrap:x', severity: 'info' }, 'forever');
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
    expect(isMuted({ dedupeKey: 'wrap:y', severity: 'info' })).toBe(true);
  });

  test('addMute refuses to silence error', () => {
    expect(addMute({ dedupeKey: 'wrap:x', severity: 'error' }, 'forever')).toBeNull();
    expect(isMuted({ dedupeKey: 'wrap:x', severity: 'error' })).toBe(false);
    expect(Object.keys(readMutes())).toHaveLength(0);
  });

  test('addMute refuses to silence danger', () => {
    expect(addMute({ dedupeKey: 'danger:x', severity: 'danger' }, 'hour')).toBeNull();
    expect(Object.keys(readMutes())).toHaveLength(0);
  });
});

describe('isMuted — defense in depth for error/danger', () => {
  test('even if a mute row is forged into storage, error rows still surface', () => {
    // Forge a mute entry directly so we can prove the read path filters
    // by severity at lookup time, not only at write time.
    localStorage.setItem(
      'cebab.notif.mutes',
      JSON.stringify({ wrap: { until: 'forever', ts: 1 } }),
    );
    expect(isMuted({ dedupeKey: 'wrap:x', severity: 'error' })).toBe(false);
    expect(isMuted({ dedupeKey: 'wrap:x', severity: 'danger' })).toBe(false);
    // The same forged entry still mutes warn/info — confirms the gate is
    // severity-keyed, not store-keyed.
    expect(isMuted({ dedupeKey: 'wrap:x', severity: 'warn' })).toBe(true);
  });
});

describe('removeMute', () => {
  test('removes a single mute, others untouched', () => {
    addMute({ dedupeKey: 'a:x', severity: 'info' }, 'forever');
    addMute({ dedupeKey: 'b:y', severity: 'info' }, 'forever');
    removeMute('a');
    const map = readMutes();
    expect(map.a).toBeUndefined();
    expect(map.b).toBeDefined();
  });

  test('unknown key is a silent no-op', () => {
    addMute({ dedupeKey: 'a:x', severity: 'info' }, 'forever');
    removeMute('nonexistent');
    expect(readMutes().a).toBeDefined();
  });
});

describe('isMuted lazy expiry', () => {
  test('expired mute is dropped from storage on next isMuted call', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    addMute({ dedupeKey: 'wrap:x', severity: 'warn' }, 'hour');
    expect(Object.keys(readMutes())).toContain('wrap');

    vi.advanceTimersByTime(2 * 60 * 60 * 1000); // 2h past
    expect(isMuted({ dedupeKey: 'wrap:x', severity: 'warn' })).toBe(false);
    // Lazy cleanup — the stale entry is gone now.
    expect(Object.keys(readMutes())).not.toContain('wrap');
  });
});

describe('storage robustness', () => {
  test('malformed JSON in storage is treated as empty', () => {
    localStorage.setItem('cebab.notif.mutes', 'not json {{{');
    expect(readMutes()).toEqual({});
    expect(isMuted({ dedupeKey: 'x:y', severity: 'info' })).toBe(false);
  });

  test('non-object JSON in storage is treated as empty', () => {
    localStorage.setItem('cebab.notif.mutes', '"a string"');
    expect(readMutes()).toEqual({});
  });
});
