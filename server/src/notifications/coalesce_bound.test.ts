import { beforeEach, describe, expect, test } from 'vitest';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { _coalesceStateSize, _resetCoalesceState, emit } from './dispatcher.js';

/**
 * Register D17: the dispatcher's coalesce map described itself as an "LRU"
 * that was "bounded implicitly by the coalesce window". It was a plain `Map`
 * with `get` and `set` and nothing that evicted — "skipped over by `emit`"
 * meant a stale entry lost a dedupe race, not that it left the map. Its keys
 * embed session ids and agent slugs, so cardinality grew with every session
 * for the life of the process.
 */

withTempDataDir('cebab-coalesce-bound-');

beforeEach(() => {
  _resetCoalesceState();
});

function emitOperational(key: string): void {
  emit({ class: 'operational', severity: 'info', dedupeKey: key, title: 't' }, () => undefined);
}

describe('the coalesce map is bounded', () => {
  test('a flood of distinct session-scoped keys does not grow without limit', () => {
    // The real key shape: one per (event kind, session). 5,000 sessions on a
    // long-lived server used to mean 5,000 permanent entries.
    for (let i = 0; i < 5_000; i += 1) emitOperational(`max_turns.hit:session-${i}`);
    expect(_coalesceStateSize()).toBeLessThanOrEqual(512);
  });

  test('and it really was filling up first — anti-vacuity', () => {
    // Without this, the assertion above passes on a map that never receives
    // anything (a broken `emit`, a changed class branch) exactly as loudly as
    // on one that is correctly pruned.
    for (let i = 0; i < 100; i += 1) emitOperational(`k-${i}`);
    expect(_coalesceStateSize()).toBe(100);
  });

  test('dedupe still works for a key inside its window', () => {
    // The bound must not cost the thing the map exists for.
    const first = emit(
      { class: 'operational', severity: 'info', dedupeKey: 'same', title: 't' },
      () => undefined,
    );
    const second = emit(
      { class: 'operational', severity: 'info', dedupeKey: 'same', title: 't' },
      () => undefined,
    );
    expect(first).toMatchObject({ ok: true, sent: true });
    expect(second).toMatchObject({ ok: true, sent: false });
    if (second.ok) expect(second.coalescedInto).toBe(first.ok ? first.id : undefined);
  });

  test('a key evicted by the flood simply stops coalescing, it does not error', () => {
    emitOperational('victim');
    for (let i = 0; i < 5_000; i += 1) emitOperational(`filler-${i}`);
    // `victim` is long gone; the next emit for it sends a fresh envelope
    // rather than throwing or silently swallowing.
    const again = emit(
      { class: 'operational', severity: 'info', dedupeKey: 'victim', title: 't' },
      () => undefined,
    );
    expect(again).toMatchObject({ ok: true, sent: true });
  });

  test('safety-class emits are unaffected — they never touch the map', () => {
    const before = _coalesceStateSize();
    emit(
      {
        class: 'safety',
        severity: 'danger',
        dedupeKey: 'safety-key',
        title: 't',
        reasonCode: 'forged_source',
        auditKind: 'router.drop',
      },
      () => undefined,
    );
    expect(_coalesceStateSize()).toBe(before);
  });
});
