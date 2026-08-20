import { describe, expect, test } from 'vitest';
import { initialRequestFor, type AuthoritySlot } from './AuthorityContext';

/**
 * Cebab-ws0.5: what a freshly-mounted authority surface should ask for.
 *
 * Two rules meet here and pull in opposite directions. A preview is read
 * before an operator acts, so it may not show a snapshot nobody measured —
 * but a probe is a process spawn, and since `Cebab-ws0.7` one already runs when
 * the project is selected, so re-probing on open would spend a second process
 * on information that has not changed.
 *
 * The third rule is the one that is not about policy at all: a `ready` slot
 * keeps its data through a re-request, so without the `refreshing` flag this
 * function returns the same YES on every render and a mount effect becomes a
 * spawn per frame.
 */

const ready = (over: Partial<Extract<AuthoritySlot, { status: 'ready' }>> = {}): AuthoritySlot => ({
  status: 'ready',
  // Only the fields this function reads matter; the snapshot is opaque to it.
  authority: { fromProbe: true } as unknown as Extract<
    AuthoritySlot,
    { status: 'ready' }
  >['authority'],
  lastFetchedMode: 'probe',
  receivedAt: 1,
  ...over,
});

describe('initialRequestFor', () => {
  test('a live snapshot already in hand needs nothing, whoever asks', () => {
    expect(initialRequestFor(ready({ lastFetchedMode: 'probe' }), true)).toBeNull();
    expect(initialRequestFor(ready({ lastFetchedMode: 'probe' }), false)).toBeNull();
  });

  test('a cache-only snapshot is not enough for a caller that wants live', () => {
    // The case the bead is about: the panel has SOMETHING, and it is not a
    // measurement. Treating any `ready` slot as good enough reddens here.
    expect(initialRequestFor(ready({ lastFetchedMode: 'cache' }), true)).toBe('probe');
  });

  test('a cache-only snapshot is left alone by a caller that does not', () => {
    // The in-session disclosure. It must not start spawning processes just
    // because it mounted.
    expect(initialRequestFor(ready({ lastFetchedMode: 'cache' }), false)).toBeNull();
  });

  test('a refresh already in flight asks for nothing — this is the spawn loop', () => {
    // A `ready` slot keeps its data through a re-request, so `refreshing` is
    // the ONLY difference between "asked a moment ago" and "never asked".
    // Dropping it makes every render of a cache-only panel issue another
    // probe.
    expect(initialRequestFor(ready({ lastFetchedMode: 'cache', refreshing: 'probe' }), true)).toBe(
      null,
    );
  });

  test('a request already in flight asks for nothing', () => {
    expect(initialRequestFor({ status: 'requesting', mode: 'cache', since: 1 }, true)).toBeNull();
    expect(initialRequestFor({ status: 'requesting', mode: 'probe', since: 1 }, false)).toBeNull();
  });

  test('an untouched slot: cache normally, probe when live is wanted', () => {
    expect(initialRequestFor({ status: 'idle' }, false)).toBe('cache');
    expect(initialRequestFor({ status: 'idle' }, true)).toBe('probe');
  });

  test('a cache-miss is retried only by a caller that wants live', () => {
    // Its cheap read already came back with nothing, so repeating it would
    // learn nothing. A probe might not.
    expect(initialRequestFor({ status: 'cache-miss', receivedAt: 1 }, false)).toBeNull();
    expect(initialRequestFor({ status: 'cache-miss', receivedAt: 1 }, true)).toBe('probe');
  });
});
