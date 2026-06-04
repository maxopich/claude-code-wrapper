// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ClientMsg, ServerMsg } from '@cebab/shared';
import { useStorageStats, type StorageStatsState, type StorageStatsView } from './useStorageStats';

// P0-C part 2 (retention visibility): the data hook behind the Settings
// "Storage" section. Driven through a null-rendering harness (the repo's
// no-testing-library convention), same shape as useSessionSearch.test.ts.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

let latest: StorageStatsState;
let subCb: ((m: ServerMsg) => void) | null;
let sent: ClientMsg[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  sent = [];
  subCb = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Harness() {
  latest = useStorageStats({
    send: (m) => sent.push(m),
    subscribeServerMsg: (cb) => {
      subCb = cb;
      return () => {
        subCb = null;
      };
    },
  });
  return null;
}

function render() {
  act(() => {
    root.render(createElement(Harness));
  });
}

function push(m: ServerMsg) {
  act(() => subCb?.(m));
}

const sampleStats: StorageStatsView = {
  type: 'storage_stats',
  dbSizeBytes: 100,
  logsDirSizeBytes: 50,
  lastPurgeAt: null,
  lastPurgeCount: null,
  tableStats: [{ table: 'events', rows: 7 }],
  purgeIntervalMs: 21_600_000,
  purgeAfterMs: 604_800_000,
};

describe('useStorageStats', () => {
  test('dispatches exactly one get_storage_stats on mount', () => {
    render();
    expect(sent).toEqual([{ type: 'get_storage_stats' }]);
    expect(latest.loading).toBe(true);
    expect(latest.stats).toBeNull();
  });

  test('a storage_stats reply populates stats and clears loading', () => {
    render();
    push(sampleStats);
    expect(latest.stats).toEqual(sampleStats);
    expect(latest.loading).toBe(false);
  });

  test('ignores unrelated server messages', () => {
    render();
    push({
      type: 'search_results',
      query: 'x',
      scope: 'all_projects',
      results: [],
      raw: false,
      truncated: false,
    });
    expect(latest.stats).toBeNull();
    expect(latest.loading).toBe(true);
  });
});
