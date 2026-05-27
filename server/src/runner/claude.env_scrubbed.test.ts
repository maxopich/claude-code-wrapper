import { describe, expect, test } from 'vitest';
import { getScrubbedEnvVars } from './claude.js';

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
});
