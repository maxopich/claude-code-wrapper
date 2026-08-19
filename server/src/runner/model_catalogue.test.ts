// The catalogue's failure behaviour, which is most of its behaviour.
//
// The success path is one line; everything that matters here is what happens
// when the CLI cannot answer. The rule the whole design rests on: a failed
// fetch must LEAVE THE PREVIOUS CACHE ALONE. Writing `[]` on failure would turn
// one bad spawn into a permanently empty picker, and it is the natural thing to
// write if `fetchModelCatalogue` returned `[]` instead of `null` for failure.
import { describe, expect, test, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { getSetting } from '../repo/settings.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import {
  CATALOGUE_TIMEOUT_MS,
  MODEL_CATALOGUE_KEY,
  fetchModelCatalogue,
  readModelCatalogue,
  refreshModelCatalogue,
  type CachedModelCatalogue,
} from './model_catalogue.js';
import type { Runner } from './index.js';

/** A runner is only an async iterable plus optional methods; nothing iterates here. */
function runnerWith(supportedModels?: Runner['supportedModels']): Runner {
  const iter = {
    // eslint-disable-next-line require-yield
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
      return;
    },
  };
  return supportedModels ? { ...iter, supportedModels } : iter;
}

const GOOD = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'd',
    resolvedModel: 'x-1',
  },
  { value: 'sonnet', displayName: 'Sonnet', description: 's' },
];

describe('fetchModelCatalogue', () => {
  test('a runner that cannot answer yields null, not an empty list', async () => {
    // The mock runner is exactly this shape. Returning [] here would be
    // indistinguishable from "asked and there are no models", which is what
    // lets a failure overwrite a good cache.
    expect(await fetchModelCatalogue(runnerWith(undefined))).toBe(null);
  });

  test('a resolving runner is narrowed to the rendered fields', async () => {
    const got = await fetchModelCatalogue(runnerWith(async () => GOOD as never));
    expect(got).toEqual([
      {
        value: 'default',
        displayName: 'Default (recommended)',
        description: 'd',
        resolvedModel: 'x-1',
      },
      { value: 'sonnet', displayName: 'Sonnet', description: 's' },
    ]);
  });

  test('SDK fields Cebab does not render are dropped', async () => {
    const got = await fetchModelCatalogue(
      runnerWith(
        async () =>
          [
            {
              value: 'a',
              displayName: 'A',
              description: '',
              supportsEffort: true,
              supportsFastMode: true,
            },
          ] as never,
      ),
    );
    expect(Object.keys(got![0]!).sort()).toEqual(['description', 'displayName', 'value']);
  });

  test('malformed rows are dropped rather than rendered blank', async () => {
    const got = await fetchModelCatalogue(
      runnerWith(
        async () =>
          [
            { value: '', displayName: 'no value', description: '' },
            { value: 'ok', displayName: 'Fine', description: '' },
            { value: 'nolabel', description: '' },
            null,
          ] as never,
      ),
    );
    expect(got).toEqual([{ value: 'ok', displayName: 'Fine', description: '' }]);
  });

  test('an all-malformed answer is null, not an empty list', async () => {
    expect(await fetchModelCatalogue(runnerWith(async () => [{ value: '' }] as never))).toBe(null);
  });

  test('a rejecting runner yields null and does not throw', async () => {
    await expect(
      fetchModelCatalogue(runnerWith(async () => Promise.reject(new Error('CLI died')))),
    ).resolves.toBe(null);
  });

  test('a call that never settles times out instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const p = fetchModelCatalogue(
        runnerWith(() => new Promise(() => {})),
        50,
      );
      await vi.advanceTimersByTimeAsync(60);
      expect(await p).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  test('its timeout is its own, not the probe budget', () => {
    // Sharing the probe's 30s would let a wedged control request eat the whole
    // authority probe — turning a free extra into the reason the panel never
    // answered.
    expect(CATALOGUE_TIMEOUT_MS).toBeLessThan(30_000);
  });
});

describe('refreshModelCatalogue / readModelCatalogue', () => {
  withTempDataDir('model-catalogue');

  test('nothing captured yet reads as null', () => {
    expect(readModelCatalogue()).toBe(null);
  });

  test('a successful refresh is persisted and read back', async () => {
    await refreshModelCatalogue(runnerWith(async () => GOOD as never));
    const got = readModelCatalogue();
    expect(got?.entries.map((e) => e.value)).toEqual(['default', 'sonnet']);
    expect(got?.capturedAt).toBeGreaterThan(0);
  });

  test('a FAILED refresh leaves a good cache intact', async () => {
    await refreshModelCatalogue(runnerWith(async () => GOOD as never));
    const before = getSetting<CachedModelCatalogue>(MODEL_CATALOGUE_KEY);

    await refreshModelCatalogue(runnerWith(async () => Promise.reject(new Error('nope'))));
    await refreshModelCatalogue(runnerWith(undefined));
    await refreshModelCatalogue(runnerWith(async () => [] as never));

    expect(getSetting<CachedModelCatalogue>(MODEL_CATALOGUE_KEY)).toEqual(before);
    expect(readModelCatalogue()?.entries).toHaveLength(2);
  });

  test('mock mode neither writes nor reads the real cache', async () => {
    const original = config.mock;
    try {
      config.mock = true;
      await refreshModelCatalogue(runnerWith(async () => GOOD as never));
      // A fixture that reached the DB would outlive the mock session and be
      // offered later as a real choice against a real CLI.
      expect(getSetting<CachedModelCatalogue>(MODEL_CATALOGUE_KEY)).toBe(null);
      const served = readModelCatalogue();
      expect(served?.entries.length).toBeGreaterThan(0);
      expect(served?.capturedAt).toBe(0);
    } finally {
      config.mock = original;
    }
  });
});
