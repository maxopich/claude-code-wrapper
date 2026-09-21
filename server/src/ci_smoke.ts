/**
 * Cross-platform CI mock smoke.
 *
 * Replaces the old bash pipeline (`MOCK=1 ... & ; nc -z ; timeout ; kill`)
 * which only ran on Linux. Pure Node: spawn the mock server, poll /health
 * over fetch, run ws_smoke, tear the server down. Works identically on
 * Linux and Windows because it never shells out — children are
 * `node <tsx-cli> <script>`, no `.cmd` shims, no `&`, no `nc`. Named by OS
 * rather than by runner image on purpose: portability does not stop being
 * true when the matrix repins, and naming the image made this sentence
 * outlive the image it named (register X12).
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
import { DEFAULT_PORT } from '@cebab/shared/net';
import {
  checkPortAvailable,
  resolveSmokeTarget,
  waitForHealthyServer,
} from './smoke_server_guard.js';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli'); // node_modules/tsx/dist/cli.mjs
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One port decision for the whole smoke, resolved the way the SERVER resolves
// it — `CEBAB_PORT` outranks the deprecated bare `PORT`, so reading only the
// latter would probe one port while the child bound another.
const PORT = String(resolveSmokeTarget(process.env, DEFAULT_PORT).port);
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ci-home-'));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ci-ws-'));
fs.mkdirSync(path.join(tmpWs, 'Cebab'), { recursive: true }); // ws_smoke needs a "Cebab" project

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MOCK: '1',
  // Both names, same value: the canonical one is what config.ts reads first,
  // and leaving a stale inherited `PORT` beside it would be the same
  // disagreement this file now exists to prevent.
  CEBAB_PORT: PORT,
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

async function main(): Promise<number> {
  // BEFORE the spawn, not after. Once something else holds the port, every
  // signal downstream is about that process instead of ours, and the error it
  // eventually produces names neither the port nor this file.
  const portProblem = await checkPortAvailable(Number(PORT));
  if (portProblem) {
    console.error(`[ci-smoke] ${portProblem}`);
    return 1;
  }

  server = runNode('src/index.ts', { wait: false }) as ChildProcess;
  let serverExited = false;
  let exitCode: number | null = null;
  server.on('exit', (code) => {
    serverExited = true;
    exitCode = code;
  });

  const verdict = await waitForHealthyServer({
    url: `http://127.0.0.1:${PORT}/health`,
    timeoutMs: 30_000,
    isDead: () => serverExited,
  });
  if (verdict !== 'healthy') {
    console.error(
      verdict === 'died'
        ? `[ci-smoke] the server we started exited (code ${exitCode}) before becoming healthy`
        : '[ci-smoke] server did not become healthy within 30s',
    );
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
 *  (POSIX tolerates unlink-while-open, which is why this only bit the
 *  Windows leg). Force-kill if a graceful stop doesn't land in time. */
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
