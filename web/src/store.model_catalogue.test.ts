// Cebab-ws0.3 reducer slice.
//
// The distinction under test is `null` (never asked) vs an EMPTY answer
// (asked, nothing there). They render differently — one hides the list, the
// other explains why it is bare — and collapsing them is the natural
// simplification, because `entries.length === 0` looks like it covers both.
import { describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { initialState, reduce } from './store';

const srv = (msg: ServerMsg) => ({ type: 'server' as const, msg });

describe('model_catalogue', () => {
  test('nothing asked yet is null, not an empty list', () => {
    expect(initialState.modelCatalogue).toBe(null);
  });

  test('an answer lands whole', () => {
    const s = reduce(
      initialState,
      srv({
        type: 'model_catalogue',
        entries: [{ value: 'sonnet', displayName: 'Sonnet', description: 'x' }],
        capturedAt: 1234,
        source: 'cache',
      }),
    );
    expect(s.modelCatalogue).toEqual({
      entries: [{ value: 'sonnet', displayName: 'Sonnet', description: 'x' }],
      capturedAt: 1234,
      source: 'cache',
    });
  });

  test('an EMPTY answer is still an answer', () => {
    const s = reduce(
      initialState,
      srv({ type: 'model_catalogue', entries: [], capturedAt: null, source: 'unavailable' }),
    );
    // Not null: the picker must be able to say "asked, nothing captured"
    // rather than silently rendering the same as "not asked yet".
    expect(s.modelCatalogue).not.toBe(null);
    expect(s.modelCatalogue?.entries).toEqual([]);
    expect(s.modelCatalogue?.source).toBe('unavailable');
  });

  test('a fresh probe REPLACES rather than merges', () => {
    let s = reduce(
      initialState,
      srv({
        type: 'model_catalogue',
        entries: [
          { value: 'old', displayName: 'Old', description: '' },
          { value: 'sonnet', displayName: 'Sonnet', description: '' },
        ],
        capturedAt: 1,
        source: 'cache',
      }),
    );
    s = reduce(
      s,
      srv({
        type: 'model_catalogue',
        entries: [{ value: 'sonnet', displayName: 'Sonnet', description: '' }],
        capturedAt: 2,
        source: 'probe',
      }),
    );
    // Merging would resurrect `old`, which a fresh probe has just told us is
    // gone — and the operator would then be able to pick a retired model.
    expect(s.modelCatalogue?.entries.map((e) => e.value)).toEqual(['sonnet']);
  });

  test('it touches nothing else', () => {
    const s = reduce(
      initialState,
      srv({ type: 'model_catalogue', entries: [], capturedAt: null, source: 'unavailable' }),
    );
    expect(s.projects).toBe(initialState.projects);
    expect(s.sessionsByProject).toBe(initialState.sessionsByProject);
  });
});
