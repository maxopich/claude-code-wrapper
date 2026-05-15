/**
 * Cross-platform CI mock smoke.
 *
 * Replaces the old bash pipeline (`MOCK=1 ... & ; nc -z ; timeout ; kill`)
 * which only ran on Linux. Pure Node: spawn the mock server, poll /health
 * over fetch, run ws_smoke, tear the server down. Works identically on
 * ubuntu-latest and windows-latest because it never shells out — children
 * are `node <tsx-cli> <script>`, no `.cmd` shims, no `&`, no `nc`.
 *
 * Hermetic: the server's data dir derives from the home dir
 * (`config.dataDir = <home>/.cebab`), so we point HOME *and* USERPROFILE
 * at a throwaway temp dir. Nothing touches the developer's real ~/.cebab,
 * and CI doesn't depend on an ephemeral-home assumption.
 *
 *   npm --workspace server exec tsx src/ci_smoke.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli'); // node_modules/tsx/dist/cli.mjs
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = process.env.PORT ?? '4319';
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ci-home-'));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ci-ws-'));
fs.mkdirSync(path.join(tmpWs, 'Cebab'), { recursive: true }); // ws_smoke needs a "Cebab" project

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MOCK: '1',
  PORT,
  WORKSPACE_ROOT: tmpWs,
  HOME: tmpHome,
  USERPROFILE: tmpHome, // os.homedir() reads USERPROFILE on Windows
  CEBAB_AUTH_TOKEN_FILE: path.join(tmpHome, '.cebab', 'auth-token'),
};

let server: ChildProcess | null = null;

function runNode(script: string, opts: { wait: boolean }): Promise<number> | ChildProcess {
  const child = spawn(process.execPath, [tsxCli, script], {
    cwd: serverDir,
    env: childEnv,
    stdio: 'inherit',
  });
  if (!opts.wait) return child;
  return new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main(): Promise<number> {
  server = runNode('src/index.ts', { wait: false }) as ChildProcess;
  let serverExited = false;
  server.on('exit', () => {
    serverExited = true;
  });

  const healthy = await waitForHealth(30_000);
  if (!healthy || serverExited) {
    console.error('[ci-smoke] server did not become healthy within 30s');
    return 1;
  }
  console.log('[ci-smoke] server healthy — running ws_smoke');

  const code = (await runNode('src/ws_smoke.ts', { wait: true })) as number;
  console.log(`[ci-smoke] ws_smoke exited ${code}`);
  return code;
}

/** Kill the server and AWAIT its real exit. On Windows the OS only
 *  releases the better-sqlite3 file handles on `<tmpHome>/.cebab` once the
 *  process is actually gone — deleting them while it lingers throws EPERM
 *  (POSIX tolerates unlink-while-open, which is why this only bit CI on
 *  windows-latest). Force-kill if a graceful stop doesn't land in time. */
async function killAndWait(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

/** rm with retry: even after the owning process exits, Windows can lag
 *  briefly before the file lock clears (AV/indexer/OS). Best-effort —
 *  CI runners are ephemeral, so a final failure only warns. */
async function rmWithRetry(target: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 9) {
        console.warn(`[ci-smoke] could not remove ${target}: ${String(err)}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[ci-smoke] threw', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) await killAndWait(server);
    await rmWithRetry(tmpHome);
    await rmWithRetry(tmpWs);
  });
