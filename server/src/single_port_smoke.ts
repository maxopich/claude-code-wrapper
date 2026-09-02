/**
 * Does `npm start` actually work? — the single-port posture, end to end.
 *
 *   npm run build && npm --workspace server exec tsx src/single_port_smoke.ts
 *
 * Everything here is a claim that NO unit test can make, because each one
 * depends on a real HTTP server with the real middleware stack in the real
 * mount order:
 *
 *   - the SPA is served from the API's own origin;
 *   - `/health` still answers as JSON rather than being swallowed by the SPA
 *     fallback — the failure mode that returns 200 and a page of HTML to
 *     something that only checks the status code;
 *   - `/auth-token` serves a same-origin browser fetch that carries NO
 *     `Origin` header, which is the exact request the previous posture 403'd
 *     and the reason this mode needed a change at all;
 *   - and it still refuses the two callers it always refused.
 *
 * Runs under `MOCK=1` and spends no model quota, which is why it lives in the
 * repo beside `ci_smoke.ts` rather than with the live smokes.
 *
 * Hermetic in the same way `ci_smoke.ts` is: HOME and USERPROFILE point at a
 * throwaway directory, so the operator's real `~/.cebab` is never opened.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { DEFAULT_PORT } from '@cebab/shared/net';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '..');

const PORT = process.env.PORT ?? String(DEFAULT_PORT);
const HOST = '127.0.0.1';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-sp-home-'));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-sp-ws-'));

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MOCK: '1',
  PORT,
  WORKSPACE_ROOT: tmpWs,
  HOME: tmpHome,
  USERPROFILE: tmpHome,
  CEBAB_AUTH_TOKEN_FILE: path.join(tmpHome, '.cebab', 'auth-token'),
};

let server: ChildProcess | null = null;
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`[single-port] ok   ${name}`);
  } else {
    failures += 1;
    console.error(`[single-port] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function get(
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: Number(PORT), path: urlPath, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await get('/health');
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function openWs(token: string): Promise<'open' | string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws?token=${encodeURIComponent(token)}`);
    const done = (v: 'open' | string): void => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(v);
    };
    ws.on('open', () => done('open'));
    ws.on('error', (e: Error) => done(e.message));
    setTimeout(() => done('timed out'), 10_000);
  });
}

async function main(): Promise<number> {
  if (!fs.existsSync(path.join(repoRoot, 'web', 'dist', 'index.html'))) {
    console.error('[single-port] web/dist is missing. Run `npm run build` first.');
    return 2;
  }

  server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverDir,
    env: childEnv,
    stdio: 'inherit',
  });
  let exited = false;
  server.on('exit', () => {
    exited = true;
  });

  if (!(await waitForHealth(30_000)) || exited) {
    console.error('[single-port] server did not become healthy within 30s');
    return 1;
  }

  const root = await get('/');
  check(
    'GET / serves the SPA',
    root.status === 200 && /<div id="root"/.test(root.body),
    `status=${root.status}`,
  );

  const health = await get('/health');
  check(
    'GET /health is JSON, not the SPA fallback',
    health.status === 200 && health.body.trimStart().startsWith('{'),
    `body=${health.body.slice(0, 60)}`,
  );

  // The request the browser actually makes once the server serves the page:
  // same-origin, so no Origin header at all.
  const sameOrigin = await get('/auth-token', {
    'Sec-Fetch-Site': 'same-origin',
    Host: `${HOST}:${PORT}`,
  });
  check(
    'GET /auth-token serves a same-origin fetch with no Origin',
    sameOrigin.status === 200 && sameOrigin.body.length > 0,
    `status=${sameOrigin.status} reason=${sameOrigin.headers['x-cebab-reject-reason'] ?? '-'}`,
  );

  const bare = await get('/auth-token', { Host: `${HOST}:${PORT}` });
  check(
    'GET /auth-token still refuses a bare non-browser client',
    bare.status === 403,
    `status=${bare.status}`,
  );

  const foreign = await get('/auth-token', {
    Origin: 'http://evil.example',
    Host: `${HOST}:${PORT}`,
  });
  check(
    'GET /auth-token still refuses a cross-origin tab',
    foreign.status === 403,
    `status=${foreign.status}`,
  );

  if (sameOrigin.status === 200) {
    const result = await openWs(sameOrigin.body);
    check('the served token opens a WS', result === 'open', result);
  } else {
    check('the served token opens a WS', false, 'no token to try');
  }

  return failures === 0 ? 0 : 1;
}

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

async function rmWithRetry(target: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 9) {
        console.warn(`[single-port] could not remove ${target}: ${String(err)}`);
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
    console.error('[single-port] threw', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) await killAndWait(server);
    await rmWithRetry(tmpHome);
    await rmWithRetry(tmpWs);
  });
