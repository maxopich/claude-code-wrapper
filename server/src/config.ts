import os from 'node:os';
import path from 'node:path';

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

export function resolvePath(input: string): string {
  return path.resolve(expandHome(input));
}

/**
 * P0-C part 2b: parse the `CEBAB_AUTO_RECLAIM_DAYS` opt-in. Returns the idle
 * cutoff in days, or null (= feature OFF) when the env var is unset, blank,
 * non-numeric, or <= 0. Fractional values floor (a "30.7 day" cutoff is 30).
 * Auto-reclaim is destructive (soft-delete), so the default is OFF — the
 * operator must deliberately set a positive integer.
 */
export function parseAutoReclaimDays(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Register S13: parse an integer env var, or fall back loudly.
 *
 * `Number(process.env.PORT ?? 4319)` was the shape everywhere, and `Number()`
 * has two failure modes that both look like success:
 *
 *   - `Number('')` is **0**. `PORT=` in a `.env` gave port 0, which makes the
 *     OS pick a free port while `buildAllowedOrigins()` and `isAllowedHost()`
 *     are still built from `:0` — so the server logs a healthy listen and the
 *     browser can never connect to it.
 *   - `Number('abc')` is **NaN**, which flowed into the SDK as an effective
 *     turn cap and into audit payloads for the operator to read.
 *
 * Falling back beats throwing: a typo in `.env` should not brick the app with
 * a stack trace at module-init. The warning names the variable, the value that
 * was rejected, and the value actually in use, which is what makes the
 * misconfiguration non-silent — the thing the finding is actually about.
 *
 * Same discipline as `parseAutoReclaimDays` above, which is why it lives here
 * rather than being inlined three times.
 */
export function parseIntEnv(
  name: string,
  raw: string | undefined,
  opts: { fallback: number; min: number; max?: number },
  warn: (msg: string) => void = console.warn,
): number {
  if (raw == null || raw.trim() === '') return opts.fallback;
  const n = Number(raw);
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < opts.min || n > max) {
    warn(
      `[cebab] ${name}=${JSON.stringify(raw)} is not an integer in [${opts.min}, ${max}] — using ${opts.fallback}`,
    );
    return opts.fallback;
  }
  return n;
}

/**
 * Register N26: resolve an env var that now carries the `CEBAB_` project
 * prefix, honouring its legacy bare name for backward compatibility.
 *
 * Six of Cebab's ten env vars shipped bare — `PORT`, `WORKSPACE_ROOT`, `MOCK`,
 * `MOCK_SCENARIO`, `MOCK_INTERVAL_MS`, `MAX_TURNS` — while `CEBAB_DATA_DIR`,
 * `CEBAB_ALLOWED_ORIGINS`, `CEBAB_AUTO_RECLAIM_DAYS` and `CEBAB_AUTH_TOKEN_FILE`
 * all carry the prefix. A bare `PORT` or `MAX_TURNS` collides with anything else
 * in the operator's shell — the exact class of bug this file already guards for
 * the API-key vars in `runner/claude.ts`. The prefixed spelling is now the
 * canonical one; the bare name still works but warns once, so an existing
 * `.env` keeps running while the operator migrates.
 *
 * The prefixed value wins whenever it is meaningfully set; an unset or blank
 * one falls through to the bare name (and only then does the deprecation fire).
 * When neither is meaningfully set the prefixed raw is returned unchanged, so a
 * downstream parser sees the same empty-vs-undefined it saw before.
 *
 * Both names are passed in as literal environment reads at each call site on
 * purpose: that is what keeps them visible to the static env-var scan in
 * `scripts/configSurfaceClaims.test.mjs`, which requires each to be documented
 * in `.env.example`.
 */
export function readAliasedEnv(
  prefixedName: string,
  prefixedValue: string | undefined,
  bareName: string,
  bareValue: string | undefined,
  warn: (msg: string) => void = console.warn,
): string | undefined {
  if (prefixedValue != null && prefixedValue.trim() !== '') return prefixedValue;
  if (bareValue != null && bareValue.trim() !== '') {
    warn(`[cebab] ${bareName} is deprecated; rename it to ${prefixedName}`);
    return bareValue;
  }
  return prefixedValue ?? bareValue;
}

/**
 * Register N26: the workspace-root raw is read once here because
 * `workspaceRootDefault` and `workspaceRootDefaultSource` both derive from it,
 * and reading it twice would fire the deprecation warning twice.
 */
const workspaceRootRaw = readAliasedEnv(
  'CEBAB_WORKSPACE_ROOT',
  process.env.CEBAB_WORKSPACE_ROOT,
  'WORKSPACE_ROOT',
  process.env.WORKSPACE_ROOT,
);

