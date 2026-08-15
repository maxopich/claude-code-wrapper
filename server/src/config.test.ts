import { afterEach, describe, expect, test, vi } from 'vitest';
import { config, parseAutoReclaimDays, parseIntEnv } from './config.js';

// P0-C part 2b: CEBAB_AUTO_RECLAIM_DAYS parsing. The feature is destructive
// (soft-delete), so anything that isn't a clear positive integer resolves to
// null = OFF.
describe('parseAutoReclaimDays', () => {
  test('unset / blank → null (feature off)', () => {
    expect(parseAutoReclaimDays(undefined)).toBeNull();
    expect(parseAutoReclaimDays('')).toBeNull();
    expect(parseAutoReclaimDays('   ')).toBeNull();
  });

  test('non-numeric / non-positive → null', () => {
    expect(parseAutoReclaimDays('abc')).toBeNull();
    expect(parseAutoReclaimDays('0')).toBeNull();
    expect(parseAutoReclaimDays('-5')).toBeNull();
    expect(parseAutoReclaimDays('NaN')).toBeNull();
  });

  test('positive integer → that number', () => {
    expect(parseAutoReclaimDays('30')).toBe(30);
    expect(parseAutoReclaimDays('1')).toBe(1);
  });

  test('fractional values floor', () => {
    expect(parseAutoReclaimDays('30.7')).toBe(30);
  });
});

// Register S13: PORT / MAX_TURNS / MOCK_INTERVAL_MS were each `Number(env ?? d)`.
// Both of `Number()`'s failure modes look like a value: `Number('')` is 0 and
// `Number('abc')` is NaN, and both then flowed on as if the operator had asked
// for them.
describe('parseIntEnv', () => {
  const swallow = (): void => {};

  test('unset / blank → the fallback, with nothing to warn about', () => {
    const warned: string[] = [];
    const warn = (m: string): void => void warned.push(m);
    expect(parseIntEnv('PORT', undefined, { fallback: 4319, min: 1, max: 65535 }, warn)).toBe(4319);
    expect(parseIntEnv('PORT', '', { fallback: 4319, min: 1, max: 65535 }, warn)).toBe(4319);
    expect(parseIntEnv('PORT', '   ', { fallback: 4319, min: 1, max: 65535 }, warn)).toBe(4319);
    // An unset variable is not a misconfiguration; only a bad one is.
    expect(warned).toEqual([]);
  });

  test('an empty PORT no longer becomes port 0', () => {
    // The original shape: `Number('')` is 0, so the OS picked a free port
    // while buildAllowedOrigins() and isAllowedHost() were still built from
    // `:0` — a server that logs a healthy listen and can never be connected to.
    expect(Number('')).toBe(0);
    expect(parseIntEnv('PORT', '', { fallback: 4319, min: 1, max: 65535 }, swallow)).toBe(4319);
  });

  test('non-numeric, fractional and out-of-range values fall back AND warn', () => {
    for (const raw of ['abc', 'NaN', '12.5', '0', '-1', '70000', 'Infinity']) {
      const warned: string[] = [];
      const got = parseIntEnv(
        'PORT',
        raw,
        { fallback: 4319, min: 1, max: 65535 },
        (m) => void warned.push(m),
      );
      expect(got, raw).toBe(4319);
      // The warning is the whole point — silence here is the bug the finding
      // describes, not a smaller version of it.
      expect(warned, raw).toHaveLength(1);
      expect(warned[0]).toContain('PORT');
      expect(warned[0]).toContain('4319');
    }
  });

  test('a valid integer is used as given', () => {
    expect(parseIntEnv('PORT', '8080', { fallback: 4319, min: 1, max: 65535 }, swallow)).toBe(8080);
    expect(parseIntEnv('MAX_TURNS', '5', { fallback: 50, min: 1 }, swallow)).toBe(5);
    // MOCK_INTERVAL_MS legitimately takes 0 — tests set it to run fixtures at
    // full speed — so its floor is 0, not 1.
    expect(parseIntEnv('MOCK_INTERVAL_MS', '0', { fallback: 50, min: 0 }, swallow)).toBe(0);
  });

  test('a NaN turn cap can no longer reach the SDK or an audit payload', () => {
    expect(Number('abc')).toBeNaN();
    expect(parseIntEnv('MAX_TURNS', 'abc', { fallback: 50, min: 1 }, swallow)).toBe(50);
  });

  test('the ambient config is sane', () => {
    expect(Number.isInteger(config.port)).toBe(true);
    expect(config.port).toBeGreaterThan(0);
    expect(Number.isInteger(config.maxTurns)).toBe(true);
    expect(config.maxTurns).toBeGreaterThan(0);
    expect(Number.isInteger(config.mockIntervalMs)).toBe(true);
    expect(config.mockIntervalMs).toBeGreaterThanOrEqual(0);
  });
});

/**
 * A helper with its own tests proves nothing about the CALL SITES — putting
 * `Number(process.env.PORT ?? 4319)` back would leave every case above green,
 * which is the whole failure mode this change is about. `config.ts` reads env
 * once at module init, so the only honest way to test the call sites is to
 * re-import the module under a stubbed environment.
 */
describe('the three env-backed numbers go through parseIntEnv', () => {
  const freshConfig = async (env: Record<string, string>): Promise<typeof config> => {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = (await import('./config.js')) as { config: typeof config };
    return mod.config;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test('an empty PORT falls back instead of becoming 0', async () => {
    const c = await freshConfig({ PORT: '' });
    expect(c.port).toBe(4319);
  });

  test('a non-numeric PORT falls back instead of becoming NaN', async () => {
    const c = await freshConfig({ PORT: 'four-three-one-nine' });
    expect(c.port).toBe(4319);
  });

  test('an out-of-range PORT falls back', async () => {
    const c = await freshConfig({ PORT: '99999' });
    expect(c.port).toBe(4319);
  });

  test('a valid PORT is honoured, so the fallback is not just a constant', async () => {
    const c = await freshConfig({ PORT: '8081' });
    expect(c.port).toBe(8081);
  });

  test('a non-numeric MAX_TURNS falls back instead of becoming NaN', async () => {
    const c = await freshConfig({ MAX_TURNS: 'lots' });
    expect(c.maxTurns).toBe(50);
    expect(Number.isNaN(c.maxTurns)).toBe(false);
  });

  test('a non-numeric MOCK_INTERVAL_MS falls back instead of firing instantly', async () => {
    // NaN reaches `setTimeout`, which treats it as 0 — a mock replay that
    // streams its whole fixture in one frame instead of pacing it.
    const c = await freshConfig({ MOCK_INTERVAL_MS: 'fast' });
    expect(c.mockIntervalMs).toBe(50);
  });
});
