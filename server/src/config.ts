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

export const config = {
  port: Number(process.env.PORT ?? 4319),
  host: '127.0.0.1' as const,
  /** Fallback workspace root when nothing is stored in the settings table.
   * `~/agents` is a placeholder — first-run UX prompts the user to set this
   * via the Settings modal, and the resolved value is overridable via the
   * WORKSPACE_ROOT env var. */
  workspaceRootDefault: resolvePath(process.env.WORKSPACE_ROOT ?? '~/agents'),
  /**
   * Cluster E Phase 3 (A4): provenance of `workspaceRootDefault`. Surfaced
   * on the `settings` ServerMsg so the operator's SettingsModal can label
   * the fallback path with its source — distinguishing "from your
   * WORKSPACE_ROOT env" vs "Cebab's built-in ~/agents default" matters
   * because the env path may have been set in a stray .zshrc the operator
   * has forgotten about.
   */
  workspaceRootDefaultSource: (process.env.WORKSPACE_ROOT ? 'env' : 'builtin') as 'env' | 'builtin',
  mock: process.env.MOCK === '1',
  dataDir: path.join(os.homedir(), '.cebab'),
  /** Hard cap on agent turns per user message. Prevents runaway loops. */
  maxTurns: Number(process.env.MAX_TURNS ?? 50),
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