export const config = {
  port: parseIntEnv(
    'CEBAB_PORT',
    readAliasedEnv('CEBAB_PORT', process.env.CEBAB_PORT, 'PORT', process.env.PORT),
    { fallback: 4319, min: 1, max: 65535 },
  ),
  host: '127.0.0.1' as const,
  /** Fallback workspace root when nothing is stored in the settings table.
   * `~/agents` is a placeholder — first-run UX prompts the user to set this
   * via the Settings modal, and the resolved value is overridable via the
   * CEBAB_WORKSPACE_ROOT env var (or the deprecated bare WORKSPACE_ROOT). */
  workspaceRootDefault: resolvePath(workspaceRootRaw ?? '~/agents'),
  /**
   * Cluster E Phase 3 (A4): provenance of `workspaceRootDefault`. Surfaced
   * on the `settings` ServerMsg so the operator's SettingsModal can label
   * the fallback path with its source — distinguishing "from your
   * WORKSPACE_ROOT env" vs "Cebab's built-in ~/agents default" matters
   * because the env path may have been set in a stray .zshrc the operator
   * has forgotten about.
   */
  workspaceRootDefaultSource: (workspaceRootRaw ? 'env' : 'builtin') as 'env' | 'builtin',
  mock: readAliasedEnv('CEBAB_MOCK', process.env.CEBAB_MOCK, 'MOCK', process.env.MOCK) === '1',
  /**
   * Bus replay scenario directory under `fixtures/bus/` (`MOCK_SCENARIO`).
   * null → each router uses its own built-in default (`chain` /
   * `orchestrator`), which is what an operator running plain `MOCK=1` wants.
   * Set it to replay a hand-written scenario instead. Ignored outside mock.
   */
  mockScenario:
    readAliasedEnv(
      'CEBAB_MOCK_SCENARIO',
      process.env.CEBAB_MOCK_SCENARIO,
      'MOCK_SCENARIO',
      process.env.MOCK_SCENARIO,
    ) || null,
  /**
   * Delay between replayed fixture events (`MOCK_INTERVAL_MS`). The 50 ms
   * default paces a single-agent replay so the UI streams visibly; a bus
   * session multiplies it by every hop, and tests set it to 0.
   */
  mockIntervalMs: parseIntEnv(
    'CEBAB_MOCK_INTERVAL_MS',
    readAliasedEnv(
      'CEBAB_MOCK_INTERVAL_MS',
      process.env.CEBAB_MOCK_INTERVAL_MS,
      'MOCK_INTERVAL_MS',
      process.env.MOCK_INTERVAL_MS,
    ),
    { fallback: 50, min: 0 },
  ),
  /**
   * Where Cebab keeps its database, logs and auth token.
   *
   * `CEBAB_DATA_DIR` was the one path here with no env override — `port`,
   * `workspaceRootDefault`, `allowedOrigins` and the rest all read one, and
   * `CEBAB_AUTH_TOKEN_FILE` already overrides a sibling path for the smoke
   * scripts. Its absence is why every DB-touching test reassigns this
   * property by hand and why `smoke.ts` had no way not to: with no env seam,
   * redirecting the data dir required running code.
   *
   * Read ONCE at module init, so anything that wants to redirect it must set
   * the variable before this module is first imported. That is exactly what
   * `vitest.setup.mjs` does, and why it can be a plain env write with no
   * imports. Assigning `config.dataDir` at runtime still works and is what
   * per-test isolation uses.
   */
  dataDir: resolvePath(process.env.CEBAB_DATA_DIR ?? '~/.cebab'),
  /** Hard cap on agent turns per user message. Prevents runaway loops. */
  maxTurns: parseIntEnv(
    'CEBAB_MAX_TURNS',
    readAliasedEnv(
      'CEBAB_MAX_TURNS',
      process.env.CEBAB_MAX_TURNS,
      'MAX_TURNS',
      process.env.MAX_TURNS,
    ),
    { fallback: 50, min: 1 },
  ),
  /**
   * P0-C part 2b: opt-in idle-session auto-reclamation cutoff, in days, from
   * `CEBAB_AUTO_RECLAIM_DAYS`. null = OFF (the default). When set, the purge
   * cron soft-deletes sessions idle longer than this (recoverable for 7 days
   * via the existing undo window). Mutable so tests can flip it like dataDir.
   */
  autoReclaimDays: parseAutoReclaimDays(process.env.CEBAB_AUTO_RECLAIM_DAYS),
  /** Extra origins permitted to open the WS. Comma-separated. */
  allowedOrigins: (process.env.CEBAB_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  get dbPath() {
    return path.join(this.dataDir, 'cebab.sqlite');
  },
  get logsDir() {
    return path.join(this.dataDir, 'logs');
  },
};
