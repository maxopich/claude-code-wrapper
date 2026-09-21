/**
 * The ordering, which is the actual defect.
 *
 * `smoke_port_guard.test.ts` proves the check answers correctly. It cannot
 * prove that `ci_smoke` CALLS it, or calls it before spawning — and "after the
 * spawn" is exactly the shape the bug had (`Cebab-j1dl`): the old code did
 * check `serverExited`, just too late to matter, because the squatter's 200
 * arrived before our child's exit event. A unit test of the helper would have
 * been green throughout.
 *
 * So this runs the real script against a real occupied port and asserts on what
 * it did NOT do. The negatives carry the weight: reaching `server healthy` or
 * the auth-token read means the guard did not stop it, whatever else it printed.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const open: http.Server[] = [];
afterEach(async () => {
  while (open.length) {
    const s = open.pop();
    // `close` waits on live sockets, and the health poll opens them. Without
    // this the hook can outlive the 15s global hookTimeout and report a future
    // regression as a confusing hook failure stacked on the real one.
    s?.closeAllConnections?.();
    await new Promise<void>((resolve) => s?.close(() => resolve()));
  }
});

/**
 * Stand in for the stray `dev:server` that cost a finished feature — and it
 * must ANSWER `/health` with a 200, which a bare TCP listener does not.
 *
 * That is the difference between this test and a vacuous one. With a socket
 * that never replies, removing the guard entirely still produced no
 * `server healthy` line and no auth-token read: our own server exits cleanly
 * on EADDRINUSE, so the run failed early for an unrelated reason and BOTH
 * negatives below passed while proving nothing. The measured incident needed
 * something that answers, so the fixture has to be something that answers.
 */
function squat(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true,"mock":true}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    open.push(s);
    s.listen({ port: 0, host: '127.0.0.1' }, () => resolve((s.address() as { port: number }).port));
  });
}

function runCiSmoke(env: Record<string, string>): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, 'src/ci_smoke.ts'], {
      cwd: serverDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (b) => (output += String(b)));
    child.stderr.on('data', (b) => (output += String(b)));
    child.on('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}

describe('ci_smoke against an occupied port', () => {
  // Both spellings, because the port the SERVER binds is resolved
  // `CEBAB_PORT` first and the bare name is only its deprecated alias. A guard
  // that read one of them would probe a different port than the server it
  // spawned — which is the same "talks to a server it did not start" failure,
  // reintroduced by the guard meant to close it.
  for (const [label, key] of [
    ['CEBAB_PORT, the canonical name', 'CEBAB_PORT'],
    ['PORT, the deprecated alias', 'PORT'],
  ] as const) {
    test(`refuses before spawning, and never reaches ws_smoke — via ${label}`, async () => {
      const port = await squat();
      const { code, output } = await runCiSmoke({ [key]: String(port) });

      // The negatives first: they are what "the guard stopped it in time"
      // actually means, and they are the assertions a regression should
      // report. Both strings lie on the path the old code took.
      expect(output, 'reached the health poll — the guard ran too late').not.toContain(
        'server healthy',
      );
      expect(output, 'reached ws_smoke — the guard did not stop it').not.toContain('auth-token');

      expect(code, `ci_smoke exited ${code}\n${output}`).not.toBe(0);
      expect(output).toContain(String(port));
      expect(output).toContain('Refusing to run');
    }, 60_000);
  }
});
