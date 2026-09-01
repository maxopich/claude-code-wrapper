import { describe, expect, test } from 'vitest';
import { getScrubbedEnvVars, SCRUBBED_ENV_VAR_NAMES } from './claude.js';

// Cluster A Phase 3 (E1, UX-5): the WS layer's env_scrubbed emission on
// every attach (`ws/server.ts` onConnection) must report the NAMES of the
// auth-precedence vars `subscriptionOnlyEnv()` strips — never the values.
// Test coverage of the var-name filter so a future refactor of the blocked
// set can't silently drop a leaked-token detection.

describe('getScrubbedEnvVars — name-only env audit', () => {
  test('returns empty when none of the auth-precedence vars are set', () => {
    expect(getScrubbedEnvVars({ HOME: '/x', PATH: '/usr/bin' })).toEqual([]);
  });

  test('detects ANTHROPIC_API_KEY presence', () => {
    expect(getScrubbedEnvVars({ ANTHROPIC_API_KEY: 'sk-...' })).toEqual(['ANTHROPIC_API_KEY']);
  });

  test('detects ANTHROPIC_AUTH_TOKEN presence', () => {
    expect(getScrubbedEnvVars({ ANTHROPIC_AUTH_TOKEN: 'tk' })).toEqual(['ANTHROPIC_AUTH_TOKEN']);
  });

  test('detects all three backend-flag scrubs simultaneously', () => {
    const out = getScrubbedEnvVars({
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
    });
    expect(out).toEqual([
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ]);
  });

  test('UX-5 [security]: never leaks the value, only the name', () => {
    // The function's signature is `string[]` — the secret value never enters
    // the return type. This test pins that contract: the output must be the
    // string `'ANTHROPIC_API_KEY'`, not the value.
    const out = getScrubbedEnvVars({ ANTHROPIC_API_KEY: 'sk-secret-do-not-leak' });
    expect(out).toEqual(['ANTHROPIC_API_KEY']);
    expect(out.join(',')).not.toContain('sk-secret');
  });

  test('ignores an empty-string value (treats as not-set)', () => {
    // A user with `export ANTHROPIC_API_KEY=` in their shell is effectively
    // unset — toasting that case would be alert-fatigue noise.
    expect(getScrubbedEnvVars({ ANTHROPIC_API_KEY: '' })).toEqual([]);
  });

  test('ignores unrelated vars even if their name contains ANTHROPIC', () => {
    expect(getScrubbedEnvVars({ ANTHROPIC_CUSTOM_FLAG: '1', UNRELATED: 'v' })).toEqual([]);
  });

  // Cebab-ygu.18 [security]: the strip set must match the CLI's OWN
  // auth-precedence enumeration, not a subset of it. The CLI's auth-source
  // resolver honours CLAUDE_CODE_OAUTH_TOKEN (the documented `claude
  // setup-token` output) and the WIF pair BEFORE the persisted OAuth session,
  // and the SDK replaces the child env wholesale — so any name missing here is
  // a credential that silently overrides the operator's subscription on every
  // spawn while `getScrubbedEnvVars()` reports nothing to strip.
  test('[security] detects CLAUDE_CODE_OAUTH_TOKEN (the strongest overriding case)', () => {
    expect(getScrubbedEnvVars({ CLAUDE_CODE_OAUTH_TOKEN: 'oat-...' })).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
  });

  test('[security] detects the WIF pair (ANTHROPIC_FEDERATION_RULE_ID + ANTHROPIC_ORGANIZATION_ID)', () => {
    const out = getScrubbedEnvVars({
      ANTHROPIC_FEDERATION_RULE_ID: 'rule',
      ANTHROPIC_ORGANIZATION_ID: 'org',
    });
    expect(out).toEqual(['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID']);
  });

  test('[security] covers the full CLI credential-env + backend-flag set', () => {
    // Every name the bundled CLI resolves as auth precedence. If the CLI's
    // enumeration grows, this list must grow with it (see Cebab-ygu.18).
    const expected = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
      'AWS_BEARER_TOKEN_BEDROCK',
      'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
      'ANTHROPIC_AWS_API_KEY',
      'ANTHROPIC_FEDERATION_RULE_ID',
      'ANTHROPIC_ORGANIZATION_ID',
      'ANTHROPIC_UNIX_SOCKET',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
      'CLAUDE_CODE_USE_MANTLE',
    ];
    // The constant carries every expected name (order-independent)...
    expect([...SCRUBBED_ENV_VAR_NAMES].sort()).toEqual([...expected].sort());
    // ...and each is actually detected when present in the env.
    const env: Record<string, string> = {};
    for (const name of expected) env[name] = 'x';
    expect(getScrubbedEnvVars(env).sort()).toEqual([...expected].sort());
  });
});
