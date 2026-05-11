import os from 'node:os';
import path from 'node:path';

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

export function resolvePath(input: string): string {
  return path.resolve(expandHome(input));
}

export const config = {
  port: Number(process.env.PORT ?? 4319),
  host: '127.0.0.1' as const,
  /** Fallback workspace root when nothing is stored in the settings table.
   * `~/agents` is a placeholder — first-run UX prompts the user to set this
   * via the Settings modal, and the resolved value is overridable via the
   * WORKSPACE_ROOT env var. */
  workspaceRootDefault: resolvePath(process.env.WORKSPACE_ROOT ?? '~/agents'),
  mock: process.env.MOCK === '1',
  dataDir: path.join(os.homedir(), '.cebab'),
  /** Hard cap on agent turns per user message. Prevents runaway loops. */
  maxTurns: Number(process.env.MAX_TURNS ?? 50),
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
