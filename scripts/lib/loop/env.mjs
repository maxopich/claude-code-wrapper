/**
 * Autonomous loop — the subprocess environment.
 *
 * WHY THIS EXISTS. The `claude` CLI prefers `ANTHROPIC_API_KEY` over the OAuth
 * subscription, so a stray `export` in a shell profile silently routes an
 * agent turn to paid API billing. Cebab's SERVER has always known this:
 * `server/src/runner/claude.ts` strips the same names before every spawn,
 * and CLAUDE.md records the reasoning. The set is the CLI's OWN
 * auth-precedence enumeration (credential-env array + WIF pair + backend
 * flags), not a hand-picked subset — `CLAUDE_CODE_OAUTH_TOKEN`, the documented
 * `claude setup-token` output, is the strongest overriding case (Cebab-ygu.18).
 *
 * The loop did not. `makeRunner` defaults to `process.env` and the driver built
 * it with no `env` argument, so every BUILD inherited whatever the operator's
 * shell exported. An unattended `--until 8` night would have billed eight full
 * agent turns to the API with no signal anywhere — the loop reports normally,
 * `costUsd` is the same token proxy either way, and nothing in the log names
 * the auth mode. Measured 2026-08-27: not firing on this machine because the
 * var happens to be unset, which is luck rather than safety.
 *
 * WHY A COPY. `scripts/*.mjs` cannot import from `server/src` — that is
 * TypeScript, compiled to `server/dist`, which is not a build dependency of the
 * loop and would make the driver require a build step to run. So this is the
 * repo's usual one-copy-per-program shape, and the copy is kept honest by
 * `loop.test.mjs` reading BOTH sources and asserting the two lists are
 * identical. Without that test the copy rots the first time the server's list
 * grows, and it rots SILENTLY, in the direction of spending money.
 */

/** Every env var that would override OAuth subscription auth. */
export const SCRUBBED_ENV_VAR_NAMES = Object.freeze([
  // Credential-class env keys the CLI honours over the stored OAuth session.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  // WIF (workload-identity federation) pair.
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  // Alternate transport the CLI dials instead of the default endpoint.
  'ANTHROPIC_UNIX_SOCKET',
  // Backend switches that re-route off the Anthropic API entirely.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
]);

/**
 * `env` with those names removed. Applied to the loop's ONE runner rather than
 * only to the `claude` spawn: `git`, `gh`, `bd` and `npm` have no use for them
 * either, and a single application point cannot be forgotten at a second one.
 */
export function subscriptionOnlyEnv(env = process.env) {
  const blocked = new Set(SCRUBBED_ENV_VAR_NAMES);
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (blocked.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Which of them were actually set — NAMES only, never values. */
export function scrubbedFrom(env = process.env) {
  return SCRUBBED_ENV_VAR_NAMES.filter((n) => typeof env[n] === 'string' && env[n] !== '');
}
