import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * PR-2: featureFlags.ts is a single-source-of-truth file for in-dev UI
 * gates. The contract that matters: `ENABLE_CUSTOM_MODE_PICKER` is `true`
 * under dev / Vitest and `false` under production builds — so a future
 * caller that wraps a UI surface in `if (ENABLE_CUSTOM_MODE_PICKER)` is
 * guaranteed to be tree-shaken out of the release bundle.
 *
 * `import.meta.env.DEV` is set by Vite at module-eval time. To exercise
 * both branches we have to `vi.stubEnv` AND `vi.resetModules` so the
 * subsequent dynamic import re-evaluates with the stub in place.
 */

describe('featureFlags (PR-2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test('ENABLE_CUSTOM_MODE_PICKER is true when import.meta.env.DEV is true', async () => {
    vi.stubEnv('DEV', true);
    vi.resetModules();
    const { ENABLE_CUSTOM_MODE_PICKER } = await import('./featureFlags');
    expect(ENABLE_CUSTOM_MODE_PICKER).toBe(true);
  });

  test('ENABLE_CUSTOM_MODE_PICKER is false under production builds', async () => {
    vi.stubEnv('DEV', false);
    vi.resetModules();
    const { ENABLE_CUSTOM_MODE_PICKER } = await import('./featureFlags');
    expect(ENABLE_CUSTOM_MODE_PICKER).toBe(false);
  });
});
