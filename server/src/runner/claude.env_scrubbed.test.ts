import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { getScrubbedEnvVars, SCRUBBED_ENV_POSTURES, SCRUBBED_ENV_VAR_NAMES } from './claude.js';

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
      'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
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
      'CLAUDE_CODE_USE_GATEWAY',
    ];
    // The constant carries every expected name (order-independent)...
    expect([...SCRUBBED_ENV_VAR_NAMES].sort()).toEqual([...expected].sort());
    // ...and each is actually detected when present in the env.
    const env: Record<string, string> = {};
    for (const name of expected) env[name] = 'x';
    expect(getScrubbedEnvVars(env).sort()).toEqual([...expected].sort());
  });
});

describe('[security] the scrub list is derived from the CLI, not from a copy of itself', () => {
  // WHAT WENT WRONG. `CLAUDE_CODE_USE_GATEWAY` is a backend switch in the
  // bundled CLI's own enumeration and was absent from SCRUBBED_ENV_VAR_NAMES,
  // so a stray `export CLAUDE_CODE_USE_GATEWAY=1` would re-route every spawn
  // off the operator's subscription while `getScrubbedEnvVars()` reported
  // nothing to strip. `Cebab-m99x`.
  //
  // It survived because the test above compares the constant to a list a
  // human typed out, and the module's header claims the set is "the CLI's OWN
  // enumeration, not a subset". Two hand-maintained copies agreeing with each
  // other is not a measurement of the third thing. The comment beside the old
  // list even said "if the CLI's enumeration grows, this list must grow with
  // it" — an instruction to remember, which is what failed.
  //
  // So this reads the shipped bundle. The hand-listed test stays: it pins the
  // credential-class names, which do not live in one extractable array.

  const require_ = createRequire(import.meta.url);

  /**
   * Resolved through the SERVER workspace, which is where the dependency is
   * declared — not from a path anchored at the repo root. npm may hoist the
   * package or keep it under `server/node_modules` depending on the tree, and
   * a root-anchored path breaks on a lockfile change with no source change.
   */
  function sdkBundle(): string {
    const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
    const bundle = path.join(path.dirname(entry), 'sdk.mjs');
    return fs.readFileSync(fs.existsSync(bundle) ? bundle : entry, 'utf8');
  }

  /**
   * The backend switches, taken from the array the CLI itself groups them in.
   *
   * Anchored on a name rather than on a shape: the bundle is minified and its
   * variable names change every release, but the string literals do not. The
   * anchor is deliberately NOT `GATEWAY` — anchoring on the name this test
   * exists to catch would make it circular.
   *
   * Feature flags (`CLAUDE_CODE_USE_COWORK_PLUGINS`,
   * `..._NATIVE_FILE_SEARCH`, `..._POWERSHELL_TOOL`) live elsewhere in the
   * bundle and are correctly out of range: they change behaviour, not billing.
   */
  function backendSwitchesFromBundle(): string[] {
    const src = sdkBundle();
    const anchor = src.indexOf('"CLAUDE_CODE_USE_BEDROCK"');
    if (anchor === -1) return [];
    const open = src.lastIndexOf('[', anchor);
    const close = src.indexOf(']', anchor);
    if (open === -1 || close === -1) return [];
    const arr = src.slice(open, close + 1);
    return [...new Set(arr.match(/CLAUDE_CODE_USE_[A-Z_]+/g) ?? [])];
  }

  /**
   * The credential-bearing file-descriptor env vars, taken from the bundle's
   * env-name registry. `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` and
   * `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` each name a numbered fd the CLI
   * reads a secret from — an API key / OAuth token — which overrides the
   * OAuth subscription just as the inline `ANTHROPIC_API_KEY` /
   * `CLAUDE_CODE_OAUTH_TOKEN` would (`Cebab-6fax.23`).
   *
   * These do NOT live in the `CI` credential array the backend-switch walk
   * anchors on; they sit in the bundle's exported env-name map. So this is a
   * second extraction rather than a reuse of the one above.
   *
   * Anchored on `API_KEY|OAUTH_TOKEN` — the two secret-bearing kinds — which
   * deliberately EXCLUDES `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR`: that is
   * transport auth, not an API-key/subscription override, and is out of this
   * bead's scope (tracked separately). Including `API_KEY` in the pattern is not
   * circular the way a hand-copied expected list would be: the bundle is still
   * the source of truth for whether the CLI KNOWS the var — if a release drops
   * it, the anti-vacuity floor below reddens ("re-derive"), not the security
   * assertion.
   */
  function credentialFdsFromBundle(): string[] {
    const src = sdkBundle();
    return [...new Set(src.match(/CLAUDE_CODE_(?:API_KEY|OAUTH_TOKEN)_FILE_DESCRIPTOR/g) ?? [])];
  }

  test('[security] every credential FILE_DESCRIPTOR the CLI knows is scrubbed', () => {
    // `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` was absent from the list until
    // `Cebab-6fax.23`, so a stray `export CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=N`
    // pointed the CLI at an fd carrying an API key and every spawn authenticated
    // as that key while `getScrubbedEnvVars()` reported nothing to strip.
    const found = credentialFdsFromBundle();

    // Anti-vacuity floor, INLINE rather than its own test on purpose: a
    // standalone floor passes even when the scrub-list fix is reverted (it only
    // asserts the bundle extraction works), so the revert-check reads it as a
    // case that measures nothing. Folded in here, the same protection runs —
    // an empty `found` makes the `missing` filter below vacuously pass, so the
    // floor guards it — while this test as a whole still reddens the moment the
    // fix is reverted (`missing` becomes non-empty). A RED on these three lines
    // means "re-derive the extraction"; a RED on the `missing` assertion means
    // "a credential fd is unscrubbed".
    expect(
      found.length,
      'no credential FILE_DESCRIPTOR names extracted from the SDK bundle',
    ).toBeGreaterThanOrEqual(2);
    expect(found).toContain('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR');
    expect(found).toContain('CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR');

    const missing = found.filter((name) => !SCRUBBED_ENV_VAR_NAMES.includes(name));
    expect(
      missing,
      `the bundled CLI reads a credential from these fds and Cebab does not strip them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  test('[security] and each credential FD is actually detected in a live env', () => {
    for (const name of credentialFdsFromBundle()) {
      expect(getScrubbedEnvVars({ [name]: '3' })).toEqual([name]);
    }
  });

  test('the extraction actually found the CLI list (anti-vacuity floor)', () => {
    // Without this the assertion below passes when the bundle is minified
    // differently and the match returns []. An empty expectation is satisfied
    // by every possible constant, which is the exact shape of a gate that runs
    // and measures nothing. A RED here means "re-derive the extraction", not
    // "the constant is wrong".
    const found = backendSwitchesFromBundle();
    expect(
      found.length,
      'no CLAUDE_CODE_USE_* names extracted from the SDK bundle',
    ).toBeGreaterThan(5);
    for (const known of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
      expect(found).toContain(known);
    }
  });

  test('[security] every backend switch the CLI knows is scrubbed', () => {
    const missing = backendSwitchesFromBundle().filter(
      (name) => !SCRUBBED_ENV_VAR_NAMES.includes(name),
    );
    expect(
      missing,
      `the bundled CLI switches these backends on and Cebab does not strip them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  test('[security] and each one is actually detected in a live env', () => {
    // The constant containing a name and the filter reporting it are two
    // different claims; the second is what the operator's attach banner reads.
    for (const name of backendSwitchesFromBundle()) {
      expect(getScrubbedEnvVars({ [name]: '1' })).toEqual([name]);
    }
  });
});

describe('[security] every scrubbed name has its own posture label (Cebab-6fax.8)', () => {
  // `SCRUBBED_ENV_POSTURES`' header claimed "CI catches the missing key via
  // the resolver's typecheck". It could not: the map is
  // `Record<string, string>` and its only read site falls back to a generic
  // 'credential-class env injection' label. So a name added to the scrub list
  // without a posture produced a vaguer authority panel — at runtime, silently,
  // for as long as nobody looked. The claim is now this test.
  //
  // It matters more than a label: the posture string is what tells an operator
  // WHY a variable is stripped ("Bedrock backend (bearer token re-routes off
  // Anthropic API)" versus "WIF auth"). A generic fallback on a newly added
  // name is exactly the case where the operator has never seen it before.

  test('no scrubbed name is missing a posture', () => {
    const missing = SCRUBBED_ENV_VAR_NAMES.filter((n) => SCRUBBED_ENV_POSTURES[n] === undefined);
    expect(
      missing,
      'A name in SCRUBBED_ENV_VAR_NAMES has no entry in SCRUBBED_ENV_POSTURES, ' +
        'so the authority panel will label it with the generic fallback. Add a ' +
        'posture string saying what that variable would re-route or override.',
    ).toEqual([]);
  });

  test('no posture describes a name that is not scrubbed', () => {
    // The other direction: a stale posture for a name dropped from the list is
    // dead weight that reads as coverage.
    const names = new Set(SCRUBBED_ENV_VAR_NAMES);
    expect(Object.keys(SCRUBBED_ENV_POSTURES).filter((k) => !names.has(k))).toEqual([]);
  });

  test('ANTI-VACUITY: both lists are non-trivially populated', () => {
    // Two empty collections satisfy both assertions above.
    expect(SCRUBBED_ENV_VAR_NAMES.length).toBeGreaterThan(5);
    expect(Object.keys(SCRUBBED_ENV_POSTURES).length).toBeGreaterThan(5);
  });
});
