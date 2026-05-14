import { describe, expect, test, vi } from 'vitest';
import { cleanupPendingPermissionsForSession, type PendingPermission } from './server.js';

// F12: pending permission Promises for a given session must be drained
// when that session is interrupted. Without this, the map grows unbounded
// under burst interrupts. The cleanup also resolves each pending Promise
// with `behavior: 'deny'` so any awaiting SDK callback unblocks rather
// than hanging forever. Plan reference: T2.4.

function makePending(sessionId: string) {
  const resolve = vi.fn<PendingPermission['resolve']>();
  return { sessionId, resolve, toolInput: {} } satisfies PendingPermission;
}

describe('[security][F12] cleanupPendingPermissionsForSession', () => {
  test('removes only entries matching the given sessionId', () => {
    const map = new Map<string, PendingPermission>();
    const a1 = makePending('sess-A');
    const a2 = makePending('sess-A');
    const b1 = makePending('sess-B');
    map.set('req-a1', a1);
    map.set('req-a2', a2);
    map.set('req-b1', b1);

    cleanupPendingPermissionsForSession(map, 'sess-A');

    // Both sess-A entries removed; sess-B preserved.
    expect(map.has('req-a1')).toBe(false);
    expect(map.has('req-a2')).toBe(false);
    expect(map.has('req-b1')).toBe(true);
  });

  test("resolves cleaned entries with behavior 'deny' message 'interrupted'", () => {
    const map = new Map<string, PendingPermission>();
    const p = makePending('sess-X');
    map.set('req-x', p);

    cleanupPendingPermissionsForSession(map, 'sess-X');

    expect(p.resolve).toHaveBeenCalledTimes(1);
    expect(p.resolve).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'interrupted',
    });
  });

  test('does NOT resolve entries from other sessions', () => {
    const map = new Map<string, PendingPermission>();
    const target = makePending('sess-A');
    const other = makePending('sess-B');
    map.set('req-target', target);
    map.set('req-other', other);

    cleanupPendingPermissionsForSession(map, 'sess-A');

    expect(target.resolve).toHaveBeenCalledTimes(1);
    expect(other.resolve).not.toHaveBeenCalled();
  });

  test('is a no-op when the sessionId has no entries', () => {
    const map = new Map<string, PendingPermission>();
    const p = makePending('sess-A');
    map.set('req-a', p);

    cleanupPendingPermissionsForSession(map, 'sess-NONE');

    expect(map.size).toBe(1);
    expect(p.resolve).not.toHaveBeenCalled();
  });

  test('handles empty map without throwing', () => {
    const map = new Map<string, PendingPermission>();
    expect(() => cleanupPendingPermissionsForSession(map, 'any')).not.toThrow();
    expect(map.size).toBe(0);
  });
});
