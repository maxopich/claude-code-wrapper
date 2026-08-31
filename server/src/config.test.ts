import { afterEach, describe, expect, test, vi } from 'vitest';
import { config, parseAutoReclaimDays, parseIntEnv, readAliasedEnv } from './config.js';

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

// Register N26: six env vars (PORT, WORKSPACE_ROOT, MOCK, MOCK_SCENARIO,
// MOCK_INTERVAL_MS, MAX_TURNS) shipped without the `CEBAB_` prefix the other
// four carry, so a bare `PORT`/`MAX_TURNS` collides with whatever else is in the
// operator's shell. `readAliasedEnv` prefers the prefixed spelling and keeps the
// bare name working-but-deprecated.
describe('readAliasedEnv', () => {
  test('the prefixed value wins when both are set, with nothing to warn about', () => {
    const warned: string[] = [];
    const got = readAliasedEnv('CEBAB_PORT', '8085', 'PORT', '9000', (m) => void warned.push(m));
    expect(got).toBe('8085');
    // Using the canonical name is not a deprecation event.
    expect(warned).toEqual([]);
  });

  test('the bare value is used when the prefixed one is unset, AND warns', () => {
    const warned: string[] = [];
    const got = readAliasedEnv('CEBAB_PORT', undefined, 'PORT', '9000', (m) => void warned.push(m));
    expect(got).toBe('9000');
    // The deprecation notice is the whole point — silence would let the bare
    // name live forever unremarked.
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('PORT');
    expect(warned[0]).toContain('CEBAB_PORT');
  });

  test('a blank prefixed value falls through to the bare name', () => {
    const warned: string[] = [];
    // `CEBAB_PORT=` in a `.env` is not a choice; it should not shadow a real
    // bare value.
    const got = readAliasedEnv('CEBAB_PORT', '  ', 'PORT', '9000', (m) => void warned.push(m));
    expect(got).toBe('9000');
    expect(warned).toHaveLength(1);
  });

  test('neither set → undefined, and nothing is deprecated', () => {
    const warned: string[] = [];
    expect(
      readAliasedEnv('CEBAB_PORT', undefined, 'PORT', undefined, (m) => void warned.push(m)),
    ).toBeUndefined();
    // A blank bare value is not "in use" either — no warning.
    expect(readAliasedEnv('CEBAB_PORT', undefined, 'PORT', '', () => {})).toBe('');
    expect(warned).toEqual([]);
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

  // Register N26: the prefixed spellings must actually reach the config, or the
  // alias is inert. Each of these fails against the pre-N26 config that read
  // only the bare name.
  test('CEBAB_PORT is honoured', async () => {
    const c = await freshConfig({ CEBAB_PORT: '8086' });
    expect(c.port).toBe(8086);
  });

  test('CEBAB_PORT wins over the deprecated bare PORT', async () => {
    const c = await freshConfig({ CEBAB_PORT: '8087', PORT: '9001' });
    expect(c.port).toBe(8087);
  });

  test('CEBAB_MAX_TURNS is honoured', async () => {
    const c = await freshConfig({ CEBAB_MAX_TURNS: '7' });
    expect(c.maxTurns).toBe(7);
  });

  test('CEBAB_MOCK turns on mock mode', async () => {
    const c = await freshConfig({ CEBAB_MOCK: '1' });
    expect(c.mock).toBe(true);
  });

  test('CEBAB_WORKSPACE_ROOT sets the workspace root and marks its source env', async () => {
    const c = await freshConfig({ CEBAB_WORKSPACE_ROOT: '/tmp/cebab-agents' });
    expect(c.workspaceRootDefault).toBe('/tmp/cebab-agents');
    expect(c.workspaceRootDefaultSource).toBe('env');
  });

  test('CEBAB_MOCK_SCENARIO and CEBAB_MOCK_INTERVAL_MS are honoured', async () => {
    const c = await freshConfig({
      CEBAB_MOCK_SCENARIO: 'orchestrator',
      CEBAB_MOCK_INTERVAL_MS: '0',
    });
    expect(c.mockScenario).toBe('orchestrator');
    expect(c.mockIntervalMs).toBe(0);
  });

  test('the deprecated bare names still work', async () => {
    // Backward compatibility: an existing `.env` keeps running.
    const c = await freshConfig({ PORT: '8088', MAX_TURNS: '9' });
    expect(c.port).toBe(8088);
    expect(c.maxTurns).toBe(9);
  });
});
