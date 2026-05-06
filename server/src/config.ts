import os from 'node:os';
import path from 'node:path';

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

export const config = {
  port: Number(process.env.PORT ?? 4319),
  host: '127.0.0.1' as const,
  workspaceRoot: path.resolve(expandHome(process.env.WORKSPACE_ROOT ?? '~/Claude_Space')),
  mock: process.env.MOCK === '1',
  dataDir: path.join(os.homedir(), '.cebab'),
  get dbPath() {
    return path.join(this.dataDir, 'cebab.sqlite');
  },
  get logsDir() {
    return path.join(this.dataDir, 'logs');
  },
};
